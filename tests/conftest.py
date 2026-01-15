"""Pytest configuration and shared fixtures for kml-heatmap tests."""

import os
import shutil
import tempfile
from pathlib import Path

import pytest


# Create a session-level temp directory for the entire test session
_TEST_CACHE_DIR = None


def pytest_configure(config):
    """Create a temporary cache directory before any tests/modules are imported.

    This sets the KML_HEATMAP_TEST_CACHE environment variable which the
    cache module checks to determine where to store cache files during testing.
    """
    global _TEST_CACHE_DIR
    _TEST_CACHE_DIR = Path(tempfile.mkdtemp(prefix="kml_heatmap_test_"))
    os.environ["KML_HEATMAP_TEST_CACHE"] = str(_TEST_CACHE_DIR)


def pytest_unconfigure(config):
    """Clean up the temporary cache directory after all tests complete."""
    global _TEST_CACHE_DIR
    if _TEST_CACHE_DIR and _TEST_CACHE_DIR.exists():
        shutil.rmtree(_TEST_CACHE_DIR, ignore_errors=True)
    if "KML_HEATMAP_TEST_CACHE" in os.environ:
        del os.environ["KML_HEATMAP_TEST_CACHE"]


@pytest.fixture(autouse=True)
def reset_airport_cache():
    """Reset the global airport cache before and after each test.

    This ensures test isolation by preventing cached data from one test
    affecting another test.
    """
    import kml_heatmap.airport_lookup as airport_lookup_module

    # Reset before test
    airport_lookup_module._airport_cache = None

    yield

    # Reset after test
    airport_lookup_module._airport_cache = None
