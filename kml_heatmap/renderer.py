"""HTML generation, rendering, and pipeline orchestration."""

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
from typing import TYPE_CHECKING, Any

import minify_html as mh
import rcssmin
import rjsmin

from .aircraft import merge_aircraft_data
from .airport_lookup import load_airport_database
from .airports import deduplicate_airports
from .cache import atomic_text_write
from .data_exporter import export_all_data
from .exceptions import KMLHeatmapError, KMLParseError
from .logger import logger
from .parser import parse_kml_coordinates
from .parser_cache import prune_stale_cache_entries
from .validation import validate_kml_file, validate_output_dir
from .workers import init_worker

if TYPE_CHECKING:
    from .types import AirportData, FlightPath, FlightPathGroup, PathMetadata

__all__ = [
    "CoordinateExtent",
    "ParsedFile",
    "create_progressive_heatmap",
    "load_template",
    "minify_html",
]


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
    needs its extent and size, which keeps the data crossing the process
    boundary (and held in the parent) to the flight paths themselves.
    """

    kml_file: str
    extent: CoordinateExtent | None = None
    point_count: int = 0
    path_groups: FlightPathGroup = field(default_factory=list)
    path_metadata: list[PathMetadata] = field(default_factory=list)


def _escape_js_string(value: str) -> str:
    """Escape a value for safe embedding in a single-quoted JS string."""
    escaped: str = json.dumps(value)
    return escaped[1:-1].replace("'", "\\'")


def load_template() -> str:
    """Load the HTML template from file."""
    template_path = Path(__file__).parent / "templates" / "map_template.html"
    with open(template_path, encoding="utf-8") as f:
        return f.read()


def minify_html(html_content: str) -> str:
    """Minify HTML, CSS, and JavaScript using specialized minification libraries."""

    def minify_css_tags(match: re.Match[str]) -> str:
        """Minify CSS content within style tags using rcssmin."""
        minified_css: str = rcssmin.cssmin(match.group(1))
        return f"<style>{minified_css}</style>"

    def minify_js_tags(match: re.Match[str]) -> str:
        """Minify JavaScript content within script tags using rjsmin."""
        minified_js: str = rjsmin.jsmin(match.group(1))
        # rjsmin preserves newlines for ASI safety. Our code uses explicit
        # semicolons, so we can remove remaining newlines safely.
        minified_js = re.sub(r"\s*\n\s*", "", minified_js)
        return f"<script>{minified_js}</script>"

    # Deliberately only attribute-less tags: a pattern such as `<script[^>]*>`
    # would also match `<script src="..." defer>`, whose body is empty, and the
    # replacement would drop the attributes and with them the referenced file.
    html_content = re.sub(
        r"<style>(.*?)</style>", minify_css_tags, html_content, flags=re.DOTALL
    )
    html_content = re.sub(
        r"<script>(.*?)</script>", minify_js_tags, html_content, flags=re.DOTALL
    )

    minified: str = mh.minify(html_content)
    return minified


def _parse_with_error_handling(kml_file: str) -> ParsedFile:
    """Parse a KML file in a worker and reduce the result for the parent."""
    try:
        coordinates, path_groups, path_metadata = parse_kml_coordinates(kml_file)
    except (OSError, ValueError, TypeError, KMLParseError) as e:
        logger.error("Error processing %s: %s", kml_file, e)
        return ParsedFile(kml_file)
    return ParsedFile(
        kml_file,
        CoordinateExtent.of(coordinates),
        len(coordinates),
        path_groups,
        path_metadata,
    )


def _parse_kml_files(
    valid_files: list[str],
) -> tuple[CoordinateExtent, FlightPathGroup, list[PathMetadata]]:
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
    prune_stale_cache_entries(valid_files)

    results: list[ParsedFile] = []
    completed_count = 0
    debug = logger.isEnabledFor(logging.DEBUG)
    with ProcessPoolExecutor(
        max_workers=max(1, min(len(valid_files), os.cpu_count() or 4)),
        initializer=init_worker,
        initargs=(debug,),
    ) as executor:
        future_to_file = {
            executor.submit(_parse_with_error_handling, f): f for f in valid_files
        }
        for future in as_completed(future_to_file):
            try:
                parsed = future.result()
            except BrokenProcessPool as e:
                raise KMLHeatmapError(
                    "A parser worker process crashed; run with --debug for details"
                ) from e
            except Exception:
                kml_file = future_to_file[future]
                logger.exception("Unexpected error processing %s", kml_file)
                parsed = ParsedFile(kml_file)
            results.append(parsed)
            completed_count += 1
            logger.info(
                "  [%d/%d] %.0f%% - %s",
                completed_count,
                len(valid_files),
                (completed_count / len(valid_files)) * 100,
                Path(parsed.kml_file).name,
            )

    input_order = {kml_file: index for index, kml_file in enumerate(valid_files)}
    results.sort(key=lambda parsed: input_order[parsed.kml_file])
    failed_count = sum(1 for parsed in results if parsed.point_count == 0)
    if failed_count > 0:
        logger.warning(
            "  %d of %d file(s) failed to parse", failed_count, len(valid_files)
        )

    extent: CoordinateExtent | None = None
    total_points = 0
    all_path_groups: FlightPathGroup = []
    all_path_metadata: list[PathMetadata] = []
    for parsed in results:
        if parsed.extent is not None:
            extent = parsed.extent.union(extent)
        total_points += parsed.point_count
        all_path_groups.extend(parsed.path_groups)
        all_path_metadata.extend(parsed.path_metadata)

    parse_time = time.time() - parse_start
    logger.info(
        "  Parsing took %.1fs (%.2fs per file)",
        parse_time,
        parse_time / len(valid_files),
    )

    if extent is None:
        raise KMLHeatmapError("No coordinates found in any KML files!")

    logger.info("\nTotal points: %d", total_points)
    return extent, all_path_groups, all_path_metadata


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


def _process_data(
    extent: CoordinateExtent,
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    data_dir: str,
    aircraft_data: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Process parsed data: deduplicate airports, export files, build stats."""
    all_path_groups, all_path_metadata = _drop_paths_without_year(
        all_path_groups, all_path_metadata
    )

    unique_airports: list[AirportData] = []
    if all_path_metadata:
        logger.info("\nProcessing %d start points...", len(all_path_metadata))
        unique_airports = deduplicate_airports(all_path_metadata, all_path_groups)
        logger.info("  Found %d unique airports", len(unique_airports))

    result = export_all_data(
        all_path_groups,
        all_path_metadata,
        unique_airports,
        data_dir,
        aircraft_data=aircraft_data,
    )

    return {
        "stats": result.stats,
        "bounds": extent.as_map_bounds(),
    }


def _render_html(output_file: str, data_dir_name: str) -> None:
    """Render and minify the HTML template."""
    logger.info("\nGenerating progressive HTML...")

    tmpl = string.Template(load_template())
    html_content = tmpl.substitute(data_dir_name=html.escape(data_dir_name))

    logger.info("\nMinifying HTML...")
    minified_html = minify_html(html_content)

    atomic_text_write(Path(output_file), minified_html)

    file_size = Path(output_file).stat().st_size
    original_size = len(html_content)
    minified_size = len(minified_html)
    reduction = (1 - minified_size / original_size) * 100

    logger.info("Progressive HTML saved: %s (%.1f KB)", output_file, file_size / 1024)
    logger.info(
        "  Minification: %.1f KB -> %.1f KB (%.1f%% reduction)",
        original_size / 1024,
        minified_size / 1024,
        reduction,
    )


def _generate_map_config(
    output_dir: str,
    templates_dir: Path,
    bounds: dict[str, float],
    data_dir_name: str,
) -> None:
    """Generate minified map_config.js from template."""
    carto_api_key = os.environ.get("CARTO_API_KEY", "")
    openaip_api_key = os.environ.get("OPENAIP_API_KEY", "")

    map_config_template_path = templates_dir / "map_config_template.js"
    map_config_dst = Path(output_dir) / "map_config.js"

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
        "Configuration generated: %s (%.1f KB)", map_config_dst, map_config_size / 1024
    )


def _copy_javascript_bundle(output_dir: str, static_dir: Path) -> None:
    """Copy the application bundle (and its source map) to the output."""
    bundle_name = "mapApp.bundle.js"
    src = static_dir / bundle_name
    dst = Path(output_dir) / bundle_name
    if not src.exists():
        logger.warning("%s not found - run npm build to generate it", bundle_name)
        return

    shutil.copy2(src, dst)
    logger.info("JavaScript copied: %s (%.1f KB)", dst, dst.stat().st_size / 1024)
    source_map = static_dir / f"{bundle_name}.map"
    if source_map.exists():
        shutil.copy2(source_map, Path(output_dir) / source_map.name)


def _copy_and_minify_css(output_dir: str, static_dir: Path) -> None:
    """Copy and minify CSS to output directory."""
    styles_css_src = static_dir / "styles.css"
    styles_css_dst = Path(output_dir) / "styles.css"

    with open(styles_css_src, encoding="utf-8") as f:
        styles_css_content = f.read()

    styles_css_minified: str = rcssmin.cssmin(styles_css_content)

    atomic_text_write(styles_css_dst, styles_css_minified)

    styles_css_size = styles_css_dst.stat().st_size
    logger.info("CSS copied: %s (%.1f KB)", styles_css_dst, styles_css_size / 1024)


def _copy_favicon_files(output_dir: str, static_dir: Path) -> None:
    """Copy favicon and manifest files to output directory."""
    for favicon_file in (
        "favicon.svg",
        "favicon.ico",
        "favicon-192.png",
        "favicon-512.png",
        "apple-touch-icon.png",
        "manifest.json",
    ):
        src = static_dir / favicon_file
        dst = Path(output_dir) / favicon_file
        if src.exists():
            shutil.copy2(src, dst)

    logger.info("Favicon files copied to %s", output_dir)


def _package_assets(
    output_dir: str,
    bounds: dict[str, float],
    data_dir_name: str,
) -> None:
    """Generate config and copy static assets (pre-built JS bundles, CSS, icons)."""
    static_dir = Path(__file__).parent / "static"
    templates_dir = Path(__file__).parent / "templates"

    if (static_dir / "mapApp.bundle.js").exists():
        logger.info("\nUsing the pre-built JavaScript bundle...")
    else:
        logger.warning(
            "JavaScript bundle not found - run 'npm run build' to generate it"
        )

    _generate_map_config(output_dir, templates_dir, bounds, data_dir_name)
    _copy_javascript_bundle(output_dir, static_dir)
    _copy_and_minify_css(output_dir, static_dir)
    _copy_favicon_files(output_dir, static_dir)


def create_progressive_heatmap(
    kml_files: list[str],
    output_file: str = "index.html",
    data_dir: str = "data",
    aircraft_files: list[Path] | None = None,
) -> bool:
    """Create a progressive-loading heatmap with external data files.

    Returns False (after logging the reason) when nothing could be generated;
    no exception escapes for the failure modes the pipeline knows about.
    """
    aircraft_files = aircraft_files or []

    # Stage 0: Refuse output directories that overlap with the inputs
    is_safe, error_msg = validate_output_dir(data_dir, [*kml_files, *aircraft_files])
    if not is_safe:
        logger.error("%s", error_msg)
        return False

    # Stage 1: Validate and parse
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

    logger.info("Parsing %d KML file(s)...", len(valid_files))

    try:
        extent, all_path_groups, all_path_metadata = _parse_kml_files(valid_files)
    except (ValueError, KMLHeatmapError) as e:
        logger.error(str(e))
        return False

    # Stage 2: Process data
    aircraft_data = merge_aircraft_data(aircraft_files) if aircraft_files else None
    try:
        result = _process_data(
            extent,
            all_path_groups,
            all_path_metadata,
            data_dir,
            aircraft_data=aircraft_data,
        )
    except (ValueError, RuntimeError, OSError) as e:
        logger.error("Export failed: %s", e)
        return False

    # Stage 3: Render HTML
    data_dir_name = Path(data_dir).name
    _render_html(output_file, data_dir_name)

    # Stage 4: Package assets
    output_dir = str(Path(output_file).parent)
    _package_assets(output_dir, result["bounds"], data_dir_name)

    logger.info(
        "  Open %s in a web browser (works with file:// or serve via HTTP)", output_file
    )

    return True
