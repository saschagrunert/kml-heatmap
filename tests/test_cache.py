"""Tests for cache module."""

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from kml_heatmap.cache import CACHE_DIR, atomic_json_write, locked_json_read_write


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


class TestLockedJsonReadWrite:
    """Tests for locked_json_read_write context manager."""

    def test_read_write_new_file(self):
        """Test creating a new cache file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "cache.json"

            with locked_json_read_write(path) as (data, existed):
                assert data == {}
                assert existed is False
                data["key"] = "value"

            with open(path) as f:
                loaded = json.load(f)
            assert loaded == {"key": "value"}

    def test_read_write_existing_file(self):
        """Test reading and updating an existing cache file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "cache.json"

            # Create existing file
            with open(path, "w") as f:
                json.dump({"existing": True}, f)

            with locked_json_read_write(path) as (data, existed):
                assert existed is True
                assert data == {"existing": True}
                data["new_key"] = "new_value"

            with open(path) as f:
                loaded = json.load(f)
            assert loaded["existing"] is True
            assert loaded["new_key"] == "new_value"

    def test_read_write_corrupted_file(self):
        """Test handling corrupted JSON cache file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "cache.json"

            with open(path, "w") as f:
                f.write("{invalid json")

            with locked_json_read_write(path) as (data, existed):
                assert data == {}
                assert existed is False
                data["recovered"] = True

            with open(path) as f:
                loaded = json.load(f)
            assert loaded == {"recovered": True}

    def test_read_write_creates_parent_directories(self):
        """Test that parent directories are created."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "sub" / "dir" / "cache.json"

            with locked_json_read_write(path) as (data, existed):
                data["key"] = "value"

            assert path.exists()

    def test_read_write_nonexistent_parent_fails_gracefully(self):
        """Test graceful failure when parent can't be created."""
        path = Path("/nonexistent/root/cache.json")

        with locked_json_read_write(path) as (data, existed):
            assert data == {}
            assert existed is False

    def test_lock_file_cleaned_up(self):
        """Test that lock file is cleaned up after use."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "cache.json"

            with locked_json_read_write(path) as (data, _):
                data["key"] = "value"

            lock_path = path.with_suffix(".json.lock")
            assert not lock_path.exists()

    def test_multiple_sequential_writes(self):
        """Test multiple sequential read-write operations."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "cache.json"

            with locked_json_read_write(path) as (data, _):
                data["first"] = True

            with locked_json_read_write(path) as (data, existed):
                assert existed is True
                assert data["first"] is True
                data["second"] = True

            with open(path) as f:
                loaded = json.load(f)
            assert loaded == {"first": True, "second": True}

    def test_data_written_back_even_without_mutation(self):
        """Test that data is written back on normal exit even without mutation."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "cache.json"

            with locked_json_read_write(path) as (data, _):
                pass  # No mutation

            # File should still be created (empty dict)
            assert path.exists()
            with open(path) as f:
                loaded = json.load(f)
            assert loaded == {}
