"""Tests for parser_cache module."""

import hashlib
import json
import os
import shutil
import time
from pathlib import Path
from unittest.mock import patch

import pytest

import kml_heatmap.airport_lookup as lookup_module
import kml_heatmap.parser_cache as parser_cache_module
from kml_heatmap.airport_lookup import database_fingerprint
from kml_heatmap.parser_cache import (
    CACHE_FORMAT_VERSION,
    CACHE_MAX_AGE_DAYS,
    KML_CACHE_DIR,
    get_cache_key,
    load_cached_parse,
    parser_fingerprint,
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
DAY = 24 * 3600


def _expected_name(kml):
    digest = hashlib.blake2b(kml.name.encode() + b"\0", digest_size=16)
    digest.update(kml.read_bytes())
    return (
        f"{digest.hexdigest()}_v{CACHE_FORMAT_VERSION}_{parser_fingerprint()}"
        f"_{database_fingerprint()}.json"
    )


def _entry(cache_dir, name, age_days=0.0):
    entry = cache_dir / name
    entry.write_text("{}")
    stamp = time.time() - age_days * DAY
    os.utime(entry, (stamp, stamp))
    return entry


class TestGetCacheKey:
    def test_nonexistent_file(self, tmp_path):
        assert get_cache_key(str(tmp_path / "missing.kml"), cache_dir=tmp_path) == (
            None,
            False,
        )

    def test_key_includes_content_version_parser_and_database(self, tmp_path):
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
        assert cache_path.parent == parser_cache_module.KML_CACHE_DIR

    def test_default_cache_dir_is_below_the_cache_directory(self):
        assert KML_CACHE_DIR.name == "kml"

    def test_unwritable_cache_dir_disables_cache(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        blocker = tmp_path / "file"
        blocker.write_text("not a directory")
        assert get_cache_key(str(kml), cache_dir=blocker / "cache") == (None, False)

    def test_unreadable_file_disables_cache(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        with patch("builtins.open", side_effect=OSError("denied")):
            assert get_cache_key(str(kml), cache_dir=tmp_path / "cache") == (
                None,
                False,
            )

    def test_valid_after_save(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        cache_path, _ = get_cache_key(str(kml), cache_dir=cache_dir)
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        assert get_cache_key(str(kml), cache_dir=cache_dir) == (cache_path, True)

    def test_content_change_invalidates_key(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml>one</kml>")
        stat = kml.stat()
        cache_dir = tmp_path / "cache"
        first, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        # Same size and modification time: a key built from those would miss it
        kml.write_bytes(b"<kml>two</kml>")
        os.utime(kml, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        second, valid = get_cache_key(str(kml), cache_dir=cache_dir)

        assert second != first
        assert valid is False

    def test_key_survives_a_checkout(self, tmp_path):
        """A fresh clone has new modification times and another path."""
        kml = tmp_path / "a" / "1_DEAGJ_DA20.kml"
        kml.parent.mkdir()
        kml.write_bytes(b"<kml/>")
        clone = tmp_path / "b" / "1_DEAGJ_DA20.kml"
        clone.parent.mkdir()
        shutil.copyfile(kml, clone)
        stat = kml.stat()
        os.utime(clone, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
        cache_dir = tmp_path / "cache"

        first, _ = get_cache_key(str(kml), cache_dir=cache_dir)
        second, _ = get_cache_key(str(clone), cache_dir=cache_dir)

        assert first == second

    def test_file_name_is_part_of_the_key(self, tmp_path):
        """The parse result carries the name and the aircraft taken from it."""
        first = tmp_path / "1_DEAGJ_DA20.kml"
        second = tmp_path / "1_DEHYL_DA40.kml"
        first.write_bytes(b"<kml/>")
        second.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"

        assert get_cache_key(str(first), cache_dir=cache_dir) != get_cache_key(
            str(second), cache_dir=cache_dir
        )

    def test_parser_change_invalidates_key(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        first, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        with patch.object(
            parser_cache_module, "parser_fingerprint", return_value="0badc0de"
        ):
            second, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        assert second != first
        assert "_0badc0de_" in second.name

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


class TestParserFingerprint:
    def test_changes_with_the_parser_code(self, tmp_path):
        package = tmp_path / "kml_heatmap"
        package.mkdir()
        for module in parser_cache_module._PARSER_MODULES:
            (package / f"{module}.py").write_text(f"# {module}\n")
        fake_file = str(package / "parser_cache.py")

        with patch.object(parser_cache_module, "__file__", fake_file):
            parser_fingerprint.cache_clear()
            first = parser_fingerprint()
            (package / "parser_common.py").write_text("# changed\n")
            parser_fingerprint.cache_clear()
            second = parser_fingerprint()
            (package / "parser_standard.py").unlink()
            parser_fingerprint.cache_clear()
            third = parser_fingerprint()
        parser_fingerprint.cache_clear()

        assert len({first, second, third}) == 3
        assert len(first) == 8
        assert parser_fingerprint() != first


class TestPruneStaleCacheEntries:
    def _current_suffix(self):
        return (
            f"_v{CACHE_FORMAT_VERSION}_{parser_fingerprint()}"
            f"_{database_fingerprint()}.json"
        )

    def test_removes_entries_no_key_can_produce(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        digest = "0123456789abcdef0123456789abcdef"
        current = _entry(cache_dir, digest + self._current_suffix())
        old_version = _entry(
            cache_dir,
            f"{digest}_v{CACHE_FORMAT_VERSION - 1}_{parser_fingerprint()}"
            f"_{database_fingerprint()}.json",
        )
        old_parser = _entry(
            cache_dir,
            f"{digest}_v{CACHE_FORMAT_VERSION}_00000000_{database_fingerprint()}.json",
        )
        old_database = _entry(
            cache_dir,
            f"{digest}_v{CACHE_FORMAT_VERSION}_{parser_fingerprint()}_nodb.json",
        )
        legacy = _entry(cache_dir, "1_DEAGJ_DA20_0123456789ab_v3_1_2_nodb.json")
        unrelated = _entry(cache_dir, "notes.txt", age_days=365)

        removed = prune_stale_cache_entries(cache_dir=cache_dir)

        assert removed == 4
        assert sorted(p.name for p in cache_dir.iterdir()) == sorted(
            [current.name, unrelated.name]
        )
        assert not any(
            p.exists() for p in (old_version, old_parser, old_database, legacy)
        )

    def test_removes_entries_unused_for_too_long(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        fresh = _entry(cache_dir, "a" * 32 + self._current_suffix(), age_days=1)
        old = _entry(
            cache_dir, "b" * 32 + self._current_suffix(), CACHE_MAX_AGE_DAYS + 1
        )
        old_tmp = _entry(cache_dir, ".x.json.abc.tmp", CACHE_MAX_AGE_DAYS + 1)
        new_tmp = _entry(cache_dir, ".y.json.abc.tmp")

        assert prune_stale_cache_entries(cache_dir=cache_dir) == 2
        assert fresh.exists()
        assert new_tmp.exists()
        assert not old.exists()
        assert not old_tmp.exists()

    def test_loading_an_entry_renews_it(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        entry = cache_dir / ("c" * 32 + self._current_suffix())
        save_to_cache(entry, COORDS, PATHS, METADATA)
        stamp = time.time() - (CACHE_MAX_AGE_DAYS + 1) * DAY
        os.utime(entry, (stamp, stamp))

        assert load_cached_parse(entry) is not None
        assert prune_stale_cache_entries(cache_dir=cache_dir) == 0
        assert entry.exists()

    def test_get_cache_key_does_not_prune(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        legacy = _entry(cache_dir, "test_0123456789ab_v2_1111_22.json")

        get_cache_key(str(kml), cache_dir=cache_dir)

        assert legacy.exists()

    def test_missing_directory_is_ignored(self, tmp_path):
        assert prune_stale_cache_entries(cache_dir=tmp_path / "no") == 0

    def test_default_directory(self, tmp_path):
        with patch.object(parser_cache_module, "KML_CACHE_DIR", tmp_path):
            _entry(tmp_path, "legacy_0123456789ab_v2_1_2.json")
            assert prune_stale_cache_entries() == 1

    def test_vanished_entry_is_ignored(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        entry = _entry(cache_dir, "d" * 32 + self._current_suffix())
        real_stat = Path.stat

        def stat(path, *args, **kwargs):
            if path == entry:
                raise OSError("gone")
            return real_stat(path, *args, **kwargs)

        with patch.object(Path, "stat", stat):
            assert prune_stale_cache_entries(cache_dir=cache_dir) == 0

    def test_unlink_errors_are_ignored(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        _entry(cache_dir, "test_0123456789ab_v2_1111_22.json")

        with patch.object(Path, "unlink", side_effect=OSError("mock")):
            assert prune_stale_cache_entries(cache_dir=cache_dir) == 0


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
