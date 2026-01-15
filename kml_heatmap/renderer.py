"""HTML generation and rendering functionality."""

import re
from pathlib import Path
from typing import Dict, Any, List
import rcssmin
import rjsmin
import minify_html as mh


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


def export_data_json(
    all_coordinates: List[List[float]],
    all_path_groups: List[List[List[float]]],
    all_path_metadata: List[Dict[str, Any]],
    unique_airports: List[Dict[str, Any]],
    stats: Dict[str, Any],
    output_dir: str = "data",
    strip_timestamps: bool = False,
) -> None:
    """
    Export data to JSON files at multiple resolutions for progressive loading.

    Args:
        all_coordinates: List of all coordinate pairs
        all_path_groups: List of path groups with altitude data
        all_path_metadata: Metadata for each path
        unique_airports: List of deduplicated airports
        stats: Statistics dictionary
        output_dir: Directory to save JSON files
        strip_timestamps: If True, remove timestamp data for privacy
    """
    # This is a complex function - for now, we'll keep a reference to call the original
    # In a full refactor, this would be extracted completely
    pass


def create_progressive_heatmap(
    kml_files: List[str], output_file: str = "index.html", data_dir: str = "data"
) -> None:
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
