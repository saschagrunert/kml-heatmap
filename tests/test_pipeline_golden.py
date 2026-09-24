"""Golden pipeline test: run the full export on committed data/*.kml files.

Checks the shape of the generated output and pins the values a fixed subset
of the sample data produces, so that a consistent regression (every speed
halved, a flight dropped, ids renumbered) fails instead of passing as
internally consistent.
"""

import math
import re
from datetime import datetime, timedelta
from pathlib import Path
from pprint import pformat

import pytest
from lxml import html as lxml_html

from kml_heatmap.data_exporter import PATH_ID_BITS
from kml_heatmap.geometry import haversine_distance
from kml_heatmap.obfuscate import obfuscate_kml_files
from kml_heatmap.renderer import create_progressive_heatmap
from kml_heatmap.segment_codec import (
    COORDINATE_SCALE,
    FORMAT_VERSION,
    GROUND_STEP,
    decode_ground,
    decode_rows,
)
from kml_heatmap.terrain import TILE_SIZE
from tests.conftest import parse_data as _load_js

DATA_DIR = Path(__file__).parent.parent / "data"
# Row: [lat, lon, altitude_ft, groundspeed_knots] plus an optional time
SEGMENT_MIN_COLUMNS = 4
SEGMENT_MAX_COLUMNS = 5


PER_YEAR = 4

# How far test_real_dates_export_exactly_like_obfuscated_ones moves the sample
# flights off January 1st. Any whole number of days that stays inside the year
# does; 137 is far enough that a date leaking into the export would be obvious.
DATE_SHIFT_DAYS = 137

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
    # Paths with a ground, and its lowest, highest and mean, over Hills
    "ground_ft": {2025: (4, 80.0, 550.0, 368.8), 2026: (4, -60.0, 980.0, 430.0)},
    "groundspeed_knots": (0.1, 167.4),
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


class Hills:
    """Rolling hills of a few hundred metres, the same on every run.

    Stands in for the elevation tiles, which the tests never download.
    """

    def pixels(self, wanted):
        return {
            tile: [
                200.0
                + 150.0
                * math.sin((tile.x * TILE_SIZE + index % TILE_SIZE) / 40)
                * math.cos((tile.y * TILE_SIZE + index // TILE_SIZE) / 40)
                for index in indices
            ]
            for tile, indices in wanted.items()
        }


def _build_site(out, inputs):
    """Run the pipeline on ``inputs`` into ``out / "site"``.

    The pipeline never writes to its inputs (only the CLI does, and only with
    --obfuscate-inputs), so data/ is safe to read here. The ground comes from
    ``Hills``.
    """
    # The pipeline requires the bundle, which the Python tests do not build
    bundle = out / "static" / "mapApp.bundle.js"
    bundle.parent.mkdir(parents=True)
    bundle.write_text("/* test bundle */", encoding="utf-8")
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr("kml_heatmap.site_assets.BUNDLE_FILE", bundle)
        return create_progressive_heatmap(
            [str(p) for p in inputs],
            str(out / "site" / "index.html"),
            str(out / "site" / "data"),
            [DATA_DIR / "aircraft.json"],
            terrain=Hills(),
        )


def _observed_values(data_dir):
    """The values GOLDEN pins, read from a generated data directory."""
    metadata = _load_js(data_dir / "metadata.json")
    airports = _load_js(data_dir / "airports.json")["airports"]
    path_ids = {}
    segment_rows = {}
    distance_km = {}
    flight_seconds = {}
    ground_ft = {}
    for year in metadata["available_years"]:
        data = _load_js(data_dir / str(year) / "data.json")
        path_ids[year] = [info["id"] for info in data["path_info"]]
        entries = data["segments"].values()
        segment_rows[year] = sum(len(entry["columns"][0]) for entry in entries)
        # The rows are scaled integers stored as differences; decoding them
        # here is a second implementation of what the frontend does, so the
        # numbers below are the ones a visitor sees. They were pinned before
        # the format changed and did not move with it.
        distance = 0.0
        seconds = 0.0
        for entry in entries:
            rows = decode_rows(entry["start"], entry["columns"])
            previous = [value / COORDINATE_SCALE for value in entry["start"]]
            for row in rows:
                distance += haversine_distance(*previous[:2], *row[:2])
                previous = row
            times = [row[4] for row in rows if len(row) > 4]
            if times:
                seconds += max(times) - min(times)
        distance_km[year] = round(distance, 1)
        flight_seconds[year] = round(seconds, 1)
        grounds = [
            feet
            for entry in entries
            if "ground" in entry
            for feet in decode_ground(entry["ground"])
        ]
        # How many paths have a ground, and its range and mean
        ground_ft[year] = (
            sum("ground" in entry for entry in entries),
            min(grounds),
            max(grounds),
            round(sum(grounds) / len(grounds), 1),
        )
    return {
        "aircraft_models": metadata["aircraft_models"],
        "airport_names": sorted(airport["name"] for airport in airports),
        "available_years": metadata["available_years"],
        "distance_km": distance_km,
        "flight_seconds": flight_seconds,
        "ground_ft": ground_ft,
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


def test_index_html_preloads_the_latest_year(golden_output):
    """The year the page opens on, at the URL the loader requests it by."""
    out, _ = golden_output
    page = lxml_html.fromstring((out / "index.html").read_text(encoding="utf-8"))
    latest = max(_load_js(out / "data" / "metadata.json")["available_years"])
    preloads = [
        (link.get("as"), link.get("href"))
        for link in page.iter("link")
        if link.get("rel") == "preload"
    ]
    assert preloads == [
        ("fetch", "data/metadata.json"),
        ("fetch", "data/airports.json"),
        ("fetch", f"data/{latest}/data.json"),
    ]
    assert (out / "data" / str(latest) / "data.json").exists()


def test_top_level_data_files(golden_output):
    out, _ = golden_output
    data_dir = out / "data"
    metadata = _load_js(data_dir / "metadata.json")
    airports = _load_js(data_dir / "airports.json")

    # No statistics: the frontend computes them from the year files
    assert set(metadata) == {
        "aircraft_models",
        "available_flags",
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
    metadata = _load_js(data_dir / "metadata.json")
    year_dirs = sorted(int(p.name) for p in data_dir.iterdir() if p.is_dir())

    assert metadata["available_years"] == year_dirs
    assert len(year_dirs) >= 2
    for year in year_dirs:
        data_file = data_dir / str(year) / "data.json"
        assert [p.name for p in (data_dir / str(year)).iterdir()] == ["data.json"]
        assert metadata["year_file_bytes"][str(year)] == data_file.stat().st_size


def test_year_data_shape_and_unique_ids(golden_output):
    out, inputs = golden_output
    data_dir = out / "data"
    metadata = _load_js(data_dir / "metadata.json")

    all_ids = []
    registrations = set()
    for year in metadata["available_years"]:
        data = _load_js(data_dir / str(year) / "data.json")
        assert list(data) == [
            "format",
            "year",
            "original_points",
            "path_info",
            "segments",
        ]
        assert data["format"] == FORMAT_VERSION
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
                "altitude_gain_ft",
            }
            assert None not in info.values()
            assert info["year"] == year
            registrations.add(info.get("aircraft_registration"))

        for entry in data["segments"].values():
            encoded = entry["columns"]
            assert encoded[0]
            assert len(entry["start"]) == 2
            # Everything on disk is an integer, which is the point of the format
            assert all(isinstance(value, int) for value in entry["start"])
            assert SEGMENT_MIN_COLUMNS <= len(encoded) <= SEGMENT_MAX_COLUMNS
            for column in encoded:
                assert len(column) == len(encoded[0])
                assert all(isinstance(value, int) for value in column)
            for row in decode_rows(entry["start"], encoded):
                assert row[2] % 100 == 0
                assert row[3] >= 0
            # The ground is optional, and covers every row where it is written
            assert set(entry) <= {"start", "columns", "ground"}
            if "ground" in entry:
                assert len(entry["ground"]) == len(encoded[0])
                assert all(isinstance(value, int) for value in entry["ground"])
                assert all(
                    feet % GROUND_STEP == 0 for feet in decode_ground(entry["ground"])
                )

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


def _with_real_dates(source_files, destination):
    """Copies of ``source_files`` with their dates moved off January 1st.

    The committed files are obfuscated, so this undoes that for the test: it
    shifts every flight by the same whole number of days, which is what a
    recording with real dates looks like to the parser (the year and the time
    of day are kept, and so are the intervals between the points).
    """
    destination.mkdir(parents=True, exist_ok=True)
    shifted = []
    for path in source_files:
        text = path.read_text(encoding="utf-8")
        moved = re.sub(
            r"(\d{4})-01-01T(\d{2}:\d{2}:\d{2})",
            lambda m: (
                datetime.fromisoformat(f"{m.group(1)}-01-01T{m.group(2)}")
                + timedelta(days=DATE_SHIFT_DAYS)
            ).strftime("%Y-%m-%dT%H:%M:%S"),
            text,
        )
        assert moved != text, f"no timestamp to shift in {path.name}"
        copy = destination / path.name
        copy.write_text(moved, encoding="utf-8")
        shifted.append(copy)
    return shifted


def test_real_dates_export_exactly_like_obfuscated_ones(tmp_path):
    """The site is the same whether or not the inputs were rewritten.

    This is why ``--obfuscate-inputs`` is off by default: rewriting the user's
    files in place buys the published site nothing, because the export drops
    every absolute timestamp anyway. If this ever stops holding, the default
    has to be reconsidered, not the assertion.
    """
    inputs, _ = _select_input_files()
    with_dates = _with_real_dates(inputs, tmp_path / "with-dates")
    obfuscated = _with_real_dates(inputs, tmp_path / "obfuscated")

    assert _build_site(tmp_path / "a", with_dates) is True
    assert obfuscate_kml_files(obfuscated) == len(obfuscated)
    assert _build_site(tmp_path / "b", obfuscated) is True

    def data_files(root):
        return {
            path.relative_to(root): path.read_bytes()
            for path in sorted((root / "site" / "data").rglob("*.json"))
        }

    exported = data_files(tmp_path / "a")
    assert len(exported) > 2
    assert exported == data_files(tmp_path / "b")


# Free-text names and a file name with the date of the flight in them
DATED_FLIGHTS = {
    "1_DEHYL_2026-08-16.kml": "Sunday flight 16 Aug 2026",
    "2_DEAGJ_DA20.kml": "Flight EDDS-EDDP 2026-08-16",
    "3_DEAGJ_DA20.kml": "EDXX 16 Aug 2026",
    "4_DEAGJ_DA20.kml": "EDDS 16.08.2026 08:50 Z - EDDP",
}


def _dated_flight(directory, file_name, name, offset):
    """A flight that takes off and lands (so its ends become airports)."""
    points = 40
    whens = "".join(f"<when>2026-08-16T10:{i:02d}:00Z</when>" for i in range(points))
    coords = "".join(
        f"<gx:coord>{8.0 + offset + i * 0.02:.3f} {48.5 + i * 0.01:.3f} "
        f"{300 if i in (0, points - 1) else 1500}</gx:coord>"
        for i in range(points)
    )
    path = directory / file_name
    path.write_text(
        '<kml xmlns="http://www.opengis.net/kml/2.2" '
        'xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Placemark>'
        f"<name>{name}</name><gx:Track>{whens}{coords}</gx:Track>"
        "</Placemark></Document></kml>",
        encoding="utf-8",
    )
    return path


def test_no_date_of_a_name_is_exported(tmp_path):
    """Names are free text; the export publishes them without their dates.

    And, as for the timestamps, the site is the same whether or not the
    inputs were obfuscated.
    """
    from kml_heatmap.date_tokens import find_date_tokens

    sources = {}
    for label in ("a", "b"):
        directory = tmp_path / f"{label}-input"
        directory.mkdir()
        sources[label] = [
            _dated_flight(directory, file_name, name, offset)
            for offset, (file_name, name) in enumerate(DATED_FLIGHTS.items())
        ]
    assert obfuscate_kml_files(sources["b"]) == len(sources["b"])
    for label, inputs in sources.items():
        assert _build_site(tmp_path / label, inputs) is True

    data_dir = tmp_path / "a" / "site" / "data"
    airports = _load_js(data_dir / "airports.json")["airports"]
    path_info = _load_js(data_dir / "2026" / "data.json")["path_info"]
    names = [airport["name"] for airport in airports] + [
        info[key]
        for info in path_info
        for key in ("start_airport", "end_airport", "aircraft_type")
        if key in info
    ]
    assert len(path_info) == len(DATED_FLIGHTS)
    assert "Sunday flight" in names
    assert "Flight EDDS-EDDP" in names
    assert "EDXX" in names
    for name in names:
        assert not find_date_tokens(name), name
        assert not re.search(r"\b16\b|Aug|08:50", name), name
    # The dated file name has no type left, the others keep theirs
    assert [info.get("aircraft_type") for info in path_info] == [
        None,
        "DA20",
        "DA20",
        "DA20",
    ]

    def data_files(root):
        return {
            path.relative_to(root): path.read_bytes()
            for path in sorted((root / "site" / "data").rglob("*.json"))
        }

    exported = data_files(tmp_path / "a")
    assert len(exported) == 3
    assert exported == data_files(tmp_path / "b")
