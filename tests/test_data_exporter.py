"""Tests for data_exporter module."""

import os
import json
import tempfile
from kml_heatmap.data_exporter import (
    export_airports_data,
    export_metadata,
    collect_unique_years,
    process_year_data,
    export_all_data,
)


def _parse_js_data(filepath):
    """Parse a JS file with 'window.VAR = {...};' format and return the JSON data."""
    with open(filepath, "r") as f:
        content = f.read()
    # Remove the 'window.XXX = ' prefix and trailing ';'
    json_start = content.index("{")
    json_str = content[json_start:].rstrip(";")
    return json.loads(json_str)


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

            data = _parse_js_data(output_file)
            assert len(data["airports"]) == 1
            assert data["airports"][0]["name"] == "EDDF Frankfurt"
            assert data["airports"][0]["lat"] == 50.0
            assert data["airports"][0]["flight_count"] == 1

    def test_export_airports_js_format(self):
        """Test that airports are exported in JS format."""
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

            output_file, _ = export_airports_data(airports, tmpdir)

            assert output_file.endswith(".js")
            with open(output_file, "r") as f:
                content = f.read()
            assert content.startswith("window.KML_AIRPORTS = ")
            assert content.endswith(";")

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

            data = _parse_js_data(output_file)
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

            data = _parse_js_data(output_file)
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

            data = _parse_js_data(output_file)
            assert len(data["airports"]) == 0

    def test_export_airports_empty_list(self):
        """Test exporting empty airport list."""
        with tempfile.TemporaryDirectory() as tmpdir:
            output_file, file_size = export_airports_data([], tmpdir)

            assert os.path.exists(output_file)
            data = _parse_js_data(output_file)
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

            data = _parse_js_data(output_file)
            assert data["stats"] == stats
            assert data["min_alt_m"] == 0
            assert data["max_alt_m"] == 5000
            assert data["min_groundspeed_knots"] == 50
            assert data["max_groundspeed_knots"] == 150
            assert data["available_years"] == [2024, 2025]
            assert "gradient" in data

    def test_export_metadata_js_format(self):
        """Test that metadata is exported in JS format."""
        with tempfile.TemporaryDirectory() as tmpdir:
            output_file, _ = export_metadata(
                {},
                min_alt_m=0,
                max_alt_m=5000,
                min_groundspeed_knots=50,
                max_groundspeed_knots=150,
                available_years=[],
                output_dir=tmpdir,
            )

            assert output_file.endswith(".js")
            with open(output_file, "r") as f:
                content = f.read()
            assert content.startswith("window.KML_METADATA = ")
            assert content.endswith(";")

    def test_export_metadata_with_file_structure(self):
        """Test metadata export with file structure."""
        with tempfile.TemporaryDirectory() as tmpdir:
            file_structure = {"2024": ["data"], "2025": ["data"]}

            output_file, _ = export_metadata(
                {},
                min_alt_m=0,
                max_alt_m=5000,
                min_groundspeed_knots=50,
                max_groundspeed_knots=150,
                available_years=[2024, 2025],
                output_dir=tmpdir,
                file_structure=file_structure,
            )

            data = _parse_js_data(output_file)
            assert data["file_structure"] == file_structure

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

            data = _parse_js_data(output_file)
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

            data = _parse_js_data(output_file)
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


def _make_path_with_timestamps(coords):
    """Create a path with timestamps from coordinate tuples."""
    path = []
    for lat, lon, alt, ts in coords:
        path.append([lat, lon, alt, ts])
    return path


class TestProcessYearData:
    """Tests for process_year_data function."""

    def test_basic_processing(self):
        """Test basic year data processing with simple path."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = [
                [50.0, 8.0, 500.0],
                [50.1, 8.1, 600.0],
                [50.2, 8.2, 700.0],
            ]
            all_path_groups = [path]
            all_coordinates = [[50.0, 8.0], [50.1, 8.1], [50.2, 8.2]]
            all_path_metadata = [
                {
                    "airport_name": "EDDF - EDDL",
                    "year": 2024,
                }
            ]

            result = process_year_data(
                year="2024",
                year_path_indices=[0],
                all_coordinates=all_coordinates,
                all_path_groups=all_path_groups,
                all_path_metadata=all_path_metadata,
                min_alt_m=500.0,
                max_alt_m=700.0,
                output_dir=tmpdir,
                resolutions={
                    "data": {
                        "factor": 1,
                        "epsilon": 0,
                        "description": "Full resolution",
                    }
                },
                resolution_order=["data"],
                quiet=True,
            )

            assert result["year"] == "2024"
            assert result["full_res_segments"] is not None
            assert result["full_res_path_info"] is not None
            assert len(result["full_res_segments"]) > 0
            assert len(result["full_res_path_info"]) == 1
            assert result["file_structure"] == ["data"]

            # Verify output file was created
            year_dir = os.path.join(tmpdir, "2024")
            assert os.path.isdir(year_dir)
            assert os.path.exists(os.path.join(year_dir, "data.js"))

    def test_with_timestamps(self):
        """Test processing with timestamped coordinates."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = _make_path_with_timestamps(
                [
                    (50.0, 8.0, 500.0, "2024-06-15T10:00:00+00:00"),
                    (50.1, 8.1, 1500.0, "2024-06-15T10:05:00+00:00"),
                    (50.2, 8.2, 1600.0, "2024-06-15T10:10:00+00:00"),
                ]
            )

            result = process_year_data(
                year="2024",
                year_path_indices=[0],
                all_coordinates=[[50.0, 8.0], [50.1, 8.1], [50.2, 8.2]],
                all_path_groups=[path],
                all_path_metadata=[{"year": 2024, "airport_name": "EDDF - EDDL"}],
                min_alt_m=500.0,
                max_alt_m=1600.0,
                output_dir=tmpdir,
                resolutions={
                    "data": {
                        "factor": 1,
                        "epsilon": 0,
                        "description": "Full resolution",
                    }
                },
                resolution_order=["data"],
                quiet=True,
            )

            assert result["max_groundspeed"] > 0
            segments = result["full_res_segments"]
            assert any(seg.get("time") is not None for seg in segments)

    def test_empty_paths_skipped(self):
        """Test that single-point paths are skipped."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = [[50.0, 8.0, 500.0]]

            result = process_year_data(
                year="2024",
                year_path_indices=[0],
                all_coordinates=[[50.0, 8.0]],
                all_path_groups=[path],
                all_path_metadata=[{"year": 2024}],
                min_alt_m=500.0,
                max_alt_m=500.0,
                output_dir=tmpdir,
                resolutions={
                    "data": {
                        "factor": 1,
                        "epsilon": 0,
                        "description": "Full resolution",
                    }
                },
                resolution_order=["data"],
                quiet=True,
            )

            assert result["full_res_segments"] is not None
            assert len(result["full_res_path_info"]) == 0

    def test_aircraft_metadata_preserved(self):
        """Test that aircraft info is included in path_info."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = [[50.0, 8.0, 500.0], [50.1, 8.1, 600.0]]

            result = process_year_data(
                year="2024",
                year_path_indices=[0],
                all_coordinates=[[50.0, 8.0], [50.1, 8.1]],
                all_path_groups=[path],
                all_path_metadata=[
                    {
                        "year": 2024,
                        "aircraft_registration": "D-ABCD",
                        "aircraft_type": "C172",
                    }
                ],
                min_alt_m=500.0,
                max_alt_m=600.0,
                output_dir=tmpdir,
                resolutions={
                    "data": {
                        "factor": 1,
                        "epsilon": 0,
                        "description": "Full resolution",
                    }
                },
                resolution_order=["data"],
                quiet=True,
            )

            path_info = result["full_res_path_info"]
            assert path_info[0]["aircraft_registration"] == "D-ABCD"
            assert path_info[0]["aircraft_type"] == "C172"


class TestExportAllData:
    """Tests for export_all_data function."""

    def test_basic_export(self):
        """Test basic full data export pipeline."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = [[50.0, 8.0, 500.0], [50.1, 8.1, 600.0]]
            all_path_groups = [path]
            all_coordinates = [[50.0, 8.0], [50.1, 8.1]]
            all_path_metadata = [{"year": 2024, "airport_name": "EDDF - EDDL"}]
            airports = [
                {
                    "lat": 50.0,
                    "lon": 8.0,
                    "name": "EDDF Frankfurt",
                    "timestamps": [],
                    "is_at_path_end": True,
                }
            ]
            stats = {
                "total_points": 2,
                "num_paths": 1,
                "total_distance_km": 10.0,
                "max_groundspeed_knots": 0,
            }

            files, segments, path_info, meta_params = export_all_data(
                all_coordinates,
                all_path_groups,
                all_path_metadata,
                airports,
                stats,
                output_dir=tmpdir,
            )

            assert "airports" in files
            assert "metadata" in files
            assert os.path.exists(files["airports"])
            assert os.path.exists(files["metadata"])

    def test_multi_year_export(self):
        """Test export with multiple years."""
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = [
                [[50.0, 8.0, 500.0], [50.1, 8.1, 600.0]],
                [[51.0, 9.0, 700.0], [51.1, 9.1, 800.0]],
            ]
            coords = [[50.0, 8.0], [50.1, 8.1], [51.0, 9.0], [51.1, 9.1]]
            metadata = [
                {"year": 2023, "airport_name": "EDDF - EDDL"},
                {"year": 2024, "airport_name": "EDDK - EDDM"},
            ]
            stats = {
                "total_points": 4,
                "num_paths": 2,
                "total_distance_km": 20.0,
                "max_groundspeed_knots": 0,
            }

            files, _, _, _ = export_all_data(
                coords, paths, metadata, [], stats, output_dir=tmpdir
            )

            # Both year directories should exist
            assert os.path.isdir(os.path.join(tmpdir, "2023"))
            assert os.path.isdir(os.path.join(tmpdir, "2024"))

    def test_stats_updated_with_aggregates(self):
        """Test that stats dict is updated with aggregated data."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = [[50.0, 8.0, 500.0], [50.1, 8.1, 600.0]]
            stats = {
                "total_points": 2,
                "num_paths": 1,
                "total_distance_km": 10.0,
                "max_groundspeed_knots": 0,
            }

            export_all_data(
                [[50.0, 8.0], [50.1, 8.1]],
                [path],
                [{"year": 2024}],
                [],
                stats,
                output_dir=tmpdir,
            )

            # These keys should be populated by export_all_data
            assert "cruise_speed_knots" in stats
            assert "longest_flight_nm" in stats
            assert "longest_flight_km" in stats

    def test_cleans_output_directory(self):
        """Test that existing output directory is cleaned before export."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a stale file
            stale_file = os.path.join(tmpdir, "stale.txt")
            with open(stale_file, "w") as f:
                f.write("stale")

            path = [[50.0, 8.0, 500.0], [50.1, 8.1, 600.0]]
            stats = {"total_points": 2, "num_paths": 1, "max_groundspeed_knots": 0}

            export_all_data(
                [[50.0, 8.0], [50.1, 8.1]],
                [path],
                [{"year": 2024}],
                [],
                stats,
                output_dir=tmpdir,
            )

            assert not os.path.exists(stale_file)
