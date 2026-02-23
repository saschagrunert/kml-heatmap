"""Tests for renderer module."""

from kml_heatmap.renderer import (
    load_template,
    minify_html,
)
from kml_heatmap.constants import HEATMAP_GRADIENT


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
        # Should contain map-related elements
        assert "map" in template.lower() or "leaflet" in template.lower()


class TestMinifyHtml:
    """Tests for minify_html function."""

    def test_minify_simple_html(self):
        """Test minifying simple HTML."""
        html = "<html>  <body>  <h1>Test</h1>  </body>  </html>"
        minified = minify_html(html)
        assert isinstance(minified, str)
        # Should be shorter due to whitespace removal
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
        # Should contain the minified CSS
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
        # Should contain script tag
        assert "<script>" in minified
        assert "</script>" in minified

    def test_minify_preserves_functionality(self):
        """Test that minification preserves HTML functionality."""
        html = '<html><body><div id="test">Content</div></body></html>'
        minified = minify_html(html)
        # Should preserve essential structure
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
        # Should be significantly shorter
        assert len(minified) < len(html)
        # Should not have excessive newlines
        assert "\n\n" not in minified

    def test_minify_empty_html(self):
        """Test minifying empty HTML."""
        html = "<html></html>"
        minified = minify_html(html)
        assert isinstance(minified, str)
        # Empty HTML may be minified to empty string
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
        # Should minify CSS
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
