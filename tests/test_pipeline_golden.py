"""Golden pipeline test: run the full export on committed data/*.kml files.

Checks the shape of the generated output and pins the values a fixed subset
of the sample data produces, so that a consistent regression (every speed
halved, a flight dropped, ids renumbered) fails instead of passing as
internally consistent.
"""

import re
from pathlib import Path
from pprint import pformat

import pytest

from kml_heatmap.data_exporter import PATH_ID_BITS
from kml_heatmap.geometry import haversine_distance
from kml_heatmap.renderer import create_progressive_heatmap
from tests.conftest import parse_js as _load_js

DATA_DIR = Path(__file__).parent.parent / "data"
# Row: [lat, lon, altitude_ft, groundspeed_knots] plus an optional time
SEGMENT_MIN_LEN = 4
SEGMENT_MAX_LEN = 5


PER_YEAR = 4

# What the subset of data/ picked by _select_input_files exports, with the
# fixture airport database of the tests. After an intended change to the
# parser, the exporter or the sample data, run
#
#     pytest tests/test_pipeline_golden.py -k golden_values
#
# which fails with the new values, and paste them here; review the diff like
# any other change. The path ids are persisted in shared links: changing them
# needs a new STATE_SCHEMA_VERSION in the frontend (state/urlState.ts).
GOLDEN = {
    "aircraft_models": {
        "D-EAGJ": "Diamond DA-20A-1 Katana",
        "D-EHYL": "Diamond DA-40TDI Diamond Star",
        "D-ELGD": "Cessna T182T Turbo Skylane",
    },
    "airport_names": ["EDAQ Halle-Oppin", "EDVM Hildesheim"],
    "available_years": [2025, 2026],
    "distance_km": {2025: 387.5, 2026: 1176.2},
    "flight_seconds": {2025: 12338.5, 2026: 23987.6},
    "groundspeed_knots": (0.1, 166.3),
    "path_count": 8,
    "path_ids": {
        2025: [411100833082, 642456146975, 336383306180, 68245584272],
        2026: [197972773580, 210679907966, 714877417394, 750385786302],
    },
    "segment_rows": {2025: 4070, 2026: 5609},
}


def _file_number(path):
    """The leading number of a data file name like ``42_DELGD_C182.kml``."""
    match = re.match(r"\d+", path.name)
    return (int(match.group()) if match else -1, path.name)


def _select_input_files(per_year=PER_YEAR):
    """Pick a deterministic subset of committed files covering every year.

    The files are ordered by their numeric prefix, so that adding newer
    recordings to data/ does not change the subset.

    Returns the selection and the number of files found per year.
    """
    by_year = {}
    for path in sorted(DATA_DIR.glob("*.kml"), key=_file_number):
        match = re.search(r"<when>(\d{4})-", path.read_text(encoding="utf-8"))
        if match:
            by_year.setdefault(match.group(1), []).append(path)
    selected = []
    for year in sorted(by_year):
        selected.extend(by_year[year][:per_year])
    return selected, {year: len(paths) for year, paths in by_year.items()}


def _build_site(out, inputs):
    """Run the pipeline on ``inputs`` into ``out / "site"``.

    Only the CLI obfuscates the input files, so data/ is safe to read here.
    """
    # The pipeline requires the bundle, which the Python tests do not build
    bundle = out / "static" / "mapApp.bundle.js"
    bundle.parent.mkdir(parents=True)
    bundle.write_text("/* test bundle */", encoding="utf-8")
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr("kml_heatmap.renderer.BUNDLE_FILE", bundle)
        return create_progressive_heatmap(
            [str(p) for p in inputs],
            str(out / "site" / "index.html"),
            str(out / "site" / "data"),
            [DATA_DIR / "aircraft.json"],
        )


def _observed_values(data_dir):
    """The values GOLDEN pins, read from a generated data directory."""
    metadata = _load_js(data_dir / "metadata.js", "KML_METADATA")
    airports = _load_js(data_dir / "airports.js", "KML_AIRPORTS")["airports"]
    path_ids = {}
    segment_rows = {}
    distance_km = {}
    flight_seconds = {}
    for year in metadata["available_years"]:
        data = _load_js(data_dir / str(year) / "data.js", f"KML_DATA_{year}")
        path_ids[year] = [info["id"] for info in data["path_info"]]
        entries = data["segments"].values()
        segment_rows[year] = sum(len(entry["rows"]) for entry in entries)
        # The rows chain from the start point; the time column is relative to
        # the start of the flight, the way the frontend reads both
        distance = 0.0
        seconds = 0.0
        for entry in entries:
            previous = entry["start"]
            for row in entry["rows"]:
                distance += haversine_distance(*previous[:2], *row[:2])
                previous = row
            times = [row[4] for row in entry["rows"] if len(row) > 4]
            if times:
                seconds += max(times) - min(times)
        distance_km[year] = round(distance, 1)
        flight_seconds[year] = round(seconds, 1)
    return {
        "aircraft_models": metadata["aircraft_models"],
        "airport_names": sorted(airport["name"] for airport in airports),
        "available_years": metadata["available_years"],
        "distance_km": distance_km,
        "flight_seconds": flight_seconds,
        "groundspeed_knots": (
            metadata["min_groundspeed_knots"],
            metadata["max_groundspeed_knots"],
        ),
        "path_count": sum(len(ids) for ids in path_ids.values()),
        "path_ids": path_ids,
        "segment_rows": segment_rows,
    }


@pytest.fixture(scope="module")
def golden_output(tmp_path_factory):
    inputs, files_per_year = _select_input_files()
    if not inputs:
        pytest.skip("no sample KML files available (data/ is not part of the image)")
    assert len(files_per_year) >= 2, "the sample data must span at least two years"
    assert len(inputs) == sum(min(PER_YEAR, n) for n in files_per_year.values())
    out = tmp_path_factory.mktemp("golden")
    assert _build_site(out, inputs) is True
    return out / "site", inputs


def test_golden_values(golden_output):
    out, _ = golden_output
    observed = _observed_values(out / "data")
    assert observed == GOLDEN, "GOLDEN is now:\n" + pformat(observed)


def test_index_html_references_bundles(golden_output):
    out, _ = golden_output
    html = (out / "index.html").read_text(encoding="utf-8")
    assert "mapApp.bundle.js" in html
    # The library bundle was removed; nothing may pull it back in
    assert "./bundle.js" not in html
    assert (out / "map_config.js").exists()
    assert (out / "styles.css").exists()


def test_top_level_data_files(golden_output):
    out, _ = golden_output
    data_dir = out / "data"
    metadata = _load_js(data_dir / "metadata.js", "KML_METADATA")
    airports = _load_js(data_dir / "airports.js", "KML_AIRPORTS")

    # No statistics: the frontend computes them from the year files
    assert set(metadata) == {
        "aircraft_models",
        "min_groundspeed_knots",
        "max_groundspeed_knots",
        "available_years",
        "year_file_bytes",
    }
    assert 0 <= metadata["min_groundspeed_knots"] <= metadata["max_groundspeed_knots"]

    assert set(airports) == {"airports"}
    assert airports["airports"]
    for airport in airports["airports"]:
        assert set(airport) <= {"name", "lat", "lon", "country"}
        assert {"name", "lat", "lon"} <= set(airport)


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


def test_year_data_shape_and_unique_ids(golden_output):
    out, inputs = golden_output
    data_dir = out / "data"
    metadata = _load_js(data_dir / "metadata.js", "KML_METADATA")

    all_ids = []
    registrations = set()
    for year in metadata["available_years"]:
        data = _load_js(data_dir / str(year) / "data.js", f"KML_DATA_{year}")
        assert list(data) == ["year", "original_points", "path_info", "segments"]
        assert data["year"] == year

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
                "min_altitude_ft",
                "max_altitude_ft",
            }
            assert None not in info.values()
            assert info["year"] == year
            registrations.add(info.get("aircraft_registration"))

        for entry in data["segments"].values():
            rows = entry["rows"]
            assert rows
            assert len(entry["start"]) == 2
            for row in rows:
                assert SEGMENT_MIN_LEN <= len(row) <= SEGMENT_MAX_LEN
                assert all(isinstance(v, int | float) for v in row)
                assert row[2] % 100 == 0
                assert row[3] >= 0

    assert len(set(all_ids)) == len(all_ids) == len(inputs)
    assert all(0 <= path_id < 2**PATH_ID_BITS for path_id in all_ids)
    assert set(metadata["aircraft_models"]) <= registrations


def test_ids_survive_removing_an_input_file(golden_output, tmp_path):
    """Shared links name flights by id; another flight must not take it."""
    out, inputs = golden_output
    before = _observed_values(out / "data")["path_ids"]

    assert _build_site(tmp_path, inputs[1:]) is True

    after = _observed_values(tmp_path / "site" / "data")["path_ids"]
    first_year = min(before)
    assert after == {**before, first_year: before[first_year][1:]}
