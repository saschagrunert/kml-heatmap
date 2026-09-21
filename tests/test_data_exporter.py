"""Tests for data_exporter module."""

import errno
import os
import tempfile
import threading
import time
from concurrent.futures import Future
from unittest.mock import patch

import pytest

import kml_heatmap.data_exporter as exporter_module
from kml_heatmap.data_exporter import (
    PATH_ID_BITS,
    STAGING_PREFIX,
    ChunkResult,
    ExportResult,
    GroundspeedRange,
    SiteOutput,
    YearExportResult,
    _assemble_year_file,
    _chunk_count,
    _export_chunks,
    _group_paths_by_year,
    _part_paths,
    _plan_chunks,
    assign_path_ids,
    drop_duplicate_paths,
    export_all_data,
    path_content_id,
    process_year_chunk,
)
from kml_heatmap.exceptions import KMLHeatmapError
from kml_heatmap.helpers import parse_timestamp_epoch
from kml_heatmap.segment_codec import FORMAT_VERSION
from kml_heatmap.types import TrackPoint
from tests.conftest import decoded_segments

skip_as_root = pytest.mark.skipif(
    os.geteuid() == 0, reason="root ignores directory permissions"
)


def _path(*points):
    """Build a flight path from (lat, lon, alt[, iso_timestamp]) tuples."""
    return [
        TrackPoint(
            p[0], p[1], p[2], parse_timestamp_epoch(p[3]) if len(p) > 3 else None
        )
        for p in points
    ]


def _timed_path(offset=0.0):
    return _path(
        (50.0 + offset, 8.0, 100.0, "2025-01-01T10:00:00Z"),
        (50.1 + offset, 8.1, 200.0, "2025-01-01T10:05:00Z"),
        (50.2 + offset, 8.2, 300.0, "2025-01-01T10:10:00Z"),
    )


def _two_point_path(index):
    return _path((50.0 + index, 8.0, 100.0), (50.1 + index, 8.1, 200.0))


def _leftover_parts(directory):
    return sorted(p.name for p in directory.rglob("*.part"))


def _write_year(year, paths, metadata, path_ids, output_dir):
    """Export a year as a single chunk, the way a small year is exported."""
    chunk = process_year_chunk(year, paths, metadata, path_ids, str(output_dir))
    return _assemble_year_file(year, [chunk], str(output_dir))


def _ids_by_start(output_dir, parse_data):
    """Path id by the start point of its segments, over every year file."""
    ids = {}
    for data_file in sorted(output_dir.glob("*/data.json")):
        for path_id, entry in parse_data(data_file)["segments"].items():
            start, _ = decoded_segments(entry)
            ids[tuple(start)] = int(path_id)
    return ids


class TestYearFile:
    def test_writes_d1_shaped_file(self, tmp_path, parse_data):
        metadata = [
            {
                "year": 2025,
                "airport_name": "EDDF - EDDM",
                "timestamp": "2025-01-01T10:00:00Z",
                "end_timestamp": "2025-01-01T10:10:00Z",
                "aircraft_registration": "D-EXYZ",
                "aircraft_type": "C172",
            }
        ]

        result = _write_year(2025, [_timed_path()], metadata, [7], tmp_path)

        content = (tmp_path / "2025" / "data.json").read_text()
        assert content.startswith('{"format":')
        data = parse_data(tmp_path / "2025" / "data.json")
        assert list(data) == [
            "format",
            "year",
            "original_points",
            "path_info",
            "segments",
        ]
        assert data["year"] == 2025
        assert data["original_points"] == 3
        assert data["path_info"] == [
            {
                "id": 7,
                "year": 2025,
                "min_altitude_ft": 328.1,
                "max_altitude_ft": 984.3,
                "start_airport": "EDDF",
                "end_airport": "EDDM",
                "aircraft_registration": "D-EXYZ",
                "aircraft_type": "C172",
            }
        ]
        # The key order is part of the format: it is what the site has
        # always shipped and what the chunk assembly reproduces
        assert list(data["path_info"][0])[:4] == [
            "id",
            "year",
            "min_altitude_ft",
            "max_altitude_ft",
        ]
        assert data["format"] == FORMAT_VERSION
        assert list(data["segments"]) == ["7"]
        entry = data["segments"]["7"]
        # On disk: scaled integers, each row the difference to the one
        # before, written column by column
        assert entry["start"] == [5000000, 800000]
        lats, lons, altitudes, _, times = entry["columns"]
        assert (lats[0], lons[0]) == (10000, 10000)
        assert altitudes[0] == 5
        assert times == [0, 3000]
        start, rows = decoded_segments(entry)
        assert start == [50.0, 8.0]
        assert len(rows) == 2
        assert rows[0][:2] == [50.1, 8.1]
        assert rows[0][2] == 500
        assert rows[0][4] == 0.0
        assert rows[1][4] == 300.0
        assert all(len(row) == 5 for row in rows)

        assert isinstance(result, YearExportResult)
        assert result.year == 2025
        assert result.path_count == 1
        assert result.original_points == 3
        assert result.file_bytes == (tmp_path / "2025" / "data.json").stat().st_size
        speeds = [row[3] for row in rows]
        assert result.groundspeed == GroundspeedRange(min(speeds), max(speeds))
        assert _leftover_parts(tmp_path) == []

    def test_omits_none_valued_keys(self, tmp_path, parse_data):
        path = _path((50.0, 8.0, 100.0), (50.1, 8.1, 200.0))
        _write_year(2025, [path], [{"year": 2025}], [0], tmp_path)

        data = parse_data(tmp_path / "2025" / "data.json")
        info = data["path_info"][0]
        assert "start_airport" not in info
        assert "aircraft_registration" not in info
        assert None not in info.values()
        # Without relative times there is no time column at all
        assert len(data["segments"]["0"]["columns"]) == 4

    def test_paths_without_an_id_are_skipped_but_counted(self, tmp_path, parse_data):
        paths = [
            _path((50.0, 8.0, 100.0)),
            _path((50.0, 8.0, 100.0), (50.1, 8.1, 200.0)),
        ]
        metadata = [{"year": 2025}, {"year": 2025}]

        result = _write_year(2025, paths, metadata, [None, 3], tmp_path)

        data = parse_data(tmp_path / "2025" / "data.json")
        assert data["original_points"] == 3
        assert [info["id"] for info in data["path_info"]] == [3]
        assert result.path_count == 1

    def test_empty_year(self, tmp_path, parse_data):
        result = _write_year(2025, [], [], [], tmp_path)
        data = parse_data(tmp_path / "2025" / "data.json")
        assert data == {
            "format": FORMAT_VERSION,
            "year": 2025,
            "original_points": 0,
            "path_info": [],
            "segments": {},
        }
        assert result.groundspeed == GroundspeedRange()

    def test_fallback_groundspeed_from_metadata_duration(self, tmp_path, parse_data):
        path = _path((50.0, 8.0, 100.0), (50.1, 8.1, 200.0), (50.2, 8.2, 300.0))
        metadata = [
            {
                "year": 2025,
                "timestamp": "2025-01-01T10:00:00Z",
                "end_timestamp": "2025-01-01T10:30:00Z",
            }
        ]
        _write_year(2025, [path], metadata, [0], tmp_path)

        entry = parse_data(tmp_path / "2025" / "data.json")["segments"]["0"]
        _, rows = decoded_segments(entry)
        assert all(row[3] > 0 for row in rows)
        assert all(len(row) == 4 for row in rows)

    def test_zero_length_segments_excluded(self, tmp_path, parse_data):
        path = _path((50.0, 8.0, 100.0), (50.0, 8.0, 100.0), (50.1, 8.1, 200.0))
        _write_year(2025, [path], [{"year": 2025}], [0], tmp_path)
        data = parse_data(tmp_path / "2025" / "data.json")
        entry = data["segments"]["0"]
        assert len(entry["columns"][0]) == 1
        # Dropping a zero-length segment keeps the chain contiguous
        start, rows = decoded_segments(entry)
        assert start == [50.0, 8.0]
        assert rows[0][:2] == [50.1, 8.1]

    def test_unrealistic_groundspeed_filtered(self, tmp_path, parse_data):
        path = _path(
            (50.0, 8.0, 100.0, "2025-01-01T10:00:00.000Z"),
            (51.0, 9.0, 100.0, "2025-01-01T10:00:01.000Z"),
        )
        result = _write_year(2025, [path], [{"year": 2025}], [0], tmp_path)
        entry = parse_data(tmp_path / "2025" / "data.json")["segments"]["0"]
        _, rows = decoded_segments(entry)
        assert rows[0][3] == 0.0
        # A row without a speed does not pull the range down to zero
        assert result.groundspeed == GroundspeedRange()

    @pytest.mark.slow
    def test_large_single_path(self, tmp_path, parse_data):
        count = 50_001
        path = [
            TrackPoint(50.0 + i * 0.0001, 8.0 + i * 0.0001, 100.0 + i % 50, None)
            for i in range(count)
        ]
        result = _write_year(2025, [path], [{"year": 2025}], [0], tmp_path)
        assert result.original_points == count
        entry = parse_data(tmp_path / "2025" / "data.json")["segments"]["0"]
        assert len(entry["columns"][0]) == count - 1


class TestGroundspeedRange:
    def test_merge_does_not_depend_on_the_order(self):
        parts = [
            GroundspeedRange(40.0, 120.0),
            GroundspeedRange(),
            GroundspeedRange(12.5, 90.0),
        ]
        forward, backward = GroundspeedRange(), GroundspeedRange()
        for part in parts:
            forward.merge(part)
        for part in reversed(parts):
            backward.merge(part)
        assert forward == backward == GroundspeedRange(12.5, 120.0)

    def test_empty_ranges_stay_empty(self):
        merged = GroundspeedRange()
        merged.merge(GroundspeedRange())
        assert merged == GroundspeedRange(None, 0.0)


class TestPathIds:
    def test_content_id_is_a_stable_40_bit_integer(self):
        path_id = path_content_id(_two_point_path(0))
        assert path_id == path_content_id(_two_point_path(0))
        assert 0 <= path_id < 2**PATH_ID_BITS
        # Exact in JavaScript, where the ids end up
        assert path_id <= 2**53 - 1
        # Pinned: ids are persisted in shared links and saved state, so a
        # change of the derivation has to be deliberate (and bump
        # STATE_SCHEMA_VERSION in the frontend)
        assert path_id == 840108108563

    def test_content_id_follows_the_exported_precision(self):
        base = path_content_id(_two_point_path(0))
        # Below the five exported decimals the path is the same
        jitter = _path((50.000001, 8.0, 100.0), (50.1, 8.100002, 200.0))
        assert path_content_id(jitter) == base
        # A moved point or a different altitude is a different path
        moved = _path((50.0, 8.0, 100.0), (50.1, 8.2, 200.0))
        climbed = _path((50.0, 8.0, 100.0), (50.1, 8.1, 250.0))
        assert path_content_id(moved) != base
        assert path_content_id(climbed) != base

    def test_content_id_ignores_the_timestamps(self):
        """Obfuscation shifts the dates; the flight stays the same."""
        untimed = _path((50.0, 8.0, 100.0), (50.1, 8.1, 200.0), (50.2, 8.2, 300.0))
        assert path_content_id(_timed_path()) == path_content_id(untimed)

    def test_only_exported_paths_get_an_id(self):
        paths = [_two_point_path(0), _path((52.0, 10.0, 1.0)), _two_point_path(1)]
        ids = assign_path_ids({2025: [0, 1], 2026: [2]}, paths)
        assert ids == {
            0: path_content_id(paths[0]),
            2: path_content_id(paths[2]),
        }

    def test_a_taken_id_moves_to_the_next_free_one_in_input_order(self):
        paths = [_two_point_path(1), _two_point_path(0), _two_point_path(0)]
        # The later year comes first in the input: input order decides
        ids = assign_path_ids({2026: [1, 2], 2025: [0]}, paths)
        first = path_content_id(paths[1])
        assert ids[1] == first
        assert ids[2] == first + 1
        assert ids[0] == path_content_id(paths[0])

    def test_a_collision_wraps_around_the_id_space(self, monkeypatch):
        monkeypatch.setattr(
            exporter_module, "path_content_id", lambda path: 2**PATH_ID_BITS - 1
        )
        paths = [_two_point_path(0), _two_point_path(1), _two_point_path(2)]
        assert assign_path_ids({2025: [0, 1, 2]}, paths) == {
            0: 2**PATH_ID_BITS - 1,
            1: 0,
            2: 1,
        }

    def test_removing_a_path_keeps_the_ids_of_the_others(self, tmp_path, parse_data):
        paths = [_timed_path(offset) for offset in range(5)]
        metadata = [{"year": 2025}, {"year": 2026}, {"year": 2025}] + [
            {"year": 2026}
        ] * 2
        export_all_data(paths, metadata, [], output_dir=str(tmp_path / "all"))
        del paths[2], metadata[2]
        export_all_data(paths, metadata, [], output_dir=str(tmp_path / "fewer"))

        before = _ids_by_start(tmp_path / "all", parse_data)
        after = _ids_by_start(tmp_path / "fewer", parse_data)
        assert len(before) == 5
        del before[(52.0, 8.0)]
        assert after == before


class TestAirportEndpoints:
    def test_ends_without_a_marker_are_not_exported(self, tmp_path, parse_data):
        """An end counts as an airport if and only if it has a marker."""
        paths = [_timed_path()]
        metadata = [
            {
                "year": 2025,
                "airport_name": "Home - Aunt Martha",
                "start_airport": "Home",
                "end_airport": "Aunt Martha",
            }
        ]
        airports = [
            {"name": "Home", "lat": 50.0, "lon": 8.0},
            {"name": "Aunt Martha", "lat": 50.2, "lon": 8.2, "is_at_path_end": True},
        ]
        export_all_data(paths, metadata, airports, output_dir=str(tmp_path))
        markers = parse_data(tmp_path / "airports.json")["airports"]
        info = parse_data(tmp_path / "2025" / "data.json")["path_info"]
        assert [marker["name"] for marker in markers] == ["Aunt Martha"]
        assert "start_airport" not in info[0]
        assert info[0]["end_airport"] == "Aunt Martha"


class TestDropDuplicatePaths:
    def test_same_flight_under_two_names_is_exported_once(
        self, tmp_path, parse_data, capsys
    ):
        paths = [_timed_path(), _timed_path(1.0), _timed_path()]
        metadata = [
            {"year": 2025, "filename": "1_DEAGJ_DA20.kml"},
            {"year": 2025, "filename": "2_DEAGJ_DA20.kml"},
            {"year": 2025, "filename": "copy of 1_DEAGJ_DA20.kml"},
        ]
        export_all_data(paths, metadata, [], output_dir=str(tmp_path))
        year = parse_data(tmp_path / "2025" / "data.json")
        assert [info["id"] for info in year["path_info"]] == [
            path_content_id(paths[0]),
            path_content_id(paths[1]),
        ]
        assert year["original_points"] == 6
        err = capsys.readouterr().err
        assert "copy of 1_DEAGJ_DA20.kml" in err
        assert "same flight as in 1_DEAGJ_DA20.kml" in err

    def test_content_is_compared_not_the_hash(self, monkeypatch):
        """Two flights that share a hash are still two flights."""
        monkeypatch.setattr(exporter_module, "path_content_id", lambda path: 7)
        paths = [_two_point_path(0), _two_point_path(1)]
        kept = drop_duplicate_paths({2025: [0, 1]}, paths, [{}, {}])
        assert kept == {2025: [0, 1]}
        assert assign_path_ids(kept, paths) == {0: 7, 1: 8}

    def test_across_years_the_first_in_input_order_is_kept(self):
        paths = [_two_point_path(0), _two_point_path(0)]
        kept = drop_duplicate_paths({2026: [0], 2025: [1]}, paths, [{}, {}])
        assert kept == {2026: [0]}

    def test_paths_that_are_not_exported_are_left_alone(self):
        paths = [_path((52.0, 10.0, 1.0)), _path((52.0, 10.0, 1.0)), _two_point_path(0)]
        kept = drop_duplicate_paths({2025: [0, 1, 2]}, paths, [{}] * 3)
        assert kept == {2025: [0, 1, 2]}


class TestProcessYearChunk:
    def test_writes_fragments(self, tmp_path):
        paths = [_two_point_path(0), _path((52.0, 10.0, 1.0)), _two_point_path(1)]
        metadata = [{"year": 2025}] * 3

        result = process_year_chunk(
            2025, paths, metadata, [5, None, 6], str(tmp_path), index=2
        )

        info_part, segments_part = _part_paths(str(tmp_path), 2025, 2)
        assert info_part.name == ".data.2.info.part"
        assert segments_part.name == ".data.2.segments.part"
        info = info_part.read_text()
        segments = segments_part.read_text()
        assert info.startswith('{"id":5,')
        assert '},{"id":6,' in info
        assert segments.startswith('"5":{"start":[')
        assert ',"6":{"start":[' in segments
        assert not info.endswith(",")
        assert result == ChunkResult(
            year=2025,
            index=2,
            path_count=2,
            original_points=5,
            groundspeed=GroundspeedRange(),
        )

    def test_paths_keep_the_input_order_whatever_their_ids(self, tmp_path):
        paths = [_two_point_path(0), _two_point_path(1)]
        process_year_chunk(2025, paths, [{"year": 2025}] * 2, [9, 2], str(tmp_path))
        info_part, segments_part = _part_paths(str(tmp_path), 2025, 0)
        assert info_part.read_text().index('"id":9') < info_part.read_text().index(
            '"id":2'
        )
        assert segments_part.read_text().startswith('"9":')

    def test_empty_chunk_writes_empty_fragments(self, tmp_path):
        result = process_year_chunk(2025, [], [], [], str(tmp_path))
        for part in _part_paths(str(tmp_path), 2025, 0):
            assert part.read_text() == ""
        assert result.path_count == 0


class TestAssembleYearFile:
    def test_concatenates_chunks_in_index_order(self, tmp_path, parse_data):
        second = process_year_chunk(
            2025, [_two_point_path(1)], [{"year": 2025}], [1], str(tmp_path), index=1
        )
        empty = process_year_chunk(2025, [], [], [], str(tmp_path), index=2)
        first = process_year_chunk(
            2025, [_two_point_path(0)], [{"year": 2025}], [0], str(tmp_path), index=0
        )

        result = _assemble_year_file(2025, [second, empty, first], str(tmp_path))

        data = parse_data(tmp_path / "2025" / "data.json")
        assert list(data) == [
            "format",
            "year",
            "original_points",
            "path_info",
            "segments",
        ]
        assert [info["id"] for info in data["path_info"]] == [0, 1]
        assert list(data["segments"]) == ["0", "1"]
        assert data["original_points"] == 4
        assert result.path_count == 2
        assert _leftover_parts(tmp_path) == []

    def test_merges_the_groundspeed_ranges_of_the_chunks(self, tmp_path):
        chunks = [
            process_year_chunk(2025, [], [], [], str(tmp_path), index=index)
            for index in range(3)
        ]
        chunks[0].groundspeed = GroundspeedRange(35.0, 96.0)
        chunks[2].groundspeed = GroundspeedRange(20.5, 80.0)

        result = _assemble_year_file(2025, chunks, str(tmp_path))

        assert result.groundspeed == GroundspeedRange(20.5, 96.0)

    def test_chunked_output_equals_unchunked_output(self, tmp_path):
        paths = [_two_point_path(i) for i in range(7)]
        metadata = [{"year": 2025, "aircraft_registration": "D-EAGJ"}] * 7
        ids = list(range(3, 10))
        whole = tmp_path / "whole"
        chunked = tmp_path / "chunked"

        _write_year(2025, paths, metadata, ids, whole)
        chunks = [
            process_year_chunk(2025, paths[:3], metadata[:3], ids[:3], str(chunked), 0),
            process_year_chunk(
                2025, paths[3:5], metadata[3:5], ids[3:5], str(chunked), 1
            ),
            process_year_chunk(2025, paths[5:], metadata[5:], ids[5:], str(chunked), 2),
        ]
        result = _assemble_year_file(2025, chunks, str(chunked))

        assert (chunked / "2025" / "data.json").read_bytes() == (
            whole / "2025" / "data.json"
        ).read_bytes()
        assert result.path_count == 7

    def test_parts_are_removed_even_when_the_write_fails(self, tmp_path):
        chunk = process_year_chunk(
            2025, [_two_point_path(0)], [{"year": 2025}], [0], str(tmp_path)
        )
        with (
            patch("kml_heatmap.cache.os.replace", side_effect=OSError("boom")),
            pytest.raises(OSError, match="boom"),
        ):
            _assemble_year_file(2025, [chunk], str(tmp_path))
        assert _leftover_parts(tmp_path) == []
        assert not (tmp_path / "2025" / "data.json").exists()


class TestGroupPathsByYear:
    def test_groups_by_year(self):
        paths = [_two_point_path(i) for i in range(3)]
        metadata = [{"year": 2025}, {"year": 2026}, {"year": 2025}]
        assert _group_paths_by_year(paths, metadata) == {2025: [0, 2], 2026: [1]}

    def test_paths_without_year_are_skipped(self):
        paths = [_two_point_path(i) for i in range(3)]
        metadata = [{"year": None}, {"other": "data"}, {"year": 2024}]
        assert _group_paths_by_year(paths, metadata) == {2024: [2]}

    def test_a_year_without_exportable_paths_is_not_listed(self):
        """Single point markers (Log Start/Stop) must not make an empty year."""
        marker = _path((51.5, 12.0, 20.0))
        paths = [marker, marker, marker, _timed_path()]
        metadata = [{"year": 2024}, {"year": 2024}, {"year": 2025}, {"year": 2025}]
        assert _group_paths_by_year(paths, metadata) == {2025: [2, 3]}

    def test_a_path_that_does_not_move_is_not_exported(self):
        """Jitter below the exported precision makes no segment row."""
        standing = _path(
            (51.500001, 12.000001, 100.0),
            (51.500002, 11.999999, 100.0),
            (51.499999, 12.000002, 101.0),
        )
        paths = [standing, _timed_path()]
        metadata = [{"year": 2024}, {"year": 2025}]
        assert _group_paths_by_year(paths, metadata) == {2025: [1]}


class TestChunkPlanning:
    @pytest.mark.parametrize(
        "paths,years,workers,expected",
        [
            (10, 1, 8, 1),  # too few paths to split
            (100, 1, 8, 2),  # 100 // 50 chunks of at least 50 paths
            (100_000, 2, 8, 4),  # 8 workers over 2 years
            (100_000, 16, 8, 1),  # more years than workers
            (0, 1, 8, 1),
        ],
    )
    def test_chunk_count(self, paths, years, workers, expected):
        assert _chunk_count(paths, years, workers) == expected

    def test_plans_follow_ascending_years_and_carry_the_path_ids(self):
        by_year = {2026: [0], 2025: [1, 2, 3], 2027: [4]}
        # Path 1 is not exported, so it has no id
        ids = {0: 70, 2: 50, 3: 10, 4: 30}

        plans = _plan_chunks(by_year, ids, max_workers=4)

        assert [(p.year, p.index, p.path_indices, p.path_ids) for p in plans] == [
            (2025, 0, [1, 2, 3], [None, 50, 10]),
            (2026, 0, [0], [70]),
            (2027, 0, [4], [30]),
        ]

    def test_chunks_split_a_year_in_input_order(self, monkeypatch):
        monkeypatch.setattr(exporter_module, "MIN_PATHS_PER_CHUNK", 1)
        by_year = {2025: [0, 1, 2, 3, 4, 5], 2026: []}
        ids = {index: 100 - index for index in range(5)}

        plans = _plan_chunks(by_year, ids, max_workers=4)

        assert [(p.year, p.index, p.path_indices, p.path_ids) for p in plans] == [
            (2025, 0, [0, 1, 2], [100, 99, 98]),
            (2025, 1, [3, 4, 5], [97, 96, None]),
            (2026, 0, [], []),
        ]


def _failing_chunk(*args):
    """A picklable process_year_chunk stand-in that always fails.

    A MagicMock cannot be pickled, and a work item that fails to pickle can
    deadlock ProcessPoolExecutor.shutdown(wait=True).
    """
    raise RuntimeError("boom")


class _RunningChunksPool:
    """A process pool stand-in whose first chunk fails with a full disk.

    The other chunks count as already running: like in a real pool they only
    finish, and write their fragments, once the pool is shut down.
    """

    def __init__(self, *args, **kwargs):
        self.running = []
        self.submitted = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.shutdown()
        return False

    def submit(self, fn, *args):
        future = Future()
        self.submitted += 1
        if self.submitted == 1:
            future.set_exception(OSError(errno.ENOSPC, "No space left on device"))
        else:
            self.running.append((future, fn, args))
        return future

    def shutdown(self, wait=True, cancel_futures=False):
        for future, fn, args in self.running:
            future.set_result(fn(*args))
        self.running = []


class _CountingPool:
    """A process pool stand-in that finishes each chunk on a thread shortly
    after it was submitted and records how many were in flight at once."""

    def __init__(self, *args, **kwargs):
        self.submitted = 0
        self.in_flight = 0
        self.max_in_flight = 0
        self.lock = threading.Lock()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def submit(self, fn, *args):
        future = Future()
        with self.lock:
            self.submitted += 1
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)

        def run():
            time.sleep(0.005)
            result = fn(*args)
            with self.lock:
                self.in_flight -= 1
            future.set_result(result)

        threading.Thread(target=run).start()
        return future


class TestExportChunks:
    def test_single_chunk_runs_without_a_pool(self, tmp_path, parse_data):
        paths = [_two_point_path(0), _two_point_path(1)]
        metadata = [{"year": 2025}, {"year": 2025}]
        plans = _plan_chunks({2025: [0, 1]}, {0: 0, 1: 1}, max_workers=4)

        with patch("kml_heatmap.data_exporter.ProcessPoolExecutor") as pool:
            results = _export_chunks(plans, paths, metadata, str(tmp_path), 4)

        pool.assert_not_called()
        assert [r.year for r in results] == [2025]
        data = parse_data(tmp_path / "2025/data.json")
        assert [p["id"] for p in data["path_info"]] == [0, 1]

    def test_results_sorted_by_year_with_their_ids(self, tmp_path, parse_data):
        paths = [_two_point_path(0), _two_point_path(1), _two_point_path(2)]
        metadata = [{"year": 2026}, {"year": 2025}, {"year": 2025}]
        ids = {0: 30, 1: 20, 2: 10}
        plans = _plan_chunks({2026: [0], 2025: [1, 2]}, ids, max_workers=4)

        results = _export_chunks(plans, paths, metadata, str(tmp_path), 4)

        assert [r.year for r in results] == [2025, 2026]
        ids_2025 = [
            p["id"] for p in parse_data(tmp_path / "2025/data.json")["path_info"]
        ]
        ids_2026 = [
            p["id"] for p in parse_data(tmp_path / "2026/data.json")["path_info"]
        ]
        assert ids_2025 == [20, 10]
        assert ids_2026 == [30]
        assert _leftover_parts(tmp_path) == []

    def test_chunked_year_matches_the_unchunked_file(
        self, tmp_path, monkeypatch, parse_data
    ):
        paths = [_two_point_path(i) for i in range(6)]
        metadata = [{"year": 2025}] * 6
        ids = {index: 1000 + index for index in range(6)}
        whole = tmp_path / "whole"
        chunked = tmp_path / "chunked"
        _export_chunks(
            _plan_chunks({2025: list(range(6))}, ids, 1),
            paths,
            metadata,
            str(whole),
            1,
        )

        monkeypatch.setattr(exporter_module, "MIN_PATHS_PER_CHUNK", 1)
        plans = _plan_chunks({2025: list(range(6))}, ids, max_workers=3)
        assert len(plans) == 3
        results = _export_chunks(plans, paths, metadata, str(chunked), 3)

        assert (chunked / "2025/data.json").read_bytes() == (
            whole / "2025/data.json"
        ).read_bytes()
        assert results[0].path_count == 6
        assert _leftover_parts(chunked) == []

    def test_processing_error_is_wrapped_single_chunk(self, tmp_path, capsys):
        paths = [_two_point_path(0)]
        plans = _plan_chunks({2025: [0]}, {0: 0}, 4)
        with (
            patch(
                "kml_heatmap.data_exporter.process_year_chunk",
                side_effect=RuntimeError("boom"),
            ),
            pytest.raises(RuntimeError, match="Failed to process year 2025: boom"),
        ):
            _export_chunks(plans, paths, [{}], str(tmp_path), 4)
        # An unexpected error keeps its traceback for the bug report
        assert "Traceback" in capsys.readouterr().err

    def test_processing_error_is_wrapped_multi_chunk(self, tmp_path):
        paths = [_two_point_path(0), _two_point_path(1)]
        plans = _plan_chunks({2025: [0], 2026: [1]}, {0: 0, 1: 1}, 4)
        (tmp_path / "2026").mkdir()
        stale = _part_paths(str(tmp_path), 2026, 0)[0]
        stale.write_text("partial")
        with (
            patch("kml_heatmap.data_exporter.process_year_chunk", _failing_chunk),
            pytest.raises(RuntimeError, match="Failed to process year"),
        ):
            _export_chunks(plans, paths, [{}, {}], str(tmp_path), 4)
        # Fragments of every planned chunk are removed on failure
        assert _leftover_parts(tmp_path) == []

    def test_failed_chunk_waits_for_running_chunks_before_cleaning_up(
        self, tmp_path, capsys
    ):
        paths = [_two_point_path(i) for i in range(4)]
        metadata = [{"year": 2026}] * 4
        plans = _plan_chunks(
            {2026: [0], 2027: [1], 2028: [2], 2029: [3]},
            {index: index for index in range(4)},
            4,
        )
        pool = _RunningChunksPool()

        with (
            patch("kml_heatmap.data_exporter.ProcessPoolExecutor", return_value=pool),
            pytest.raises(RuntimeError, match="No space left on device"),
        ):
            _export_chunks(plans, paths, metadata, str(tmp_path), 4)

        assert _leftover_parts(tmp_path) == []
        # An expected error is one line, without a traceback
        assert "Traceback" not in capsys.readouterr().err

    def test_no_plans(self, tmp_path):
        assert _export_chunks([], [], [], str(tmp_path), 4) == []

    def test_chunks_are_handed_to_the_pool_a_few_at_a_time(
        self, tmp_path, monkeypatch, parse_data
    ):
        """Submitting every chunk at once would pickle the whole dataset into
        the executor's queue while the main process still holds it."""
        years = list(range(2020, 2028))
        paths = [_two_point_path(i) for i in range(len(years))]
        metadata = [{"year": year} for year in years]
        monkeypatch.setattr(exporter_module, "MIN_PATHS_PER_CHUNK", 1)
        plans = _plan_chunks(
            {year: [index] for index, year in enumerate(years)},
            {index: index for index in range(len(years))},
            max_workers=2,
        )
        assert len(plans) == len(years)
        pool = _CountingPool()

        with patch("kml_heatmap.data_exporter.ProcessPoolExecutor", return_value=pool):
            results = _export_chunks(plans, paths, metadata, str(tmp_path), 2)

        assert [r.year for r in results] == years
        assert pool.submitted == len(years)
        assert pool.max_in_flight <= 2 * exporter_module.MAX_QUEUED_CHUNKS_PER_WORKER
        assert _leftover_parts(tmp_path) == []
        for year in years:
            assert len(parse_data(tmp_path / f"{year}/data.json")["path_info"]) == 1


def _stage_site(site, years=(2025,), version="new"):
    """Write a minimal site into the staging directories of ``site``."""
    for year in years:
        (site.data_stage / str(year)).mkdir()
        (site.data_stage / str(year) / "data.json").write_text(f"{version} {year}")
    (site.data_stage / "airports.json").write_text(f"{version} airports")
    (site.data_stage / "metadata.json").write_text(f"{version} metadata")
    (site.site_stage / "index.html").write_text(f"{version} page")
    (site.site_stage / "manifest.json").write_text(f"{version} manifest")


def _publish_site(out, years=(2025,), version="old"):
    with SiteOutput(out, out / "data", ("manifest.json",)) as site:
        _stage_site(site, years, version)
        site.publish(years)


def _tree(directory):
    """Every file and symlink below ``directory`` with its content or target."""
    tree = {}
    for path in sorted(directory.rglob("*")):
        name = path.relative_to(directory).as_posix()
        if path.is_symlink():
            tree[name] = f"-> {os.readlink(path)}"
        elif path.is_file():
            tree[name] = path.read_text()
    return tree


def _stages(directory):
    return sorted(
        p.name for p in directory.rglob("*") if p.name.startswith(STAGING_PREFIX)
    )


class TestSiteOutput:
    def test_publishes_the_staged_files(self, tmp_path):
        out = tmp_path / "out"

        with SiteOutput(out, out / "data") as site:
            assert site.site_stage.parent == out
            assert site.data_stage.parent == out / "data"
            assert site.site_stage.name.startswith(STAGING_PREFIX)
            _stage_site(site, years=(2025, 2026))
            site.publish([2025, 2026])

        assert _tree(out) == {
            "data/2025/data.json": "new 2025",
            "data/2026/data.json": "new 2026",
            "data/airports.json": "new airports",
            "data/metadata.json": "new metadata",
            "index.html": "new page",
            "manifest.json": "new manifest",
        }
        assert _stages(out) == []

    def test_a_second_run_on_the_same_output_is_refused(self, tmp_path):
        """It would delete the staging directories of the running one."""
        out = tmp_path / "out"
        with SiteOutput(out, out / "data") as site:
            with (
                pytest.raises(KMLHeatmapError, match="Another run"),
                SiteOutput(out, out / "data"),
            ):
                pass
            # The first run still has its stages and publishes normally
            _stage_site(site)
            site.publish([2025])

        assert _tree(out)["index.html"] == "new page"
        # Released on exit
        _publish_site(out)

    def test_runs_unguarded_where_locks_are_not_supported(self, tmp_path):
        out = tmp_path / "out"
        with patch(
            "kml_heatmap.data_exporter.fcntl.flock",
            side_effect=OSError(errno.ENOLCK, "No locks available"),
        ):
            _publish_site(out)
        assert _tree(out)["index.html"] == "old page"

    def test_an_incomplete_stage_is_not_published(self, tmp_path):
        out = tmp_path / "out"
        _publish_site(out)
        previous = _tree(out)

        with SiteOutput(out, out / "data") as site:
            _stage_site(site)
            (site.site_stage / "index.html").unlink()
            with pytest.raises(KMLHeatmapError, match=r"index\.html missing"):
                site.publish([2025])

        assert _tree(out) == previous

    def test_a_failed_run_leaves_the_previous_site(self, tmp_path):
        out = tmp_path / "out"
        _publish_site(out)
        previous = _tree(out)

        def run_out_of_space():
            with SiteOutput(out, out / "data") as site:
                _stage_site(site, years=(2026,))
                raise OSError(errno.ENOSPC, "No space left on device")

        with pytest.raises(OSError, match="No space"):
            run_out_of_space()

        assert _tree(out) == previous
        assert _stages(out) == []

    def test_script_data_of_earlier_versions_is_removed(self, tmp_path):
        """A site from when the page loaded its data with script tags."""
        out = tmp_path / "out"
        _publish_site(out, years=(2019, 2025))
        data = out / "data"
        for legacy in ("airports.js", "metadata.js", "2019/data.js", "2025/data.js"):
            (data / legacy).write_text("window.KML = {};")

        with SiteOutput(out, data) as site:
            _stage_site(site)
            site.publish([2025])

        assert _tree(out) == {
            "data/2025/data.json": "new 2025",
            "data/airports.json": "new airports",
            "data/metadata.json": "new metadata",
            "index.html": "new page",
            "manifest.json": "new manifest",
        }

    def test_stale_outputs_are_removed_and_foreign_files_kept(self, tmp_path, capsys):
        out = tmp_path / "out"
        _publish_site(out, years=(2019, 2025))
        data = out / "data"
        (data / "2019" / ".data.0.info.part").write_text("fragment")
        (data / "2025" / ".data.1.segments.part").write_text("fragment")
        (data / "unknown").mkdir()
        (data / "unknown" / "data.json").write_text("old versions")
        (data / "2018").mkdir()
        (data / "2018" / "data.json").write_text("old")
        (data / "2018" / "notes.txt").write_text("keep me")
        (data / "notes.txt").write_text("keep me")
        (out / "CNAME").write_text("keep me")

        with SiteOutput(out, data, ("manifest.json", "styles.css")) as site:
            _stage_site(site)
            (site.site_stage / "manifest.json").unlink()
            site.publish([2025])

        assert _tree(out) == {
            "CNAME": "keep me",
            "data/2018/notes.txt": "keep me",
            "data/2025/data.json": "new 2025",
            "data/airports.json": "new airports",
            "data/metadata.json": "new metadata",
            "data/notes.txt": "keep me",
            "index.html": "new page",
        }
        err = capsys.readouterr().err
        assert "Leaving non-empty year directory" in err
        assert "Leaving unexpected item in output directory" in err

    @pytest.mark.parametrize(
        "sabotage",
        [
            pytest.param(
                lambda out, victim: (out / "data" / "metadata.json").symlink_to(victim),
                id="symlinked-metadata",
            ),
            pytest.param(
                lambda out, victim: (out / "manifest.json").symlink_to(victim),
                id="symlinked-site-file",
            ),
            pytest.param(
                lambda out, victim: (out / "data" / "2026").symlink_to(victim.parent),
                id="symlinked-year-dir",
            ),
            pytest.param(
                lambda out, victim: (out / "data" / "2026").write_text("a file"),
                id="file-in-place-of-a-year-dir",
            ),
            pytest.param(
                lambda out, victim: (out / "data" / "2026" / "data.json").mkdir(
                    parents=True
                ),
                id="directory-in-place-of-a-file",
            ),
        ],
    )
    def test_refusals_come_before_anything_is_moved(self, tmp_path, sabotage):
        out = tmp_path / "out"
        _publish_site(out)
        (out / "manifest.json").unlink()
        (out / "data" / "metadata.json").unlink()
        victim = tmp_path / "victim" / "data.json"
        victim.parent.mkdir()
        victim.write_text("precious")
        sabotage(out, victim)
        previous = _tree(out)

        with SiteOutput(out, out / "data") as site:
            _stage_site(site, years=(2025, 2026))
            with pytest.raises(ValueError, match="Refusing"):
                site.publish([2025, 2026])

        assert _tree(out) == previous
        assert victim.read_text() == "precious"
        assert _stages(out) == []

    def test_stale_symlinks_are_left_alone(self, tmp_path, capsys):
        out = tmp_path / "out"
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "data.json").write_text("precious")
        (out / "data" / "2020").mkdir(parents=True)
        (out / "data" / "2019").symlink_to(elsewhere)
        (out / "data" / "2020" / "data.json").symlink_to(elsewhere / "data.json")
        (out / "mapApp.bundle.js.map").symlink_to(elsewhere / "data.json")

        with SiteOutput(out, out / "data", ("mapApp.bundle.js.map",)) as site:
            _stage_site(site)
            site.publish([2025])

        assert (elsewhere / "data.json").read_text() == "precious"
        assert (out / "data" / "2019").is_symlink()
        assert (out / "data" / "2020" / "data.json").is_symlink()
        assert (out / "mapApp.bundle.js.map").is_symlink()
        assert "Leaving symlink in output directory" in capsys.readouterr().err

    def test_flags_of_countries_no_longer_visited_are_removed(self, tmp_path):
        """A stale flag would give away the country of a removed flight."""
        out = tmp_path / "out"
        (out / "flags").mkdir(parents=True)
        for code in ("de", "fr"):
            (out / "flags" / f"{code}.svg").write_text("old")
        (out / "flags" / "notes.txt").write_text("mine")

        with SiteOutput(out, out / "data", (), ("flags/*.svg",)) as site:
            _stage_site(site)
            (site.site_stage / "flags").mkdir()
            (site.site_stage / "flags" / "de.svg").write_text("new")
            site.publish([2025])

        assert sorted(p.name for p in (out / "flags").iterdir()) == [
            "de.svg",
            "notes.txt",
        ]
        assert (out / "flags" / "de.svg").read_text() == "new"

    def test_empty_flags_directory_is_removed(self, tmp_path):
        out = tmp_path / "out"
        (out / "flags").mkdir(parents=True)
        (out / "flags" / "de.svg").write_text("old")

        with SiteOutput(out, out / "data", (), ("flags/*.svg",)) as site:
            _stage_site(site)
            site.publish([2025])

        assert not (out / "flags").exists()

    def test_symlinked_flags_directory_is_not_searched(self, tmp_path):
        out = tmp_path / "out"
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "de.svg").write_text("precious")
        out.mkdir()
        (out / "flags").symlink_to(elsewhere)

        with SiteOutput(out, out / "data", (), ("flags/*.svg",)) as site:
            _stage_site(site)
            site.publish([2025])

        assert (elsewhere / "de.svg").read_text() == "precious"

    @skip_as_root
    def test_unwritable_directory_is_refused_before_anything_is_moved(self, tmp_path):
        out = tmp_path / "out"
        _publish_site(out)
        previous = _tree(out)

        with SiteOutput(out, out / "data") as site:
            _stage_site(site, years=(2025, 2026))
            (out / "data").chmod(0o555)
            try:
                with pytest.raises(PermissionError):
                    site.publish([2025, 2026])
            finally:
                (out / "data").chmod(0o755)

        assert _tree(out) == previous

    @skip_as_root
    def test_stale_file_that_cannot_be_removed_is_a_warning(self, tmp_path, capsys):
        out = tmp_path / "out"
        _publish_site(out, years=(2019, 2025))
        (out / "data" / "2019").chmod(0o555)
        try:
            _publish_site(out, version="new")
        finally:
            (out / "data" / "2019").chmod(0o755)

        assert (out / "data" / "2019" / "data.json").exists()
        assert (out / "data" / "2025" / "data.json").read_text() == "new 2025"
        assert "Could not remove stale output" in capsys.readouterr().err

    def test_stages_of_killed_runs_are_removed(self, tmp_path):
        out = tmp_path / "out"
        for leftover in (out, out / "data"):
            stage = leftover / f"{STAGING_PREFIX}killed"
            stage.mkdir(parents=True)
            (stage / "index.html").write_text("half written")

        _publish_site(out)

        assert _stages(out) == []
        assert (out / "index.html").read_text() == "old page"

    def test_failing_to_create_a_stage_removes_the_other(self, tmp_path):
        out = tmp_path / "out"
        real_mkdtemp = tempfile.mkdtemp

        def mkdtemp(**kwargs):
            if _stages(out):
                raise OSError(errno.ENOSPC, "No space left on device")
            return real_mkdtemp(**kwargs)

        with (
            patch("kml_heatmap.data_exporter.tempfile.mkdtemp", mkdtemp),
            pytest.raises(OSError, match="No space"),
            SiteOutput(out, out / "data"),
        ):
            pass

        assert (out / "data").is_dir()
        assert _stages(out) == []

    @pytest.mark.parametrize("dangerous", ["/", str(os.path.expanduser("~"))])
    def test_dangerous_data_dir_rejected(self, tmp_path, dangerous):
        with pytest.raises(ValueError, match="dangerous"):
            SiteOutput(tmp_path, dangerous)

    @pytest.mark.parametrize("dangerous", ["/", str(os.path.expanduser("~"))])
    def test_dangerous_output_dir_rejected(self, dangerous):
        with pytest.raises(ValueError, match="dangerous"):
            SiteOutput(dangerous, os.path.join(dangerous, "data"))

    def test_protected_directories_without_home(self):
        with patch.object(
            exporter_module.Path, "home", side_effect=RuntimeError("no home")
        ):
            assert exporter_module.protected_directories() == (
                exporter_module.Path("/"),
            )

    def test_runs_unguarded_without_fcntl(self, tmp_path, monkeypatch):
        """Windows has no fcntl; the export works without the lock."""
        monkeypatch.setattr(exporter_module, "fcntl", None)
        out = tmp_path / "out"
        _publish_site(out)
        assert _tree(out)["index.html"] == "old page"
        # A second run is not detected, but nothing breaks either
        with SiteOutput(out, out / "data"), SiteOutput(out, out / "data"):
            pass


class TestExportAllData:
    def test_multi_year_export_is_consistent(self, tmp_path, parse_data):
        paths = [
            _timed_path(),
            _path((51.0, 9.0, 700.0), (51.1, 9.1, 800.0)),
            _path((52.0, 10.0, 1.0)),
        ]
        metadata = [
            {
                "year": 2026,
                "airport_name": "EDDF - EDDM",
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "1_DEAGJ_DA20.kml",
            },
            {"year": 2025, "airport_name": "EDDK - EDDM"},
            {"year": 2025, "airport_name": "Log Start: x"},
        ]

        result = export_all_data(paths, metadata, [], output_dir=str(tmp_path))

        assert result == ExportResult(years=[2025, 2026], countries=[])
        meta = parse_data(tmp_path / "metadata.json")
        data_2025 = parse_data(tmp_path / "2025" / "data.json")
        data_2026 = parse_data(tmp_path / "2026" / "data.json")
        _, rows_2026 = decoded_segments(
            data_2026["segments"][str(path_content_id(paths[0]))]
        )
        speeds = [row[3] for row in rows_2026]
        assert meta == {
            "aircraft_models": {},
            "available_flags": [],
            "available_years": [2025, 2026],
            "max_groundspeed_knots": max(speeds),
            "min_groundspeed_knots": min(speeds),
            "year_file_bytes": {
                "2025": (tmp_path / "2025" / "data.json").stat().st_size,
                "2026": (tmp_path / "2026" / "data.json").stat().st_size,
            },
        }
        assert [p["id"] for p in data_2025["path_info"]] == [path_content_id(paths[1])]
        assert [p["id"] for p in data_2026["path_info"]] == [path_content_id(paths[0])]
        assert data_2025["original_points"] == 3
        assert _leftover_parts(tmp_path) == []

    def test_aircraft_models_of_the_exported_paths(self, tmp_path, parse_data):
        paths = [_timed_path(), _path((52.0, 10.0, 1.0)), _timed_path(1.0)]
        metadata = [
            {"year": 2025, "aircraft_registration": "D-EAGJ"},
            # A single point is not exported, so neither is its aircraft
            {"year": 2025, "aircraft_registration": "D-EHYL"},
            {"year": 2025, "aircraft_registration": "D-ESST"},
        ]

        export_all_data(
            paths,
            metadata,
            [],
            output_dir=str(tmp_path),
            aircraft_data={"D-EAGJ": "Katana", "D-EHYL": "Star", "D-XXXX": "Other"},
        )

        meta = parse_data(tmp_path / "metadata.json")
        assert meta["aircraft_models"] == {"D-EAGJ": "Katana"}

    def test_paths_without_year_are_excluded(self, tmp_path, parse_data):
        paths = [_timed_path(), _path((51.0, 9.0, 700.0), (51.1, 9.1, 800.0))]
        metadata = [{"year": 2025}, {"year": None}]

        export_all_data(paths, metadata, [], output_dir=str(tmp_path))

        assert sorted(p.name for p in tmp_path.iterdir()) == [
            "2025",
            "airports.json",
            "metadata.json",
        ]
        data = parse_data(tmp_path / "2025" / "data.json")
        assert [info["id"] for info in data["path_info"]] == [path_content_id(paths[0])]
        assert data["original_points"] == 3

    def test_year_with_only_point_markers_is_not_exported(self, tmp_path, parse_data):
        paths = [_path((51.5, 12.0, 20.0)), _path((51.5, 12.0, 20.0)), _timed_path()]
        metadata = [{"year": 2024}, {"year": 2024}, {"year": 2025}]

        result = export_all_data(paths, metadata, [], output_dir=str(tmp_path))

        assert result.years == [2025]
        assert parse_data(tmp_path / "metadata.json")["available_years"] == [2025]
        assert not (tmp_path / "2024").exists()

    def test_no_paths_produces_empty_metadata(self, tmp_path, parse_data):
        result = export_all_data([], [], [], output_dir=str(tmp_path))
        assert result.years == []
        assert parse_data(tmp_path / "metadata.json") == {
            "aircraft_models": {},
            "available_flags": [],
            "available_years": [],
            "max_groundspeed_knots": 0.0,
            "min_groundspeed_knots": 0.0,
            "year_file_bytes": {},
        }

    def test_output_does_not_depend_on_the_worker_count(self, tmp_path, monkeypatch):
        """One worker or several, chunked or not: the files are byte identical."""
        paths = [_timed_path(offset / 10) for offset in range(6)]
        paths.append(_path((52.0, 10.0, 1.0)))
        metadata = [
            {"year": 2025 + index % 2, "aircraft_registration": "D-EAGJ"}
            for index in range(len(paths))
        ]
        monkeypatch.setattr(exporter_module, "MIN_PATHS_PER_CHUNK", 1)

        trees = []
        for cpu_count in (1, 4):
            output_dir = tmp_path / str(cpu_count)
            with patch(
                "kml_heatmap.data_exporter.os.process_cpu_count",
                return_value=cpu_count,
            ):
                export_all_data(
                    paths,
                    metadata,
                    [],
                    output_dir=str(output_dir),
                    aircraft_data={"D-EAGJ": "Katana"},
                )
            trees.append(
                {
                    path.relative_to(output_dir).as_posix(): path.read_bytes()
                    for path in sorted(output_dir.rglob("*"))
                    if path.is_file()
                }
            )

        assert sorted(trees[0]) == [
            "2025/data.json",
            "2026/data.json",
            "airports.json",
            "metadata.json",
        ]
        assert trees[0] == trees[1]
