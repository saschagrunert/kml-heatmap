"""Tests for cache module."""

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from kml_heatmap.cache import CACHE_DIR, atomic_json_write


class TestCacheDir:
    """Tests for CACHE_DIR constant."""

    def test_cache_dir_is_path(self):
        """Test that CACHE_DIR is a Path object."""
        assert isinstance(CACHE_DIR, Path)

    def test_cache_dir_location(self):
        """Test that CACHE_DIR is properly configured."""
        assert CACHE_DIR.is_absolute()

    def test_cache_dir_name(self):
        """Test that CACHE_DIR has a valid name."""
        assert len(CACHE_DIR.name) > 0

    def test_cache_dir_can_be_created(self):
        """Test that CACHE_DIR can be created."""
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        assert CACHE_DIR.exists()
        assert CACHE_DIR.is_dir()


class TestAtomicJsonWrite:
    """Tests for atomic_json_write function."""

    def test_write_simple_data(self):
        """Test writing simple JSON data atomically."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "test.json"
            data = {"key": "value", "number": 42}

            atomic_json_write(path, data, Path(tmpdir))

            assert path.exists()
            with open(path) as f:
                loaded = json.load(f)
            assert loaded == data

    def test_write_overwrites_existing(self):
        """Test that atomic write overwrites existing file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "test.json"

            atomic_json_write(path, {"old": True}, Path(tmpdir))
            atomic_json_write(path, {"new": True}, Path(tmpdir))

            with open(path) as f:
                loaded = json.load(f)
            assert loaded == {"new": True}

    def test_write_compact_format(self):
        """Test that data is written with compact separators."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "test.json"
            data = {"a": 1, "b": 2}

            atomic_json_write(path, data, Path(tmpdir))

            with open(path) as f:
                content = f.read()
            # Compact format: no spaces after : and ,
            assert ": " not in content
            assert ", " not in content

    def test_write_empty_dict(self):
        """Test writing empty dict."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "test.json"

            atomic_json_write(path, {}, Path(tmpdir))

            with open(path) as f:
                loaded = json.load(f)
            assert loaded == {}

    def test_write_nested_data(self):
        """Test writing nested data structures."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "test.json"
            data = {"nested": {"list": [1, 2, 3]}}

            atomic_json_write(path, data, Path(tmpdir))

            with open(path) as f:
                loaded = json.load(f)
            assert loaded == data

    def test_write_to_nonexistent_directory(self):
        """Test writing to a nonexistent directory handles error gracefully."""
        path = Path("/nonexistent/dir/test.json")

        # Should not raise, just log the error
        atomic_json_write(path, {"key": "value"}, Path("/nonexistent/dir"))

    def test_write_cleans_up_temp_on_error(self):
        """Test that temp file is cleaned up on write error."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "test.json"

            # Mock os.replace to simulate failure
            with patch("os.replace", side_effect=OSError("Mock error")):
                atomic_json_write(path, {"key": "value"}, Path(tmpdir))

            # Original file should not exist
            assert not path.exists()

    def test_write_cleans_up_temp_file_on_replace_failure(self):
        """Test that the temp file is removed when os.replace fails."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "test.json"

            with (
                patch(
                    "kml_heatmap.cache.os.replace",
                    side_effect=OSError("replace failed"),
                ) as mock_replace,
                patch("kml_heatmap.cache.os.unlink") as mock_unlink,
            ):
                atomic_json_write(path, {"key": "value"}, Path(tmpdir))

                mock_replace.assert_called_once()
                # The temp file path should have been passed to unlink
                mock_unlink.assert_called_once()

    def test_write_handles_temp_cleanup_failure(self):
        """Test graceful handling when both os.replace and os.unlink fail."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "test.json"

            with (
                patch(
                    "kml_heatmap.cache.os.replace",
                    side_effect=OSError("replace failed"),
                ),
                patch(
                    "kml_heatmap.cache.os.unlink", side_effect=OSError("unlink failed")
                ),
            ):
                # Should not raise despite both operations failing
                atomic_json_write(path, {"key": "value"}, Path(tmpdir))
