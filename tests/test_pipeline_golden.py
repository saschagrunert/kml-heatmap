"""Golden pipeline test: run the full export on committed data/*.kml files.

Checks the structural invariants of the generated output (D1/D2 file shapes
and the internal consistency of the statistics) rather than exact numbers.
"""

import json
import re
from pathlib import Path

import pytest

from kml_heatmap.helpers import format_flight_time
from kml_heatmap.renderer import create_progressive_heatmap

DATA_DIR = Path(__file__).parent.parent / "data"
SEGMENT_MIN_LEN = 6
SEGMENT_MAX_LEN = 7


def _select_input_files(per_year=4):
    """Pick a deterministic subset of committed files covering every year."""
    by_year = {}
    for path in sorted(DATA_DIR.glob("*.kml")):
        match = re.search(r"<when>(\d{4})-", path.read_text(encoding="utf-8"))
        if match:
            by_year.setdefault(match.group(1), []).append(path)
    selected = []
    for year in sorted(by_year):
        selected.extend(by_year[year][:per_year])
    return selected


def _load_js(path, variable):
    content = path.read_text(encoding="utf-8")
    prefix = f"window.{variable} = "
    assert content.startswith(prefix), f"{path} does not start with {prefix!r}"
    assert content.endswith(";")
    return json.loads(content[len(prefix) : -1])


@pytest.fixture(scope="module")
def golden_output(tmp_path_factory):
    inputs = _select_input_files()
    if not inputs:
        pytest.skip("no sample KML files available (data/ is not part of the image)")
    assert 6 <= len(inputs) <= 8, f"expected 6-8 input files, got {len(inputs)}"
    out = tmp_path_factory.mktemp("golden")
    ok = create_progressive_heatmap(
        [str(p) for p in inputs],
        str(out / "index.html"),
        str(out / "data"),
        [DATA_DIR / "aircraft.json"],
    )
    assert ok is True
    return out, inputs


def test_index_html_references_bundles(golden_output):
    out, _ = golden_output
    html = (out / "index.html").read_text(encoding="utf-8")
    assert "bundle.js" in html
    assert "mapApp.bundle.js" in html
    assert (out / "map_config.js").exists()
    assert (out / "styles.css").exists()


def test_top_level_data_files(golden_output):
    out, _ = golden_output
    data_dir = out / "data"
    metadata = _load_js(data_dir / "metadata.js", "KML_METADATA")
    airports = _load_js(data_dir / "airports.js", "KML_AIRPORTS")

    assert set(metadata) == {
        "stats",
        "min_alt_m",
        "max_alt_m",
        "min_groundspeed_knots",
        "max_groundspeed_knots",
        "available_years",
        "year_file_bytes",
    }
    assert metadata["min_alt_m"] <= metadata["max_alt_m"]
    assert 0 <= metadata["min_groundspeed_knots"] <= metadata["max_groundspeed_knots"]

    assert set(airports) == {"airports"}
    assert airports["airports"]
    for airport in airports["airports"]:
        assert set(airport) <= {"name", "lat", "lon", "country", "flight_count"}
        assert {"name", "lat", "lon", "flight_count"} <= set(airport)
        assert airport["flight_count"] >= 1


def test_year_files_match_available_years(golden_output):
    out, _ = golden_output
    data_dir = out / "data"
    metadata = _load_js(data_dir / "metadata.js", "KML_METADATA")
    year_dirs = sorted(int(p.name) for p in data_dir.iterdir() if p.is_dir())

    assert metadata["available_years"] == year_dirs
    assert len(year_dirs) >= 2
    for year in year_dirs:
        data_file = data_dir / str(year) / "data.js"
        assert [p.name for p in (data_dir / str(year)).iterdir()] == ["data.js"]
        assert metadata["year_file_bytes"][str(year)] == data_file.stat().st_size


def test_year_data_shape_and_global_ids(golden_output):
    out, inputs = golden_output
    data_dir = out / "data"
    metadata = _load_js(data_dir / "metadata.js", "KML_METADATA")

    all_ids = []
    total_original_points = 0
    for year in metadata["available_years"]:
        data = _load_js(data_dir / str(year) / "data.js", f"KML_DATA_{year}")
        assert list(data) == ["year", "original_points", "path_info", "segments"]
        assert data["year"] == year
        total_original_points += data["original_points"]

        ids = [info["id"] for info in data["path_info"]]
        assert set(data["segments"]) == {str(i) for i in ids}
        all_ids.extend(ids)

        for info in data["path_info"]:
            assert set(info) <= {
                "id",
                "aircraft_registration",
                "aircraft_type",
                "year",
                "start_airport",
                "end_airport",
                "start_coords",
                "end_coords",
                "segment_count",
                "min_altitude_ft",
                "max_altitude_ft",
            }
            assert None not in info.values()
            assert info["year"] == year
            assert len(info["start_coords"]) == 2
            assert len(info["end_coords"]) == 2

        for rows in data["segments"].values():
            assert rows
            for row in rows:
                assert SEGMENT_MIN_LEN <= len(row) <= SEGMENT_MAX_LEN
                assert all(isinstance(v, int | float) for v in row)
                assert row[4] % 100 == 0
                assert row[5] >= 0

    assert all_ids == list(range(len(all_ids)))
    assert len(all_ids) == len(inputs)
    assert metadata["stats"]["num_paths"] == len(all_ids)
    assert metadata["stats"]["total_points"] == total_original_points


def test_statistics_are_internally_consistent(golden_output):
    out, _ = golden_output
    stats = _load_js(out / "data" / "metadata.js", "KML_METADATA")["stats"]

    assert stats["total_flight_time_seconds"] > 0
    assert stats["total_flight_time_str"] == format_flight_time(
        stats["total_flight_time_seconds"]
    )
    assert stats["total_distance_nm"] == pytest.approx(
        stats["total_distance_km"] / 1.852
    )
    assert stats["min_altitude_m"] <= stats["max_altitude_m"]
    assert stats["max_groundspeed_knots"] >= stats["avg_groundspeed_knots"] > 0
    assert stats["num_airports"] == len(stats["airport_names"])
    assert stats["num_aircraft"] == len(stats["aircraft_list"])
    total_aircraft_time = sum(a["flight_time_seconds"] for a in stats["aircraft_list"])
    assert total_aircraft_time == pytest.approx(stats["total_flight_time_seconds"])
    for aircraft in stats["aircraft_list"]:
        assert aircraft["flight_time_str"] == format_flight_time(
            aircraft["flight_time_seconds"]
        )
        assert aircraft["model"]
