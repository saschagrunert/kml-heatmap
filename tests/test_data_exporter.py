"""Tests for data_exporter module."""

import os
from unittest.mock import patch

import pytest

import kml_heatmap.data_exporter as exporter_module
from kml_heatmap.data_exporter import (
    ChunkResult,
    ExportResult,
    YearExportResult,
    _assemble_year_file,
    _chunk_count,
    _clean_output_dir,
    _export_chunks,
    _group_paths_by_year,
    _part_paths,
    _plan_chunks,
    export_all_data,
    process_year_chunk,
    process_year_data,
)
from kml_heatmap.export_reconciler import YearAggregate
from kml_heatmap.helpers import format_flight_time, parse_timestamp_epoch
from kml_heatmap.types import TrackPoint


def _path(*points):
    """Build a flight path from (lat, lon, alt[, iso_timestamp]) tuples."""
    return [
        TrackPoint(
            p[0], p[1], p[2], parse_timestamp_epoch(p[3]) if len(p) > 3 else None
        )
        for p in points
    ]


def _timed_path():
    return _path(
        (50.0, 8.0, 100.0, "2025-01-01T10:00:00Z"),
        (50.1, 8.1, 200.0, "2025-01-01T10:05:00Z"),
        (50.2, 8.2, 300.0, "2025-01-01T10:10:00Z"),
    )


def _two_point_path(index):
    return _path((50.0 + index, 8.0, 100.0), (50.1 + index, 8.1, 200.0))


def _leftover_parts(directory):
    return sorted(p.name for p in directory.rglob("*.part"))


class TestProcessYearData:
    def test_writes_d1_shaped_file(self, tmp_path, parse_js):
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

        result = process_year_data(2025, [_timed_path()], metadata, 7, str(tmp_path))

        content = (tmp_path / "2025" / "data.js").read_text()
        assert content.startswith("window.KML_DATA_2025 = {")
        data = parse_js(tmp_path / "2025" / "data.js", "KML_DATA_2025")
        assert list(data) == ["year", "original_points", "path_info", "segments"]
        assert data["year"] == 2025
        assert data["original_points"] == 3
        assert data["path_info"] == [
            {
                "id": 7,
                "year": 2025,
                "start_coords": [50.0, 8.0],
                "end_coords": [50.2, 8.2],
                "segment_count": 2,
                "min_altitude_ft": 328.1,
                "max_altitude_ft": 984.3,
                "start_airport": "EDDF",
                "end_airport": "EDDM",
                "aircraft_registration": "D-EXYZ",
                "aircraft_type": "C172",
            }
        ]
        # The key order is part of the format: it is what the file:// site
        # has always shipped and what the chunk assembly reproduces
        assert list(data["path_info"][0])[:5] == [
            "id",
            "year",
            "start_coords",
            "end_coords",
            "segment_count",
        ]
        assert list(data["segments"]) == ["7"]
        entry = data["segments"]["7"]
        assert entry["start"] == [50.0, 8.0]
        rows = entry["rows"]
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
        assert result.file_bytes == (tmp_path / "2025" / "data.js").stat().st_size
        assert result.aggregate.total_points == 3
        assert result.aggregate.num_paths == 1
        assert _leftover_parts(tmp_path) == []

    def test_omits_none_valued_keys(self, tmp_path, parse_js):
        path = _path((50.0, 8.0, 100.0), (50.1, 8.1, 200.0))
        process_year_data(2025, [path], [{"year": 2025}], 0, str(tmp_path))

        data = parse_js(tmp_path / "2025" / "data.js")
        info = data["path_info"][0]
        assert "start_airport" not in info
        assert "aircraft_registration" not in info
        assert None not in info.values()
        assert all(len(row) == 4 for row in data["segments"]["0"]["rows"])

    def test_single_point_paths_are_skipped_but_counted(self, tmp_path, parse_js):
        paths = [
            _path((50.0, 8.0, 100.0)),
            _path((50.0, 8.0, 100.0), (50.1, 8.1, 200.0)),
        ]
        metadata = [{"year": 2025}, {"year": 2025}]

        result = process_year_data(2025, paths, metadata, 3, str(tmp_path))

        data = parse_js(tmp_path / "2025" / "data.js")
        assert data["original_points"] == 3
        assert [info["id"] for info in data["path_info"]] == [3]
        assert result.path_count == 1

    def test_empty_year(self, tmp_path, parse_js):
        result = process_year_data(2025, [], [], 0, str(tmp_path))
        data = parse_js(tmp_path / "2025" / "data.js")
        assert data == {
            "year": 2025,
            "original_points": 0,
            "path_info": [],
            "segments": {},
        }
        assert result.aggregate.min_groundspeed_or_zero == 0.0

    def test_quiet_flag(self, tmp_path, capsys):
        process_year_data(
            2025, [_timed_path()], [{"year": 2025}], 0, str(tmp_path), True
        )
        assert "Processing year" not in capsys.readouterr().out
        process_year_data(2025, [_timed_path()], [{"year": 2025}], 0, str(tmp_path))
        assert "Processing year 2025" in capsys.readouterr().out

    def test_fallback_groundspeed_from_metadata_duration(self, tmp_path, parse_js):
        path = _path((50.0, 8.0, 100.0), (50.1, 8.1, 200.0), (50.2, 8.2, 300.0))
        metadata = [
            {
                "year": 2025,
                "timestamp": "2025-01-01T10:00:00Z",
                "end_timestamp": "2025-01-01T10:30:00Z",
            }
        ]
        process_year_data(2025, [path], metadata, 0, str(tmp_path))

        rows = parse_js(tmp_path / "2025" / "data.js")["segments"]["0"]["rows"]
        assert all(row[3] > 0 for row in rows)
        assert all(len(row) == 4 for row in rows)

    def test_zero_length_segments_excluded(self, tmp_path, parse_js):
        path = _path((50.0, 8.0, 100.0), (50.0, 8.0, 100.0), (50.1, 8.1, 200.0))
        process_year_data(2025, [path], [{"year": 2025}], 0, str(tmp_path))
        data = parse_js(tmp_path / "2025" / "data.js")
        entry = data["segments"]["0"]
        assert len(entry["rows"]) == 1
        # Dropping a zero-length segment keeps the chain contiguous
        assert entry["start"] == [50.0, 8.0]
        assert entry["rows"][0][:2] == [50.1, 8.1]
        assert data["path_info"][0]["segment_count"] == 1

    def test_unrealistic_groundspeed_filtered(self, tmp_path, parse_js):
        path = _path(
            (50.0, 8.0, 100.0, "2025-01-01T10:00:00.000Z"),
            (51.0, 9.0, 100.0, "2025-01-01T10:00:01.000Z"),
        )
        process_year_data(2025, [path], [{"year": 2025}], 0, str(tmp_path))
        rows = parse_js(tmp_path / "2025" / "data.js")["segments"]["0"]["rows"]
        assert rows[0][3] == 0.0

    @pytest.mark.slow
    def test_large_single_path(self, tmp_path, parse_js):
        count = 50_001
        path = [
            TrackPoint(50.0 + i * 0.0001, 8.0 + i * 0.0001, 100.0 + i % 50, None)
            for i in range(count)
        ]
        result = process_year_data(2025, [path], [{"year": 2025}], 0, str(tmp_path))
        assert result.original_points == count
        entry = parse_js(tmp_path / "2025" / "data.js")["segments"]["0"]
        assert len(entry["rows"]) == count - 1


class TestProcessYearChunk:
    def test_writes_fragments(self, tmp_path):
        paths = [_two_point_path(0), _path((52.0, 10.0, 1.0)), _two_point_path(1)]
        metadata = [{"year": 2025}] * 3

        result = process_year_chunk(2025, paths, metadata, 5, str(tmp_path), index=2)

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
            aggregate=result.aggregate,
        )
        assert result.aggregate.num_paths == 2

    def test_empty_chunk_writes_empty_fragments(self, tmp_path):
        result = process_year_chunk(2025, [], [], 0, str(tmp_path))
        for part in _part_paths(str(tmp_path), 2025, 0):
            assert part.read_text() == ""
        assert result.path_count == 0


class TestAssembleYearFile:
    def test_concatenates_chunks_in_index_order(self, tmp_path, parse_js):
        second = process_year_chunk(
            2025, [_two_point_path(1)], [{"year": 2025}], 1, str(tmp_path), index=1
        )
        empty = process_year_chunk(2025, [], [], 1, str(tmp_path), index=2)
        first = process_year_chunk(
            2025, [_two_point_path(0)], [{"year": 2025}], 0, str(tmp_path), index=0
        )

        result = _assemble_year_file(2025, [second, empty, first], str(tmp_path))

        data = parse_js(tmp_path / "2025" / "data.js", "KML_DATA_2025")
        assert list(data) == ["year", "original_points", "path_info", "segments"]
        assert [info["id"] for info in data["path_info"]] == [0, 1]
        assert list(data["segments"]) == ["0", "1"]
        assert data["original_points"] == 4
        assert result.path_count == 2
        assert result.aggregate.num_paths == 2
        assert _leftover_parts(tmp_path) == []

    def test_chunked_output_equals_unchunked_output(self, tmp_path, parse_js):
        paths = [_two_point_path(i) for i in range(7)]
        metadata = [{"year": 2025, "aircraft_registration": "D-EAGJ"}] * 7
        whole = tmp_path / "whole"
        chunked = tmp_path / "chunked"

        process_year_data(2025, paths, metadata, 3, str(whole))
        chunks = [
            process_year_chunk(2025, paths[:3], metadata[:3], 3, str(chunked), 0),
            process_year_chunk(2025, paths[3:5], metadata[3:5], 6, str(chunked), 1),
            process_year_chunk(2025, paths[5:], metadata[5:], 8, str(chunked), 2),
        ]
        result = _assemble_year_file(2025, chunks, str(chunked))

        assert (chunked / "2025" / "data.js").read_bytes() == (
            whole / "2025" / "data.js"
        ).read_bytes()
        assert result.aggregate.num_paths == 7
        assert result.aggregate.aircraft_distance_km["D-EAGJ"] == pytest.approx(
            result.aggregate.total_distance_km
        )

    def test_parts_are_removed_even_when_the_write_fails(self, tmp_path):
        chunk = process_year_chunk(
            2025, [_two_point_path(0)], [{"year": 2025}], 0, str(tmp_path)
        )
        with (
            patch("kml_heatmap.cache.os.replace", side_effect=OSError("boom")),
            pytest.raises(OSError, match="boom"),
        ):
            _assemble_year_file(2025, [chunk], str(tmp_path))
        assert _leftover_parts(tmp_path) == []
        assert not (tmp_path / "2025" / "data.js").exists()


class TestGroupPathsByYear:
    def test_groups_by_year(self):
        metadata = [{"year": 2025}, {"year": 2026}, {"year": 2025}]
        assert _group_paths_by_year(metadata) == {2025: [0, 2], 2026: [1]}

    def test_paths_without_year_are_skipped(self):
        metadata = [{"year": None}, {"other": "data"}, {"year": 2024}]
        assert _group_paths_by_year(metadata) == {2024: [2]}


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

    def test_offsets_follow_ascending_years_and_skip_short_paths(self):
        paths = [
            _two_point_path(0),  # 2026
            _path((50.0, 8.0, 1.0)),  # 2025, single point (not exported)
            _two_point_path(1),  # 2025
            _two_point_path(2),  # 2025
            _two_point_path(3),  # 2027
        ]
        by_year = {2026: [0], 2025: [1, 2, 3], 2027: [4]}

        plans = _plan_chunks(by_year, paths, max_workers=4)

        assert [(p.year, p.index, p.path_indices, p.path_id_offset) for p in plans] == [
            (2025, 0, [1, 2, 3], 0),
            (2026, 0, [0], 2),
            (2027, 0, [4], 3),
        ]

    def test_chunks_continue_the_ids_within_a_year(self, monkeypatch):
        monkeypatch.setattr(exporter_module, "MIN_PATHS_PER_CHUNK", 1)
        paths = [_two_point_path(i) for i in range(5)] + [_path((50.0, 8.0, 1.0))]
        by_year = {2025: [0, 1, 2, 3, 4, 5], 2026: []}

        plans = _plan_chunks(by_year, paths, max_workers=4)

        assert [(p.year, p.index, p.path_indices, p.path_id_offset) for p in plans] == [
            (2025, 0, [0, 1, 2], 0),
            (2025, 1, [3, 4, 5], 3),
            (2026, 0, [], 5),
        ]


class TestExportChunks:
    def test_single_chunk_runs_without_a_pool(self, tmp_path, parse_js):
        paths = [_two_point_path(0), _two_point_path(1)]
        metadata = [{"year": 2025}, {"year": 2025}]
        plans = _plan_chunks({2025: [0, 1]}, paths, max_workers=4)

        with patch("kml_heatmap.data_exporter.ProcessPoolExecutor") as pool:
            results = _export_chunks(plans, paths, metadata, str(tmp_path), 4)

        pool.assert_not_called()
        assert [r.year for r in results] == [2025]
        data = parse_js(tmp_path / "2025/data.js")
        assert [p["id"] for p in data["path_info"]] == [0, 1]

    def test_results_sorted_by_year_with_global_ids(self, tmp_path, parse_js):
        paths = [_two_point_path(0), _two_point_path(1), _two_point_path(2)]
        metadata = [{"year": 2026}, {"year": 2025}, {"year": 2025}]
        plans = _plan_chunks({2026: [0], 2025: [1, 2]}, paths, max_workers=4)

        results = _export_chunks(plans, paths, metadata, str(tmp_path), 4)

        assert [r.year for r in results] == [2025, 2026]
        ids_2025 = [p["id"] for p in parse_js(tmp_path / "2025/data.js")["path_info"]]
        ids_2026 = [p["id"] for p in parse_js(tmp_path / "2026/data.js")["path_info"]]
        assert ids_2025 == [0, 1]
        assert ids_2026 == [2]
        assert _leftover_parts(tmp_path) == []

    def test_chunked_year_matches_the_unchunked_file(
        self, tmp_path, monkeypatch, parse_js
    ):
        paths = [_two_point_path(i) for i in range(6)]
        metadata = [{"year": 2025}] * 6
        whole = tmp_path / "whole"
        chunked = tmp_path / "chunked"
        _export_chunks(
            _plan_chunks({2025: list(range(6))}, paths, 1),
            paths,
            metadata,
            str(whole),
            1,
        )

        monkeypatch.setattr(exporter_module, "MIN_PATHS_PER_CHUNK", 1)
        plans = _plan_chunks({2025: list(range(6))}, paths, max_workers=3)
        assert len(plans) == 3
        results = _export_chunks(plans, paths, metadata, str(chunked), 3)

        assert (chunked / "2025/data.js").read_bytes() == (
            whole / "2025/data.js"
        ).read_bytes()
        assert results[0].path_count == 6
        assert _leftover_parts(chunked) == []

    def test_processing_error_is_wrapped_single_chunk(self, tmp_path):
        paths = [_two_point_path(0)]
        plans = _plan_chunks({2025: [0]}, paths, 4)
        with (
            patch(
                "kml_heatmap.data_exporter.process_year_chunk",
                side_effect=RuntimeError("boom"),
            ),
            pytest.raises(RuntimeError, match="Failed to process year 2025"),
        ):
            _export_chunks(plans, paths, [{}], str(tmp_path), 4)

    def test_processing_error_is_wrapped_multi_chunk(self, tmp_path):
        paths = [_two_point_path(0), _two_point_path(1)]
        plans = _plan_chunks({2025: [0], 2026: [1]}, paths, 4)
        (tmp_path / "2026").mkdir()
        stale = _part_paths(str(tmp_path), 2026, 0)[0]
        stale.write_text("partial")
        with (
            patch(
                "kml_heatmap.data_exporter.process_year_chunk",
                side_effect=RuntimeError("boom"),
            ),
            pytest.raises(RuntimeError, match="Failed to process year"),
        ):
            _export_chunks(plans, paths, [{}, {}], str(tmp_path), 4)
        # Fragments of every planned chunk are removed on failure
        assert _leftover_parts(tmp_path) == []

    def test_no_plans(self, tmp_path):
        assert _export_chunks([], [], [], str(tmp_path), 4) == []


class TestCleanOutputDir:
    def test_removes_only_tool_owned_outputs(self, tmp_path):
        (tmp_path / "airports.js").write_text("x")
        (tmp_path / "metadata.js").write_text("x")
        (tmp_path / "2025").mkdir()
        (tmp_path / "2025" / "data.js").write_text("x")
        (tmp_path / "2025" / ".data.0.info.part").write_text("stale fragment")
        (tmp_path / "notes.txt").write_text("keep me")
        (tmp_path / "photos").mkdir()
        (tmp_path / "2026").mkdir()
        (tmp_path / "2026" / "data.js").write_text("x")
        (tmp_path / "2026" / "extra.txt").write_text("keep me")

        _clean_output_dir(tmp_path)

        remaining = sorted(
            p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*")
        )
        assert remaining == ["2026", "2026/extra.txt", "notes.txt", "photos"]

    def test_symlinked_year_dir_is_left_alone(self, tmp_path):
        target = tmp_path / "elsewhere"
        target.mkdir()
        (target / "data.js").write_text("precious")
        os.symlink(target, tmp_path / "2025")

        _clean_output_dir(tmp_path)

        assert (target / "data.js").read_text() == "precious"

    def test_symlinked_tool_files_are_refused(self, tmp_path):
        target = tmp_path / "elsewhere.js"
        target.write_text("precious")
        os.symlink(target, tmp_path / "airports.js")

        with pytest.raises(ValueError, match="symlink"):
            _clean_output_dir(tmp_path)
        assert target.read_text() == "precious"

    def test_symlinked_year_data_file_is_refused(self, tmp_path):
        target = tmp_path / "elsewhere.js"
        target.write_text("precious")
        (tmp_path / "2025").mkdir()
        os.symlink(target, tmp_path / "2025" / "data.js")

        with pytest.raises(ValueError, match="symlink"):
            _clean_output_dir(tmp_path)
        assert target.read_text() == "precious"

    def test_missing_directory_is_noop(self, tmp_path):
        _clean_output_dir(tmp_path / "missing")
        assert not (tmp_path / "missing").exists()


class TestExportAllData:
    def test_multi_year_export_is_consistent(self, tmp_path, parse_js):
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

        assert isinstance(result, ExportResult)
        assert set(result.files) == {"airports", "metadata"}
        meta = parse_js(tmp_path / "metadata.js", "KML_METADATA")
        assert meta["available_years"] == [2025, 2026]
        assert set(meta) == {
            "stats",
            "min_groundspeed_knots",
            "max_groundspeed_knots",
            "available_years",
            "year_file_bytes",
        }
        assert meta["year_file_bytes"] == {
            "2025": (tmp_path / "2025" / "data.js").stat().st_size,
            "2026": (tmp_path / "2026" / "data.js").stat().st_size,
        }
        data_2025 = parse_js(tmp_path / "2025" / "data.js")
        data_2026 = parse_js(tmp_path / "2026" / "data.js")
        assert [p["id"] for p in data_2025["path_info"]] == [0]
        assert [p["id"] for p in data_2026["path_info"]] == [1]
        stats = result.stats
        assert meta["stats"] == stats
        assert stats["total_points"] == (
            data_2025["original_points"] + data_2026["original_points"]
        )
        assert stats["num_paths"] == 2
        # Segment times are segment start times: 10:00 and 10:05 -> 300 s
        assert stats["total_flight_time_seconds"] == 300.0
        assert stats["total_flight_time_str"] == format_flight_time(300.0)
        assert stats["num_aircraft"] == 1
        assert stats["aircraft_list"][0]["registration"] == "D-EAGJ"
        assert stats["aircraft_list"][0]["flights"] == 1
        assert stats["aircraft_list"][0]["flight_time_seconds"] == 300.0
        assert stats["aircraft_list"][0]["flight_time_str"] == "0h 5m"
        assert meta["max_groundspeed_knots"] == stats["max_groundspeed_knots"]
        assert stats["num_airports"] == 0
        assert _leftover_parts(tmp_path) == []

    def test_airport_names_and_models_in_stats(self, tmp_path):
        airports = [
            {"name": "EDDF Frankfurt - EDDK Cologne", "lat": 50.0, "lon": 8.5},
            {
                "name": "EDDF Frankfurt - EDDK Cologne",
                "lat": 50.9,
                "lon": 7.1,
                "is_at_path_end": True,
            },
            {"name": "Log Start: nothing", "lat": 1.0, "lon": 1.0},
        ]
        metadata = [
            {"year": 2025, "aircraft_registration": "D-EAGJ", "filename": "a.kml"}
        ]

        result = export_all_data(
            [_timed_path()],
            metadata,
            airports,
            output_dir=str(tmp_path),
            aircraft_data={"D-EAGJ": "Katana"},
        )

        assert result.stats["airport_names"] == ["EDDF Frankfurt", "EDDK Cologne"]
        assert result.stats["num_airports"] == 2
        assert result.stats["aircraft_list"][0]["model"] == "Katana"

    def test_paths_without_year_are_excluded(self, tmp_path):
        paths = [_timed_path(), _path((51.0, 9.0, 700.0), (51.1, 9.1, 800.0))]
        metadata = [{"year": 2025}, {"year": None}]

        result = export_all_data(paths, metadata, [], output_dir=str(tmp_path))

        assert sorted(p.name for p in tmp_path.iterdir()) == [
            "2025",
            "airports.js",
            "metadata.js",
        ]
        assert result.stats["num_paths"] == 1
        assert result.stats["total_points"] == 3

    def test_stale_files_are_left_and_tool_files_replaced(self, tmp_path):
        stale = tmp_path / "stale.txt"
        stale.write_text("stale")
        (tmp_path / "2019").mkdir()
        (tmp_path / "2019" / "data.js").write_text("old")

        export_all_data([_timed_path()], [{"year": 2025}], [], output_dir=str(tmp_path))

        assert stale.exists()
        assert not (tmp_path / "2019").exists()
        assert (tmp_path / "2025" / "data.js").exists()

    @pytest.mark.parametrize("dangerous", ["/", str(os.path.expanduser("~"))])
    def test_dangerous_output_dir_rejected(self, dangerous):
        with pytest.raises(ValueError, match="dangerous"):
            export_all_data([], [], [], output_dir=dangerous)

    def test_protected_directories_without_home(self):
        with patch.object(
            exporter_module.Path, "home", side_effect=RuntimeError("no home")
        ):
            assert exporter_module._protected_directories() == (
                exporter_module.Path("/"),
            )

    def test_no_paths_produces_empty_metadata(self, tmp_path, parse_js):
        result = export_all_data([], [], [], output_dir=str(tmp_path))
        meta = parse_js(tmp_path / "metadata.js")
        assert meta["available_years"] == []
        assert meta["year_file_bytes"] == {}
        assert result.stats["total_points"] == 0
        assert result.stats["min_altitude_m"] is None

    def test_aggregate_merge_matches_single_year(self, tmp_path):
        """Merging per-year aggregates equals aggregating everything at once."""
        paths = [_timed_path(), _path((51.0, 9.0, 700.0), (51.1, 9.1, 800.0))]
        one_year = process_year_data(
            2025, paths, [{"year": 2025}] * 2, 0, str(tmp_path)
        )
        year_a = process_year_data(2025, paths[:1], [{"year": 2025}], 0, str(tmp_path))
        year_b = process_year_data(2026, paths[1:], [{"year": 2026}], 1, str(tmp_path))

        merged = YearAggregate()
        merged.merge(year_a.aggregate)
        merged.merge(year_b.aggregate)

        assert merged == one_year.aggregate
