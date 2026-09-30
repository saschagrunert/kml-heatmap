"""Tests for cache module."""

import contextlib
import importlib
import os
from pathlib import Path
from unittest.mock import patch

import pytest

import kml_heatmap.cache as cache_module
from kml_heatmap.cache import (
    CACHE_DIR,
    atomic_bytes_write,
    atomic_data_write,
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

    def test_newline_keeps_line_endings(self, tmp_path):
        path = tmp_path / "flight.kml"
        atomic_write(path, lambda tmp: tmp.write("a\r\nb\n"), newline="")
        assert path.read_bytes() == b"a\r\nb\n"

    def test_keep_mode_takes_the_mode_of_the_replaced_file(self, tmp_path):
        path = tmp_path / "flight.kml"
        path.write_text("old")
        path.chmod(0o640)
        atomic_write(path, lambda tmp: tmp.write("new"), keep_mode=True)
        assert path.read_text() == "new"
        assert oct(path.stat().st_mode & 0o777) == "0o640"

    def test_keep_mode_needs_a_file_to_replace(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            atomic_write(
                tmp_path / "missing.kml", lambda tmp: tmp.write("x"), keep_mode=True
            )
        assert list(tmp_path.iterdir()) == []

    def test_durable_flushes_the_file_then_its_directory(self, tmp_path):
        path = tmp_path / "flight.kml"
        synced = []
        real_fsync = os.fsync

        def fsync(fd):
            synced.append(os.fstat(fd))
            real_fsync(fd)

        with patch("kml_heatmap.cache.os.fsync", side_effect=fsync):
            atomic_write(path, lambda tmp: tmp.write("x"), durable=True)
        assert path.read_text() == "x"
        # The data before the rename, the directory entry after it
        assert [stat.st_ino for stat in synced] == [
            path.stat().st_ino,
            tmp_path.stat().st_ino,
        ]

    def test_a_directory_that_cannot_be_flushed_is_no_failure(self, tmp_path):
        path = tmp_path / "flight.kml"
        calls = 0
        real_fsync = os.fsync

        def fsync(fd):
            nonlocal calls
            calls += 1
            if calls > 1:
                raise OSError("not supported")
            real_fsync(fd)

        with patch("kml_heatmap.cache.os.fsync", side_effect=fsync):
            atomic_write(path, lambda tmp: tmp.write("x"), durable=True)
        assert path.read_text() == "x"

    def test_directory_fsync_tolerates_errors(self, tmp_path):
        with patch("kml_heatmap.cache.os.fsync") as fsync:
            cache_module._fsync_directory(tmp_path / "missing")
        fsync.assert_not_called()
        closed = []
        real_close = os.close

        def recording_close(fd):
            closed.append(fd)
            real_close(fd)

        with (
            patch("kml_heatmap.cache.os.fsync", side_effect=OSError("nope")),
            patch("kml_heatmap.cache.os.close", side_effect=recording_close),
        ):
            cache_module._fsync_directory(tmp_path)
        # The directory is closed again although the flush failed
        assert len(closed) == 1

    def test_not_durable_by_default(self, tmp_path):
        with patch("kml_heatmap.cache.os.fsync") as fsync:
            atomic_text_write(tmp_path / "file.txt", "x")
        fsync.assert_not_called()

    def test_a_temp_file_that_cannot_be_removed_is_no_second_error(self, tmp_path):
        path = tmp_path / "test.json"

        with (
            patch("kml_heatmap.cache.os.replace", side_effect=OSError("replace")),
            patch("kml_heatmap.cache.os.unlink", side_effect=OSError("unlink")),
            pytest.raises(OSError, match="replace"),
        ):
            atomic_write(path, lambda tmp: tmp.write("{}"))

        assert not path.exists()


class TestAtomicBytesWrite:
    def test_writes_bytes_with_regular_file_mode(self, tmp_path, umask_022):
        path = tmp_path / "tile.png"
        atomic_bytes_write(path, b"\x89PNG")
        assert path.read_bytes() == b"\x89PNG"
        assert oct(path.stat().st_mode & 0o777) == "0o644"
        assert [p.name for p in tmp_path.iterdir()] == ["tile.png"]

    def test_failed_replace_leaves_no_temp_file(self, tmp_path):
        path = tmp_path / "tile.png"
        path.write_bytes(b"old")
        with (
            patch("kml_heatmap.cache.os.replace", side_effect=OSError("boom")),
            pytest.raises(OSError, match="boom"),
        ):
            atomic_bytes_write(path, b"new")
        assert path.read_bytes() == b"old"
        assert [p.name for p in tmp_path.iterdir()] == ["tile.png"]


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
