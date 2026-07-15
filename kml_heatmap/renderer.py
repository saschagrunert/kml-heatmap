"""HTML generation, rendering, and pipeline orchestration."""

import os
import re
import shutil
import string
import subprocess
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import rcssmin
import rjsmin
import minify_html as mh

from .airports import deduplicate_airports, extract_airport_name
from .data_exporter import export_all_data
from .helpers import numeric_filename_key
from .logger import logger
from .parser import parse_kml_coordinates
from .parser_common import is_mid_flight_start, is_valid_landing
from .statistics import calculate_statistics
from .types import AirportData, PathMetadata
from .validation import validate_kml_file


def load_template() -> str:
    """Load the HTML template from file."""
    template_path = Path(__file__).parent / "templates" / "map_template.html"
    with open(template_path, "r") as f:
        return f.read()


def minify_html(html: str) -> str:
    """Minify HTML, CSS, and JavaScript using specialized minification libraries."""

    # First, minify inline CSS and JavaScript
    def minify_css_tags(match: re.Match[str]) -> str:
        """Minify CSS content within style tags using rcssmin."""
        css_content = match.group(1)
        minified_css: str = rcssmin.cssmin(css_content)
        return f"<style>{minified_css}</style>"

    def minify_js_tags(match: re.Match[str]) -> str:
        """Minify JavaScript content within script tags using rjsmin."""
        js_content = match.group(1)
        minified_js: str = rjsmin.jsmin(js_content)
        # rjsmin preserves some newlines for ASI (Automatic Semicolon Insertion) safety.
        # Since our generated code uses explicit semicolons, we can safely remove
        # remaining newlines. Replace with space to maintain token separation where needed.
        minified_js = re.sub(r"\s*\n\s*", "", minified_js)
        return f"<script>{minified_js}</script>"

    # Minify inline CSS
    html = re.sub(r"<style>(.*?)</style>", minify_css_tags, html, flags=re.DOTALL)

    # Minify inline JavaScript (not script tags with src attribute)
    html = re.sub(r"<script>(.*?)</script>", minify_js_tags, html, flags=re.DOTALL)

    # Use minify-html for HTML minification
    minified: str = mh.minify(html)

    return minified


def _parse_with_error_handling(
    kml_file: str,
) -> tuple[str, tuple[list[list[float]], list[list[list[float]]], list[PathMetadata]]]:
    """Parse a KML file with error handling."""
    try:
        return kml_file, parse_kml_coordinates(kml_file)
    except (OSError, ValueError, TypeError, AttributeError) as e:
        logger.error(f"Error processing {kml_file}: {e}")
        return kml_file, ([], [], [])


def _build_javascript_bundle() -> bool:
    """Build the JavaScript bundle using npm."""
    try:
        project_root = Path(__file__).parent.parent
        package_json = project_root / "package.json"
        if not package_json.exists():
            logger.warning("package.json not found - skipping JavaScript build")
            return False

        node_modules = project_root / "node_modules"
        if not node_modules.exists():
            logger.info("Installing Node.js dependencies...")
            result = subprocess.run(
                ["npm", "install"],
                cwd=project_root,
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result.returncode != 0:
                logger.error(f"npm install failed: {result.stderr}")
                return False

        logger.info("Building JavaScript bundle...")
        result = subprocess.run(
            ["npm", "run", "build"],
            cwd=project_root,
            capture_output=True,
            text=True,
            timeout=60,
        )

        if result.returncode != 0:
            logger.error(f"JavaScript build failed: {result.stderr}")
            return False

        logger.info("JavaScript bundle built successfully")
        return True

    except FileNotFoundError:
        logger.warning("npm not found - skipping JavaScript build")
        return False
    except subprocess.TimeoutExpired:
        logger.error("JavaScript build timed out")
        return False
    except (OSError, ValueError, RuntimeError) as e:
        logger.error(f"JavaScript build error: {e}")
        return False


def _parse_kml_files(
    valid_files: list[str],
) -> tuple[list[list[float]], list[list[list[float]]], list[PathMetadata]]:
    """Parse KML files in parallel and merge results."""
    from .airport_lookup import _load_airport_database

    _load_airport_database()

    parse_start = time.time()

    all_coordinates: list[list[float]] = []
    all_path_groups: list[list[list[float]]] = []
    all_path_metadata: list[PathMetadata] = []

    results: list[
        tuple[str, list[list[float]], list[list[list[float]]], list[PathMetadata]]
    ] = []
    completed_count = 0
    with ProcessPoolExecutor(
        max_workers=min(len(valid_files), os.cpu_count() or 4)
    ) as executor:
        future_to_file = {
            executor.submit(_parse_with_error_handling, f): f for f in valid_files
        }
        for future in as_completed(future_to_file):
            kml_file, (coords, path_groups, path_metadata) = future.result()
            results.append((kml_file, coords, path_groups, path_metadata))
            completed_count += 1
            progress_pct = (completed_count / len(valid_files)) * 100
            logger.info(
                f"  [{completed_count}/{len(valid_files)}] {progress_pct:.0f}% - {Path(kml_file).name}"
            )

    results.sort(key=lambda r: numeric_filename_key(r[0]))
    for _, coords, path_groups, path_metadata in results:
        all_coordinates.extend(coords)
        all_path_groups.extend(path_groups)
        all_path_metadata.extend(path_metadata)

    parse_time = time.time() - parse_start
    logger.info(
        f"  Parsing took {parse_time:.1f}s ({parse_time / len(valid_files):.2f}s per file)"
    )

    if not all_coordinates:
        raise ValueError("No coordinates found in any KML files!")

    logger.info(f"\nTotal points: {len(all_coordinates)}")
    return all_coordinates, all_path_groups, all_path_metadata


def _process_data(
    all_coordinates: list[list[float]],
    all_path_groups: list[list[list[float]]],
    all_path_metadata: list[PathMetadata],
    data_dir: str,
    aircraft_file: Path | None = None,
) -> dict[str, Any]:
    """Process parsed data: deduplicate airports, calculate stats, export files."""
    lats = [coord[0] for coord in all_coordinates]
    lons = [coord[1] for coord in all_coordinates]
    bounds = {
        "min_lat": min(lats),
        "max_lat": max(lats),
        "min_lon": min(lons),
        "max_lon": max(lons),
        "center_lat": (min(lats) + max(lats)) / 2,
        "center_lon": (min(lons) + max(lons)) / 2,
    }

    unique_airports: list[AirportData] = []
    if all_path_metadata:
        logger.info(f"\nProcessing {len(all_path_metadata)} start points...")
        unique_airports = deduplicate_airports(
            all_path_metadata, all_path_groups, is_mid_flight_start, is_valid_landing
        )
        logger.info(f"  Found {len(unique_airports)} unique airports")

    logger.info("\nCalculating statistics...")
    stats = calculate_statistics(
        all_coordinates, all_path_groups, all_path_metadata, aircraft_file=aircraft_file
    )

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
        all_coordinates,
        all_path_groups,
        all_path_metadata,
        unique_airports,
        stats,
        data_dir,
        strip_timestamps=True,
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

    with open(output_file, "w") as f:
        f.write(minified_html)

    file_size = Path(output_file).stat().st_size
    original_size = len(html_content)
    minified_size = len(minified_html)
    reduction = (1 - minified_size / original_size) * 100

    logger.info(f"Progressive HTML saved: {output_file} ({file_size / 1024:.1f} KB)")
    logger.info(
        f"  Minification: {original_size / 1024:.1f} KB -> {minified_size / 1024:.1f} KB ({reduction:.1f}% reduction)"
    )


def _generate_map_config(
    output_dir: str,
    templates_dir: Path,
    bounds: dict[str, float],
    data_dir_name: str,
) -> None:
    """Generate minified map_config.js from template."""
    stadia_api_key = os.environ.get("STADIA_API_KEY", "")
    openaip_api_key = os.environ.get("OPENAIP_API_KEY", "")

    map_config_template_path = templates_dir / "map_config_template.js"
    map_config_dst = Path(output_dir) / "map_config.js"

    with open(map_config_template_path, "r") as f:
        map_config_raw = f.read()

    config_vars = {
        "stadia_api_key": stadia_api_key,
        "openaip_api_key": openaip_api_key,
        "data_dir_name": data_dir_name,
        "center_lat": str(bounds["center_lat"]),
        "center_lon": str(bounds["center_lon"]),
        "min_lat": str(bounds["min_lat"]),
        "max_lat": str(bounds["max_lat"]),
        "min_lon": str(bounds["min_lon"]),
        "max_lon": str(bounds["max_lon"]),
    }
    map_config_content = string.Template(map_config_raw).substitute(config_vars)
    map_config_minified: str = rjsmin.jsmin(map_config_content)

    with open(map_config_dst, "w") as f:
        f.write(map_config_minified)

    map_config_size = map_config_dst.stat().st_size
    logger.info(
        f"Configuration generated: {map_config_dst} ({map_config_size / 1024:.1f} KB)"
    )


def _copy_javascript_bundles(output_dir: str, static_dir: Path) -> None:
    """Copy JavaScript bundle files to output directory."""
    for bundle_name in ("bundle.js", "mapApp.bundle.js"):
        src = static_dir / bundle_name
        dst = Path(output_dir) / bundle_name
        if src.exists():
            shutil.copy2(src, dst)
            size = dst.stat().st_size
            logger.info(f"JavaScript copied: {dst} ({size / 1024:.1f} KB)")
        else:
            logger.warning(f"{bundle_name} not found - run npm build to generate it")


def _copy_and_minify_css(output_dir: str, static_dir: Path) -> None:
    """Copy and minify CSS to output directory."""
    styles_css_src = static_dir / "styles.css"
    styles_css_dst = Path(output_dir) / "styles.css"

    with open(styles_css_src, "r") as f:
        styles_css_content = f.read()

    styles_css_minified: str = rcssmin.cssmin(styles_css_content)

    with open(styles_css_dst, "w") as f:
        f.write(styles_css_minified)

    styles_css_size = styles_css_dst.stat().st_size
    logger.info(f"CSS copied: {styles_css_dst} ({styles_css_size / 1024:.1f} KB)")


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

    logger.info(f"Favicon files copied to {output_dir}")


def _package_assets(
    output_dir: str,
    bounds: dict[str, float],
    data_dir_name: str,
) -> None:
    """Build JS bundles (if needed), generate config, and copy static assets."""
    static_dir = Path(__file__).parent / "static"
    templates_dir = Path(__file__).parent / "templates"

    if not (
        (static_dir / "bundle.js").exists()
        and (static_dir / "mapApp.bundle.js").exists()
    ):
        logger.info("\nBuilding JavaScript modules...")
        _build_javascript_bundle()
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
    aircraft_file: Path | None = None,
) -> bool:
    """Create a progressive-loading heatmap with external data files."""
    # Stage 1: Validate and parse
    valid_files = []
    for kml_file in kml_files:
        is_valid, error_msg = validate_kml_file(kml_file)
        if not is_valid:
            logger.error(f"  {error_msg}")
        else:
            valid_files.append(kml_file)

    if not valid_files:
        logger.error("No valid KML files to process!")
        return False

    logger.info(f"Parsing {len(valid_files)} KML file(s)...")

    try:
        all_coordinates, all_path_groups, all_path_metadata = _parse_kml_files(
            valid_files
        )
    except ValueError as e:
        logger.error(str(e))
        return False

    # Stage 2: Process data
    result = _process_data(
        all_coordinates,
        all_path_groups,
        all_path_metadata,
        data_dir,
        aircraft_file=aircraft_file,
    )

    # Stage 3: Render HTML
    data_dir_name = Path(data_dir).name
    _render_html(output_file, data_dir_name)

    # Stage 4: Package assets
    output_dir = str(Path(output_file).parent)
    _package_assets(output_dir, result["bounds"], data_dir_name)

    logger.info(
        f"  Open {output_file} in a web browser (works with file:// or serve via HTTP)"
    )

    return True
