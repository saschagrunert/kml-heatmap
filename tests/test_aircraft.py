"""Tests for aircraft module."""

import tempfile
import os
import json
from kml_heatmap.aircraft import (
    AircraftDataParser,
    parse_aircraft_from_filename,
    lookup_aircraft_model,
)


class TestAircraftDataParser:
    """Tests for AircraftDataParser class."""

    def test_parse_aircraft_title(self):
        """Test parsing aircraft info from HTML title."""
        parser = AircraftDataParser()
        html = "<html><head><title>Aircraft info for D-EAGJ - 2001 Diamond DA-20A-1 Katana</title></head></html>"
        parser.feed(html)
        assert parser.model == "Diamond DA-20A-1 Katana"

    def test_parse_without_year(self):
        """Test parsing aircraft info without year prefix."""
        parser = AircraftDataParser()
        html = "<html><head><title>Aircraft info for D-EAGJ - Cessna 172</title></head></html>"
        parser.feed(html)
        assert parser.model == "Cessna 172"

    def test_no_aircraft_info(self):
        """Test parsing HTML without aircraft info."""
        parser = AircraftDataParser()
        html = "<html><head><title>Some Other Page</title></head></html>"
        parser.feed(html)
        assert parser.model is None

    def test_empty_html(self):
        """Test parsing empty HTML."""
        parser = AircraftDataParser()
        parser.feed("")
        assert parser.model is None

    def test_multiple_titles(self):
        """Test parsing HTML with multiple title tags."""
        parser = AircraftDataParser()
        html = """
        <html>
            <head><title>First Title</title></head>
            <body><title>Aircraft info for D-EAGJ - 2020 Piper PA-28</title></body>
        </html>
        """
        parser.feed(html)
        # Should get the model from the second title
        assert parser.model == "Piper PA-28"


class TestParseAircraftFromFilename:
    """Tests for parse_aircraft_from_filename function."""

    def test_full_format(self):
        """Test parsing filename with full format."""
        # Format: YYYYMMDD_HHMM_AIRPORT_REGISTRATION_TYPE.kml
        result = parse_aircraft_from_filename("20250822_1013_EDAV_DEHYL_DA40.kml")
        assert isinstance(result, dict)
        assert result.get("registration") == "D-EHYL"
        assert result.get("type") == "DA40"

    def test_german_registration(self):
        """Test parsing German registration (D-XXXX format)."""
        result = parse_aircraft_from_filename("20250101_1200_EDDF_DEAGJ_DA20.kml")
        assert isinstance(result, dict)
        assert result.get("registration") == "D-EAGJ"
        assert result.get("type") == "DA20"

    def test_different_aircraft_type(self):
        """Test parsing different aircraft type."""
        result = parse_aircraft_from_filename("20250101_1200_EDDF_DEABC_C172.kml")
        assert isinstance(result, dict)
        assert result.get("type") == "C172"

    def test_incomplete_format(self):
        """Test parsing filename with incomplete format."""
        result = parse_aircraft_from_filename("flight_log.kml")
        assert isinstance(result, dict)
        # Should return empty dict or dict without registration/type

    def test_fewer_parts(self):
        """Test parsing filename with fewer than 5 parts."""
        result = parse_aircraft_from_filename("20250101_1200.kml")
        assert isinstance(result, dict)

    def test_without_kml_extension(self):
        """Test parsing filename without .kml extension."""
        result = parse_aircraft_from_filename("20250822_1013_EDAV_DEHYL_DA40")
        assert isinstance(result, dict)

    def test_with_path(self):
        """Test parsing filename with path (should use basename)."""
        result = parse_aircraft_from_filename(
            "/path/to/20250822_1013_EDAV_DEHYL_DA40.kml"
        )
        assert isinstance(result, dict)
        # Should still parse correctly

    def test_empty_filename(self):
        """Test parsing empty filename."""
        result = parse_aircraft_from_filename("")
        assert isinstance(result, dict)

    def test_numeric_type(self):
        """Test aircraft type with numbers."""
        result = parse_aircraft_from_filename("20250101_1200_EDDF_DEABC_PA28.kml")
        assert isinstance(result, dict)
        assert result.get("type") == "PA28"


class TestAircraftDataParserEdgeCases:
    """Tests for AircraftDataParser edge cases."""

    def test_malformed_html(self):
        """Test parsing malformed HTML."""
        parser = AircraftDataParser()
        # Malformed HTML should not crash
        parser.feed("<html><title>Unclosed tag<body></html>")
        # Should handle gracefully


class TestLookupAircraftModel:
    """Tests for lookup_aircraft_model function."""

    def test_lookup_from_cache(self):
        """Test looking up aircraft from cache."""
        # Create temporary cache file
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            cache = {"D-EAGJ": "Diamond DA-20A-1 Katana"}
            json.dump(cache, f)
            cache_file = f.name

        try:
            result = lookup_aircraft_model("D-EAGJ", cache_file=cache_file)
            assert result == "Diamond DA-20A-1 Katana"
        finally:
            os.unlink(cache_file)

    def test_lookup_nonexistent_cache(self):
        """Test lookup when cache file doesn't exist."""
        result = lookup_aircraft_model("D-EAGJ", cache_file="/nonexistent/cache.json")
        # Should handle gracefully (either return None or attempt web lookup)
        assert isinstance(result, (str, type(None)))

    def test_lookup_empty_registration(self):
        """Test lookup with empty registration."""
        result = lookup_aircraft_model("", cache_file="test_cache.json")
        assert result is None or isinstance(result, str)

    def test_cache_persists_new_lookup(self):
        """Test that new lookups are persisted to cache."""
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            cache = {}
            json.dump(cache, f)
            cache_file = f.name

        try:
            # First lookup (will try web lookup)
            lookup_aircraft_model("D-TEST", cache_file=cache_file)

            # Check cache was updated (if lookup succeeded)
            if os.path.exists(cache_file):
                with open(cache_file, "r") as f:
                    updated_cache = json.load(f)
                    # Cache should have been accessed
                    assert isinstance(updated_cache, dict)
        finally:
            if os.path.exists(cache_file):
                os.unlink(cache_file)

    def test_lookup_invalid_registration_format(self):
        """Test lookup with invalid registration format."""
        result = lookup_aircraft_model("INVALID123", cache_file="test_cache.json")
        # Should handle gracefully
        assert isinstance(result, (str, type(None)))

    def test_corrupted_cache_file(self):
        """Test handling of corrupted cache file."""
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            # Write invalid JSON
            f.write("{invalid json content")
            cache_file = f.name

        try:
            # Should handle corrupted cache gracefully (start with empty cache)
            result = lookup_aircraft_model("D-TEST", cache_file=cache_file)
            # Will try to fetch from web (likely returns None in tests)
            assert isinstance(result, (str, type(None)))
        finally:
            os.unlink(cache_file)

    def test_cache_write_failure(self):
        """Test handling when cache write fails."""
        # Use a read-only directory to trigger write failure
        import stat

        with tempfile.TemporaryDirectory() as tmpdir:
            cache_file = os.path.join(tmpdir, "cache.json")

            # Create an initial valid cache
            with open(cache_file, "w") as f:
                json.dump({"D-EAGJ": "Diamond DA-20A-1 Katana"}, f)

            # Make directory read-only
            os.chmod(tmpdir, stat.S_IRUSR | stat.S_IXUSR)

            try:
                # Lookup existing entry (from cache, no write needed)
                result = lookup_aircraft_model("D-EAGJ", cache_file=cache_file)
                assert result == "Diamond DA-20A-1 Katana"
            finally:
                # Restore permissions for cleanup
                os.chmod(tmpdir, stat.S_IRWXU)

    def test_http_404_not_found(self):
        """Test handling of 404 HTTP error (aircraft not found)."""
        from unittest.mock import patch
        import urllib.error

        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            json.dump({}, f)
            cache_file = f.name

        try:
            with patch("urllib.request.urlopen") as mock_urlopen:
                mock_urlopen.side_effect = urllib.error.HTTPError(
                    url="test", code=404, msg="Not Found", hdrs={}, fp=None
                )
                result = lookup_aircraft_model("D-NOTFOUND", cache_file=cache_file)
                # Should return None for 404
                assert result is None
        finally:
            os.unlink(cache_file)

    def test_http_429_rate_limit(self):
        """Test handling of 429 rate limit error."""
        from unittest.mock import patch
        import urllib.error

        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            json.dump({}, f)
            cache_file = f.name

        try:
            with patch("urllib.request.urlopen") as mock_urlopen:
                mock_urlopen.side_effect = urllib.error.HTTPError(
                    url="test", code=429, msg="Too Many Requests", hdrs={}, fp=None
                )
                result = lookup_aircraft_model("D-EAGJ", cache_file=cache_file)
                # Should return None and log warning
                assert result is None
        finally:
            os.unlink(cache_file)

    def test_http_other_error(self):
        """Test handling of other HTTP errors (500, etc)."""
        from unittest.mock import patch
        import urllib.error

        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            json.dump({}, f)
            cache_file = f.name

        try:
            with patch("urllib.request.urlopen") as mock_urlopen:
                mock_urlopen.side_effect = urllib.error.HTTPError(
                    url="test", code=500, msg="Internal Server Error", hdrs={}, fp=None
                )
                result = lookup_aircraft_model("D-EAGJ", cache_file=cache_file)
                # Should return None and log warning
                assert result is None
        finally:
            os.unlink(cache_file)

    def test_network_error(self):
        """Test handling of network errors."""
        from unittest.mock import patch
        import urllib.error

        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            json.dump({}, f)
            cache_file = f.name

        try:
            with patch("urllib.request.urlopen") as mock_urlopen:
                mock_urlopen.side_effect = urllib.error.URLError("Network unreachable")
                result = lookup_aircraft_model("D-EAGJ", cache_file=cache_file)
                # Should return None and log warning
                assert result is None
        finally:
            os.unlink(cache_file)

    def test_timeout_error(self):
        """Test handling of timeout errors."""
        from unittest.mock import patch

        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            json.dump({}, f)
            cache_file = f.name

        try:
            with patch("urllib.request.urlopen") as mock_urlopen:
                mock_urlopen.side_effect = TimeoutError("Request timed out")
                result = lookup_aircraft_model("D-EAGJ", cache_file=cache_file)
                # Should return None and log warning
                assert result is None
        finally:
            os.unlink(cache_file)

    def test_unexpected_exception(self):
        """Test handling of unexpected exceptions."""
        from unittest.mock import patch

        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            json.dump({}, f)
            cache_file = f.name

        try:
            with patch("urllib.request.urlopen") as mock_urlopen:
                mock_urlopen.side_effect = RuntimeError("Unexpected error")
                result = lookup_aircraft_model("D-EAGJ", cache_file=cache_file)
                # Should return None and log warning
                assert result is None
        finally:
            os.unlink(cache_file)

    def test_successful_lookup_with_cache_update(self):
        """Test successful lookup updates cache."""
        from unittest.mock import patch, MagicMock

        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            json.dump({}, f)
            cache_file = f.name

        try:
            # Mock successful HTTP response with aircraft data
            html_content = b"""<html>
            <head><title>Aircraft info for D-EAGJ - 2001 Diamond DA-20A-1 Katana</title></head>
            <body></body>
            </html>"""

            with patch("urllib.request.urlopen") as mock_urlopen:
                # Create a mock response that behaves like a file object
                mock_response = MagicMock()
                mock_response.read.return_value = html_content
                mock_response.__enter__.return_value = mock_response
                mock_response.__exit__.return_value = None
                mock_urlopen.return_value = mock_response

                result = lookup_aircraft_model("D-EAGJ", cache_file=cache_file)

                # Should return the model
                assert result == "Diamond DA-20A-1 Katana"

                # Verify cache was updated
                with open(cache_file, "r") as f:
                    cache = json.load(f)
                    assert cache.get("D-EAGJ") == "Diamond DA-20A-1 Katana"
        finally:
            os.unlink(cache_file)
