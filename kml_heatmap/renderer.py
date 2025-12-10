"""HTML generation and rendering functionality."""

import os
import json
import re
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import rcssmin
import rjsmin
import minify_html as mh

from .geometry import downsample_path_rdp, get_altitude_color
from .airports import extract_airport_name, deduplicate_airports
from .statistics import calculate_statistics
from .parser import parse_kml_coordinates, is_mid_flight_start, is_valid_landing

# Heatmap configuration
HEATMAP_GRADIENT = {
    0.0: 'blue',
    0.3: 'cyan',
    0.5: 'lime',
    0.7: 'yellow',
    1.0: 'red'
}


def load_template():
    """Load the HTML template from file."""
    template_path = Path(__file__).parent / 'templates' / 'map_template.html'
    with open(template_path, 'r') as f:
        return f.read()


def minify_html(html):
    """
    Minify HTML, CSS, and JavaScript using specialized minification libraries.

    Args:
        html: HTML string to minify

    Returns:
        Minified HTML string
    """
    # First, minify inline CSS and JavaScript
    def minify_css_tags(match):
        css_content = match.group(1)
        minified_css = rcssmin.cssmin(css_content)
        return f'<style>{minified_css}</style>'

    def minify_js_tags(match):
        js_content = match.group(1)
        minified_js = rjsmin.jsmin(js_content)
        # rjsmin preserves some newlines for ASI (Automatic Semicolon Insertion) safety.
        # Since our generated code uses explicit semicolons, we can safely remove
        # remaining newlines. Replace with space to maintain token separation where needed.
        minified_js = re.sub(r'\s*\n\s*', '', minified_js)
        return f'<script>{minified_js}</script>'

    # Minify inline CSS
    html = re.sub(r'<style>(.*?)</style>', minify_css_tags, html, flags=re.DOTALL)

    # Minify inline JavaScript (not script tags with src attribute)
    html = re.sub(r'<script>(.*?)</script>', minify_js_tags, html, flags=re.DOTALL)

    # Use minify-html for HTML minification
    minified = mh.minify(html)

    return minified


def export_data_json(all_coordinates, all_path_groups, all_path_metadata, unique_airports, stats, output_dir="data", strip_timestamps=False):
    """
    Export data to JSON files at multiple resolutions for progressive loading.
    
    This function will be implemented by reading from the original kml-heatmap.py
    """
    # This is a complex function - for now, we'll keep a reference to call the original
    # In a full refactor, this would be extracted completely
    pass


def create_progressive_heatmap(kml_files, output_file="index.html", data_dir="data"):
    """
    Create a progressive-loading heatmap with external JSON data files.

    This generates a lightweight HTML file that loads data based on zoom level,
    significantly reducing initial load time and memory usage on mobile devices.

    Args:
        kml_files: List of KML file paths
        output_file: Output HTML file path
        data_dir: Directory to save JSON data files

    Note:
        Date/time information is automatically stripped from exported data for privacy.
    """
    # This function will be a wrapper that calls the modularized components
    pass


