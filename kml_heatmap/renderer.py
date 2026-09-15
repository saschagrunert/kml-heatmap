"""HTML generation, rendering, and pipeline orchestration."""

import hashlib
import html
import json
import logging
import os
import re
import shutil
import string
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

import minify_html as mh
import rcssmin
import rjsmin

from .aircraft import merge_aircraft_data
from .airport_lookup import load_airport_database
from .airports import deduplicate_airports
from .cache import atomic_text_write
from .data_exporter import (
    ExportResult,
    SiteOutput,
    export_all_data,
    is_exportable_path,
)
from .exceptions import KMLHeatmapError, KMLParseError
from .logger import logger
from .parser import parse_kml_coordinates
from .parser_cache import prune_stale_cache_entries
from .validation import validate_kml_file, validate_output_dir
from .workers import init_worker, parse_worker_count

if TYPE_CHECKING:
    from .types import FlightPath, FlightPathGroup, PathMetadata

__all__ = [
    "CoordinateExtent",
    "ParsedFile",
    "create_progressive_heatmap",
    "load_template",
    "minify_html",
]

STATIC_DIR = Path(__file__).parent / "static"
TEMPLATES_DIR = Path(__file__).parent / "templates"
# Built by `npm run build` and not committed
BUNDLE_FILE = STATIC_DIR / "mapApp.bundle.js"
# The sources of the bundle; only present in a checkout, not in the image
FRONTEND_DIR = Path(__file__).parent / "frontend"
# First line of the bundle; the group is the source hash (scripts/source-hash.js)
BUNDLE_BANNER = re.compile(rb"/\* kml-heatmap build ([0-9a-f]{12}) \*/")
FAVICON_FILES = (
    "favicon.svg",
    "favicon.ico",
    "favicon-192.png",
    "favicon-512.png",
    "apple-touch-icon.png",
    "manifest.json",
)
# The files the tool owns next to the page. Any of them that a run does not
# produce (the source map of a bundle built without one) is removed.
SITE_FILES = (
    "map_config.js",
    "styles.css",
    BUNDLE_FILE.name,
    f"{BUNDLE_FILE.name}.map",
    *FAVICON_FILES,
)


@dataclass(frozen=True)
class CoordinateExtent:
    """Bounding box of a set of coordinates."""

    min_lat: float
    max_lat: float
    min_lon: float
    max_lon: float

    @classmethod
    def of(cls, coordinates: FlightPath) -> CoordinateExtent | None:
        """The extent of a coordinate list, or None when it is empty."""
        if not coordinates:
            return None
        return cls(
            min(point.lat for point in coordinates),
            max(point.lat for point in coordinates),
            min(point.lon for point in coordinates),
            max(point.lon for point in coordinates),
        )

    def union(self, other: CoordinateExtent | None) -> CoordinateExtent:
        """The extent covering this one and ``other``."""
        if other is None:
            return self
        return CoordinateExtent(
            min(self.min_lat, other.min_lat),
            max(self.max_lat, other.max_lat),
            min(self.min_lon, other.min_lon),
            max(self.max_lon, other.max_lon),
        )

    def as_map_bounds(self) -> dict[str, float]:
        """The bounds dictionary the map configuration is rendered from."""
        return {
            "min_lat": self.min_lat,
            "max_lat": self.max_lat,
            "min_lon": self.min_lon,
            "max_lon": self.max_lon,
            "center_lat": (self.min_lat + self.max_lat) / 2,
            "center_lon": (self.min_lon + self.max_lon) / 2,
        }


@dataclass
class ParsedFile:
    """What a parse worker sends back to the main process.

    The flat coordinate list stays in the worker: the main process only
    needs its size, which keeps the data crossing the process boundary (and
    held in the parent) to the flight paths themselves.
    """

    kml_file: str
    point_count: int = 0
    path_groups: FlightPathGroup = field(default_factory=list)
    path_metadata: list[PathMetadata] = field(default_factory=list)


def _escape_js_string(value: str) -> str:
    """Escape a value for safe embedding in a single-quoted JS string."""
    escaped: str = json.dumps(value)
    return escaped[1:-1].replace("'", "\\'")


def load_template() -> str:
    """Load the HTML template from file."""
    template_path = TEMPLATES_DIR / "map_template.html"
    with open(template_path, encoding="utf-8") as f:
        return f.read()


def minify_html(html_content: str) -> str:
    """Minify the HTML page.

    Only the markup: the template has no inline styles or scripts (its CSP
    blocks inline scripts), the stylesheet and the config are minified as
    separate files.
    """
    minified: str = mh.minify(html_content)
    return minified


def _frontend_source_hash() -> str | None:
    """The hash build.js stamps into the bundle, None without the sources.

    Mirrors scripts/source-hash.js: every .ts file in path order, each as its
    path relative to the repository and its content.
    """
    if not FRONTEND_DIR.is_dir():
        return None
    root = FRONTEND_DIR.parent.parent
    digest = hashlib.sha1(usedforsecurity=False)
    for path in sorted(FRONTEND_DIR.rglob("*.ts"), key=str):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:12]


def _warn_about_a_stale_bundle() -> None:
    """Warn when the bundle was built from other sources than the checkout's.

    An old bundle left over from before a pull reads a data format the new
    generator no longer writes; the page then breaks in ways that are hard to
    trace back to a missing ``npm run build``.
    """
    try:
        current = _frontend_source_hash()
        with BUNDLE_FILE.open("rb") as bundle:
            match = BUNDLE_BANNER.match(bundle.readline())
    except OSError:
        return
    if current is not None and (match is None or match.group(1).decode() != current):
        logger.warning(
            "The JavaScript bundle was built from other frontend sources; "
            "run 'npm run build' to rebuild it"
        )


def _parse_with_error_handling(kml_file: str) -> ParsedFile:
    """Parse a KML file in a worker and reduce the result for the parent."""
    try:
        coordinates, path_groups, path_metadata = parse_kml_coordinates(kml_file)
    except (OSError, ValueError, TypeError, KMLParseError) as e:
        logger.error("Error processing %s: %s", kml_file, e)
        return ParsedFile(kml_file)
    return ParsedFile(kml_file, len(coordinates), path_groups, path_metadata)


def _parse_kml_files(
    valid_files: list[str],
) -> tuple[FlightPathGroup, list[PathMetadata]]:
    """Parse KML files in parallel and merge the results in input order.

    The input order decides the path ids, so the merge must not depend on
    which worker finished first or on the file names: two directories may
    well contain files with the same name.
    """
    parse_start = time.time()
    # Load (and if needed download) the airport database once in the parent:
    # the workers then find a valid cache instead of each waiting for the
    # download, and the cache keys below see the same database as they do
    load_airport_database()
    prune_stale_cache_entries()

    results: list[ParsedFile] = []
    debug = logger.isEnabledFor(logging.DEBUG)

    def record(parsed: ParsedFile) -> None:
        results.append(parsed)
        logger.info(
            "  [%d/%d] %.0f%% - %s",
            len(results),
            len(valid_files),
            (len(results) / len(valid_files)) * 100,
            Path(parsed.kml_file).name,
        )

    pool_broken = False
    with ProcessPoolExecutor(
        max_workers=parse_worker_count(valid_files),
        initializer=init_worker,
        initargs=(debug,),
    ) as executor:
        future_to_file = {
            executor.submit(_parse_with_error_handling, f): f for f in valid_files
        }
        for future in as_completed(future_to_file):
            try:
                parsed = future.result()
            except BrokenProcessPool:
                # Usually a worker killed for running out of memory while
                # others parsed large files at the same time
                pool_broken = True
                break
            except KMLHeatmapError:
                # Not a problem of this one file (the airport database, say),
                # so every other file would fail the same way
                executor.shutdown(wait=True, cancel_futures=True)
                raise
            except Exception:
                kml_file = future_to_file[future]
                logger.exception("Unexpected error processing %s", kml_file)
                parsed = ParsedFile(kml_file)
            record(parsed)

    if pool_broken:
        done = {parsed.kml_file for parsed in results}
        remaining = [f for f in valid_files if f not in done]
        logger.warning(
            "  A parser worker process crashed; parsing the %d remaining "
            "file(s) one at a time",
            len(remaining),
        )
        # Still in a worker: a file that is too large to parse must not take
        # the main process down with it, and one at a time names the file
        with ProcessPoolExecutor(
            max_workers=1, initializer=init_worker, initargs=(debug,)
        ) as executor:
            for kml_file in remaining:
                try:
                    parsed = executor.submit(
                        _parse_with_error_handling, kml_file
                    ).result()
                except BrokenProcessPool:
                    raise KMLHeatmapError(
                        f"A parser worker process crashed on {kml_file}, possibly "
                        "out of memory; run with --debug for details"
                    ) from None
                record(parsed)

    input_order = {kml_file: index for index, kml_file in enumerate(valid_files)}
    results.sort(key=lambda parsed: input_order[parsed.kml_file])
    total_points = 0
    all_path_groups: FlightPathGroup = []
    all_path_metadata: list[PathMetadata] = []
    for parsed in results:
        total_points += parsed.point_count
        all_path_groups.extend(parsed.path_groups)
        all_path_metadata.extend(parsed.path_metadata)

    parse_time = time.time() - parse_start
    logger.info(
        "  Parsing took %.1fs (%.2fs per file)",
        parse_time,
        parse_time / len(valid_files),
    )

    if total_points == 0:
        raise KMLHeatmapError("No coordinates found in any KML files!")
    failed_count = sum(1 for parsed in results if parsed.point_count == 0)
    if failed_count > 0:
        raise KMLHeatmapError(
            f"{failed_count} of {len(valid_files)} file(s) failed to parse "
            "(see above); fix or remove them"
        )

    logger.info("\nTotal points: %d", total_points)
    return all_path_groups, all_path_metadata


def _drop_paths_without_year(
    all_path_groups: FlightPathGroup, all_path_metadata: list[PathMetadata]
) -> tuple[FlightPathGroup, list[PathMetadata]]:
    """Exclude paths whose year cannot be determined, with a warning each."""
    kept_groups: FlightPathGroup = []
    kept_metadata: list[PathMetadata] = []
    for path, metadata in zip(all_path_groups, all_path_metadata, strict=True):
        if metadata.get("year") is None:
            logger.warning(
                "Excluding path without a determinable year: %s (%s)",
                metadata.get("filename") or "unknown file",
                metadata.get("airport_name") or "unnamed",
            )
            continue
        kept_groups.append(path)
        kept_metadata.append(metadata)
    return kept_groups, kept_metadata


def _map_extent(all_path_groups: FlightPathGroup) -> CoordinateExtent:
    """The extent of the exported paths, which the map is fitted to.

    Only exported paths count: an excluded path would widen the map and give
    away where it was. Raises when there is nothing to export at all.
    """
    extent: CoordinateExtent | None = None
    for path in all_path_groups:
        path_extent = CoordinateExtent.of(path) if is_exportable_path(path) else None
        if path_extent is not None:
            extent = path_extent.union(extent)
    if extent is None:
        raise KMLHeatmapError("No flight paths with a determinable year to export")
    return extent


def _export_site(
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    output_file: Path,
    data_dir: Path,
    aircraft_data: dict[str, str] | None = None,
) -> ExportResult:
    """Export the data, render the page and package its assets.

    Everything is staged first and published at the end (see ``SiteOutput``),
    so a failure at any step leaves the previous site in the output as it was.
    """
    all_path_groups, all_path_metadata = _drop_paths_without_year(
        all_path_groups, all_path_metadata
    )
    extent = _map_extent(all_path_groups)

    # Only exported paths contribute airports: a path that gets no id and no
    # segments (a single point, a recording that never moved) would still
    # publish its location and name through the airport list
    exported = [
        (path, metadata)
        for path, metadata in zip(all_path_groups, all_path_metadata, strict=True)
        if is_exportable_path(path)
    ]
    logger.info("\nProcessing %d start points...", len(exported))
    unique_airports = deduplicate_airports(
        [metadata for _, metadata in exported], [path for path, _ in exported]
    )
    logger.info("  Found %d unique airports", len(unique_airports))

    data_dir_name = data_dir.name
    with SiteOutput(output_file.parent, data_dir, SITE_FILES) as site:
        result = export_all_data(
            all_path_groups,
            all_path_metadata,
            unique_airports,
            site.data_stage,
            aircraft_data=aircraft_data,
        )
        _render_html(site.site_stage / output_file.name, data_dir_name)
        _package_assets(site.site_stage, extent.as_map_bounds(), data_dir_name)

        logger.info("\nPublishing the site to %s", output_file.parent)
        site.publish(result.years)

    return result


def _render_html(output_file: Path, data_dir_name: str) -> None:
    """Render and minify the HTML template."""
    logger.info("\nGenerating progressive HTML...")

    tmpl = string.Template(load_template())
    html_content = tmpl.substitute(data_dir_name=html.escape(data_dir_name))

    logger.info("\nMinifying HTML...")
    minified_html = minify_html(html_content)

    atomic_text_write(output_file, minified_html)

    file_size = output_file.stat().st_size
    original_size = len(html_content)
    minified_size = len(minified_html)
    reduction = (1 - minified_size / original_size) * 100

    logger.info(
        "Progressive HTML saved: %s (%.1f KB)", output_file.name, file_size / 1024
    )
    logger.info(
        "  Minification: %.1f KB -> %.1f KB (%.1f%% reduction)",
        original_size / 1024,
        minified_size / 1024,
        reduction,
    )


def _generate_map_config(
    output_dir: Path,
    bounds: dict[str, float],
    data_dir_name: str,
) -> None:
    """Generate minified map_config.js from template."""
    carto_api_key = os.environ.get("CARTO_API_KEY", "")
    openaip_api_key = os.environ.get("OPENAIP_API_KEY", "")

    map_config_template_path = TEMPLATES_DIR / "map_config_template.js"
    map_config_dst = output_dir / "map_config.js"

    with open(map_config_template_path, encoding="utf-8") as f:
        map_config_raw = f.read()

    config_vars = {
        "carto_api_key": _escape_js_string(carto_api_key),
        "openaip_api_key": _escape_js_string(openaip_api_key),
        "data_dir_name": _escape_js_string(data_dir_name),
        "center_lat": str(bounds["center_lat"]),
        "center_lon": str(bounds["center_lon"]),
        "min_lat": str(bounds["min_lat"]),
        "max_lat": str(bounds["max_lat"]),
        "min_lon": str(bounds["min_lon"]),
        "max_lon": str(bounds["max_lon"]),
    }
    map_config_content = string.Template(map_config_raw).substitute(config_vars)
    map_config_minified: str = rjsmin.jsmin(map_config_content)

    atomic_text_write(map_config_dst, map_config_minified)

    map_config_size = map_config_dst.stat().st_size
    logger.info(
        "Configuration generated: %s (%.1f KB)",
        map_config_dst.name,
        map_config_size / 1024,
    )


def _copy_javascript_bundle(output_dir: Path, bundle: Path) -> None:
    """Copy the application bundle (and its source map, if any) to the output."""
    dst = output_dir / bundle.name
    shutil.copy2(bundle, dst)
    logger.info("JavaScript copied: %s (%.1f KB)", dst.name, dst.stat().st_size / 1024)
    source_map = bundle.with_name(f"{bundle.name}.map")
    if source_map.exists():
        shutil.copy2(source_map, output_dir / source_map.name)


def _copy_and_minify_css(output_dir: Path, static_dir: Path) -> None:
    """Copy and minify CSS to output directory."""
    styles_css_src = static_dir / "styles.css"
    styles_css_dst = output_dir / "styles.css"

    with open(styles_css_src, encoding="utf-8") as f:
        styles_css_content = f.read()

    styles_css_minified: str = rcssmin.cssmin(styles_css_content)

    atomic_text_write(styles_css_dst, styles_css_minified)

    styles_css_size = styles_css_dst.stat().st_size
    logger.info("CSS copied: %s (%.1f KB)", styles_css_dst.name, styles_css_size / 1024)


def _copy_favicon_files(output_dir: Path, static_dir: Path) -> None:
    """Copy favicon and manifest files to output directory."""
    for favicon_file in FAVICON_FILES:
        src = static_dir / favicon_file
        if src.exists():
            shutil.copy2(src, output_dir / favicon_file)

    logger.info("Favicon files copied")


def _package_assets(
    output_dir: Path,
    bounds: dict[str, float],
    data_dir_name: str,
) -> None:
    """Generate config and copy static assets (pre-built JS bundles, CSS, icons)."""
    _generate_map_config(output_dir, bounds, data_dir_name)
    _copy_javascript_bundle(output_dir, BUNDLE_FILE)
    _copy_and_minify_css(output_dir, STATIC_DIR)
    _copy_favicon_files(output_dir, STATIC_DIR)


def create_progressive_heatmap(
    kml_files: list[str],
    output_file: str = "index.html",
    data_dir: str = "data",
    aircraft_files: list[Path] | None = None,
) -> bool:
    """Create a progressive-loading heatmap with external data files.

    Returns False (after logging the reason) when the site could not be
    generated; a previous site in the output is then left as it was. No
    exception escapes for the failure modes the pipeline knows about.
    """
    aircraft_files = aircraft_files or []

    # Stage 0: Refuse output directories that overlap with the inputs, a data
    # directory the page could not reach, and a run that could only produce a
    # page without its application
    output_dir = Path(output_file).resolve().parent
    if Path(data_dir).resolve().parent != output_dir:
        logger.error(
            "The data directory %s must be directly inside the output directory "
            "%s, where the page looks for it",
            data_dir,
            output_dir,
        )
        return False
    is_safe, error_msg = validate_output_dir(output_dir, [*kml_files, *aircraft_files])
    if not is_safe:
        logger.error("%s", error_msg)
        return False

    if not BUNDLE_FILE.is_file():
        logger.error(
            "JavaScript bundle not found: %s (run 'npm run build' to generate it)",
            BUNDLE_FILE,
        )
        return False
    _warn_about_a_stale_bundle()

    # Stage 1: Validate and parse. A file that cannot be used fails the run:
    # a site published without one of the flights, and exit status 0, would
    # hide it until someone notices the flight is missing.
    valid_files = []
    for kml_file in kml_files:
        is_valid, error_msg = validate_kml_file(kml_file)
        if not is_valid:
            logger.error("  %s", error_msg)
        else:
            valid_files.append(kml_file)

    if not valid_files:
        logger.error("No valid KML files to process!")
        return False
    if len(valid_files) < len(kml_files):
        logger.error(
            "%d of %d input file(s) are not valid KML files (see above); "
            "fix or remove them",
            len(kml_files) - len(valid_files),
            len(kml_files),
        )
        return False

    logger.info("Parsing %d KML file(s)...", len(valid_files))

    try:
        all_path_groups, all_path_metadata = _parse_kml_files(valid_files)
    except (ValueError, OSError, KMLHeatmapError) as e:
        logger.error(str(e))
        return False

    # Stage 2: Export the data, the page and the assets
    aircraft_data = merge_aircraft_data(aircraft_files) if aircraft_files else None
    try:
        _export_site(
            all_path_groups,
            all_path_metadata,
            Path(output_file),
            Path(data_dir),
            aircraft_data=aircraft_data,
        )
    except (ValueError, RuntimeError, OSError, KMLHeatmapError) as e:
        logger.error("Export failed: %s", e)
        return False

    logger.info(
        "  Open %s in a web browser (works with file:// or serve via HTTP)", output_file
    )

    return True
