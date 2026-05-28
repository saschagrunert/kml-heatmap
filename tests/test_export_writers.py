"""Tests for export_writers module."""

import json
import os

from kml_heatmap.export_writers import (
    collect_unique_years,
    export_airports_data,
    export_metadata,
)


class TestExportAirportsData:
    def test_valid_airports(self, tmp_path):
        airports = [
            {
                "name": "EDDS Stuttgart",
                "lat": 48.6899,
                "lon": 9.2220,
                "timestamps": ["2025-03-03T08:00:00Z"],
                "is_at_path_end": False,
            }
        ]
        filepath, size = export_airports_data(airports, str(tmp_path))
        assert os.path.exists(filepath)
        assert size > 0

        content = open(filepath).read()
        assert content.startswith("window.KML_AIRPORTS = ")
        assert content.endswith(";")
        data = json.loads(content[len("window.KML_AIRPORTS = ") : -1])
        assert len(data["airports"]) == 1
        assert data["airports"][0]["flight_count"] == 1

    def test_empty_name_filtered(self, tmp_path):
        airports = [
            {
                "name": "",
                "lat": 48.0,
                "lon": 9.0,
                "timestamps": [],
                "is_at_path_end": False,
            }
        ]
        filepath, _ = export_airports_data(airports, str(tmp_path))
        content = open(filepath).read()
        data = json.loads(content[len("window.KML_AIRPORTS = ") : -1])
        assert len(data["airports"]) == 0

    def test_duplicate_locations_deduplicated(self, tmp_path):
        airports = [
            {
                "name": "EDDS Stuttgart",
                "lat": 48.6899,
                "lon": 9.2220,
                "timestamps": ["t1"],
                "is_at_path_end": False,
            },
            {
                "name": "EDDS Stuttgart",
                "lat": 48.6899,
                "lon": 9.2220,
                "timestamps": ["t2"],
                "is_at_path_end": False,
            },
        ]
        filepath, _ = export_airports_data(airports, str(tmp_path))
        content = open(filepath).read()
        data = json.loads(content[len("window.KML_AIRPORTS = ") : -1])
        assert len(data["airports"]) == 1

    def test_strip_timestamps(self, tmp_path):
        airports = [
            {
                "name": "EDDS Stuttgart",
                "lat": 48.6899,
                "lon": 9.2220,
                "timestamps": ["2025-03-03T08:00:00Z"],
                "is_at_path_end": False,
            }
        ]
        filepath, _ = export_airports_data(
            airports, str(tmp_path), strip_timestamps=True
        )
        content = open(filepath).read()
        data = json.loads(content[len("window.KML_AIRPORTS = ") : -1])
        assert "timestamps" not in data["airports"][0]

    def test_flight_count_from_multiple_timestamps(self, tmp_path):
        airports = [
            {
                "name": "EDDS Stuttgart",
                "lat": 48.6899,
                "lon": 9.2220,
                "timestamps": ["t1", "t2", "t3"],
                "is_at_path_end": False,
            }
        ]
        filepath, _ = export_airports_data(airports, str(tmp_path))
        content = open(filepath).read()
        data = json.loads(content[len("window.KML_AIRPORTS = ") : -1])
        assert data["airports"][0]["flight_count"] == 3


class TestExportMetadata:
    def test_normal_values(self, tmp_path):
        stats = {"total_flights": 10}
        filepath, size = export_metadata(
            stats, 100.0, 5000.0, 50.0, 180.0, [2024, 2025], str(tmp_path)
        )
        assert os.path.exists(filepath)
        content = open(filepath).read()
        assert content.startswith("window.KML_METADATA = ")
        data = json.loads(content[len("window.KML_METADATA = ") : -1])
        assert data["min_alt_m"] == 100.0
        assert data["max_alt_m"] == 5000.0
        assert data["min_groundspeed_knots"] == 50.0
        assert data["max_groundspeed_knots"] == 180.0
        assert data["available_years"] == [2024, 2025]

    def test_infinite_groundspeed_clamped(self, tmp_path):
        filepath, _ = export_metadata(
            {}, 0, 1000, float("inf"), float("-inf"), [], str(tmp_path)
        )
        content = open(filepath).read()
        data = json.loads(content[len("window.KML_METADATA = ") : -1])
        assert data["min_groundspeed_knots"] == 0.0
        assert data["max_groundspeed_knots"] == 0.0

    def test_nan_groundspeed_clamped(self, tmp_path):
        filepath, _ = export_metadata(
            {}, 0, 1000, float("nan"), float("nan"), [], str(tmp_path)
        )
        content = open(filepath).read()
        data = json.loads(content[len("window.KML_METADATA = ") : -1])
        assert data["min_groundspeed_knots"] == 0.0
        assert data["max_groundspeed_knots"] == 0.0

    def test_with_file_structure(self, tmp_path):
        structure = {"2025": ["full", "medium"]}
        filepath, _ = export_metadata(
            {}, 0, 1000, 50, 180, [2025], str(tmp_path), file_structure=structure
        )
        content = open(filepath).read()
        data = json.loads(content[len("window.KML_METADATA = ") : -1])
        assert data["file_structure"] == structure

    def test_without_file_structure(self, tmp_path):
        filepath, _ = export_metadata({}, 0, 1000, 50, 180, [], str(tmp_path))
        content = open(filepath).read()
        data = json.loads(content[len("window.KML_METADATA = ") : -1])
        assert "file_structure" not in data

    def test_groundspeed_rounding(self, tmp_path):
        filepath, _ = export_metadata({}, 0, 1000, 55.678, 199.123, [], str(tmp_path))
        content = open(filepath).read()
        data = json.loads(content[len("window.KML_METADATA = ") : -1])
        assert data["min_groundspeed_knots"] == 55.7
        assert data["max_groundspeed_knots"] == 199.1


class TestCollectUniqueYears:
    def test_empty_list(self):
        assert collect_unique_years([]) == []

    def test_single_year(self):
        assert collect_unique_years([{"year": 2025}]) == [2025]

    def test_duplicate_years(self):
        metadata = [{"year": 2025}, {"year": 2025}, {"year": 2024}]
        assert collect_unique_years(metadata) == [2024, 2025]

    def test_none_years_skipped(self):
        metadata = [{"year": 2025}, {"year": None}, {"other": "data"}]
        assert collect_unique_years(metadata) == [2025]

    def test_sorted_output(self):
        metadata = [{"year": 2026}, {"year": 2024}, {"year": 2025}]
        assert collect_unique_years(metadata) == [2024, 2025, 2026]
