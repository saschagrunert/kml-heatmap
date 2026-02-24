"""HTML generation, rendering, and pipeline orchestration."""

import os
import re
import shutil
import string
import subprocess
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, Any, List

import rcssmin
import rjsmin
import minify_html as mh

from .airports import deduplicate_airports, extract_airport_name
from .data_exporter import export_all_data
from .logger import logger
from .parser import parse_kml_coordinates, is_mid_flight_start, is_valid_landing
from .statistics import calculate_statistics
from .validation import validate_kml_file


def load_template() -> str:
    """Load the HTML template from file.

    Returns:
        HTML template content as string
    """
    template_path = Path(__file__).parent / "templates" / "map_template.html"
    with open(template_path, "r") as f:
        return f.read()


def minify_html(html: str) -> str:
    """
    Minify HTML, CSS, and JavaScript using specialized minification libraries.

    Args:
        html: HTML string to minify

    Returns:
        Minified HTML string
    """

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
) -> tuple[
    str, tuple[list[list[float]], list[list[list[float]]], list[Dict[str, Any]]]
]:
    """Parse a KML file with error handling.

    Args:
        kml_file: Path to KML file

    Returns:
        Tuple of (kml_file, (coordinates, path_groups, path_metadata))
    """
    try:
        return kml_file, parse_kml_coordinates(kml_file)
    except (OSError, ValueError, TypeError, AttributeError) as e:
        logger.error(f"Error processing {kml_file}: {e}")
        return kml_file, ([], [], [])


def _build_javascript_bundle() -> bool:
    """
    Build the JavaScript bundle using npm.

    Returns:
        True if build succeeded, False otherwise
    """
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
    valid_files: List[str],
) -> tuple[List[List[float]], List[List[List[float]]], List[Dict[str, Any]]]:
    """Parse KML files in parallel and merge results.

    Args:
        valid_files: List of validated KML file paths.

    Returns:
        Tuple of (all_coordinates, all_path_groups, all_path_metadata).

    Raises:
        ValueError: If no coordinates are found in any file.
    """
    from .airport_lookup import _load_airport_database

    _load_airport_database()

    parse_start = time.time()

    all_coordinates: List[List[float]] = []
    all_path_groups: List[List[List[float]]] = []
    all_path_metadata: List[Dict[str, Any]] = []

    results: List[
        tuple[str, List[List[float]], List[List[List[float]]], List[Dict[str, Any]]]
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

    results.sort(key=lambda x: x[0])
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
    all_coordinates: List[List[float]],
    all_path_groups: List[List[List[float]]],
    all_path_metadata: List[Dict[str, Any]],
    data_dir: str,
) -> Dict[str, Any]:
    """Process parsed data: deduplicate airports, calculate stats, export files.

    Args:
        all_coordinates: Merged coordinates from all KML files.
        all_path_groups: Merged path groups.
        all_path_metadata: Merged path metadata.
        data_dir: Directory to save data files.

    Returns:
        Dict with keys: stats, unique_airports, bounds, metadata_params,
        full_res_segments, full_res_path_info.
    """
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

    unique_airports: List[Dict[str, Any]] = []
    if all_path_metadata:
        logger.info(f"\nProcessing {len(all_path_metadata)} start points...")
        unique_airports = deduplicate_airports(
            all_path_metadata, all_path_groups, is_mid_flight_start, is_valid_landing
        )
        logger.info(f"  Found {len(unique_airports)} unique airports")

    logger.info("\nCalculating statistics...")
    stats = calculate_statistics(all_coordinates, all_path_groups, all_path_metadata)

    valid_airport_names = []
    for airport in unique_airports:
        full_name = airport.get("name", "Unknown")
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
    """Render and minify the HTML template.

    Args:
        output_file: Path to write the output HTML.
        data_dir_name: Base name of the data directory.
    """
    logger.info("\nGenerating progressive HTML...")

    tmpl = string.Template(load_template())
    html_content = tmpl.substitute(data_dir_name=data_dir_name)

    logger.info("\nMinifying HTML...")
    minified_html = minify_html(html_content)

    with open(output_file, "w") as f:
        f.write(minified_html)

    file_size = os.path.getsize(output_file)
    original_size = len(html_content)
    minified_size = len(minified_html)
    reduction = (1 - minified_size / original_size) * 100

    logger.info(f"Progressive HTML saved: {output_file} ({file_size / 1024:.1f} KB)")
    logger.info(
        f"  Minification: {original_size / 1024:.1f} KB -> {minified_size / 1024:.1f} KB ({reduction:.1f}% reduction)"
    )


def _package_assets(
    output_dir: str,
    bounds: Dict[str, float],
    data_dir_name: str,
) -> None:
    """Build JS bundles (if needed), generate config, and copy static assets.

    Args:
        output_dir: Directory to write output files.
        bounds: Dict with min_lat, max_lat, min_lon, max_lon, center_lat, center_lon.
        data_dir_name: Base name of the data directory.
    """
    static_dir = Path(__file__).parent / "static"
    templates_dir = Path(__file__).parent / "templates"

    stadia_api_key = os.environ.get("STADIA_API_KEY", "")
    openaip_api_key = os.environ.get("OPENAIP_API_KEY", "")

    # Build JavaScript bundles if needed
    if not (
        (static_dir / "bundle.js").exists()
        and (static_dir / "mapApp.bundle.js").exists()
    ):
        logger.info("\nBuilding JavaScript modules...")
        _build_javascript_bundle()
    else:
        logger.info("\nUsing pre-built JavaScript bundles...")

    # Generate map_config.js
    map_config_template_path = templates_dir / "map_config_template.js"
    map_config_dst = os.path.join(output_dir, "map_config.js")

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

    map_config_size = os.path.getsize(map_config_dst)
    logger.info(
        f"Configuration generated: {map_config_dst} ({map_config_size / 1024:.1f} KB)"
    )

    # Copy JavaScript bundles
    for bundle_name in ("bundle.js", "mapApp.bundle.js"):
        src = static_dir / bundle_name
        dst = os.path.join(output_dir, bundle_name)
        if src.exists():
            shutil.copy2(src, dst)
            size = os.path.getsize(dst)
            logger.info(f"JavaScript copied: {dst} ({size / 1024:.1f} KB)")
        else:
            logger.warning(f"{bundle_name} not found - run npm build to generate it")

    # Copy and minify CSS
    styles_css_src = static_dir / "styles.css"
    styles_css_dst = os.path.join(output_dir, "styles.css")

    with open(styles_css_src, "r") as f:
        styles_css_content = f.read()

    styles_css_minified: str = rcssmin.cssmin(styles_css_content)

    with open(styles_css_dst, "w") as f:
        f.write(styles_css_minified)

    styles_css_size = os.path.getsize(styles_css_dst)
    logger.info(f"CSS copied: {styles_css_dst} ({styles_css_size / 1024:.1f} KB)")

    # Copy favicon files
    for favicon_file in (
        "favicon.svg",
        "favicon.ico",
        "favicon-192.png",
        "favicon-512.png",
        "apple-touch-icon.png",
        "manifest.json",
    ):
        src = static_dir / favicon_file
        dst = os.path.join(output_dir, favicon_file)
        if src.exists():
            shutil.copy2(src, dst)

    logger.info(f"Favicon files copied to {output_dir}")


def create_progressive_heatmap(
    kml_files: List[str], output_file: str = "index.html", data_dir: str = "data"
) -> bool:
    """Create a progressive-loading heatmap with external data files.

    Pipeline stages:
    1. Validate and parse KML files in parallel
    2. Process data: deduplicate airports, calculate stats, export files
    3. Render minified HTML
    4. Package static assets (JS bundles, config, CSS, favicons)

    Args:
        kml_files: List of KML file paths
        output_file: Output HTML file path
        data_dir: Directory to save data files

    Returns:
        True if successful, False otherwise
    """
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
        all_coordinates, all_path_groups, all_path_metadata, data_dir
    )

    # Stage 3: Render HTML
    data_dir_name = os.path.basename(data_dir)
    _render_html(output_file, data_dir_name)

    # Stage 4: Package assets
    output_dir = os.path.dirname(output_file) or "."
    _package_assets(output_dir, result["bounds"], data_dir_name)

    logger.info(
        f"  Open {output_file} in a web browser (works with file:// or serve via HTTP)"
    )

    return True
