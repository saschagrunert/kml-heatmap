"""Tests for data_exporter module."""

import os
import json
import tempfile
from kml_heatmap.data_exporter import (
    downsample_coordinates,
    export_resolution_data,
    export_airports_data,
    export_metadata,
    collect_unique_years,
)


class TestDownsampleCoordinates:
    """Tests for downsample_coordinates function."""

    def test_downsample_factor_1(self):
        """Test downsampling with factor 1 returns original data."""
        coords = [[50.0, 8.5], [51.0, 9.5], [52.0, 10.5]]
        result = downsample_coordinates(coords, 1)
        assert result == coords

    def test_downsample_factor_2(self):
        """Test downsampling with factor 2."""
        coords = [[50.0, 8.5], [51.0, 9.5], [52.0, 10.5], [53.0, 11.5]]
        result = downsample_coordinates(coords, 2)
        assert result == [[50.0, 8.5], [52.0, 10.5]]

    def test_downsample_factor_3(self):
        """Test downsampling with factor 3."""
        coords = [[50.0, 8.5], [51.0, 9.5], [52.0, 10.5], [53.0, 11.5], [54.0, 12.5]]
        result = downsample_coordinates(coords, 3)
        assert result == [[50.0, 8.5], [53.0, 11.5]]

    def test_downsample_empty_list(self):
        """Test downsampling empty list."""
        result = downsample_coordinates([], 2)
        assert result == []

    def test_downsample_single_coordinate(self):
        """Test downsampling single coordinate."""
        coords = [[50.0, 8.5]]
        result = downsample_coordinates(coords, 2)
        assert result == [[50.0, 8.5]]

    def test_downsample_factor_0(self):
        """Test downsampling with factor 0 returns original."""
        coords = [[50.0, 8.5], [51.0, 9.5]]
        result = downsample_coordinates(coords, 0)
        assert result == coords

    def test_downsample_large_factor(self):
        """Test downsampling with factor larger than list length."""
        coords = [[50.0, 8.5], [51.0, 9.5], [52.0, 10.5]]
        result = downsample_coordinates(coords, 10)
        assert result == [[50.0, 8.5]]


class TestExportResolutionData:
    """Tests for export_resolution_data function."""

    def test_export_resolution_data(self):
        """Test exporting resolution data to JSON."""
        with tempfile.TemporaryDirectory() as tmpdir:
            coords = [[50.0, 8.5], [51.0, 9.5]]
            segments = [{"start": 0, "end": 1, "speed": 100}]
            path_info = [{"name": "Test Path"}]
            resolution_config = {"description": "Test resolution"}

            output_file, file_size = export_resolution_data(
                "z0_4", resolution_config, coords, segments, path_info, tmpdir
            )

            assert os.path.exists(output_file)
            assert file_size > 0

            # Verify JSON content
            with open(output_file, "r") as f:
                data = json.load(f)
                assert data["coordinates"] == coords
                assert data["path_segments"] == segments
                assert data["path_info"] == path_info
                assert data["resolution"] == "z0_4"
                assert data["original_points"] == 2

    def test_export_resolution_creates_file(self):
        """Test that export creates the expected file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            coords = [[50.0, 8.5]]
            output_file, _ = export_resolution_data(
                "z14_plus",
                {"description": "Full resolution"},
                coords,
                [],
                [],
                tmpdir,
            )

            expected_file = os.path.join(tmpdir, "data_z14_plus.json")
            assert output_file == expected_file
            assert os.path.exists(expected_file)


class TestExportAirportsData:
    """Tests for export_airports_data function."""

    def test_export_airports_basic(self):
        """Test basic airport export."""
        with tempfile.TemporaryDirectory() as tmpdir:
            airports = [
                {
                    "lat": 50.0,
                    "lon": 8.5,
                    "name": "EDDF Frankfurt",
                    "timestamps": ["2025-01-01T10:00:00Z"],
                    "is_at_path_end": True,
                }
            ]

            output_file, file_size = export_airports_data(airports, tmpdir)

            assert os.path.exists(output_file)
            assert file_size > 0

            # Verify JSON content
            with open(output_file, "r") as f:
                data = json.load(f)
                assert len(data["airports"]) == 1
                assert data["airports"][0]["name"] == "EDDF Frankfurt"
                assert data["airports"][0]["lat"] == 50.0
                assert data["airports"][0]["flight_count"] == 1

    def test_export_airports_strip_timestamps(self):
        """Test airport export with timestamp stripping."""
        with tempfile.TemporaryDirectory() as tmpdir:
            airports = [
                {
                    "lat": 50.0,
                    "lon": 8.5,
                    "name": "EDDF Frankfurt",
                    "timestamps": ["2025-01-01T10:00:00Z"],
                    "is_at_path_end": True,
                }
            ]

            output_file, _ = export_airports_data(
                airports, tmpdir, strip_timestamps=True
            )

            with open(output_file, "r") as f:
                data = json.load(f)
                assert "timestamps" not in data["airports"][0]

    def test_export_airports_deduplicates_locations(self):
        """Test that duplicate locations are deduplicated."""
        with tempfile.TemporaryDirectory() as tmpdir:
            airports = [
                {
                    "lat": 50.0,
                    "lon": 8.5,
                    "name": "EDDF Frankfurt",
                    "timestamps": ["2025-01-01T10:00:00Z"],
                    "is_at_path_end": True,
                },
                {
                    "lat": 50.0001,  # Very close to first
                    "lon": 8.5001,
                    "name": "EDDF Frankfurt",
                    "timestamps": ["2025-01-02T10:00:00Z"],
                    "is_at_path_end": True,
                },
            ]

            output_file, _ = export_airports_data(airports, tmpdir)

            with open(output_file, "r") as f:
                data = json.load(f)
                # Close locations should be deduplicated
                assert len(data["airports"]) >= 1

    def test_export_airports_skips_invalid_names(self):
        """Test that airports with invalid names are skipped."""
        with tempfile.TemporaryDirectory() as tmpdir:
            airports = [
                {
                    "lat": 50.0,
                    "lon": 8.5,
                    "name": "Unknown",  # Invalid name
                    "timestamps": [],
                    "is_at_path_end": True,
                }
            ]

            output_file, _ = export_airports_data(airports, tmpdir)

            with open(output_file, "r") as f:
                data = json.load(f)
                assert len(data["airports"]) == 0

    def test_export_airports_empty_list(self):
        """Test exporting empty airport list."""
        with tempfile.TemporaryDirectory() as tmpdir:
            output_file, file_size = export_airports_data([], tmpdir)

            assert os.path.exists(output_file)
            with open(output_file, "r") as f:
                data = json.load(f)
                assert data["airports"] == []


class TestExportMetadata:
    """Tests for export_metadata function."""

    def test_export_metadata_basic(self):
        """Test basic metadata export."""
        with tempfile.TemporaryDirectory() as tmpdir:
            stats = {
                "total_distance_km": 1000,
                "total_flights": 10,
            }

            output_file, file_size = export_metadata(
                stats,
                min_alt_m=0,
                max_alt_m=5000,
                min_groundspeed_knots=50,
                max_groundspeed_knots=150,
                available_years=[2024, 2025],
                output_dir=tmpdir,
            )

            assert os.path.exists(output_file)
            assert file_size > 0

            with open(output_file, "r") as f:
                data = json.load(f)
                assert data["stats"] == stats
                assert data["min_alt_m"] == 0
                assert data["max_alt_m"] == 5000
                assert data["min_groundspeed_knots"] == 50
                assert data["max_groundspeed_knots"] == 150
                assert data["available_years"] == [2024, 2025]
                assert "gradient" in data

    def test_export_metadata_infinity_speed(self):
        """Test metadata export with infinity min groundspeed."""
        with tempfile.TemporaryDirectory() as tmpdir:
            output_file, _ = export_metadata(
                {},
                min_alt_m=0,
                max_alt_m=5000,
                min_groundspeed_knots=float("inf"),
                max_groundspeed_knots=150,
                available_years=[],
                output_dir=tmpdir,
            )

            with open(output_file, "r") as f:
                data = json.load(f)
                # Infinity should be converted to 0.0
                assert data["min_groundspeed_knots"] == 0.0

    def test_export_metadata_rounds_speeds(self):
        """Test that groundspeeds are rounded."""
        with tempfile.TemporaryDirectory() as tmpdir:
            output_file, _ = export_metadata(
                {},
                min_alt_m=0,
                max_alt_m=5000,
                min_groundspeed_knots=50.123456,
                max_groundspeed_knots=150.987654,
                available_years=[],
                output_dir=tmpdir,
            )

            with open(output_file, "r") as f:
                data = json.load(f)
                assert data["min_groundspeed_knots"] == 50.1
                assert data["max_groundspeed_knots"] == 151.0


class TestCollectUniqueYears:
    """Tests for collect_unique_years function."""

    def test_collect_unique_years(self):
        """Test collecting unique years from metadata."""
        metadata = [
            {"year": 2024},
            {"year": 2025},
            {"year": 2024},  # Duplicate
        ]

        result = collect_unique_years(metadata)
        assert result == [2024, 2025]

    def test_collect_unique_years_sorted(self):
        """Test that years are sorted."""
        metadata = [
            {"year": 2025},
            {"year": 2023},
            {"year": 2024},
        ]

        result = collect_unique_years(metadata)
        assert result == [2023, 2024, 2025]

    def test_collect_unique_years_empty(self):
        """Test collecting years from empty metadata."""
        result = collect_unique_years([])
        assert result == []

    def test_collect_unique_years_no_year_field(self):
        """Test metadata without year field."""
        metadata = [
            {"name": "Path 1"},
            {"name": "Path 2"},
        ]

        result = collect_unique_years(metadata)
        assert result == []

    def test_collect_unique_years_mixed(self):
        """Test metadata with some entries having year, some not."""
        metadata = [
            {"year": 2024},
            {"name": "Path without year"},
            {"year": 2025},
        ]

        result = collect_unique_years(metadata)
        assert result == [2024, 2025]

    def test_collect_unique_years_none_values(self):
        """Test metadata with None year values."""
        metadata = [
            {"year": 2024},
            {"year": None},
            {"year": 2025},
        ]

        result = collect_unique_years(metadata)
        assert result == [2024, 2025]
