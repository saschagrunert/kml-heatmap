"""Tests for cache module."""

from pathlib import Path


class TestCacheDir:
    """Tests for CACHE_DIR constant."""

    def test_cache_dir_is_path(self):
        """Test that CACHE_DIR is a Path object."""
        from kml_heatmap.cache import CACHE_DIR

        assert isinstance(CACHE_DIR, Path)

    def test_cache_dir_location(self):
        """Test that CACHE_DIR is in user's home directory."""
        from kml_heatmap.cache import CACHE_DIR

        # Should be ~/.cache/kml-heatmap
        assert CACHE_DIR == Path.home() / ".cache" / "kml-heatmap"

    def test_cache_dir_name(self):
        """Test that CACHE_DIR has correct name."""
        from kml_heatmap.cache import CACHE_DIR

        assert CACHE_DIR.name == "kml-heatmap"
        assert CACHE_DIR.parent.name == ".cache"

    def test_cache_dir_can_be_created(self):
        """Test that CACHE_DIR can be created."""
        from kml_heatmap.cache import CACHE_DIR

        # This should work without errors
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        assert CACHE_DIR.exists()
        assert CACHE_DIR.is_dir()
