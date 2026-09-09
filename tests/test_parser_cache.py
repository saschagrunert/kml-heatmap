"""Tests for parser_cache module."""

import hashlib
import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from kml_heatmap.parser_cache import (
    CACHE_FORMAT_VERSION,
    KML_CACHE_DIR,
    get_cache_key,
    load_cached_parse,
    save_to_cache,
)
from kml_heatmap.types import TrackPoint

COORDS = [TrackPoint(50.0, 8.5, 300.0, 1000.5), TrackPoint(51.0, 9.5, None, None)]
PATHS = [[TrackPoint(50.0, 8.5, 300.0, 1000.5)]]
METADATA = [{"filename": "test.kml", "start_point": [50.0, 8.5, 300.0], "year": 2025}]


def _hash(path):
    return hashlib.sha256(str(Path(path).resolve()).encode()).hexdigest()[:12]


class TestGetCacheKey:
    def test_nonexistent_file(self, tmp_path):
        assert get_cache_key(str(tmp_path / "missing.kml"), cache_dir=tmp_path) == (
            None,
            False,
        )

    def test_key_includes_version_mtime_ns_and_size(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        stat = kml.stat()

        cache_path, valid = get_cache_key(str(kml), cache_dir=tmp_path / "cache")

        assert valid is False
        assert cache_path is not None
        assert cache_path.parent == tmp_path / "cache"
        assert cache_path.name == (
            f"test_{_hash(kml)}_v{CACHE_FORMAT_VERSION}_{stat.st_mtime_ns}_{stat.st_size}.json"
        )

    def test_default_cache_dir(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_path, _ = get_cache_key(str(kml))
        assert cache_path is not None
        assert cache_path.parent == KML_CACHE_DIR

    def test_valid_after_save(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        cache_path, _ = get_cache_key(str(kml), cache_dir=cache_dir)
        save_to_cache(cache_path, COORDS, PATHS, METADATA, cache_dir=cache_dir)
        assert get_cache_key(str(kml), cache_dir=cache_dir) == (cache_path, True)

    def test_size_change_invalidates_key(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        first, _ = get_cache_key(str(kml), cache_dir=cache_dir)
        first.write_text("{}")

        kml.write_bytes(b"<kml>changed</kml>")
        second, valid = get_cache_key(str(kml), cache_dir=cache_dir)

        assert second != first
        assert valid is False
        assert not first.exists()

    def test_mtime_change_invalidates_key(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        first, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        stat = kml.stat()
        os.utime(kml, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        second, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        assert second != first

    def test_old_version_files_are_cleaned_up(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        old_version = cache_dir / f"test_{_hash(kml)}_1111111.json"
        old_version.write_text("{}")
        other_file = cache_dir / f"other_{_hash(kml)}_1111111.json"
        other_file.write_text("{}")

        get_cache_key(str(kml), cache_dir=cache_dir)

        assert not old_version.exists()
        assert other_file.exists()

    def test_cleanup_errors_are_ignored(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        (cache_dir / f"test_{_hash(kml)}_old.json").write_text("{}")

        with patch.object(Path, "unlink", side_effect=OSError("mock")):
            cache_path, _ = get_cache_key(str(kml), cache_dir=cache_dir)
        assert cache_path is not None


class TestSaveAndLoad:
    def test_round_trip_preserves_track_points(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_to_cache(cache_path, COORDS, PATHS, METADATA, cache_dir=tmp_path)

        loaded = load_cached_parse(cache_path)

        assert loaded == (COORDS, PATHS, METADATA)
        assert all(isinstance(p, TrackPoint) for p in loaded[0])
        assert loaded[0][1].alt is None
        assert loaded[0][1].ts is None

    def test_file_format_is_explicit(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_to_cache(cache_path, COORDS, PATHS, METADATA, cache_dir=tmp_path)
        raw = json.loads(cache_path.read_text())
        assert raw["version"] == CACHE_FORMAT_VERSION
        assert raw["coordinates"] == [
            [50.0, 8.5, 300.0, 1000.5],
            [51.0, 9.5, None, None],
        ]
        assert raw["path_groups"] == [[[50.0, 8.5, 300.0, 1000.5]]]
        assert raw["path_metadata"] == METADATA

    def test_version_mismatch_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_to_cache(cache_path, COORDS, PATHS, METADATA, cache_dir=tmp_path)
        raw = json.loads(cache_path.read_text())
        raw["version"] = CACHE_FORMAT_VERSION - 1
        cache_path.write_text(json.dumps(raw))
        assert load_cached_parse(cache_path) is None

    def test_missing_version_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        cache_path.write_text(
            json.dumps({"coordinates": [], "path_groups": [], "path_metadata": []})
        )
        assert load_cached_parse(cache_path) is None

    def test_corrupt_json_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        cache_path.write_text("invalid json")
        assert load_cached_parse(cache_path) is None

    def test_wrong_structure_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        cache_path.write_text(
            json.dumps(
                {
                    "version": CACHE_FORMAT_VERSION,
                    "coordinates": [[1, 2]],
                    "path_groups": [],
                    "path_metadata": [],
                }
            )
        )
        assert load_cached_parse(cache_path) is None

    def test_missing_file(self, tmp_path):
        assert load_cached_parse(tmp_path / "missing.json") is None

    @pytest.mark.skipif(
        hasattr(os, "geteuid") and os.geteuid() == 0,
        reason="root ignores directory permissions",
    )
    def test_save_error_is_swallowed(self, tmp_path):
        read_only = tmp_path / "ro"
        read_only.mkdir()
        read_only.chmod(0o555)
        try:
            save_to_cache(read_only / "cache.json", [], [], [], cache_dir=read_only)
            assert not (read_only / "cache.json").exists()
        finally:
            read_only.chmod(0o755)
