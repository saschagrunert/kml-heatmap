"""Tests for cache module."""

import json
import os
from pathlib import Path
from unittest.mock import patch

from kml_heatmap.cache import CACHE_DIR, atomic_json_write


class TestCacheDir:
    def test_cache_dir_follows_environment_setting(self):
        assert Path(os.environ["KML_HEATMAP_CACHE_DIR"]) == CACHE_DIR

    def test_cache_dir_is_absolute(self):
        assert CACHE_DIR.is_absolute()

    def test_cache_dir_can_be_created(self):
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        assert CACHE_DIR.is_dir()


class TestAtomicJsonWrite:
    def test_write_simple_data(self, tmp_path):
        path = tmp_path / "test.json"
        data = {"key": "value", "number": 42}

        atomic_json_write(path, data, tmp_path)

        assert json.loads(path.read_text()) == data

    def test_write_overwrites_existing(self, tmp_path):
        path = tmp_path / "test.json"

        atomic_json_write(path, {"old": True}, tmp_path)
        atomic_json_write(path, {"new": True}, tmp_path)

        assert json.loads(path.read_text()) == {"new": True}

    def test_write_compact_format(self, tmp_path):
        path = tmp_path / "test.json"

        atomic_json_write(path, {"a": 1, "b": 2}, tmp_path)

        content = path.read_text()
        assert ": " not in content
        assert ", " not in content

    def test_write_nested_data(self, tmp_path):
        path = tmp_path / "test.json"
        data = {"nested": {"list": [1, 2, 3]}}

        atomic_json_write(path, data, tmp_path)

        assert json.loads(path.read_text()) == data

    def test_no_temp_files_left_behind(self, tmp_path):
        atomic_json_write(tmp_path / "test.json", {"a": 1}, tmp_path)
        assert [p.name for p in tmp_path.iterdir()] == ["test.json"]

    def test_write_to_nonexistent_directory(self, tmp_path):
        missing = tmp_path / "missing"
        atomic_json_write(missing / "test.json", {"key": "value"}, missing)
        assert not missing.exists()

    def test_write_cleans_up_temp_on_replace_failure(self, tmp_path):
        path = tmp_path / "test.json"

        with patch("kml_heatmap.cache.os.replace", side_effect=OSError("boom")):
            atomic_json_write(path, {"key": "value"}, tmp_path)

        assert not path.exists()
        assert list(tmp_path.iterdir()) == []

    def test_write_handles_temp_cleanup_failure(self, tmp_path):
        path = tmp_path / "test.json"

        with (
            patch("kml_heatmap.cache.os.replace", side_effect=OSError("replace")),
            patch("kml_heatmap.cache.os.unlink", side_effect=OSError("unlink")),
        ):
            atomic_json_write(path, {"key": "value"}, tmp_path)

        assert not path.exists()
