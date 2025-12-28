"""Tests for airport_lookup module."""

from unittest.mock import patch

from kml_heatmap.airport_lookup import (
    get_cache_info,
    lookup_airport_coordinates,
)


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
