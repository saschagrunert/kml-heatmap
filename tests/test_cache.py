"""Tests for cache module."""

import contextlib
import importlib
import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

import kml_heatmap.cache as cache_module
from kml_heatmap.cache import (
    CACHE_DIR,
    atomic_data_write,
    atomic_json_write,
    atomic_text_write,
    atomic_write,
)


@pytest.fixture
def umask_022():
    """Run a test under the common 022 umask and restore the previous one."""
    previous = os.umask(0o022)
    try:
        yield
    finally:
        os.umask(previous)


class TestCacheDir:
    def test_cache_dir_follows_environment_setting(self):
        assert Path(os.environ["KML_HEATMAP_CACHE_DIR"]) == CACHE_DIR

    def test_cache_dir_is_absolute(self):
        assert CACHE_DIR.is_absolute()

    def test_cache_dir_can_be_created(self):
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        assert CACHE_DIR.is_dir()

    def test_default_cache_dir_below_home(self, monkeypatch, tmp_path):
        monkeypatch.delenv("KML_HEATMAP_CACHE_DIR")
        with patch.object(Path, "home", return_value=tmp_path):
            assert cache_module._default_cache_dir() == (
                tmp_path / ".cache" / "kml-heatmap"
            )

    def test_default_cache_dir_without_home_uses_tempdir(self):
        with patch.object(Path, "home", side_effect=RuntimeError("no home")):
            result = cache_module._default_cache_dir()
        assert result.name == "kml-heatmap-cache"
        assert result.parent.is_dir()

    def test_module_reads_environment_at_import(self, monkeypatch, tmp_path):
        monkeypatch.setenv("KML_HEATMAP_CACHE_DIR", str(tmp_path / "elsewhere"))
        try:
            reloaded = importlib.reload(cache_module)
            assert tmp_path / "elsewhere" == reloaded.CACHE_DIR
        finally:
            monkeypatch.undo()
            importlib.reload(cache_module)
        assert cache_module.CACHE_DIR == CACHE_DIR


class TestAtomicWrite:
    def test_result_has_regular_file_mode(self, tmp_path, umask_022):
        path = tmp_path / "site.html"
        atomic_write(path, lambda tmp: tmp.write("<html/>"))
        assert oct(path.stat().st_mode & 0o777) == "0o644"

    def test_umask_is_read_once_at_import(self, tmp_path):
        """Reading the umask means setting it, which must not happen while
        other threads create files; the mode is taken at import."""
        previous = os.umask(0o077)
        try:
            path = tmp_path / "as-imported.txt"
            atomic_text_write(path, "x")
            assert path.stat().st_mode & 0o777 == 0o666 & ~previous

            reloaded = importlib.reload(cache_module)
            assert reloaded.REGULAR_FILE_MODE == 0o600
            path = tmp_path / "private.txt"
            atomic_text_write(path, "x")
            assert oct(path.stat().st_mode & 0o777) == "0o600"
        finally:
            os.umask(previous)
            importlib.reload(cache_module)
        assert 0o666 & ~previous == cache_module.REGULAR_FILE_MODE

    def test_replaces_existing_file(self, tmp_path):
        path = tmp_path / "file.txt"
        path.write_text("old")
        atomic_text_write(path, "new")
        assert path.read_text() == "new"

    def test_temp_file_removed_when_writer_fails(self, tmp_path):
        path = tmp_path / "file.txt"

        def boom(_tmp):
            raise ValueError("writer failed")

        with pytest.raises(ValueError, match="writer failed"):
            atomic_write(path, boom)
        assert list(tmp_path.iterdir()) == []

    def test_writer_error_leaves_existing_file_intact(self, tmp_path):
        path = tmp_path / "file.txt"
        path.write_text("keep")

        def boom(_tmp):
            raise OSError("disk full")

        with pytest.raises(OSError, match="disk full"):
            atomic_write(path, boom)
        assert path.read_text() == "keep"
        assert [p.name for p in tmp_path.iterdir()] == ["file.txt"]


class TestAtomicDataWrite:
    def test_writes_compact_json(self, tmp_path):
        path = tmp_path / "data.json"
        atomic_data_write(path, {"key": "value"})

        content = path.read_text()
        assert content == '{"key":"value"}'

    def test_sort_keys(self, tmp_path):
        path = tmp_path / "data.json"
        atomic_data_write(path, {"b": 2, "a": 1}, sort_keys=True)

        content = path.read_text()
        assert content == '{"a":1,"b":2}'

    def test_no_temp_files_left_behind(self, tmp_path):
        atomic_data_write(tmp_path / "data.json", [1, 2])
        assert [p.name for p in tmp_path.iterdir()] == ["data.json"]

    def test_readable_by_others(self, tmp_path, umask_022):
        path = tmp_path / "data.json"
        atomic_data_write(path, [1])
        assert path.stat().st_mode & 0o044 == 0o044

    def test_cleans_up_temp_on_replace_failure(self, tmp_path):
        path = tmp_path / "data.json"
        with (
            patch("kml_heatmap.cache.os.replace", side_effect=OSError("boom")),
            contextlib.suppress(OSError),
        ):
            atomic_data_write(path, {"a": 1})

        assert not path.exists()
        assert list(tmp_path.iterdir()) == []


class TestAtomicJsonWrite:
    def test_write_simple_data(self, tmp_path):
        path = tmp_path / "test.json"
        data = {"key": "value", "number": 42}

        atomic_json_write(path, data)

        assert json.loads(path.read_text()) == data

    def test_write_overwrites_existing(self, tmp_path):
        path = tmp_path / "test.json"

        atomic_json_write(path, {"old": True})
        atomic_json_write(path, {"new": True})

        assert json.loads(path.read_text()) == {"new": True}

    def test_write_compact_format(self, tmp_path):
        path = tmp_path / "test.json"

        atomic_json_write(path, {"a": 1, "b": 2})

        content = path.read_text()
        assert ": " not in content
        assert ", " not in content

    def test_write_nested_data(self, tmp_path):
        path = tmp_path / "test.json"
        data = {"nested": {"list": [1, 2, 3]}}

        atomic_json_write(path, data)

        assert json.loads(path.read_text()) == data

    def test_no_temp_files_left_behind(self, tmp_path):
        atomic_json_write(tmp_path / "test.json", {"a": 1})
        assert [p.name for p in tmp_path.iterdir()] == ["test.json"]

    def test_write_to_nonexistent_directory(self, tmp_path):
        missing = tmp_path / "missing"
        atomic_json_write(missing / "test.json", {"key": "value"})
        assert not missing.exists()

    def test_write_cleans_up_temp_on_replace_failure(self, tmp_path):
        path = tmp_path / "test.json"

        with patch("kml_heatmap.cache.os.replace", side_effect=OSError("boom")):
            atomic_json_write(path, {"key": "value"})

        assert not path.exists()
        assert list(tmp_path.iterdir()) == []

    def test_write_handles_temp_cleanup_failure(self, tmp_path):
        path = tmp_path / "test.json"

        with (
            patch("kml_heatmap.cache.os.replace", side_effect=OSError("replace")),
            patch("kml_heatmap.cache.os.unlink", side_effect=OSError("unlink")),
        ):
            atomic_json_write(path, {"key": "value"})

        assert not path.exists()
