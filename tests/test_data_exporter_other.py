"""Unit tests for other functions in data_exporter module."""

import os
import json
import tempfile
import shutil

import pytest

from kml_heatmap.data_exporter import (
    export_metadata,
    export_airports_data,
    collect_unique_years,
)


def _parse_js_data(filepath):
    """Parse a JS file with 'window.VAR = {...};' format and return the JSON data."""
    with open(filepath, "r") as f:
        content = f.read()
    json_start = content.index("{")
    json_str = content[json_start:].rstrip(";")
    return json.loads(json_str)


class TestExportMetadata:
    """Test suite for export_metadata function."""

    @pytest.fixture
    def temp_output_dir(self):
        """Create a temporary output directory."""
        temp_dir = tempfile.mkdtemp()
        yield temp_dir
        shutil.rmtree(temp_dir, ignore_errors=True)

    def test_export_metadata_basic(self, temp_output_dir):
        """Test basic metadata export."""
        stats = {
            "total_flights": 10,
            "total_distance_nm": 1000.5,
            "total_time_hours": 20.5,
            "average_speed_knots": 150.0,
        }

        meta_file, file_size = export_metadata(
            stats,
            min_alt_m=100.0,
            max_alt_m=5000.0,
            min_groundspeed_knots=50.0,
            max_groundspeed_knots=200.0,
            available_years=[2024, 2025],
            output_dir=temp_output_dir,
        )

        # Verify file was created
        assert os.path.exists(meta_file)
        assert meta_file == os.path.join(temp_output_dir, "metadata.js")
        assert file_size > 0

        # Verify content is valid JS-wrapped JSON
        data = _parse_js_data(meta_file)

        assert "stats" in data
        assert data["stats"] == stats

    def test_export_metadata_empty_stats(self, temp_output_dir):
        """Test metadata export with empty stats."""
        stats = {}

        meta_file, file_size = export_metadata(
            stats,
            min_alt_m=0.0,
            max_alt_m=0.0,
            min_groundspeed_knots=0.0,
            max_groundspeed_knots=0.0,
            available_years=[],
            output_dir=temp_output_dir,
        )

        assert os.path.exists(meta_file)
        assert file_size > 0


class TestExportAirportsData:
    """Test suite for export_airports_data function."""

    @pytest.fixture
    def temp_output_dir(self):
        """Create a temporary output directory."""
        temp_dir = tempfile.mkdtemp()
        yield temp_dir
        shutil.rmtree(temp_dir, ignore_errors=True)

    def test_export_airports_basic(self, temp_output_dir):
        """Test basic airport data export."""
        airports = [
            {
                "name": "Frankfurt Airport",
                "icao": "EDDF",
                "lat": 50.0,
                "lon": 8.5,
                "timestamps": ["2025-01-01T10:00:00Z"],
            },
            {
                "name": "Munich Airport",
                "icao": "EDDM",
                "lat": 48.4,
                "lon": 11.8,
                "timestamps": ["2025-01-01T11:00:00Z"],
            },
        ]

        airports_file, file_size = export_airports_data(
            airports, temp_output_dir, strip_timestamps=False
        )

        # Verify file was created
        assert os.path.exists(airports_file)
        assert airports_file == os.path.join(temp_output_dir, "airports.js")
        assert file_size > 0

        # Verify content is valid JS-wrapped JSON
        data = _parse_js_data(airports_file)

        airports_list = data["airports"]
        assert len(airports_list) == 2
        assert airports_list[0]["name"] == "Frankfurt Airport"
        assert airports_list[1]["name"] == "Munich Airport"

    def test_export_airports_empty_list(self, temp_output_dir):
        """Test exporting empty airport list."""
        airports_file, file_size = export_airports_data(
            [], temp_output_dir, strip_timestamps=False
        )

        assert os.path.exists(airports_file)
        assert file_size > 0


class TestCollectUniqueYears:
    """Test suite for collect_unique_years function."""

    def test_collect_years_basic(self):
        """Test collecting years from metadata."""
        metadata = [
            {"year": 2025},
            {"year": 2024},
            {"year": 2025},  # Duplicate
            {"year": 2023},
        ]

        years = collect_unique_years(metadata)

        assert len(years) == 3
        assert set(years) == {2023, 2024, 2025}

    def test_collect_years_sorted(self):
        """Test that years are returned sorted."""
        metadata = [
            {"year": 2025},
            {"year": 2023},
            {"year": 2024},
        ]

        years = collect_unique_years(metadata)

        assert years == [2023, 2024, 2025]

    def test_collect_years_empty_metadata(self):
        """Test collecting years from empty metadata."""
        years = collect_unique_years([])

        assert years == []
