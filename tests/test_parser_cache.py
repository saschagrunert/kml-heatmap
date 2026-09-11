"""Tests for parser_cache module."""

import hashlib
import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

import kml_heatmap.airport_lookup as lookup_module
from kml_heatmap.airport_lookup import database_fingerprint
from kml_heatmap.parser_cache import (
    CACHE_FORMAT_VERSION,
    KML_CACHE_DIR,
    _entry_prefix,
    get_cache_key,
    load_cached_parse,
    prune_stale_cache_entries,
    save_to_cache,
)
from kml_heatmap.types import TrackPoint

SHARED = TrackPoint(50.0, 8.5, 300.0, 1000.5)
COORDS = [SHARED, TrackPoint(51.0, 9.5, None, None)]
# The path point is the very object that sits in the coordinate list, as the
# parsers build it
PATHS = [[SHARED]]
METADATA = [{"filename": "test.kml", "start_point": [50.0, 8.5, 300.0], "year": 2025}]


def _hash(path):
    return hashlib.sha256(str(Path(path).resolve()).encode()).hexdigest()[:12]


def _expected_name(kml):
    stat = kml.stat()
    return (
        f"{kml.stem}_{_hash(kml)}_v{CACHE_FORMAT_VERSION}"
        f"_{stat.st_mtime_ns}_{stat.st_size}_{database_fingerprint()}.json"
    )


class TestGetCacheKey:
    def test_nonexistent_file(self, tmp_path):
        assert get_cache_key(str(tmp_path / "missing.kml"), cache_dir=tmp_path) == (
            None,
            False,
        )

    def test_key_includes_version_mtime_size_and_database(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")

        cache_path, valid = get_cache_key(str(kml), cache_dir=tmp_path / "cache")

        assert valid is False
        assert cache_path is not None
        assert cache_path.parent == tmp_path / "cache"
        assert cache_path.name == _expected_name(kml)

    def test_default_cache_dir(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_path, _ = get_cache_key(str(kml))
        assert cache_path is not None
        assert cache_path.parent == KML_CACHE_DIR

    def test_unwritable_cache_dir_disables_cache(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        blocker = tmp_path / "file"
        blocker.write_text("not a directory")
        assert get_cache_key(str(kml), cache_dir=blocker / "cache") == (None, False)

    def test_valid_after_save(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        cache_path, _ = get_cache_key(str(kml), cache_dir=cache_dir)
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        assert get_cache_key(str(kml), cache_dir=cache_dir) == (cache_path, True)

    def test_size_change_invalidates_key(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        first, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        kml.write_bytes(b"<kml>changed</kml>")
        second, valid = get_cache_key(str(kml), cache_dir=cache_dir)

        assert second != first
        assert valid is False

    def test_mtime_change_invalidates_key(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        first, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        stat = kml.stat()
        os.utime(kml, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        second, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        assert second != first

    def test_airport_database_change_invalidates_key(self, tmp_path):
        """Names are standardized with the database, so it is part of the key."""
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        database = tmp_path / "airports.csv"

        with patch.object(lookup_module, "CACHE_FILE", database):
            without_db, _ = get_cache_key(str(kml), cache_dir=cache_dir)
            database.write_text("ident,name\n")
            with_db, _ = get_cache_key(str(kml), cache_dir=cache_dir)
            database.write_text("ident,name\nEDDF,Frankfurt\n")
            with_other_db, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        assert without_db.name.endswith("_nodb.json")
        assert len({without_db, with_db, with_other_db}) == 3


class TestEntryPrefix:
    def test_prefix_of_current_and_older_formats(self):
        hash12 = "0123456789ab"
        assert _entry_prefix(f"1_DEAGJ_DA20_{hash12}_v3_1_2_abcd1234.json") == (
            f"1_DEAGJ_DA20_{hash12}_"
        )
        assert _entry_prefix(f"test_{hash12}_v2_1_2.json") == f"test_{hash12}_"

    @pytest.mark.parametrize("name", ["notes.txt", "weird.json", "a_b_c.json"])
    def test_unrelated_names(self, name):
        assert _entry_prefix(name) is None


class TestPruneStaleCacheEntries:
    def test_removes_only_outdated_entries_of_the_given_files(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        current = cache_dir / _expected_name(kml)
        current.write_text("{}")
        old_version = cache_dir / f"test_{_hash(kml)}_v2_1111_22.json"
        old_version.write_text("{}")
        old_mtime = cache_dir / f"test_{_hash(kml)}_v3_1111_22_nodb.json"
        old_mtime.write_text("{}")
        other_file = cache_dir / "other_abcdefabcdef_v3_1111_22_nodb.json"
        other_file.write_text("{}")
        unrelated = cache_dir / "notes.txt"
        unrelated.write_text("keep")

        removed = prune_stale_cache_entries([str(kml)], cache_dir=cache_dir)

        assert removed == 2
        assert sorted(p.name for p in cache_dir.iterdir()) == sorted(
            [current.name, other_file.name, "notes.txt"]
        )

    def test_get_cache_key_does_not_prune(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        old_version = cache_dir / f"test_{_hash(kml)}_v2_1111_22.json"
        old_version.write_text("{}")

        get_cache_key(str(kml), cache_dir=cache_dir)

        assert old_version.exists()

    def test_missing_files_and_directories_are_ignored(self, tmp_path):
        assert prune_stale_cache_entries([str(tmp_path / "missing.kml")]) == 0
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        assert prune_stale_cache_entries([str(kml)], cache_dir=tmp_path / "no") == 0

    def test_unlink_errors_are_ignored(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        (cache_dir / f"test_{_hash(kml)}_v2_1111_22.json").write_text("{}")

        with patch.object(Path, "unlink", side_effect=OSError("mock")):
            assert prune_stale_cache_entries([str(kml)], cache_dir=cache_dir) == 0


class TestSaveAndLoad:
    def test_round_trip_preserves_track_points_and_identity(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)

        loaded = load_cached_parse(cache_path)

        assert loaded == (COORDS, PATHS, METADATA)
        coordinates, path_groups, _ = loaded
        assert all(isinstance(p, TrackPoint) for p in coordinates)
        assert coordinates[1].alt is None
        assert coordinates[1].ts is None
        # A path point is the coordinate entry itself, as after parsing
        assert path_groups[0][0] is coordinates[0]

    def test_file_format_is_explicit(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        raw = json.loads(cache_path.read_text())
        assert raw["version"] == CACHE_FORMAT_VERSION
        assert raw["coordinates"] == [
            [50.0, 8.5, 300.0, 1000.5],
            [51.0, 9.5, None, None],
        ]
        assert raw["path_groups"] == [[0]]
        assert raw["path_metadata"] == METADATA

    def test_path_point_outside_coordinates_is_stored_in_full(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        extra = TrackPoint(52.0, 10.0, 100.0, None)
        save_to_cache(cache_path, COORDS, [[SHARED, extra]], METADATA)

        raw = json.loads(cache_path.read_text())
        assert raw["path_groups"] == [[0, [52.0, 10.0, 100.0, None]]]
        loaded = load_cached_parse(cache_path)
        assert loaded[1] == [[SHARED, extra]]

    def test_version_mismatch_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
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

    @pytest.mark.parametrize(
        "coordinates,path_groups",
        [
            ([[1, 2]], []),
            ([[50.0, 8.5, 300.0, 1000.5]], [[7]]),
            ([], "not a list"),
        ],
        ids=["short-point", "index-out-of-range", "wrong-type"],
    )
    def test_wrong_structure_is_rejected(self, tmp_path, coordinates, path_groups):
        cache_path = tmp_path / "cache.json"
        cache_path.write_text(
            json.dumps(
                {
                    "version": CACHE_FORMAT_VERSION,
                    "coordinates": coordinates,
                    "path_groups": path_groups,
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
            save_to_cache(read_only / "cache.json", [], [], [])
            assert not (read_only / "cache.json").exists()
        finally:
            read_only.chmod(0o755)
