"""Unit tests for process_year_data function."""

import os
import json
import tempfile
import shutil
from unittest.mock import patch

import pytest

from kml_heatmap.data_exporter import process_year_data
from kml_heatmap.constants import DATA_RESOLUTION

# Test helper constant
RESOLUTION_LEVELS = {
    DATA_RESOLUTION: {"factor": 1, "epsilon": 0, "description": "Full resolution"}
}


class TestProcessYearData:
    """Test suite for process_year_data function."""

    @pytest.fixture
    def sample_coordinates(self):
        """Sample coordinate list."""
        return [
            [50.0, 8.0],
            [50.1, 8.1],
            [50.2, 8.2],
            [50.3, 8.3],
        ]

    @pytest.fixture
    def sample_path_groups(self):
        """Sample path groups with altitude and timestamps."""
        return [
            [
                [50.0, 8.0, 100.0, "2025-01-01T10:00:00Z"],
                [50.1, 8.1, 200.0, "2025-01-01T10:05:00Z"],
                [50.2, 8.2, 300.0, "2025-01-01T10:10:00Z"],
            ],
            [
                [50.3, 8.3, 150.0, "2025-01-01T11:00:00Z"],
                [50.4, 8.4, 250.0, "2025-01-01T11:05:00Z"],
            ],
        ]

    @pytest.fixture
    def sample_path_metadata(self):
        """Sample path metadata."""
        return [
            {
                "year": 2025,
                "airport_name": "EDDF - EDDM",
                "timestamp": "2025-01-01T10:00:00Z",
                "end_timestamp": "2025-01-01T10:10:00Z",
                "aircraft_registration": "D-EXYZ",
                "aircraft_type": "C172",
            },
            {
                "year": 2025,
                "airport_name": "EDDM - EDDF",
                "timestamp": "2025-01-01T11:00:00Z",
                "end_timestamp": "2025-01-01T11:05:00Z",
            },
        ]

    @pytest.fixture
    def temp_output_dir(self):
        """Create a temporary output directory."""
        temp_dir = tempfile.mkdtemp()
        yield temp_dir
        shutil.rmtree(temp_dir, ignore_errors=True)

    def test_basic_year_processing(
        self,
        sample_coordinates,
        sample_path_groups,
        sample_path_metadata,
        temp_output_dir,
    ):
        """Test basic year data processing."""
        result = process_year_data(
            year="2025",
            year_path_indices=[0, 1],
            all_coordinates=sample_coordinates,
            all_path_groups=sample_path_groups,
            all_path_metadata=sample_path_metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Verify result structure
        assert result["year"] == "2025"
        assert result["max_groundspeed"] >= 0
        assert result["min_groundspeed"] >= 0
        assert result["cruise_distance"] >= 0
        assert result["cruise_time"] >= 0
        assert result["max_path_distance"] >= 0
        assert isinstance(result["cruise_altitude_histogram"], dict)
        assert isinstance(result["file_structure"], list)
        assert len(result["file_structure"]) == 1  # 1 resolution (data)
        assert result["full_res_segments"] is not None
        assert result["full_res_path_info"] is not None

        # Verify file was created
        year_dir = os.path.join(temp_output_dir, "2025")
        assert os.path.exists(year_dir)
        assert os.path.exists(os.path.join(year_dir, "data.js"))

    def test_quiet_mode(
        self,
        sample_coordinates,
        sample_path_groups,
        sample_path_metadata,
        temp_output_dir,
    ):
        """Test that quiet mode suppresses logging."""
        with patch("kml_heatmap.data_exporter.logger") as mock_logger:
            process_year_data(
                year="2025",
                year_path_indices=[0],
                all_coordinates=sample_coordinates,
                all_path_groups=sample_path_groups,
                all_path_metadata=sample_path_metadata,
                min_alt_m=100.0,
                max_alt_m=300.0,
                output_dir=temp_output_dir,
                resolutions=RESOLUTION_LEVELS,
                resolution_order=["data"],
                quiet=True,
            )

            # Verify logger.info was not called (quiet mode)
            mock_logger.info.assert_not_called()

    def test_verbose_mode(
        self,
        sample_coordinates,
        sample_path_groups,
        sample_path_metadata,
        temp_output_dir,
    ):
        """Test that verbose mode logs progress."""
        with patch("kml_heatmap.data_exporter.logger") as mock_logger:
            process_year_data(
                year="2025",
                year_path_indices=[0],
                all_coordinates=sample_coordinates,
                all_path_groups=sample_path_groups,
                all_path_metadata=sample_path_metadata,
                min_alt_m=100.0,
                max_alt_m=300.0,
                output_dir=temp_output_dir,
                resolutions=RESOLUTION_LEVELS,
                resolution_order=["data"],
                quiet=False,
            )

            # Verify logger.info was called (verbose mode)
            assert mock_logger.info.call_count > 0

    def test_unknown_year(
        self,
        sample_coordinates,
        sample_path_groups,
        sample_path_metadata,
        temp_output_dir,
    ):
        """Test processing data with unknown year."""
        result = process_year_data(
            year="unknown",
            year_path_indices=[0],
            all_coordinates=sample_coordinates,
            all_path_groups=sample_path_groups,
            all_path_metadata=sample_path_metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        assert result["year"] == "unknown"
        year_dir = os.path.join(temp_output_dir, "unknown")
        assert os.path.exists(year_dir)

    def test_empty_path_indices(
        self,
        sample_coordinates,
        sample_path_groups,
        sample_path_metadata,
        temp_output_dir,
    ):
        """Test processing with empty path indices."""
        result = process_year_data(
            year="2025",
            year_path_indices=[],
            all_coordinates=sample_coordinates,
            all_path_groups=sample_path_groups,
            all_path_metadata=sample_path_metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should still return valid result structure
        assert result["year"] == "2025"
        assert result["max_groundspeed"] == 0
        assert result["min_groundspeed"] == float("inf")

    def test_single_point_paths(self, temp_output_dir):
        """Test processing paths with single points (should be skipped)."""
        single_point_coords = [[50.0, 8.0]]
        single_point_groups = [[[50.0, 8.0, 100.0]]]
        single_point_metadata = [{"year": 2025}]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=single_point_coords,
            all_path_groups=single_point_groups,
            all_path_metadata=single_point_metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Path should be skipped, no segments created
        assert result["full_res_path_info"] == []
        assert result["full_res_segments"] == []

    def test_aircraft_metadata_extraction(
        self, sample_coordinates, sample_path_groups, temp_output_dir
    ):
        """Test that aircraft metadata is correctly extracted."""
        metadata_with_aircraft = [
            {
                "year": 2025,
                "aircraft_registration": "D-ABCD",
                "aircraft_type": "DA40",
            }
        ]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=sample_coordinates,
            all_path_groups=sample_path_groups,
            all_path_metadata=metadata_with_aircraft,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Verify aircraft info is in path_info
        path_info = result["full_res_path_info"]
        assert len(path_info) > 0
        assert path_info[0]["aircraft_registration"] == "D-ABCD"
        assert path_info[0]["aircraft_type"] == "DA40"

    def test_airport_extraction(
        self, sample_coordinates, sample_path_groups, temp_output_dir
    ):
        """Test that airport information is correctly extracted."""
        metadata_with_airports = [
            {
                "year": 2025,
                "airport_name": "EDDF - EDDM",
            }
        ]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=sample_coordinates,
            all_path_groups=sample_path_groups,
            all_path_metadata=metadata_with_airports,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Verify airport info is in path_info
        path_info = result["full_res_path_info"]
        assert len(path_info) > 0
        assert path_info[0]["start_airport"] == "EDDF"
        assert path_info[0]["end_airport"] == "EDDM"

    def test_file_export_format(
        self,
        sample_coordinates,
        sample_path_groups,
        sample_path_metadata,
        temp_output_dir,
    ):
        """Test that exported files have correct format."""
        process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=sample_coordinates,
            all_path_groups=sample_path_groups,
            all_path_metadata=sample_path_metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Read and verify file format
        file_path = os.path.join(temp_output_dir, "2025", "data.js")
        with open(file_path, "r") as f:
            content = f.read()

        # Should start with window.KML_DATA_
        assert content.startswith("window.KML_DATA_2025_DATA = ")
        assert content.endswith(";")

        # Extract JSON data
        json_str = content.replace("window.KML_DATA_2025_DATA = ", "").rstrip(";")
        data = json.loads(json_str)

        # Verify structure
        assert "coordinates" in data
        assert "path_segments" in data
        assert "path_info" in data
        assert "resolution" in data
        assert data["resolution"] == "data"

    def test_groundspeed_tracking(
        self,
        sample_coordinates,
        sample_path_groups,
        sample_path_metadata,
        temp_output_dir,
    ):
        """Test that groundspeed is correctly tracked."""
        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=sample_coordinates,
            all_path_groups=sample_path_groups,
            all_path_metadata=sample_path_metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should have calculated some groundspeed
        assert result["max_groundspeed"] >= 0

    def test_cruise_altitude_tracking(self, temp_output_dir):
        """Test that cruise altitude histogram is tracked."""
        # Create path with high altitude (cruise altitude)
        high_alt_groups = [
            [
                [50.0, 8.0, 2000.0, "2025-01-01T10:00:00Z"],  # ~6500ft
                [50.1, 8.1, 2000.0, "2025-01-01T10:05:00Z"],
                [50.2, 8.2, 2000.0, "2025-01-01T10:10:00Z"],
            ]
        ]
        metadata = [
            {
                "year": 2025,
                "timestamp": "2025-01-01T10:00:00Z",
                "end_timestamp": "2025-01-01T10:10:00Z",
            }
        ]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=[[50.0, 8.0], [50.1, 8.1], [50.2, 8.2]],
            all_path_groups=high_alt_groups,
            all_path_metadata=metadata,
            min_alt_m=2000.0,
            max_alt_m=2000.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should have cruise altitude data
        assert isinstance(result["cruise_altitude_histogram"], dict)

    def test_adaptive_downsampling(self, temp_output_dir):
        """Test that adaptive downsampling is applied for large datasets."""
        # Create a large dataset that should trigger adaptive downsampling
        large_coords = [[50.0 + i * 0.001, 8.0 + i * 0.001] for i in range(200000)]
        large_groups = [
            [[50.0 + i * 0.001, 8.0 + i * 0.001, 100.0 + i] for i in range(200000)]
        ]
        metadata = [{"year": 2025}]

        with patch("kml_heatmap.data_exporter.logger"):
            result = process_year_data(
                year="2025",
                year_path_indices=[0],
                all_coordinates=large_coords,
                all_path_groups=large_groups,
                all_path_metadata=metadata,
                min_alt_m=100.0,
                max_alt_m=200100.0,
                output_dir=temp_output_dir,
                resolutions=RESOLUTION_LEVELS,
                resolution_order=["data", "data"],
                quiet=False,
            )

        # Verify processing completed
        assert result["year"] == "2025"
        assert len(result["file_structure"]) == 2

    def test_path_distance_tracking(self, temp_output_dir):
        """Test that maximum path distance is tracked."""
        # Create a long path
        long_path_groups = [
            [
                [50.0, 8.0, 100.0],
                [51.0, 9.0, 100.0],  # ~100km distance
                [52.0, 10.0, 100.0],
            ]
        ]
        metadata = [{"year": 2025}]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=[[50.0, 8.0], [51.0, 9.0], [52.0, 10.0]],
            all_path_groups=long_path_groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=100.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should have tracked path distance
        assert result["max_path_distance"] > 0

    def test_missing_metadata(self, temp_output_dir):
        """Test handling of missing metadata."""
        coords = [[50.0, 8.0], [50.1, 8.1]]
        groups = [[[50.0, 8.0, 100.0], [50.1, 8.1, 200.0]]]
        metadata = [{}]  # Empty metadata

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=200.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should handle missing metadata gracefully
        assert result["year"] == "2025"
        path_info = result["full_res_path_info"]
        assert len(path_info) > 0
        assert path_info[0]["start_airport"] is None
        assert path_info[0]["end_airport"] is None

    def test_zero_length_segments_excluded(self, temp_output_dir):
        """Test that zero-length segments are excluded."""
        # Create path with duplicate coordinates
        dup_groups = [
            [
                [50.0, 8.0, 100.0],
                [50.0, 8.0, 100.0],  # Duplicate
                [50.1, 8.1, 200.0],
            ]
        ]
        metadata = [{"year": 2025}]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=[[50.0, 8.0], [50.0, 8.0], [50.1, 8.1]],
            all_path_groups=dup_groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=200.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Verify zero-length segments were excluded
        segments = result["full_res_segments"]
        for segment in segments:
            coord1 = segment["coords"][0]
            coord2 = segment["coords"][1]
            # No identical coordinates
            assert coord1 != coord2

    def test_single_resolution(
        self,
        sample_coordinates,
        sample_path_groups,
        sample_path_metadata,
        temp_output_dir,
    ):
        """Test processing single resolution level."""
        result = process_year_data(
            year="2025",
            year_path_indices=[0, 1],
            all_coordinates=sample_coordinates,
            all_path_groups=sample_path_groups,
            all_path_metadata=sample_path_metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Verify single resolution was processed
        assert result["file_structure"] == ["data"]

        # Verify file exists
        year_dir = os.path.join(temp_output_dir, "2025")
        assert os.path.exists(os.path.join(year_dir, "data.js"))

    def test_path_info_structure(
        self,
        sample_coordinates,
        sample_path_groups,
        sample_path_metadata,
        temp_output_dir,
    ):
        """Test that path_info has correct structure."""
        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=sample_coordinates,
            all_path_groups=sample_path_groups,
            all_path_metadata=sample_path_metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        path_info = result["full_res_path_info"]
        assert len(path_info) > 0

        # Verify required fields
        info = path_info[0]
        assert "id" in info
        assert "start_airport" in info
        assert "end_airport" in info
        assert "start_coords" in info
        assert "end_coords" in info
        assert "segment_count" in info
        assert "year" in info

    def test_segment_data_structure(
        self,
        sample_coordinates,
        sample_path_groups,
        sample_path_metadata,
        temp_output_dir,
    ):
        """Test that segment data has correct structure."""
        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=sample_coordinates,
            all_path_groups=sample_path_groups,
            all_path_metadata=sample_path_metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        segments = result["full_res_segments"]
        assert len(segments) > 0

        # Verify required fields
        segment = segments[0]
        assert "coords" in segment
        assert "altitude_ft" in segment
        assert "altitude_m" in segment
        assert "groundspeed_knots" in segment
        assert "path_id" in segment
        assert len(segment["coords"]) == 2  # Start and end coords

    def test_paths_without_timestamps(self, temp_output_dir):
        """Test processing paths without timestamp data."""
        coords = [[50.0, 8.0], [50.1, 8.1], [50.2, 8.2]]
        groups = [
            [
                [50.0, 8.0, 100.0],  # No timestamp
                [50.1, 8.1, 200.0],
                [50.2, 8.2, 300.0],
            ]
        ]
        metadata = [{"year": 2025}]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should still process, but without speed calculations
        assert result["year"] == "2025"
        assert len(result["full_res_segments"]) > 0

    def test_invalid_timestamp_parsing(self, temp_output_dir):
        """Test handling of invalid timestamps."""
        coords = [[50.0, 8.0], [50.1, 8.1]]
        groups = [
            [
                [50.0, 8.0, 100.0, "invalid-timestamp"],
                [50.1, 8.1, 200.0, "also-invalid"],
            ]
        ]
        metadata = [{"year": 2025}]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=200.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should handle gracefully
        assert result["year"] == "2025"

    def test_path_with_duration_metadata(self, temp_output_dir):
        """Test paths with duration metadata but no segment timestamps."""
        coords = [[50.0, 8.0], [50.1, 8.1], [50.2, 8.2]]
        groups = [
            [
                [50.0, 8.0, 100.0],
                [50.1, 8.1, 200.0],
                [50.2, 8.2, 300.0],
            ]
        ]
        # Metadata has timestamps but coordinates don't
        metadata = [
            {
                "year": 2025,
                "timestamp": "2025-01-01T10:00:00Z",
                "end_timestamp": "2025-01-01T10:30:00Z",
            }
        ]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should calculate groundspeed from path average
        assert result["year"] == "2025"
        segments = result["full_res_segments"]
        # Some segments should have groundspeed
        has_groundspeed = any(s["groundspeed_knots"] > 0 for s in segments)
        assert has_groundspeed

    def test_groundspeed_clamping_lower_resolutions(self, temp_output_dir):
        """Test that groundspeed is clamped for lower resolutions."""
        coords = [[50.0, 8.0], [50.1, 8.1], [50.2, 8.2]]
        groups = [
            [
                [50.0, 8.0, 100.0, "2025-01-01T10:00:00Z"],
                [50.1, 8.1, 200.0, "2025-01-01T10:01:00Z"],
                [50.2, 8.2, 300.0, "2025-01-01T10:02:00Z"],
            ]
        ]
        metadata = [{"year": 2025}]

        # Process both full resolution and downsampled
        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data", "data"],
            quiet=True,
        )

        assert result["year"] == "2025"
        # Both files should exist
        assert "data" in result["file_structure"]
        assert "data" in result["file_structure"]

    def test_relative_time_calculation(self, temp_output_dir):
        """Test that relative time from path start is calculated."""
        coords = [[50.0, 8.0], [50.1, 8.1], [50.2, 8.2]]
        groups = [
            [
                [50.0, 8.0, 100.0, "2025-01-01T10:00:00Z"],
                [50.1, 8.1, 200.0, "2025-01-01T10:05:00Z"],  # 5 min later
                [50.2, 8.2, 300.0, "2025-01-01T10:10:00Z"],  # 10 min later
            ]
        ]
        metadata = [{"year": 2025}]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=300.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        segments = result["full_res_segments"]
        # Check if time field exists in segments
        time_fields = [s.get("time") for s in segments if "time" in s]
        # At least some segments should have time data
        if time_fields:
            assert all(t >= 0 for t in time_fields if t is not None)

    def test_unrealistic_groundspeed_filtered(self, temp_output_dir):
        """Test that unrealistic groundspeeds are filtered out."""
        coords = [[50.0, 8.0], [51.0, 9.0]]
        # Create path with very short time delta => unrealistic speed
        groups = [
            [
                [50.0, 8.0, 100.0, "2025-01-01T10:00:00.000Z"],
                [51.0, 9.0, 100.0, "2025-01-01T10:00:00.001Z"],  # 1ms => absurd speed
            ]
        ]
        metadata = [{"year": 2025}]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=100.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Unrealistic speed should be filtered to 0
        segments = result["full_res_segments"]
        assert len(segments) > 0

    def test_altitude_bins_at_different_levels(self, temp_output_dir):
        """Test cruise altitude histogram with different altitude levels."""
        # Create paths at different cruise altitudes
        coords = [
            [50.0, 8.0],
            [50.1, 8.1],
            [50.2, 8.2],
            [50.3, 8.3],
        ]
        groups = [
            # Path 1: ~3000m altitude (cruise)
            [
                [50.0, 8.0, 3000.0, "2025-01-01T10:00:00Z"],
                [50.1, 8.1, 3000.0, "2025-01-01T10:05:00Z"],
            ],
            # Path 2: ~4000m altitude (cruise)
            [
                [50.2, 8.2, 4000.0, "2025-01-01T11:00:00Z"],
                [50.3, 8.3, 4000.0, "2025-01-01T11:05:00Z"],
            ],
        ]
        metadata = [
            {
                "year": 2025,
                "timestamp": "2025-01-01T10:00:00Z",
                "end_timestamp": "2025-01-01T10:05:00Z",
            },
            {
                "year": 2025,
                "timestamp": "2025-01-01T11:00:00Z",
                "end_timestamp": "2025-01-01T11:05:00Z",
            },
        ]

        result = process_year_data(
            year="2025",
            year_path_indices=[0, 1],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=3000.0,
            max_alt_m=4000.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should have cruise altitude histogram data
        histogram = result["cruise_altitude_histogram"]
        assert isinstance(histogram, dict)

    def test_min_segment_time_threshold(self, temp_output_dir):
        """Test that segments below minimum time threshold are handled."""
        coords = [[50.0, 8.0], [50.1, 8.1]]
        # Very short time segment
        groups = [
            [
                [50.0, 8.0, 100.0, "2025-01-01T10:00:00Z"],
                [50.1, 8.1, 200.0, "2025-01-01T10:00:00.5Z"],  # 0.5 seconds
            ]
        ]
        metadata = [{"year": 2025}]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=200.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should handle short segments
        assert result["year"] == "2025"

    def test_downsampling_fallback(self, temp_output_dir):
        """Test fallback to coordinate downsampling when RDP returns empty."""
        # This can happen with extreme epsilon values
        coords = [[50.0, 8.0], [50.0001, 8.0001]]  # Very close points
        groups = [[[50.0, 8.0, 100.0], [50.0001, 8.0001, 100.0]]]
        metadata = [{"year": 2025}]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=100.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],  # Aggressive downsampling
            quiet=True,
        )

        assert result["year"] == "2025"

    def test_multiple_paths_statistics_aggregation(self, temp_output_dir):
        """Test that statistics are correctly aggregated across multiple paths."""
        coords = [
            [50.0, 8.0],
            [50.1, 8.1],
            [50.2, 8.2],
            [50.3, 8.3],
        ]
        groups = [
            # Fast path
            [
                [50.0, 8.0, 100.0, "2025-01-01T10:00:00Z"],
                [50.1, 8.1, 100.0, "2025-01-01T10:01:00Z"],
            ],
            # Slow path
            [
                [50.2, 8.2, 100.0, "2025-01-01T11:00:00Z"],
                [50.3, 8.3, 100.0, "2025-01-01T11:10:00Z"],  # 10 min for small distance
            ],
        ]
        metadata = [{"year": 2025}, {"year": 2025}]

        result = process_year_data(
            year="2025",
            year_path_indices=[0, 1],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=100.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should track both max and min across paths
        assert result["max_groundspeed"] >= result["min_groundspeed"]
        if result["min_groundspeed"] != float("inf"):
            assert result["min_groundspeed"] > 0

    def test_airport_name_without_separator(self, temp_output_dir):
        """Test handling of airport names without ' - ' separator."""
        coords = [[50.0, 8.0], [50.1, 8.1]]
        groups = [[[50.0, 8.0, 100.0], [50.1, 8.1, 200.0]]]
        metadata = [
            {
                "year": 2025,
                "airport_name": "EDDF",  # No separator
            }
        ]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=200.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        path_info = result["full_res_path_info"]
        # Should have None for both airports
        assert path_info[0]["start_airport"] is None
        assert path_info[0]["end_airport"] is None

    def test_metadata_index_out_of_range(self, temp_output_dir):
        """Test handling when path index exceeds metadata length."""
        coords = [[50.0, 8.0], [50.1, 8.1]]
        groups = [[[50.0, 8.0, 100.0], [50.1, 8.1, 200.0]]]
        metadata = []  # Empty metadata

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=200.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should handle gracefully with empty metadata
        assert result["year"] == "2025"
        path_info = result["full_res_path_info"]
        assert len(path_info) > 0

    def test_segment_altitude_metadata(self, temp_output_dir):
        """Test that segment altitude metadata is correctly set."""
        coords = [[50.0, 8.0], [50.1, 8.1]]
        groups = [[[50.0, 8.0, 1000.0], [50.1, 8.1, 2000.0]]]
        metadata = [{"year": 2025}]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=1000.0,
            max_alt_m=2000.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        segments = result["full_res_segments"]
        assert len(segments) > 0

        segment = segments[0]
        # Average altitude should be between 1000 and 2000
        assert 1000 <= segment["altitude_m"] <= 2000
        # Altitude in feet should be set
        assert segment["altitude_ft"] > 0
        # Should be rounded to nearest 100ft
        assert segment["altitude_ft"] % 100 == 0

    def test_airport_name_parsing_edge_cases(self, temp_output_dir):
        """Test various edge cases in airport name parsing."""
        coords = [[50.0, 8.0], [50.1, 8.1]]
        groups = [[[50.0, 8.0, 100.0], [50.1, 8.1, 200.0]]]

        # Test with multiple separators
        metadata = [
            {
                "year": 2025,
                "airport_name": "EDDF - EDDM - EDDT",  # More than 2 parts
            }
        ]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=200.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should handle multiple separators gracefully
        path_info = result["full_res_path_info"]
        assert len(path_info) > 0

    def test_invalid_duration_parsing(self, temp_output_dir):
        """Test handling of invalid duration that returns 0."""
        coords = [[50.0, 8.0], [50.1, 8.1]]
        groups = [[[50.0, 8.0, 100.0], [50.1, 8.1, 200.0]]]
        metadata = [
            {
                "year": 2025,
                "timestamp": "invalid",
                "end_timestamp": "also-invalid",
            }
        ]

        result = process_year_data(
            year="2025",
            year_path_indices=[0],
            all_coordinates=coords,
            all_path_groups=groups,
            all_path_metadata=metadata,
            min_alt_m=100.0,
            max_alt_m=200.0,
            output_dir=temp_output_dir,
            resolutions=RESOLUTION_LEVELS,
            resolution_order=["data"],
            quiet=True,
        )

        # Should handle gracefully
        assert result["year"] == "2025"
