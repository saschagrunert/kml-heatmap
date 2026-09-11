"""Tests for the lazily resolved package exports."""

import pytest

import kml_heatmap


class TestLazyExports:
    def test_every_export_resolves(self):
        for name in kml_heatmap.__all__:
            assert getattr(kml_heatmap, name) is not None

    def test_all_lists_exactly_the_lazy_names_and_the_version(self):
        assert set(kml_heatmap.__all__) == {"__version__", *kml_heatmap._LAZY_EXPORTS}
        assert kml_heatmap.__all__[0] == "__version__"
        assert kml_heatmap.__all__[1:] == sorted(kml_heatmap.__all__[1:])

    def test_pipeline_entry_points_are_exported(self):
        from kml_heatmap.obfuscate import check_kml_obfuscated, obfuscate_kml_files
        from kml_heatmap.renderer import create_progressive_heatmap

        assert kml_heatmap.create_progressive_heatmap is create_progressive_heatmap
        assert kml_heatmap.obfuscate_kml_files is obfuscate_kml_files
        assert kml_heatmap.check_kml_obfuscated is check_kml_obfuscated

    def test_renderer_internals_are_not_exported(self):
        assert "minify_html" not in kml_heatmap.__all__
        assert "load_template" not in kml_heatmap.__all__

    def test_unknown_attribute_raises(self):
        with pytest.raises(AttributeError, match="has no attribute 'nope'"):
            kml_heatmap.nope  # noqa: B018

    def test_version(self):
        assert kml_heatmap.__version__ == "1.0.0"
