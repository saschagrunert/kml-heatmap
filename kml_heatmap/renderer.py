"""HTML generation, rendering, and pipeline orchestration."""

import json
import logging
import os
import re
import shutil
import string
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path
from typing import Any

import minify_html as mh
import rcssmin
import rjsmin

from .aircraft import merge_aircraft_data
from .airports import deduplicate_airports, extract_airport_name
from .data_exporter import export_all_data
from .exceptions import KMLHeatmapError, KMLParseError
from .helpers import numeric_filename_key
from .logger import logger
from .parser import parse_kml_coordinates
from .parser_common import is_mid_flight_start, is_valid_landing
from .statistics import calculate_statistics
from .types import AirportData, FlightPath, FlightPathGroup, PathMetadata
from .validation import validate_kml_file, validate_output_dir
from .workers import init_worker

ParseResult = tuple[FlightPath, FlightPathGroup, list[PathMetadata]]


def _escape_js_string(value: str) -> str:
    """Escape a value for safe embedding in a single-quoted JS string."""
    escaped: str = json.dumps(value)
    return escaped[1:-1].replace("'", "\\'")


def load_template() -> str:
    """Load the HTML template from file."""
    template_path = Path(__file__).parent / "templates" / "map_template.html"
    with open(template_path, encoding="utf-8") as f:
        return f.read()


def minify_html(html: str) -> str:
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

    html = re.sub(r"<style>(.*?)</style>", minify_css_tags, html, flags=re.DOTALL)
    html = re.sub(r"<script>(.*?)</script>", minify_js_tags, html, flags=re.DOTALL)

    minified: str = mh.minify(html)
    return minified


def _parse_with_error_handling(kml_file: str) -> tuple[str, ParseResult]:
    """Parse a KML file with error handling."""
    try:
        return kml_file, parse_kml_coordinates(kml_file)
    except (OSError, ValueError, TypeError, KMLParseError) as e:
        logger.error("Error processing %s: %s", kml_file, e)
        return kml_file, ([], [], [])


def _parse_kml_files(valid_files: list[str]) -> ParseResult:
    """Parse KML files in parallel and merge results."""
    parse_start = time.time()

    results: list[tuple[str, FlightPath, FlightPathGroup, list[PathMetadata]]] = []
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
                kml_file, (coords, path_groups, path_metadata) = future.result()
            except BrokenProcessPool as e:
                raise KMLHeatmapError(
                    "A parser worker process crashed; run with --debug for details"
                ) from e
            except Exception:
                kml_file = future_to_file[future]
                logger.exception("Unexpected error processing %s", kml_file)
                coords, path_groups, path_metadata = [], [], []
            results.append((kml_file, coords, path_groups, path_metadata))
            completed_count += 1
            logger.info(
                "  [%d/%d] %.0f%% - %s",
                completed_count,
                len(valid_files),
                (completed_count / len(valid_files)) * 100,
                Path(kml_file).name,
            )

    results.sort(key=lambda r: numeric_filename_key(r[0]))
    failed_count = sum(1 for _, coords, _, _ in results if not coords)
    if failed_count > 0:
        logger.warning(
            "  %d of %d file(s) failed to parse", failed_count, len(valid_files)
        )

    all_coordinates: FlightPath = []
    all_path_groups: FlightPathGroup = []
    all_path_metadata: list[PathMetadata] = []
    for _, coords, path_groups, path_metadata in results:
        all_coordinates.extend(coords)
        all_path_groups.extend(path_groups)
        all_path_metadata.extend(path_metadata)

    parse_time = time.time() - parse_start
    logger.info(
        "  Parsing took %.1fs (%.2fs per file)",
        parse_time,
        parse_time / len(valid_files),
    )

    if not all_coordinates:
        raise ValueError("No coordinates found in any KML files!")

    logger.info("\nTotal points: %d", len(all_coordinates))
    return all_coordinates, all_path_groups, all_path_metadata


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
    all_coordinates: FlightPath,
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    data_dir: str,
    aircraft_data: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Process parsed data: deduplicate airports, calculate stats, export files."""
    min_lat = min_lon = float("inf")
    max_lat = max_lon = float("-inf")
    for point in all_coordinates:
        min_lat = min(min_lat, point.lat)
        max_lat = max(max_lat, point.lat)
        min_lon = min(min_lon, point.lon)
        max_lon = max(max_lon, point.lon)
    bounds = {
        "min_lat": min_lat,
        "max_lat": max_lat,
        "min_lon": min_lon,
        "max_lon": max_lon,
        "center_lat": (min_lat + max_lat) / 2,
        "center_lon": (min_lon + max_lon) / 2,
    }

    all_path_groups, all_path_metadata = _drop_paths_without_year(
        all_path_groups, all_path_metadata
    )

    unique_airports: list[AirportData] = []
    if all_path_metadata:
        logger.info("\nProcessing %d start points...", len(all_path_metadata))
        unique_airports = deduplicate_airports(
            all_path_metadata, all_path_groups, is_mid_flight_start, is_valid_landing
        )
        logger.info("  Found %d unique airports", len(unique_airports))

    logger.info("\nCalculating statistics...")
    stats = calculate_statistics(all_path_metadata, aircraft_data=aircraft_data)

    valid_airport_names = []
    for airport in unique_airports:
        full_name = airport.get("name") or "Unknown"
        is_at_path_end = airport.get("is_at_path_end", False)
        airport_name = extract_airport_name(full_name, is_at_path_end)
        if airport_name:
            valid_airport_names.append(airport_name)

    stats["num_airports"] = len(valid_airport_names)
    stats["airport_names"] = sorted(valid_airport_names)

    export_all_data(
        all_path_groups,
        all_path_metadata,
        unique_airports,
        stats,
        data_dir,
    )

    return {
        "stats": stats,
        "bounds": bounds,
    }


def _render_html(output_file: str, data_dir_name: str) -> None:
    """Render and minify the HTML template."""
    logger.info("\nGenerating progressive HTML...")

    tmpl = string.Template(load_template())
    html_content = tmpl.substitute(data_dir_name=data_dir_name)

    logger.info("\nMinifying HTML...")
    minified_html = minify_html(html_content)

    with open(output_file, "w", encoding="utf-8") as f:
        f.write(minified_html)

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

    with open(map_config_dst, "w", encoding="utf-8") as f:
        f.write(map_config_minified)

    map_config_size = map_config_dst.stat().st_size
    logger.info(
        "Configuration generated: %s (%.1f KB)", map_config_dst, map_config_size / 1024
    )


def _copy_javascript_bundles(output_dir: str, static_dir: Path) -> None:
    """Copy JavaScript bundle files to output directory."""
    for bundle_name in ("bundle.js", "mapApp.bundle.js"):
        src = static_dir / bundle_name
        dst = Path(output_dir) / bundle_name
        if src.exists():
            shutil.copy2(src, dst)
            size = dst.stat().st_size
            logger.info("JavaScript copied: %s (%.1f KB)", dst, size / 1024)
            source_map = static_dir / f"{bundle_name}.map"
            if source_map.exists():
                shutil.copy2(source_map, Path(output_dir) / source_map.name)
        else:
            logger.warning("%s not found - run npm build to generate it", bundle_name)


def _copy_and_minify_css(output_dir: str, static_dir: Path) -> None:
    """Copy and minify CSS to output directory."""
    styles_css_src = static_dir / "styles.css"
    styles_css_dst = Path(output_dir) / "styles.css"

    with open(styles_css_src, encoding="utf-8") as f:
        styles_css_content = f.read()

    styles_css_minified: str = rcssmin.cssmin(styles_css_content)

    with open(styles_css_dst, "w", encoding="utf-8") as f:
        f.write(styles_css_minified)

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

    if not (
        (static_dir / "bundle.js").exists()
        and (static_dir / "mapApp.bundle.js").exists()
    ):
        logger.warning(
            "JavaScript bundles not found - run 'npm run build' to generate them"
        )
    else:
        logger.info("\nUsing pre-built JavaScript bundles...")

    _generate_map_config(output_dir, templates_dir, bounds, data_dir_name)
    _copy_javascript_bundles(output_dir, static_dir)
    _copy_and_minify_css(output_dir, static_dir)
    _copy_favicon_files(output_dir, static_dir)


def create_progressive_heatmap(
    kml_files: list[str],
    output_file: str = "index.html",
    data_dir: str = "data",
    aircraft_files: list[Path] | None = None,
) -> bool:
    """Create a progressive-loading heatmap with external data files."""
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
        all_coordinates, all_path_groups, all_path_metadata = _parse_kml_files(
            valid_files
        )
    except (ValueError, KMLHeatmapError) as e:
        logger.error(str(e))
        return False

    # Stage 2: Process data
    aircraft_data = merge_aircraft_data(aircraft_files) if aircraft_files else None
    result = _process_data(
        all_coordinates,
        all_path_groups,
        all_path_metadata,
        data_dir,
        aircraft_data=aircraft_data,
    )

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
