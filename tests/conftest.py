"""Pytest configuration and shared fixtures for kml-heatmap tests.

The cache directory is redirected to a session-private directory through the
production ``KML_HEATMAP_CACHE_DIR`` setting, a small fixture airports.csv is
installed there so no test needs the network, and any attempt to download the
airport database or an elevation tile fails loudly.
"""

import json
import os
import shutil
import tempfile
import time
from pathlib import Path

import pytest
from hypothesis import settings

# The functions under property tests take microseconds, but a GC pause or a
# busy CI runner (the suite runs under xdist) can still trip the default
# 200 ms deadline and report a flaky test; without it Hypothesis only
# reports failing examples.
settings.register_profile("no-deadline", deadline=None)
settings.load_profile("no-deadline")

_TEST_CACHE_DIR: Path | None = None

FIXTURE_AIRPORTS_CSV = Path(__file__).parent / "fixtures" / "airports.csv"


def pytest_configure(config):
    """Point the cache at a private directory before kml_heatmap is imported."""
    global _TEST_CACHE_DIR
    _TEST_CACHE_DIR = Path(tempfile.mkdtemp(prefix="kml_heatmap_test_"))
    os.environ["KML_HEATMAP_CACHE_DIR"] = str(_TEST_CACHE_DIR)


def pytest_unconfigure(config):
    """Clean up the private cache directory after all tests complete."""
    if _TEST_CACHE_DIR and _TEST_CACHE_DIR.exists():
        shutil.rmtree(_TEST_CACHE_DIR, ignore_errors=True)
    os.environ.pop("KML_HEATMAP_CACHE_DIR", None)


@pytest.fixture(scope="session", autouse=True)
def airport_fixture_csv():
    """Install the fixture airports.csv as the (fresh) airport cache."""
    from kml_heatmap.airport_lookup import CACHE_FILE

    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(FIXTURE_AIRPORTS_CSV, CACHE_FILE)
    now = time.time()
    os.utime(CACHE_FILE, (now, now))
    return CACHE_FILE


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Fail loudly if anything tries to download the airport database or tiles.

    An AssertionError is none of the errors the elevation tile download
    degrades on, so it fails the test from the download thread.
    """

    def _refuse(*args, **kwargs):
        raise AssertionError("Unexpected network access through urlopen in tests")

    monkeypatch.setattr("kml_heatmap.airport_lookup.urlopen", _refuse)
    monkeypatch.setattr("kml_heatmap.terrain.urlopen", _refuse)


@pytest.fixture(autouse=True)
def private_parse_cache(monkeypatch, tmp_path_factory):
    """Give every test its own parse cache directory (in this process).

    Entries are keyed by file name and content, so two tests writing the same
    KML file would otherwise share an entry and skip the parse (and its log
    output) depending on the order they run in.
    """
    monkeypatch.setattr(
        "kml_heatmap.parser_cache.KML_CACHE_DIR", tmp_path_factory.mktemp("kml")
    )


@pytest.fixture(autouse=True)
def reset_airport_cache():
    """Reset the airport cache and the download failure marker around each test.

    The marker lives in the (session private) cache directory; a test that
    exercises a failed download must not stop the next test from trying.
    """
    import kml_heatmap.airport_lookup as airport_lookup_module

    airport_lookup_module._airport_cache = None
    airport_lookup_module._clear_download_failure()
    yield
    airport_lookup_module._airport_cache = None
    airport_lookup_module._clear_download_failure()


def parse_data(path):
    """The payload of a data file of the site."""
    return json.loads(Path(path).read_text(encoding="utf-8"))


@pytest.fixture(name="parse_data")
def parse_data_fixture():
    """The ``parse_data`` helper as a fixture."""
    return parse_data


def decoded_segments(entry):
    """A segments entry of a year file as the frontend reads it.

    The rows on disk are scaled integers stored as differences, column
    by column (see
    ``kml_heatmap.segment_codec``). Tests that care about the values rather
    than the encoding go through here.
    """
    from kml_heatmap.segment_codec import COORDINATE_SCALE, decode_rows

    start = [value / COORDINATE_SCALE for value in entry["start"]]
    return start, decode_rows(entry["start"], entry["columns"])


@pytest.fixture
def decode_entry():
    """Fixture form of :func:`decoded_segments`."""
    return decoded_segments
