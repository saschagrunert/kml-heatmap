"""Tests for airport_lookup module."""

import os
import pytest
from unittest.mock import patch

from kml_heatmap.airport_lookup import (
    get_cache_info,
    lookup_airport_coordinates,
)


@pytest.fixture(autouse=True)
def preserve_airport_cache():
    """Preserve and restore the global airport cache between tests."""
    import kml_heatmap.airport_lookup as lookup_module

    # Save current cache state
    original_cache = lookup_module._airport_cache

    yield

    # Restore original cache state after test
    lookup_module._airport_cache = original_cache


class TestLookupAirportCoordinates:
    """Tests for lookup_airport_coordinates function."""

    def test_lookup_existing_airport(self):
        """Test lookup of existing airport (will download database on first run)."""
        result = lookup_airport_coordinates("EDDP")
        assert result is not None
        lat, lon, name = result
        # OurAirports has slightly different coordinates than our old hardcoded values
        assert abs(lat - 51.42) < 0.1  # Close to Leipzig
        assert abs(lon - 12.23) < 0.1  # Close to Leipzig
        assert "Leipzig" in name or "Halle" in name

    def test_lookup_lowercase_icao(self):
        """Test lookup with lowercase ICAO code."""
        result = lookup_airport_coordinates("eddp")
        assert result is not None
        lat, lon, name = result
        assert abs(lat - 51.42) < 0.1
        assert abs(lon - 12.23) < 0.1

    def test_lookup_nonexistent_airport(self):
        """Test lookup of non-existent airport."""
        result = lookup_airport_coordinates("XXXX")
        assert result is None

    def test_lookup_invalid_icao_too_short(self):
        """Test lookup with too short ICAO code."""
        result = lookup_airport_coordinates("EDD")
        assert result is None

    def test_lookup_invalid_icao_too_long(self):
        """Test lookup with too long ICAO code."""
        result = lookup_airport_coordinates("EDDDP")
        assert result is None

    def test_lookup_empty_string(self):
        """Test lookup with empty string."""
        result = lookup_airport_coordinates("")
        assert result is None

    def test_lookup_none(self):
        """Test lookup with None - should handle gracefully."""
        result = lookup_airport_coordinates(None)  # type: ignore
        assert result is None

    def test_lookup_multiple_airports(self):
        """Test that database contains multiple airports."""
        # Test a few known airports
        assert lookup_airport_coordinates("EDDP") is not None
        assert lookup_airport_coordinates("EDDH") is not None
        assert lookup_airport_coordinates("EDDC") is not None
        # These smaller airports should also be in OurAirports
        assert lookup_airport_coordinates("EDAQ") is not None


class TestCacheInfo:
    """Tests for cache info function."""

    def test_get_cache_info(self):
        """Test getting cache information."""
        info = get_cache_info()
        assert "cache_file" in info
        assert "cache_exists" in info
        assert "cache_valid" in info
        assert "database_loaded" in info
        assert isinstance(info["cache_exists"], bool)


class TestDownloadAndCaching:
    """Tests for download and caching functionality."""

    def test_empty_database_on_download_failure(self):
        """Test that empty database is returned when download fails."""
        with patch(
            "kml_heatmap.airport_lookup.urlretrieve",
            side_effect=Exception("Network error"),
        ):
            with patch("kml_heatmap.airport_lookup.CACHE_FILE") as mock_cache:
                # Make cache file not exist
                mock_cache.exists.return_value = False

                # Reset global cache to force reload
                import kml_heatmap.airport_lookup as lookup_module

                lookup_module._airport_cache = None

                # Should return None (empty database)
                result = lookup_airport_coordinates("EDDP")
                assert result is None

    def test_cache_validity_check(self):
        """Test cache validity checking."""
        from kml_heatmap.airport_lookup import _is_cache_valid
        from unittest.mock import patch, MagicMock
        import time

        # Test with non-existent cache
        with patch("kml_heatmap.airport_lookup.CACHE_FILE") as mock_cache:
            mock_cache.exists.return_value = False
            assert _is_cache_valid() is False

        # Test with old cache
        with patch("kml_heatmap.airport_lookup.CACHE_FILE") as mock_cache:
            mock_cache.exists.return_value = True
            mock_stat = MagicMock()
            # Cache from 31 days ago
            mock_stat.st_mtime = time.time() - (31 * 24 * 3600)
            mock_cache.stat.return_value = mock_stat
            assert _is_cache_valid() is False

        # Test with recent cache
        with patch("kml_heatmap.airport_lookup.CACHE_FILE") as mock_cache:
            mock_cache.exists.return_value = True
            mock_stat = MagicMock()
            # Cache from 1 day ago
            mock_stat.st_mtime = time.time() - (1 * 24 * 3600)
            mock_cache.stat.return_value = mock_stat
            assert _is_cache_valid() is True

    def test_load_database_with_invalid_csv(self):
        """Test loading database with invalid CSV data."""
        from kml_heatmap.airport_lookup import _load_airport_database
        from pathlib import Path
        import tempfile

        # Create temporary file with invalid data
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".csv") as f:
            f.write("invalid,csv,data\n")
            f.write("no,proper,headers\n")
            temp_path = Path(f.name)

        try:
            with patch("kml_heatmap.airport_lookup.CACHE_FILE", temp_path):
                with patch(
                    "kml_heatmap.airport_lookup._is_cache_valid", return_value=True
                ):
                    # Reset global cache
                    import kml_heatmap.airport_lookup as lookup_module

                    lookup_module._airport_cache = None

                    # Should handle invalid CSV gracefully
                    db = _load_airport_database()
                    # May return empty or partially loaded database
                    assert isinstance(db, dict)
        finally:
            if temp_path.exists():
                temp_path.unlink()

    def test_load_database_with_non_numeric_coordinates(self):
        """Test loading database with non-numeric coordinates."""
        from kml_heatmap.airport_lookup import _load_airport_database
        from pathlib import Path
        import tempfile

        # Create CSV with invalid coordinates
        csv_content = """ident,latitude_deg,longitude_deg,name
XXXX,not_a_number,8.5,Test Airport
YYYY,50.0,not_a_number,Test Airport 2
"""

        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".csv") as f:
            f.write(csv_content)
            temp_path = Path(f.name)

        try:
            with patch("kml_heatmap.airport_lookup.CACHE_FILE", temp_path):
                with patch(
                    "kml_heatmap.airport_lookup._is_cache_valid", return_value=True
                ):
                    # Reset global cache
                    import kml_heatmap.airport_lookup as lookup_module

                    lookup_module._airport_cache = None

                    # Should skip invalid entries
                    db = _load_airport_database()
                    # Should not contain invalid airports
                    assert "XXXX" not in db
                    assert "YYYY" not in db
        finally:
            if temp_path.exists():
                temp_path.unlink()

    def test_load_database_returns_cached_data(self):
        """Test that load_airport_database returns cached data on subsequent calls."""
        from kml_heatmap.airport_lookup import _load_airport_database

        # Load once
        db1 = _load_airport_database()

        # Should return same cached instance
        db2 = _load_airport_database()

        assert db1 is db2  # Same object reference

    def test_file_locking_without_fcntl(self):
        """Test that code works without fcntl (Windows)."""
        from kml_heatmap.airport_lookup import _load_airport_database
        import kml_heatmap.airport_lookup as lookup_module

        # Reset cache
        lookup_module._airport_cache = None

        # Temporarily disable fcntl
        with patch("kml_heatmap.airport_lookup.HAS_FCNTL", False):
            with patch("kml_heatmap.airport_lookup._is_cache_valid", return_value=True):
                with patch("kml_heatmap.airport_lookup.CACHE_FILE") as mock_cache:
                    mock_cache.exists.return_value = True

                    with patch("builtins.open", create=True):
                        with patch("csv.DictReader", return_value=[]):
                            # Should not raise even without fcntl
                            result = _load_airport_database()
                            assert isinstance(result, dict)

    def test_download_failure_handling(self):
        """Test handling of download failures."""
        from kml_heatmap.airport_lookup import _download_airport_database

        with patch("kml_heatmap.airport_lookup.urlretrieve") as mock_retrieve:
            mock_retrieve.side_effect = Exception("Network error")

            # Should return False and not raise
            result = _download_airport_database()
            assert result is False

    def test_empty_cache_file_after_download(self):
        """Test handling of empty cache file after download."""
        from kml_heatmap.airport_lookup import _download_airport_database
        import tempfile

        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as f:
            temp_path = f.name

        try:
            with patch("kml_heatmap.airport_lookup.CACHE_FILE", temp_path):
                with patch("kml_heatmap.airport_lookup.urlretrieve"):
                    # Create empty file
                    with open(temp_path, "w") as f:
                        pass

                    result = _download_airport_database()
                    # Should detect empty file
                    assert result is False
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)

    def test_successful_download(self):
        """Test successful database download."""
        from kml_heatmap.airport_lookup import _download_airport_database
        from pathlib import Path
        import tempfile

        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as f:
            temp_path = Path(f.name)

        try:
            with patch("kml_heatmap.airport_lookup.CACHE_FILE", temp_path):
                with patch("kml_heatmap.airport_lookup.urlretrieve"):
                    # Create non-empty file to simulate successful download
                    with open(temp_path, "w") as f:
                        f.write("ident,latitude_deg,longitude_deg,name\n")
                        f.write("EDDF,50.0,8.5,Frankfurt Airport\n")

                    result = _download_airport_database()
                    # Should succeed
                    assert result is True
        finally:
            if temp_path.exists():
                temp_path.unlink()

    def test_load_database_csv_exception(self):
        """Test handling of CSV reading exceptions."""
        from kml_heatmap.airport_lookup import _load_airport_database
        from pathlib import Path
        import tempfile

        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as f:
            temp_path = Path(f.name)

        try:
            with patch("kml_heatmap.airport_lookup.CACHE_FILE", temp_path):
                with patch(
                    "kml_heatmap.airport_lookup._is_cache_valid", return_value=True
                ):
                    # Create file that exists but will fail to read
                    with open(temp_path, "w") as f:
                        f.write("test")

                    # Reset cache
                    import kml_heatmap.airport_lookup as lookup_module

                    lookup_module._airport_cache = None

                    # Mock csv.DictReader to raise exception
                    with patch("csv.DictReader", side_effect=Exception("CSV error")):
                        db = _load_airport_database()
                        # Should return empty dict on error
                        assert db == {}
        finally:
            if temp_path.exists():
                temp_path.unlink()

    def test_lookup_with_valid_database(self):
        """Test lookup with a valid pre-loaded database."""
        from kml_heatmap.airport_lookup import lookup_airport_coordinates
        import kml_heatmap.airport_lookup as lookup_module

        # Pre-populate cache with test data
        lookup_module._airport_cache = {
            "TEST": (50.0, 8.5, "Test Airport"),
            "EDDF": (50.0333, 8.5706, "Frankfurt Airport"),
        }

        # Lookup should succeed
        result = lookup_airport_coordinates("TEST")
        assert result is not None
        assert result[0] == 50.0
        assert result[1] == 8.5
        assert result[2] == "Test Airport"

        # Lookup non-existent should return None
        result = lookup_airport_coordinates("ZZZZ")
        assert result is None

    def test_file_lock_close_exception(self):
        """Test that file lock close exceptions are handled."""
        from kml_heatmap.airport_lookup import _load_airport_database, HAS_FCNTL
        from pathlib import Path
        import tempfile

        if not HAS_FCNTL:
            # Skip on Windows
            return

        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as f:
            temp_path = Path(f.name)
            # Write valid CSV
            f.write(b"ident,latitude_deg,longitude_deg,name\n")
            f.write(b"TEST,50.0,8.5,Test Airport\n")

        try:
            with patch("kml_heatmap.airport_lookup.CACHE_FILE", temp_path):
                with patch(
                    "kml_heatmap.airport_lookup._is_cache_valid", return_value=True
                ):
                    # Reset cache
                    import kml_heatmap.airport_lookup as lookup_module

                    lookup_module._airport_cache = None

                    # Should handle any errors during cleanup
                    db = _load_airport_database()
                    assert isinstance(db, dict)
        finally:
            if temp_path.exists():
                temp_path.unlink()


class TestAdditionalCoverage:
    """Additional tests to improve coverage."""

    def test_get_cache_info_with_loaded_database(self):
        """Test get_cache_info when database is loaded (covers line 223)."""
        from kml_heatmap.airport_lookup import get_cache_info
        import kml_heatmap.airport_lookup as lookup_module

        # Pre-populate cache to ensure line 223 is covered
        original_cache = lookup_module._airport_cache
        try:
            lookup_module._airport_cache = {
                "TEST": (50.0, 8.5, "Test Airport"),
                "EDDF": (50.0333, 8.5706, "Frankfurt Airport"),
            }

            info = get_cache_info()
            assert "airport_count" in info
            assert info["airport_count"] == 2
        finally:
            lookup_module._airport_cache = original_cache
