"""Unit tests for parallel path processing functions."""

import os
import json
import tempfile
import shutil
from unittest.mock import patch

import pytest

from kml_heatmap.data_exporter import process_single_path, aggregate_results_by_year
from kml_heatmap.constants import RESOLUTION_LEVELS


class TestProcessSinglePath:
    """Test suite for process_single_path function."""

    @pytest.fixture
    def sample_path(self):
        """Sample path with altitude and timestamps."""
        return [
            [50.0, 8.0, 100.0, "2025-01-01T10:00:00Z"],
            [50.1, 8.1, 200.0, "2025-01-01T10:05:00Z"],
            [50.2, 8.2, 300.0, "2025-01-01T10:10:00Z"],
            [50.3, 8.3, 400.0, "2025-01-01T10:15:00Z"],
        ]

    @pytest.fixture
    def sample_metadata(self):
        """Sample path metadata."""
        return {
            "year": 2025,
            "airport_name": "EDDF Frankfurt - EDDM Munich",
            "timestamp": "2025-01-01T10:00:00Z",
            "end_timestamp": "2025-01-01T10:15:00Z",
            "aircraft_registration": "D-EAGJ",
            "aircraft_type": "DA20",
        }

    @pytest.fixture
    def epsilon_values(self):
        """Sample epsilon values for all resolutions."""
        return {
            "z14_plus": 0.0,
            "z11_13": 0.0001,
            "z8_10": 0.0002,
            "z5_7": 0.0003,
            "z0_4": 0.0004,
        }

    def test_basic_path_processing(self, sample_path, sample_metadata, epsilon_values):
        """Test basic path processing with valid data."""
        args = (
            0,  # path_idx
            sample_path,
            sample_metadata,
            0.0,  # min_alt_m
            1000.0,  # max_alt_m
            RESOLUTION_LEVELS,
            ["z14_plus", "z11_13", "z8_10", "z5_7", "z0_4"],
            epsilon_values,
        )

        result = process_single_path(args)

        assert result is not None
        assert result["path_idx"] == 0
        assert result["year"] == "2025"
        assert "resolution_data" in result
        assert len(result["resolution_data"]) == 5

    def test_single_point_path_returns_none(self, sample_metadata, epsilon_values):
        """Test that single-point paths return None."""
        single_point_path = [[50.0, 8.0, 100.0]]

        args = (
            0,
            single_point_path,
            sample_metadata,
            0.0,
            1000.0,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            epsilon_values,
        )

        result = process_single_path(args)
        assert result is None

    def test_empty_path_returns_none(self, sample_metadata, epsilon_values):
        """Test that empty paths return None."""
        args = (
            0,
            [],
            sample_metadata,
            0.0,
            1000.0,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            epsilon_values,
        )

        result = process_single_path(args)
        assert result is None

    def test_airport_extraction(self, sample_path, sample_metadata, epsilon_values):
        """Test that airport names are correctly extracted."""
        args = (
            0,
            sample_path,
            sample_metadata,
            0.0,
            1000.0,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            epsilon_values,
        )

        result = process_single_path(args)
        path_info = result["resolution_data"]["z14_plus"]["path_info"]

        assert path_info["start_airport"] == "EDDF Frankfurt"
        assert path_info["end_airport"] == "EDDM Munich"

    def test_aircraft_metadata_extraction(self, sample_path, sample_metadata, epsilon_values):
        """Test that aircraft metadata is correctly extracted."""
        args = (
            0,
            sample_path,
            sample_metadata,
            0.0,
            1000.0,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            epsilon_values,
        )

        result = process_single_path(args)
        path_info = result["resolution_data"]["z14_plus"]["path_info"]

        assert path_info["aircraft_registration"] == "D-EAGJ"
        assert path_info["aircraft_type"] == "DA20"

    def test_missing_metadata(self, sample_path, epsilon_values):
        """Test path processing with minimal metadata."""
        minimal_metadata = {}

        args = (
            0,
            sample_path,
            minimal_metadata,
            0.0,
            1000.0,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            epsilon_values,
        )

        result = process_single_path(args)

        assert result is not None
        path_info = result["resolution_data"]["z14_plus"]["path_info"]
        assert path_info["start_airport"] is None
        assert path_info["end_airport"] is None

    def test_segment_structure(self, sample_path, sample_metadata, epsilon_values):
        """Test that segments have correct structure."""
        args = (
            0,
            sample_path,
            sample_metadata,
            0.0,
            1000.0,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            epsilon_values,
        )

        result = process_single_path(args)
        segments = result["resolution_data"]["z14_plus"]["segments"]

        assert len(segments) > 0
        for segment in segments:
            assert "coords" in segment
            assert "color" in segment
            assert "altitude_ft" in segment
            assert "altitude_m" in segment
            assert "groundspeed_knots" in segment
            assert "path_id" in segment
            assert len(segment["coords"]) == 2

    def test_multiple_resolutions(self, sample_path, sample_metadata, epsilon_values):
        """Test that all resolutions are processed."""
        resolution_order = ["z14_plus", "z11_13", "z8_10", "z5_7", "z0_4"]

        args = (
            0,
            sample_path,
            sample_metadata,
            0.0,
            1000.0,
            RESOLUTION_LEVELS,
            resolution_order,
            epsilon_values,
        )

        result = process_single_path(args)

        for res_name in resolution_order:
            assert res_name in result["resolution_data"]
            assert "segments" in result["resolution_data"][res_name]
            assert "path_info" in result["resolution_data"][res_name]
            assert "downsampled_coords" in result["resolution_data"][res_name]

    def test_epsilon_zero_no_downsampling(self, sample_path, sample_metadata):
        """Test that epsilon=0 means no downsampling."""
        epsilon_values = {res: 0.0 for res in ["z14_plus", "z11_13", "z8_10", "z5_7", "z0_4"]}

        args = (
            0,
            sample_path,
            sample_metadata,
            0.0,
            1000.0,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            epsilon_values,
        )

        result = process_single_path(args)
        coords = result["resolution_data"]["z14_plus"]["downsampled_coords"]

        # Should have same number of points as original path
        assert len(coords) == len(sample_path)

    def test_groundspeed_calculation(self, sample_path, sample_metadata, epsilon_values):
        """Test that groundspeed is calculated for segments."""
        args = (
            0,
            sample_path,
            sample_metadata,
            0.0,
            1000.0,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            epsilon_values,
        )

        result = process_single_path(args)
        z14_data = result["resolution_data"]["z14_plus"]

        # Should have groundspeed statistics
        assert "max_groundspeed" in z14_data
        assert "min_groundspeed" in z14_data
        assert z14_data["max_groundspeed"] >= 0

    def test_cruise_altitude_tracking(self, epsilon_values):
        """Test cruise altitude histogram tracking."""
        # Create path with high altitude cruise
        cruise_path = [
            [50.0, 8.0, 100.0, "2025-01-01T10:00:00Z"],
            [50.1, 8.1, 1500.0, "2025-01-01T10:05:00Z"],  # Above 1000ft AGL
            [50.2, 8.2, 1500.0, "2025-01-01T10:10:00Z"],
            [50.3, 8.3, 100.0, "2025-01-01T10:15:00Z"],
        ]

        metadata = {
            "year": 2025,
            "timestamp": "2025-01-01T10:00:00Z",
            "end_timestamp": "2025-01-01T10:15:00Z",
        }

        args = (0, cruise_path, metadata, 0.0, 2000.0, RESOLUTION_LEVELS, ["z14_plus"], epsilon_values)

        result = process_single_path(args)
        z14_data = result["resolution_data"]["z14_plus"]

        assert "cruise_altitude_histogram" in z14_data

    def test_year_extraction(self, sample_path, epsilon_values):
        """Test year extraction from metadata."""
        metadata_with_year = {"year": 2026}
        metadata_without_year = {}

        args_with = (0, sample_path, metadata_with_year, 0.0, 1000.0, RESOLUTION_LEVELS, ["z14_plus"], epsilon_values)
        args_without = (0, sample_path, metadata_without_year, 0.0, 1000.0, RESOLUTION_LEVELS, ["z14_plus"], epsilon_values)

        result_with = process_single_path(args_with)
        result_without = process_single_path(args_without)

        assert result_with["year"] == "2026"
        assert result_without["year"] == "unknown"


class TestAggregateResultsByYear:
    """Test suite for aggregate_results_by_year function."""

    @pytest.fixture
    def temp_output_dir(self):
        """Create a temporary output directory."""
        temp_dir = tempfile.mkdtemp()
        yield temp_dir
        shutil.rmtree(temp_dir)

    @pytest.fixture
    def sample_path_results(self):
        """Sample results from process_single_path."""
        return [
            {
                "path_idx": 0,
                "year": "2025",
                "resolution_data": {
                    "z14_plus": {
                        "segments": [
                            {
                                "coords": [[50.0, 8.0], [50.1, 8.1]],
                                "color": "#ff0000",
                                "altitude_ft": 328,
                                "altitude_m": 100,
                                "groundspeed_knots": 120.0,
                                "path_id": 0,
                            }
                        ],
                        "path_info": {
                            "id": 0,
                            "start_airport": "EDDF",
                            "end_airport": "EDDM",
                            "start_coords": [50.0, 8.0],
                            "end_coords": [50.1, 8.1],
                            "segment_count": 1,
                            "year": 2025,
                        },
                        "downsampled_coords": [[50.0, 8.0], [50.1, 8.1]],
                        "max_groundspeed": 120.0,
                        "min_groundspeed": 120.0,
                        "cruise_distance": 10.0,
                        "cruise_time": 300.0,
                        "cruise_altitude_histogram": {4000: 300.0},
                        "path_distance_nm": 50.0,
                    }
                },
            },
            {
                "path_idx": 1,
                "year": "2025",
                "resolution_data": {
                    "z14_plus": {
                        "segments": [
                            {
                                "coords": [[51.0, 9.0], [51.1, 9.1]],
                                "color": "#00ff00",
                                "altitude_ft": 656,
                                "altitude_m": 200,
                                "groundspeed_knots": 100.0,
                                "path_id": 1,
                            }
                        ],
                        "path_info": {
                            "id": 1,
                            "start_airport": "EDDM",
                            "end_airport": "EDDF",
                            "start_coords": [51.0, 9.0],
                            "end_coords": [51.1, 9.1],
                            "segment_count": 1,
                            "year": 2025,
                        },
                        "downsampled_coords": [[51.0, 9.0], [51.1, 9.1]],
                        "max_groundspeed": 100.0,
                        "min_groundspeed": 100.0,
                        "cruise_distance": 5.0,
                        "cruise_time": 200.0,
                        "cruise_altitude_histogram": {3000: 200.0},
                        "path_distance_nm": 30.0,
                    }
                },
            },
        ]

    def test_basic_aggregation(self, sample_path_results, temp_output_dir):
        """Test basic year aggregation."""
        year_results = aggregate_results_by_year(
            sample_path_results,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            temp_output_dir,
        )

        assert len(year_results) == 1
        assert year_results[0]["year"] == "2025"

    def test_multiple_years(self, temp_output_dir):
        """Test aggregation with multiple years."""
        path_results = [
            {
                "path_idx": 0,
                "year": "2025",
                "resolution_data": {
                    "z14_plus": {
                        "segments": [{"coords": [[50.0, 8.0], [50.1, 8.1]], "color": "#ff0000", "altitude_ft": 328, "altitude_m": 100, "groundspeed_knots": 120.0, "path_id": 0}],
                        "path_info": {"id": 0, "start_airport": None, "end_airport": None, "start_coords": [50.0, 8.0], "end_coords": [50.1, 8.1], "segment_count": 1, "year": 2025},
                        "downsampled_coords": [[50.0, 8.0], [50.1, 8.1]],
                        "max_groundspeed": 120.0,
                        "min_groundspeed": 120.0,
                        "cruise_distance": 0,
                        "cruise_time": 0,
                        "cruise_altitude_histogram": {},
                        "path_distance_nm": 50.0,
                    }
                },
            },
            {
                "path_idx": 1,
                "year": "2026",
                "resolution_data": {
                    "z14_plus": {
                        "segments": [{"coords": [[51.0, 9.0], [51.1, 9.1]], "color": "#00ff00", "altitude_ft": 656, "altitude_m": 200, "groundspeed_knots": 100.0, "path_id": 1}],
                        "path_info": {"id": 1, "start_airport": None, "end_airport": None, "start_coords": [51.0, 9.0], "end_coords": [51.1, 9.1], "segment_count": 1, "year": 2026},
                        "downsampled_coords": [[51.0, 9.0], [51.1, 9.1]],
                        "max_groundspeed": 100.0,
                        "min_groundspeed": 100.0,
                        "cruise_distance": 0,
                        "cruise_time": 0,
                        "cruise_altitude_histogram": {},
                        "path_distance_nm": 30.0,
                    }
                },
            },
        ]

        year_results = aggregate_results_by_year(
            path_results,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            temp_output_dir,
        )

        assert len(year_results) == 2
        years = {r["year"] for r in year_results}
        assert years == {"2025", "2026"}

    def test_statistics_aggregation(self, sample_path_results, temp_output_dir):
        """Test that statistics are correctly aggregated."""
        year_results = aggregate_results_by_year(
            sample_path_results,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            temp_output_dir,
        )

        result = year_results[0]

        # Check aggregated statistics
        assert result["max_groundspeed"] == 120.0  # Max of 120 and 100
        assert result["min_groundspeed"] == 100.0  # Min of 120 and 100
        assert result["cruise_distance"] == 15.0  # Sum of 10 and 5
        assert result["cruise_time"] == 500.0  # Sum of 300 and 200
        assert result["max_path_distance"] == 50.0  # Max of 50 and 30

    def test_cruise_altitude_histogram_merge(self, sample_path_results, temp_output_dir):
        """Test that cruise altitude histograms are merged."""
        year_results = aggregate_results_by_year(
            sample_path_results,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            temp_output_dir,
        )

        result = year_results[0]
        histogram = result["cruise_altitude_histogram"]

        assert 4000 in histogram
        assert 3000 in histogram
        assert histogram[4000] == 300.0
        assert histogram[3000] == 200.0

    def test_path_id_remapping(self, sample_path_results, temp_output_dir):
        """Test that path IDs are remapped sequentially."""
        year_results = aggregate_results_by_year(
            sample_path_results,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            temp_output_dir,
        )

        # Check that files were written
        year_dir = os.path.join(temp_output_dir, "2025")
        assert os.path.exists(year_dir)

        # Read the z14_plus file
        z14_file = os.path.join(year_dir, "z14_plus.js")
        assert os.path.exists(z14_file)

        with open(z14_file, "r") as f:
            content = f.read()
            # Remove JS wrapper
            json_str = content.replace("window.KML_DATA_2025_Z14_PLUS = ", "").rstrip(";")
            data = json.loads(json_str)

        # Path IDs should be 0, 1 (sequential)
        path_ids = [seg["path_id"] for seg in data["path_segments"]]
        assert 0 in path_ids
        assert 1 in path_ids

    def test_file_export(self, sample_path_results, temp_output_dir):
        """Test that files are correctly exported."""
        year_results = aggregate_results_by_year(
            sample_path_results,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            temp_output_dir,
        )

        # Check year directory was created
        year_dir = os.path.join(temp_output_dir, "2025")
        assert os.path.exists(year_dir)

        # Check z14_plus.js exists
        z14_file = os.path.join(year_dir, "z14_plus.js")
        assert os.path.exists(z14_file)

        # Verify file format
        with open(z14_file, "r") as f:
            content = f.read()
            assert content.startswith("window.KML_DATA_2025_Z14_PLUS = ")
            assert content.endswith(";")

    def test_sorted_output(self, temp_output_dir):
        """Test that paths are sorted by path_idx for deterministic output."""
        # Create results in non-sorted order
        path_results = [
            {
                "path_idx": 2,
                "year": "2025",
                "resolution_data": {
                    "z14_plus": {
                        "segments": [{"coords": [[52.0, 10.0], [52.1, 10.1]], "color": "#0000ff", "altitude_ft": 328, "altitude_m": 100, "groundspeed_knots": 110.0, "path_id": 2}],
                        "path_info": {"id": 2, "start_airport": None, "end_airport": None, "start_coords": [52.0, 10.0], "end_coords": [52.1, 10.1], "segment_count": 1, "year": 2025},
                        "downsampled_coords": [[52.0, 10.0], [52.1, 10.1]],
                        "max_groundspeed": 110.0,
                        "min_groundspeed": 110.0,
                        "cruise_distance": 0,
                        "cruise_time": 0,
                        "cruise_altitude_histogram": {},
                        "path_distance_nm": 40.0,
                    }
                },
            },
            {
                "path_idx": 0,
                "year": "2025",
                "resolution_data": {
                    "z14_plus": {
                        "segments": [{"coords": [[50.0, 8.0], [50.1, 8.1]], "color": "#ff0000", "altitude_ft": 328, "altitude_m": 100, "groundspeed_knots": 120.0, "path_id": 0}],
                        "path_info": {"id": 0, "start_airport": None, "end_airport": None, "start_coords": [50.0, 8.0], "end_coords": [50.1, 8.1], "segment_count": 1, "year": 2025},
                        "downsampled_coords": [[50.0, 8.0], [50.1, 8.1]],
                        "max_groundspeed": 120.0,
                        "min_groundspeed": 120.0,
                        "cruise_distance": 0,
                        "cruise_time": 0,
                        "cruise_altitude_histogram": {},
                        "path_distance_nm": 50.0,
                    }
                },
            },
        ]

        aggregate_results_by_year(
            path_results,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            temp_output_dir,
        )

        # Read output and verify order
        z14_file = os.path.join(temp_output_dir, "2025", "z14_plus.js")
        with open(z14_file, "r") as f:
            content = f.read()
            json_str = content.replace("window.KML_DATA_2025_Z14_PLUS = ", "").rstrip(";")
            data = json.loads(json_str)

        # First path should have been path_idx=0 originally
        # It should now be remapped to id=0
        assert data["path_info"][0]["id"] == 0

    def test_empty_results(self, temp_output_dir):
        """Test handling of empty results list."""
        year_results = aggregate_results_by_year(
            [],
            RESOLUTION_LEVELS,
            ["z14_plus"],
            temp_output_dir,
        )

        assert year_results == []

    def test_none_results_filtered(self, temp_output_dir):
        """Test that None results are filtered out."""
        path_results = [
            None,
            {
                "path_idx": 0,
                "year": "2025",
                "resolution_data": {
                    "z14_plus": {
                        "segments": [{"coords": [[50.0, 8.0], [50.1, 8.1]], "color": "#ff0000", "altitude_ft": 328, "altitude_m": 100, "groundspeed_knots": 120.0, "path_id": 0}],
                        "path_info": {"id": 0, "start_airport": None, "end_airport": None, "start_coords": [50.0, 8.0], "end_coords": [50.1, 8.1], "segment_count": 1, "year": 2025},
                        "downsampled_coords": [[50.0, 8.0], [50.1, 8.1]],
                        "max_groundspeed": 120.0,
                        "min_groundspeed": 120.0,
                        "cruise_distance": 0,
                        "cruise_time": 0,
                        "cruise_altitude_histogram": {},
                        "path_distance_nm": 50.0,
                    }
                },
            },
            None,
        ]

        year_results = aggregate_results_by_year(
            path_results,
            RESOLUTION_LEVELS,
            ["z14_plus"],
            temp_output_dir,
        )

        assert len(year_results) == 1
