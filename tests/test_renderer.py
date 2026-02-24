"""Tests for renderer module."""

import os
import string
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from kml_heatmap.constants import HEATMAP_GRADIENT
from kml_heatmap.renderer import (
    _build_javascript_bundle,
    _package_assets,
    _parse_with_error_handling,
    _render_html,
    load_template,
    minify_html,
)


class TestLoadTemplate:
    """Tests for load_template function."""

    def test_load_template_returns_string(self):
        """Test that load_template returns a string."""
        template = load_template()
        assert isinstance(template, str)
        assert len(template) > 0

    def test_load_template_contains_html(self):
        """Test that template contains HTML markup."""
        template = load_template()
        assert "<html" in template.lower()
        assert "</html>" in template.lower()

    def test_load_template_is_map_template(self):
        """Test that template is a map template."""
        template = load_template()
        assert "map" in template.lower() or "leaflet" in template.lower()

    def test_load_template_has_data_dir_placeholder(self):
        """Test that template contains $data_dir_name placeholder."""
        template = load_template()
        assert "$data_dir_name" in template


class TestMinifyHtml:
    """Tests for minify_html function."""

    def test_minify_simple_html(self):
        """Test minifying simple HTML."""
        html = "<html>  <body>  <h1>Test</h1>  </body>  </html>"
        minified = minify_html(html)
        assert isinstance(minified, str)
        assert len(minified) <= len(html)

    def test_minify_html_with_css(self):
        """Test minifying HTML with inline CSS."""
        html = """
        <html>
            <head>
                <style>
                    body {
                        margin: 0;
                        padding: 0;
                    }
                </style>
            </head>
            <body></body>
        </html>
        """
        minified = minify_html(html)
        assert isinstance(minified, str)
        assert "body{margin:0" in minified or "body{padding:0" in minified

    def test_minify_html_with_javascript(self):
        """Test minifying HTML with inline JavaScript."""
        html = """
        <html>
            <body>
                <script>
                    var x = 10;
                    console.log(x);
                </script>
            </body>
        </html>
        """
        minified = minify_html(html)
        assert isinstance(minified, str)
        assert "<script>" in minified
        assert "</script>" in minified

    def test_minify_preserves_functionality(self):
        """Test that minification preserves HTML functionality."""
        html = '<html><body><div id="test">Content</div></body></html>'
        minified = minify_html(html)
        assert 'id="test"' in minified or "id=test" in minified
        assert "Content" in minified

    def test_minify_removes_whitespace(self):
        """Test that minification removes unnecessary whitespace."""
        html = """
        <html>
            <body>
                <div>
                    <p>Test</p>
                </div>
            </body>
        </html>
        """
        minified = minify_html(html)
        assert len(minified) < len(html)
        assert "\n\n" not in minified

    def test_minify_empty_html(self):
        """Test minifying empty HTML."""
        html = "<html></html>"
        minified = minify_html(html)
        assert isinstance(minified, str)
        assert len(minified) >= 0

    def test_minify_complex_css(self):
        """Test minifying HTML with complex CSS."""
        html = """
        <style>
            .class1 { color: red; font-size: 12px; }
            .class2 { background: blue; margin: 10px; }
        </style>
        """
        minified = minify_html(html)
        assert "color:red" in minified or "color: red" in minified

    def test_minify_multiple_scripts(self):
        """Test minifying HTML with multiple script tags."""
        html = """
        <script>var a = 1;</script>
        <script>var b = 2;</script>
        """
        minified = minify_html(html)
        assert minified.count("<script>") == 2
        assert minified.count("</script>") == 2


class TestHeatmapGradient:
    """Tests for HEATMAP_GRADIENT constant."""

    def test_gradient_is_dict(self):
        """Test that gradient is a dictionary."""
        assert isinstance(HEATMAP_GRADIENT, dict)

    def test_gradient_has_values(self):
        """Test that gradient has color values."""
        assert len(HEATMAP_GRADIENT) > 0

    def test_gradient_contains_colors(self):
        """Test that gradient contains color strings."""
        for value in HEATMAP_GRADIENT.values():
            assert isinstance(value, str)

    def test_gradient_keys_are_floats(self):
        """Test that gradient keys are float values."""
        for key in HEATMAP_GRADIENT.keys():
            assert isinstance(key, float)

    def test_gradient_range(self):
        """Test that gradient keys are in valid range."""
        for key in HEATMAP_GRADIENT.keys():
            assert 0.0 <= key <= 1.0


class TestParseWithErrorHandling:
    """Tests for _parse_with_error_handling function."""

    def test_returns_empty_on_nonexistent_file(self):
        """Test that a nonexistent file returns empty results."""
        kml_file, (coords, paths, meta) = _parse_with_error_handling(
            "/nonexistent/file.kml"
        )
        assert kml_file == "/nonexistent/file.kml"
        assert coords == []
        assert paths == []
        assert meta == []

    def test_returns_empty_on_invalid_kml(self):
        """Test that invalid KML returns empty results."""
        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False, mode="w") as f:
            f.write("<not-kml>garbage</not-kml>")
            path = f.name

        try:
            kml_file, (coords, paths, meta) = _parse_with_error_handling(path)
            assert kml_file == path
            # Invalid KML may return empty or raise handled errors
            assert isinstance(coords, list)
            assert isinstance(paths, list)
            assert isinstance(meta, list)
        finally:
            os.unlink(path)


class TestRenderHtml:
    """Tests for _render_html function."""

    def test_renders_html_to_file(self):
        """Test that HTML is rendered and written to output file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            output_file = os.path.join(tmpdir, "index.html")

            _render_html(output_file, "data")

            assert os.path.exists(output_file)
            with open(output_file) as f:
                content = f.read()
            assert len(content) > 0
            # Should be minified HTML
            assert "<!doctype html>" in content.lower() or "<!DOCTYPE" in content

    def test_substitutes_data_dir_name(self):
        """Test that $data_dir_name is substituted correctly."""
        with tempfile.TemporaryDirectory() as tmpdir:
            output_file = os.path.join(tmpdir, "index.html")

            _render_html(output_file, "my_data_dir")

            with open(output_file) as f:
                content = f.read()
            assert "my_data_dir" in content
            assert "$data_dir_name" not in content

    def test_output_is_minified(self):
        """Test that output HTML is minified (smaller than template)."""
        template = load_template()
        substituted = string.Template(template).substitute(data_dir_name="data")

        with tempfile.TemporaryDirectory() as tmpdir:
            output_file = os.path.join(tmpdir, "index.html")
            _render_html(output_file, "data")

            output_size = os.path.getsize(output_file)
            assert output_size < len(substituted)


class TestPackageAssets:
    """Tests for _package_assets function."""

    def test_generates_map_config(self):
        """Test that map_config.js is generated with correct values."""
        with tempfile.TemporaryDirectory() as tmpdir:
            bounds = {
                "center_lat": 51.0,
                "center_lon": 13.0,
                "min_lat": 48.0,
                "max_lat": 54.0,
                "min_lon": 9.0,
                "max_lon": 17.0,
            }

            _package_assets(tmpdir, bounds, "data")

            config_path = os.path.join(tmpdir, "map_config.js")
            assert os.path.exists(config_path)

            with open(config_path) as f:
                content = f.read()
            assert "51.0" in content
            assert "13.0" in content
            assert "$center_lat" not in content

    def test_copies_css(self):
        """Test that styles.css is copied and minified."""
        with tempfile.TemporaryDirectory() as tmpdir:
            bounds = {
                "center_lat": 51.0,
                "center_lon": 13.0,
                "min_lat": 48.0,
                "max_lat": 54.0,
                "min_lon": 9.0,
                "max_lon": 17.0,
            }

            _package_assets(tmpdir, bounds, "data")

            css_path = os.path.join(tmpdir, "styles.css")
            assert os.path.exists(css_path)
            assert os.path.getsize(css_path) > 0

    def test_copies_favicon_files(self):
        """Test that favicon files are copied."""
        with tempfile.TemporaryDirectory() as tmpdir:
            bounds = {
                "center_lat": 51.0,
                "center_lon": 13.0,
                "min_lat": 48.0,
                "max_lat": 54.0,
                "min_lon": 9.0,
                "max_lon": 17.0,
            }

            _package_assets(tmpdir, bounds, "data")

            # At least favicon.svg and manifest.json should exist
            static_dir = Path(__file__).parent.parent / "kml_heatmap" / "static"
            for fname in ("favicon.svg", "manifest.json"):
                src = static_dir / fname
                if src.exists():
                    assert os.path.exists(os.path.join(tmpdir, fname))

    def test_config_uses_env_api_keys(self):
        """Test that API keys from environment are used in config."""
        with tempfile.TemporaryDirectory() as tmpdir:
            bounds = {
                "center_lat": 51.0,
                "center_lon": 13.0,
                "min_lat": 48.0,
                "max_lat": 54.0,
                "min_lon": 9.0,
                "max_lon": 17.0,
            }

            with patch.dict(
                os.environ,
                {"STADIA_API_KEY": "test-stadia", "OPENAIP_API_KEY": "test-openaip"},
            ):
                _package_assets(tmpdir, bounds, "data")

            config_path = os.path.join(tmpdir, "map_config.js")
            with open(config_path) as f:
                content = f.read()
            assert "test-stadia" in content
            assert "test-openaip" in content

    def test_copies_js_bundles_when_present(self):
        """Test that JS bundles are copied when they exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            bounds = {
                "center_lat": 51.0,
                "center_lon": 13.0,
                "min_lat": 48.0,
                "max_lat": 54.0,
                "min_lon": 9.0,
                "max_lon": 17.0,
            }

            _package_assets(tmpdir, bounds, "data")

            static_dir = Path(__file__).parent.parent / "kml_heatmap" / "static"
            for bundle in ("bundle.js", "mapApp.bundle.js"):
                if (static_dir / bundle).exists():
                    assert os.path.exists(os.path.join(tmpdir, bundle))


class TestBuildJavascriptBundle:
    """Tests for _build_javascript_bundle function."""

    def test_returns_false_when_npm_not_found(self):
        """Test that missing npm returns False."""
        with patch("subprocess.run", side_effect=FileNotFoundError):
            result = _build_javascript_bundle()
            assert result is False

    def test_returns_false_on_timeout(self):
        """Test that build timeout returns False."""
        import subprocess

        with patch(
            "subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="npm", timeout=60),
        ):
            result = _build_javascript_bundle()
            assert result is False

    def test_returns_false_on_build_failure(self):
        """Test that failed build returns False."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stderr = "build error"

        with patch("subprocess.run", return_value=mock_result):
            result = _build_javascript_bundle()
            assert result is False

    def test_returns_false_when_no_package_json(self):
        """Test that missing package.json returns False."""
        with patch(
            "kml_heatmap.renderer.Path.__truediv__",
            return_value=Path("/nonexistent/package.json"),
        ):
            # Use a nonexistent project root
            with patch.object(Path, "exists", return_value=False):
                result = _build_javascript_bundle()
                assert result is False
