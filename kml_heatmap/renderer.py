"""HTML generation, rendering, and pipeline orchestration."""

import json
import os
import re
import shutil
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
from .geometry import haversine_distance
from .helpers import format_flight_time
from .logger import logger
from .parser import parse_kml_coordinates, is_mid_flight_start, is_valid_landing
from .statistics import calculate_statistics
from .validation import validate_kml_file


# Heatmap configuration
HEATMAP_GRADIENT = {0.0: "blue", 0.3: "cyan", 0.5: "lime", 0.7: "yellow", 1.0: "red"}


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
    def minify_css_tags(match):
        """Minify CSS content within style tags using rcssmin."""
        css_content = match.group(1)
        minified_css = rcssmin.cssmin(css_content)
        return f"<style>{minified_css}</style>"

    def minify_js_tags(match):
        """Minify JavaScript content within script tags using rjsmin."""
        js_content = match.group(1)
        minified_js = rjsmin.jsmin(js_content)
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
    minified = mh.minify(html)

    return minified


def _parse_with_error_handling(kml_file):
    """Parse a KML file with error handling.

    Args:
        kml_file: Path to KML file

    Returns:
        Tuple of (kml_file, (coordinates, path_groups, path_metadata))
    """
    try:
        return kml_file, parse_kml_coordinates(kml_file)
    except Exception as e:
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
    except Exception as e:
        logger.error(f"JavaScript build error: {e}")
        return False


def _recalculate_stats_from_segments(
    stats: Dict[str, Any],
    segments: List[Dict[str, Any]],
    path_info_list: List[Dict[str, Any]],
) -> None:
    """
    Recalculate statistics from exported segment data to match JavaScript.

    This ensures the statistics panel and filtered stats show consistent values
    with the frontend JavaScript calculations.

    Args:
        stats: Statistics dictionary (modified in place)
        segments: Full resolution path segments
        path_info_list: Full resolution path info entries
    """
    # 1. Total Points (segments x 2)
    stats["total_points"] = len(segments) * 2

    # 2. Altitude statistics
    altitudes_m = [seg["altitude_m"] for seg in segments]
    stats["min_altitude_m"] = min(altitudes_m) if altitudes_m else 0
    stats["max_altitude_m"] = max(altitudes_m) if altitudes_m else 0
    stats["min_altitude_ft"] = stats["min_altitude_m"] * 3.28084
    stats["max_altitude_ft"] = stats["max_altitude_m"] * 3.28084

    # 3. Total altitude gain
    total_gain_m = 0
    prev_alt = None
    for seg in segments:
        alt = seg["altitude_m"]
        if prev_alt is not None and alt > prev_alt:
            total_gain_m += alt - prev_alt
        prev_alt = alt
    stats["total_altitude_gain_m"] = total_gain_m
    stats["total_altitude_gain_ft"] = total_gain_m * 3.28084

    # 4. Average groundspeed
    groundspeeds = [
        seg["groundspeed_knots"] for seg in segments if seg["groundspeed_knots"] > 0
    ]
    stats["average_groundspeed_knots"] = (
        sum(groundspeeds) / len(groundspeeds) if groundspeeds else 0
    )

    # 5. Cruise speed (segments > 1000ft AGL)
    min_alt_m = stats["min_altitude_m"]
    cruise_segs = [
        seg for seg in segments if seg["altitude_ft"] > (min_alt_m * 3.28084 + 1000)
    ]
    cruise_speeds = [
        seg["groundspeed_knots"] for seg in cruise_segs if seg["groundspeed_knots"] > 0
    ]
    stats["cruise_speed_knots"] = (
        sum(cruise_speeds) / len(cruise_speeds) if cruise_speeds else 0
    )

    # 6. Most common cruise altitude (time-weighted)
    altitude_bins: Dict[int, int] = {}
    for seg in cruise_segs:
        if "time" in seg:
            bin_alt = round(seg["altitude_ft"] / 100) * 100
            altitude_bins[bin_alt] = altitude_bins.get(bin_alt, 0) + 1

    if altitude_bins:
        stats["most_common_cruise_altitude_ft"] = max(
            altitude_bins.keys(), key=lambda k: altitude_bins[k]
        )
        stats["most_common_cruise_altitude_m"] = round(
            stats["most_common_cruise_altitude_ft"] * 0.3048
        )

    # 7. Flight time from segments
    total_flight_time = 0.0
    path_durations: Dict[int, List[float]] = {}
    for segment in segments:
        if "time" in segment and "path_id" in segment:
            path_id = segment["path_id"]
            if path_id not in path_durations:
                path_durations[path_id] = []
            path_durations[path_id].append(segment["time"])

    for times in path_durations.values():
        if len(times) >= 2:
            duration = max(times) - min(times)
            total_flight_time += duration

    stats["total_flight_time_seconds"] = total_flight_time

    # 8. Per-aircraft flight times and distances
    if stats.get("aircraft_list"):
        aircraft_times: Dict[str, float] = {}
        aircraft_distances: Dict[str, float] = {}
        aircraft_years: Dict[str, set] = {}

        for idx, pi in enumerate(path_info_list):
            reg = pi.get("aircraft_registration")
            path_id = pi.get("id")
            year = pi.get("year")
            if reg and path_id is not None and path_id in path_durations:
                if reg not in aircraft_times:
                    aircraft_times[reg] = 0
                    aircraft_distances[reg] = 0.0
                    aircraft_years[reg] = set()
                times = path_durations[path_id]
                if len(times) >= 2:
                    aircraft_times[reg] += max(times) - min(times)
                    if year:
                        aircraft_years[reg].add(str(year))

        for segment in segments:
            path_id = segment.get("path_id")
            if path_id is not None and path_id < len(path_info_list):
                pi = path_info_list[path_id]
                reg = pi.get("aircraft_registration")
                if reg and reg in aircraft_distances:
                    coords = segment.get("coords", [])
                    if len(coords) == 2:
                        lat1, lon1 = coords[0]
                        lat2, lon2 = coords[1]
                        aircraft_distances[reg] += haversine_distance(
                            lat1, lon1, lat2, lon2
                        )

        for aircraft in stats["aircraft_list"]:
            reg = aircraft["registration"]
            if reg in aircraft_times:
                flight_time_seconds = aircraft_times[reg]
                flight_distance_km = aircraft_distances.get(reg, 0.0)
                aircraft["flight_time_seconds"] = flight_time_seconds
                aircraft["flight_distance_km"] = flight_distance_km
                aircraft["flight_time_str"] = format_flight_time(flight_time_seconds)


def create_progressive_heatmap(
    kml_files: List[str], output_file: str = "index.html", data_dir: str = "data"
) -> bool:
    """
    Create a progressive-loading heatmap with external data files.

    This is the main pipeline that:
    1. Parses KML files in parallel
    2. Deduplicates airports
    3. Calculates statistics
    4. Exports data files (per-year JS, airports, metadata)
    5. Recalculates stats from segment data for JS consistency
    6. Generates minified HTML
    7. Generates map_config.js
    8. Copies static assets (JS bundles, CSS, favicons)

    Args:
        kml_files: List of KML file paths
        output_file: Output HTML file path
        data_dir: Directory to save data files

    Returns:
        True if successful, False otherwise
    """
    # Get API keys
    stadia_api_key = os.environ.get("STADIA_API_KEY", "")
    openaip_api_key = os.environ.get("OPENAIP_API_KEY", "")

    # Validate KML files
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

    # Pre-load airport database to avoid multiple downloads in worker processes
    from .airport_lookup import _load_airport_database

    _load_airport_database()

    parse_start = time.time()

    # Parse files in parallel
    all_coordinates: List[List[float]] = []
    all_path_groups: List[List[List[float]]] = []
    all_path_metadata: List[Dict[str, Any]] = []

    results = []
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

    # Sort results by filename for deterministic output
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
        logger.error("No coordinates found in any KML files!")
        return False

    logger.info(f"\nTotal points: {len(all_coordinates)}")

    # Calculate bounds
    lats = [coord[0] for coord in all_coordinates]
    lons = [coord[1] for coord in all_coordinates]
    min_lat, max_lat = min(lats), max(lats)
    min_lon, max_lon = min(lons), max(lons)
    center_lat = (min_lat + max_lat) / 2
    center_lon = (min_lon + max_lon) / 2

    # Process airports
    unique_airports: List[Dict[str, Any]] = []
    if all_path_metadata:
        logger.info(f"\nProcessing {len(all_path_metadata)} start points...")
        unique_airports = deduplicate_airports(
            all_path_metadata, all_path_groups, is_mid_flight_start, is_valid_landing
        )
        logger.info(f"  Found {len(unique_airports)} unique airports")

    # Calculate statistics
    logger.info("\nCalculating statistics...")
    stats = calculate_statistics(all_coordinates, all_path_groups, all_path_metadata)

    # Add airport info to stats
    valid_airport_names = []
    for airport in unique_airports:
        full_name = airport.get("name", "Unknown")
        is_at_path_end = airport.get("is_at_path_end", False)
        airport_name = extract_airport_name(full_name, is_at_path_end)
        if airport_name:
            valid_airport_names.append(airport_name)

    stats["num_airports"] = len(valid_airport_names)
    stats["airport_names"] = sorted(valid_airport_names)

    # Export data (strip timestamps by default for privacy)
    files, full_res_segments, full_res_path_info = export_all_data(
        all_coordinates,
        all_path_groups,
        all_path_metadata,
        unique_airports,
        stats,
        data_dir,
        strip_timestamps=True,
    )

    # Recalculate statistics from segment data to match JavaScript
    if full_res_segments is not None and full_res_path_info is not None:
        logger.info("\nRecalculating statistics from segment data...")
        _recalculate_stats_from_segments(stats, full_res_segments, full_res_path_info)

        # Read existing metadata to preserve file_structure, available_years, gradient
        meta_file = os.path.join(data_dir, "metadata.js")
        existing_meta: Dict[str, Any] = {}
        if os.path.exists(meta_file):
            with open(meta_file, "r") as f:
                content = f.read()
                json_str = content.replace("window.KML_METADATA = ", "").rstrip(";")
                existing_meta = json.loads(json_str)

        # Re-export metadata with recalculated statistics
        meta_data = {
            "available_years": existing_meta.get("available_years", []),
            "gradient": existing_meta.get("gradient", {}),
            "file_structure": existing_meta.get("file_structure", {}),
            "max_alt_m": stats["max_altitude_m"],
            "max_groundspeed_knots": stats.get("max_groundspeed_knots", 0),
            "min_alt_m": stats["min_altitude_m"],
            "min_groundspeed_knots": stats.get("min_groundspeed_knots", 0),
            "stats": stats,
        }
        with open(meta_file, "w") as f:
            f.write("window.KML_METADATA = ")
            json.dump(meta_data, f, separators=(",", ":"), sort_keys=True)
            f.write(";")
        logger.info("  Updated metadata with segment-based statistics")

    # Generate HTML
    logger.info("\nGenerating progressive HTML...")
    data_dir_name = os.path.basename(data_dir)

    template = load_template()
    html_content = template.replace("{STADIA_API_KEY}", stadia_api_key)
    html_content = html_content.replace("{OPENAIP_API_KEY}", openaip_api_key)
    html_content = html_content.replace("{data_dir_name}", data_dir_name)
    html_content = html_content.replace("{center_lat}", str(center_lat))
    html_content = html_content.replace("{center_lon}", str(center_lon))
    html_content = html_content.replace("{min_lat}", str(min_lat))
    html_content = html_content.replace("{max_lat}", str(max_lat))
    html_content = html_content.replace("{min_lon}", str(min_lon))
    html_content = html_content.replace("{max_lon}", str(max_lon))

    # Minify and write HTML
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

    # Build JavaScript bundle if needed
    output_dir = os.path.dirname(output_file) or "."
    static_dir = Path(__file__).parent / "static"
    templates_dir = Path(__file__).parent / "templates"

    bundle_exists = (static_dir / "bundle.js").exists()
    mapapp_exists = (static_dir / "mapApp.bundle.js").exists()

    if not (bundle_exists and mapapp_exists):
        logger.info("\nBuilding JavaScript modules...")
        _build_javascript_bundle()
    else:
        logger.info("\nUsing pre-built JavaScript bundles...")

    # Generate map_config.js from template
    map_config_template = templates_dir / "map_config_template.js"
    map_config_dst = os.path.join(output_dir, "map_config.js")

    with open(map_config_template, "r") as f:
        map_config_content = f.read()

    map_config_content = map_config_content.replace(
        "{{STADIA_API_KEY}}", stadia_api_key
    )
    map_config_content = map_config_content.replace(
        "{{OPENAIP_API_KEY}}", openaip_api_key
    )
    map_config_content = map_config_content.replace("{{data_dir_name}}", data_dir_name)
    map_config_content = map_config_content.replace("{{center_lat}}", str(center_lat))
    map_config_content = map_config_content.replace("{{center_lon}}", str(center_lon))
    map_config_content = map_config_content.replace("{{min_lat}}", str(min_lat))
    map_config_content = map_config_content.replace("{{max_lat}}", str(max_lat))
    map_config_content = map_config_content.replace("{{min_lon}}", str(min_lon))
    map_config_content = map_config_content.replace("{{max_lon}}", str(max_lon))

    map_config_minified = rjsmin.jsmin(map_config_content)

    with open(map_config_dst, "w") as f:
        f.write(map_config_minified)

    map_config_size = os.path.getsize(map_config_dst)
    logger.info(
        f"Configuration generated: {map_config_dst} ({map_config_size / 1024:.1f} KB)"
    )

    # Copy JavaScript bundles
    bundle_js_src = static_dir / "bundle.js"
    if bundle_js_src.exists():
        bundle_js_dst = os.path.join(output_dir, "bundle.js")
        shutil.copy2(bundle_js_src, bundle_js_dst)
        bundle_js_size = os.path.getsize(bundle_js_dst)
        logger.info(
            f"JavaScript library copied: {bundle_js_dst} ({bundle_js_size / 1024:.1f} KB)"
        )
    else:
        logger.warning("bundle.js not found - run npm build to generate it")

    mapapp_bundle_src = static_dir / "mapApp.bundle.js"
    if mapapp_bundle_src.exists():
        mapapp_bundle_dst = os.path.join(output_dir, "mapApp.bundle.js")
        shutil.copy2(mapapp_bundle_src, mapapp_bundle_dst)
        mapapp_bundle_size = os.path.getsize(mapapp_bundle_dst)
        logger.info(
            f"JavaScript application copied: {mapapp_bundle_dst} ({mapapp_bundle_size / 1024:.1f} KB)"
        )
    else:
        logger.warning("mapApp.bundle.js not found - run npm build to generate it")

    # Copy and minify CSS
    styles_css_src = static_dir / "styles.css"
    styles_css_dst = os.path.join(output_dir, "styles.css")

    with open(styles_css_src, "r") as f:
        styles_css_content = f.read()

    styles_css_minified = rcssmin.cssmin(styles_css_content)

    with open(styles_css_dst, "w") as f:
        f.write(styles_css_minified)

    styles_css_size = os.path.getsize(styles_css_dst)
    logger.info(f"CSS copied: {styles_css_dst} ({styles_css_size / 1024:.1f} KB)")

    # Copy favicon files
    favicon_files = [
        "favicon.svg",
        "favicon.ico",
        "favicon-192.png",
        "favicon-512.png",
        "apple-touch-icon.png",
        "manifest.json",
    ]

    for favicon_file in favicon_files:
        favicon_src = static_dir / favicon_file
        favicon_dst = os.path.join(output_dir, favicon_file)
        if favicon_src.exists():
            shutil.copy2(favicon_src, favicon_dst)

    logger.info(f"Favicon files copied to {output_dir}")
    logger.info(
        f"  Open {output_file} in a web browser (works with file:// or serve via HTTP)"
    )

    return True
