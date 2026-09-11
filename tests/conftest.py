"""Pytest configuration and shared fixtures for kml-heatmap tests.

The cache directory is redirected to a session-private directory through the
production ``KML_HEATMAP_CACHE_DIR`` setting, a small fixture airports.csv is
installed there so no test needs the network, and any attempt to download the
airport database fails loudly.
"""

import json
import os
import shutil
import tempfile
import time
from pathlib import Path

import pytest

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
    """Fail loudly if anything tries to download the airport database."""

    def _refuse(*args, **kwargs):
        raise AssertionError("Unexpected network access through urlopen in tests")

    monkeypatch.setattr("kml_heatmap.airport_lookup.urlopen", _refuse)


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


def parse_js(path, variable=None):
    """Parse a ``window.<variable> = <json>;`` file and return the payload.

    With ``variable`` the exact prefix is checked, otherwise any window
    variable is accepted.
    """
    content = Path(path).read_text(encoding="utf-8")
    prefix = f"window.{variable} = " if variable else "window."
    assert content.startswith(prefix), f"{path} does not start with {prefix!r}"
    assert content.endswith(";"), f"{path} does not end with a semicolon"
    start = len(prefix) if variable else content.index("=") + 1
    return json.loads(content[start:-1].strip())


@pytest.fixture(name="parse_js")
def parse_js_fixture():
    """The ``parse_js`` helper as a fixture."""
    return parse_js
