"""Tests for export_writers module."""

import json

import pytest

from kml_heatmap.export_writers import export_airports_data, export_metadata


def _parse(path, prefix):
    content = path.read_text()
    assert content.startswith(prefix)
    assert content.endswith(";")
    return json.loads(content[len(prefix) : -1])


def _airport(name, lat=48.6899, lon=9.2220, timestamps=None, is_at_path_end=False):
    return {
        "name": name,
        "lat": lat,
        "lon": lon,
        "timestamps": timestamps or [],
        "is_at_path_end": is_at_path_end,
    }


class TestExportAirportsData:
    def test_valid_airport_with_country(self, tmp_path):
        airports = [_airport("EDDS Stuttgart", timestamps=["t1"])]
        filepath, size = export_airports_data(airports, str(tmp_path))

        assert filepath == str(tmp_path / "airports.js")
        assert size == (tmp_path / "airports.js").stat().st_size
        data = _parse(tmp_path / "airports.js", "window.KML_AIRPORTS = ")
        assert data == {
            "airports": [
                {
                    "country": "DE",
                    "lat": 48.6899,
                    "lon": 9.222,
                    "name": "EDDS Stuttgart",
                }
            ]
        }

    def test_timestamps_never_exported(self, tmp_path):
        export_airports_data(
            [_airport("EDDS Stuttgart", timestamps=["t1"])], str(tmp_path)
        )
        data = _parse(tmp_path / "airports.js", "window.KML_AIRPORTS = ")
        assert "timestamps" not in data["airports"][0]
        assert "icao" not in data["airports"][0]

    def test_unknown_icao_has_no_country(self, tmp_path):
        export_airports_data([_airport("ZZZZ Nowhere")], str(tmp_path))
        data = _parse(tmp_path / "airports.js", "window.KML_AIRPORTS = ")
        assert "country" not in data["airports"][0]

    def test_route_name_uses_position(self, tmp_path):
        airports = [
            _airport("EDDS Stuttgart - EDDP Leipzig", is_at_path_end=False),
            _airport(
                "EDDS Stuttgart - EDDP Leipzig",
                lat=51.42,
                lon=12.23,
                is_at_path_end=True,
            ),
        ]
        export_airports_data(airports, str(tmp_path))
        data = _parse(tmp_path / "airports.js", "window.KML_AIRPORTS = ")
        assert [a["name"] for a in data["airports"]] == [
            "EDDS Stuttgart",
            "EDDP Leipzig",
        ]

    @pytest.mark.parametrize("name", ["", "Unknown", "Log Start: 03 Mar 2025", None])
    def test_invalid_names_filtered(self, tmp_path, name):
        export_airports_data([_airport(name)], str(tmp_path))
        data = _parse(tmp_path / "airports.js", "window.KML_AIRPORTS = ")
        assert data["airports"] == []

    def test_duplicate_locations_deduplicated(self, tmp_path):
        airports = [
            _airport("EDDS Stuttgart", timestamps=["t1"]),
            _airport("EDDS Stuttgart", lat=48.68991, lon=9.22201, timestamps=["t2"]),
        ]
        export_airports_data(airports, str(tmp_path))
        data = _parse(tmp_path / "airports.js", "window.KML_AIRPORTS = ")
        assert len(data["airports"]) == 1

    def test_flight_count_never_exported(self, tmp_path):
        """The frontend counts flights per active filter; see export_writers."""
        airports = [_airport("EDDS Stuttgart", timestamps=["t1", "t2", "t3"])]
        export_airports_data(airports, str(tmp_path))
        data = _parse(tmp_path / "airports.js", "window.KML_AIRPORTS = ")
        assert "flight_count" not in data["airports"][0]

    def test_empty_list(self, tmp_path):
        export_airports_data([], str(tmp_path))
        data = _parse(tmp_path / "airports.js", "window.KML_AIRPORTS = ")
        assert data == {"airports": []}


class TestExportMetadata:
    def _export(self, tmp_path, **overrides):
        kwargs = {
            "stats": {"total_points": 10},
            "min_groundspeed_knots": 50.0,
            "max_groundspeed_knots": 180.0,
            "available_years": [2025, 2024],
            "year_file_bytes": {"2024": 10, "2025": 20},
            "output_dir": str(tmp_path),
        }
        kwargs.update(overrides)
        return export_metadata(**kwargs)

    def test_d2_shape(self, tmp_path):
        filepath, size = self._export(tmp_path)
        assert filepath == str(tmp_path / "metadata.js")
        assert size == (tmp_path / "metadata.js").stat().st_size
        data = _parse(tmp_path / "metadata.js", "window.KML_METADATA = ")
        assert data == {
            "stats": {"total_points": 10},
            "min_groundspeed_knots": 50.0,
            "max_groundspeed_knots": 180.0,
            "available_years": [2024, 2025],
            "year_file_bytes": {"2024": 10, "2025": 20},
        }
        assert "gradient" not in data
        assert "file_structure" not in data

    @pytest.mark.parametrize(
        "min_speed,max_speed,expected_min,expected_max",
        [
            (float("inf"), 150, 0.0, 150),
            (float("nan"), float("nan"), 0.0, 0.0),
            (float("-inf"), float("-inf"), 0.0, 0.0),
            (50.0, float("inf"), 50.0, 0.0),
        ],
        ids=["inf-min", "nan-both", "neg-inf-both", "inf-max"],
    )
    def test_non_finite_speeds_become_zero(
        self, tmp_path, min_speed, max_speed, expected_min, expected_max
    ):
        self._export(
            tmp_path, min_groundspeed_knots=min_speed, max_groundspeed_knots=max_speed
        )
        data = _parse(tmp_path / "metadata.js", "window.KML_METADATA = ")
        assert data["min_groundspeed_knots"] == expected_min
        assert data["max_groundspeed_knots"] == expected_max

    def test_groundspeed_rounding(self, tmp_path):
        self._export(
            tmp_path, min_groundspeed_knots=55.678, max_groundspeed_knots=199.123
        )
        data = _parse(tmp_path / "metadata.js", "window.KML_METADATA = ")
        assert data["min_groundspeed_knots"] == 55.7
        assert data["max_groundspeed_knots"] == 199.1
