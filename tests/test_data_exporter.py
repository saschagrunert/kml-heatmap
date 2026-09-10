"""Tests for data_exporter module."""

import json
import os
from unittest.mock import patch

import pytest

from kml_heatmap.data_exporter import (
    YearExportResult,
    _clean_output_dir,
    _group_paths_by_year,
    _path_id_offsets,
    _process_years_parallel,
    export_all_data,
    process_year_data,
)
from kml_heatmap.export_reconciler import YearAggregate
from kml_heatmap.helpers import format_flight_time, parse_timestamp_epoch
from kml_heatmap.types import TrackPoint


def _parse_js(path):
    """Parse a 'window.X = {...};' file and return the JSON payload."""
    content = path.read_text()
    assert content.endswith(";")
    return json.loads(content[content.index("=") + 1 : -1].strip())


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


class TestProcessYearData:
    def test_writes_d1_shaped_file(self, tmp_path):
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
        data = _parse_js(tmp_path / "2025" / "data.js")
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

    def test_omits_none_valued_keys(self, tmp_path):
        path = _path((50.0, 8.0, 100.0), (50.1, 8.1, 200.0))
        process_year_data(2025, [path], [{"year": 2025}], 0, str(tmp_path))

        data = _parse_js(tmp_path / "2025" / "data.js")
        info = data["path_info"][0]
        assert "start_airport" not in info
        assert "aircraft_registration" not in info
        assert None not in info.values()
        assert all(len(row) == 4 for row in data["segments"]["0"]["rows"])

    def test_single_point_paths_are_skipped_but_counted(self, tmp_path):
        paths = [
            _path((50.0, 8.0, 100.0)),
            _path((50.0, 8.0, 100.0), (50.1, 8.1, 200.0)),
        ]
        metadata = [{"year": 2025}, {"year": 2025}]

        result = process_year_data(2025, paths, metadata, 3, str(tmp_path))

        data = _parse_js(tmp_path / "2025" / "data.js")
        assert data["original_points"] == 3
        assert [info["id"] for info in data["path_info"]] == [3]
        assert result.path_count == 1

    def test_empty_year(self, tmp_path):
        result = process_year_data(2025, [], [], 0, str(tmp_path))
        data = _parse_js(tmp_path / "2025" / "data.js")
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

    def test_fallback_groundspeed_from_metadata_duration(self, tmp_path):
        path = _path((50.0, 8.0, 100.0), (50.1, 8.1, 200.0), (50.2, 8.2, 300.0))
        metadata = [
            {
                "year": 2025,
                "timestamp": "2025-01-01T10:00:00Z",
                "end_timestamp": "2025-01-01T10:30:00Z",
            }
        ]
        process_year_data(2025, [path], metadata, 0, str(tmp_path))

        rows = _parse_js(tmp_path / "2025" / "data.js")["segments"]["0"]["rows"]
        assert all(row[3] > 0 for row in rows)
        assert all(len(row) == 4 for row in rows)

    def test_zero_length_segments_excluded(self, tmp_path):
        path = _path((50.0, 8.0, 100.0), (50.0, 8.0, 100.0), (50.1, 8.1, 200.0))
        process_year_data(2025, [path], [{"year": 2025}], 0, str(tmp_path))
        entry = _parse_js(tmp_path / "2025" / "data.js")["segments"]["0"]
        assert len(entry["rows"]) == 1
        # Dropping a zero-length segment keeps the chain contiguous
        assert entry["start"] == [50.0, 8.0]
        assert entry["rows"][0][:2] == [50.1, 8.1]

    def test_unrealistic_groundspeed_filtered(self, tmp_path):
        path = _path(
            (50.0, 8.0, 100.0, "2025-01-01T10:00:00.000Z"),
            (51.0, 9.0, 100.0, "2025-01-01T10:00:01.000Z"),
        )
        process_year_data(2025, [path], [{"year": 2025}], 0, str(tmp_path))
        rows = _parse_js(tmp_path / "2025" / "data.js")["segments"]["0"]["rows"]
        assert rows[0][3] == 0.0

    @pytest.mark.slow
    def test_large_single_path(self, tmp_path):
        count = 50_001
        path = [
            TrackPoint(50.0 + i * 0.0001, 8.0 + i * 0.0001, 100.0 + i % 50, None)
            for i in range(count)
        ]
        result = process_year_data(2025, [path], [{"year": 2025}], 0, str(tmp_path))
        assert result.original_points == count
        entry = _parse_js(tmp_path / "2025" / "data.js")["segments"]["0"]
        assert len(entry["rows"]) == count - 1


class TestGroupPathsByYear:
    def test_groups_by_year(self):
        metadata = [{"year": 2025}, {"year": 2026}, {"year": 2025}]
        assert _group_paths_by_year(metadata) == {2025: [0, 2], 2026: [1]}

    def test_paths_without_year_are_skipped(self):
        metadata = [{"year": None}, {"other": "data"}, {"year": 2024}]
        assert _group_paths_by_year(metadata) == {2024: [2]}


class TestPathIdOffsets:
    def test_offsets_follow_ascending_years_and_skip_short_paths(self):
        paths = [
            _path((50.0, 8.0, 1.0), (50.1, 8.1, 1.0)),  # 2026
            _path((50.0, 8.0, 1.0)),  # 2025, single point (not exported)
            _path((50.0, 8.0, 1.0), (50.1, 8.1, 1.0)),  # 2025
            _path((50.0, 8.0, 1.0), (50.1, 8.1, 1.0)),  # 2025
            _path((50.0, 8.0, 1.0), (50.1, 8.1, 1.0)),  # 2027
        ]
        by_year = {2026: [0], 2025: [1, 2, 3], 2027: [4]}
        assert _path_id_offsets(by_year, paths) == {2025: 0, 2026: 2, 2027: 3}


class TestProcessYearsParallel:
    def test_results_sorted_by_year_with_global_ids(self, tmp_path):
        paths = [
            _path((50.0, 8.0, 1.0), (50.1, 8.1, 1.0)),
            _path((51.0, 9.0, 1.0), (51.1, 9.1, 1.0)),
            _path((52.0, 10.0, 1.0), (52.1, 10.1, 1.0)),
        ]
        metadata = [{"year": 2026}, {"year": 2025}, {"year": 2025}]
        by_year = {2026: [0], 2025: [1, 2]}

        results = _process_years_parallel(
            by_year, paths, metadata, {2025: 0, 2026: 2}, str(tmp_path)
        )

        assert [r.year for r in results] == [2025, 2026]
        ids_2025 = [p["id"] for p in _parse_js(tmp_path / "2025/data.js")["path_info"]]
        ids_2026 = [p["id"] for p in _parse_js(tmp_path / "2026/data.js")["path_info"]]
        assert ids_2025 == [0, 1]
        assert ids_2026 == [2]

    def test_single_year_skips_pool(self, tmp_path):
        paths = [
            _path((50.0, 8.0, 1.0), (50.1, 8.1, 1.0)),
            _path((51.0, 9.0, 1.0), (51.1, 9.1, 1.0)),
        ]
        metadata = [{"year": 2025}, {"year": 2025}]
        by_year = {2025: [0, 1]}

        results = _process_years_parallel(
            by_year, paths, metadata, {2025: 0}, str(tmp_path)
        )

        assert len(results) == 1
        assert results[0].year == 2025
        data = _parse_js(tmp_path / "2025/data.js")
        assert [p["id"] for p in data["path_info"]] == [0, 1]

    def test_processing_error_is_wrapped_single_year(self, tmp_path):
        with (
            patch(
                "kml_heatmap.data_exporter.process_year_data",
                side_effect=RuntimeError("boom"),
            ),
            pytest.raises(RuntimeError, match="Failed to process year 2025"),
        ):
            _process_years_parallel(
                {2025: [0]}, [_path((50.0, 8.0, 1.0))], [{}], {2025: 0}, str(tmp_path)
            )

    def test_processing_error_is_wrapped_multi_year(self, tmp_path):
        paths = [_path((50.0, 8.0, 1.0)), _path((51.0, 9.0, 2.0))]
        with (
            patch(
                "kml_heatmap.data_exporter.process_year_data",
                side_effect=RuntimeError("boom"),
            ),
            pytest.raises(RuntimeError, match="Failed to process year"),
        ):
            _process_years_parallel(
                {2025: [0], 2026: [1]},
                paths,
                [{}, {}],
                {2025: 0, 2026: 1},
                str(tmp_path),
            )


class TestCleanOutputDir:
    def test_removes_only_tool_owned_outputs(self, tmp_path):
        (tmp_path / "airports.js").write_text("x")
        (tmp_path / "metadata.js").write_text("x")
        (tmp_path / "2025").mkdir()
        (tmp_path / "2025" / "data.js").write_text("x")
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

    def test_missing_directory_is_noop(self, tmp_path):
        _clean_output_dir(tmp_path / "missing")
        assert not (tmp_path / "missing").exists()


class TestExportAllData:
    def _stats(self):
        return {
            "total_points": 0,
            "num_paths": 0,
            "total_distance_km": 0.0,
            "max_groundspeed_knots": 0.0,
            "aircraft_list": [{"registration": "D-EAGJ"}],
        }

    def test_multi_year_export_is_consistent(self, tmp_path):
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
            },
            {"year": 2025, "airport_name": "EDDK - EDDM"},
            {"year": 2025, "airport_name": "Log Start: x"},
        ]
        stats = self._stats()

        files = export_all_data(paths, metadata, [], stats, output_dir=str(tmp_path))

        assert set(files) == {"airports", "metadata"}
        meta = _parse_js(tmp_path / "metadata.js")
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
        data_2025 = _parse_js(tmp_path / "2025" / "data.js")
        data_2026 = _parse_js(tmp_path / "2026" / "data.js")
        assert [p["id"] for p in data_2025["path_info"]] == [0]
        assert [p["id"] for p in data_2026["path_info"]] == [1]
        assert stats["total_points"] == (
            data_2025["original_points"] + data_2026["original_points"]
        )
        assert stats["num_paths"] == 2
        # Segment times are segment start times: 10:00 and 10:05 -> 300 s
        assert stats["total_flight_time_seconds"] == 300.0
        assert stats["total_flight_time_str"] == format_flight_time(300.0)
        assert stats["aircraft_list"][0]["flight_time_seconds"] == 300.0
        assert stats["aircraft_list"][0]["flight_time_str"] == "0h 5m"
        assert meta["max_groundspeed_knots"] == stats["max_groundspeed_knots"]

    def test_paths_without_year_are_excluded(self, tmp_path):
        paths = [_timed_path(), _path((51.0, 9.0, 700.0), (51.1, 9.1, 800.0))]
        metadata = [{"year": 2025}, {"year": None}]
        stats = self._stats()

        export_all_data(paths, metadata, [], stats, output_dir=str(tmp_path))

        assert sorted(p.name for p in tmp_path.iterdir()) == [
            "2025",
            "airports.js",
            "metadata.js",
        ]
        assert stats["num_paths"] == 1
        assert stats["total_points"] == 3

    def test_stale_files_are_left_and_tool_files_replaced(self, tmp_path):
        stale = tmp_path / "stale.txt"
        stale.write_text("stale")
        (tmp_path / "2019").mkdir()
        (tmp_path / "2019" / "data.js").write_text("old")

        export_all_data(
            [_timed_path()],
            [{"year": 2025}],
            [],
            self._stats(),
            output_dir=str(tmp_path),
        )

        assert stale.exists()
        assert not (tmp_path / "2019").exists()
        assert (tmp_path / "2025" / "data.js").exists()

    @pytest.mark.parametrize("dangerous", ["/", str(os.path.expanduser("~"))])
    def test_dangerous_output_dir_rejected(self, dangerous):
        with pytest.raises(ValueError, match="dangerous"):
            export_all_data([], [], [], self._stats(), output_dir=dangerous)

    def test_no_paths_produces_empty_metadata(self, tmp_path):
        stats = self._stats()
        export_all_data([], [], [], stats, output_dir=str(tmp_path))
        meta = _parse_js(tmp_path / "metadata.js")
        assert meta["available_years"] == []
        assert meta["year_file_bytes"] == {}
        assert stats["total_points"] == 0
        assert stats["min_altitude_m"] is None

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
