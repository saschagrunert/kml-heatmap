"""Tests for cache module."""

from pathlib import Path


class TestCacheDir:
    """Tests for CACHE_DIR constant."""

    def test_cache_dir_is_path(self):
        """Test that CACHE_DIR is a Path object."""
        from kml_heatmap.cache import CACHE_DIR

        assert isinstance(CACHE_DIR, Path)

    def test_cache_dir_location(self):
        """Test that CACHE_DIR is properly configured."""
        from kml_heatmap.cache import CACHE_DIR

        # During testing, CACHE_DIR is patched to use a temp directory
        # In production, it should be ~/.cache/kml-heatmap
        # Just verify it's a valid path
        assert CACHE_DIR.is_absolute()

    def test_cache_dir_name(self):
        """Test that CACHE_DIR has a valid name."""
        from kml_heatmap.cache import CACHE_DIR

        # During testing, CACHE_DIR is patched to use a temp directory
        # In production, it should be "kml-heatmap"
        # Just verify it has a name (could be temp dir like "kml_heatmap_test_xyz")
        assert len(CACHE_DIR.name) > 0

    def test_cache_dir_can_be_created(self):
        """Test that CACHE_DIR can be created."""
        from kml_heatmap.cache import CACHE_DIR

        # This should work without errors
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        assert CACHE_DIR.exists()
        assert CACHE_DIR.is_dir()
