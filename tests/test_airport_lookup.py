"""Tests for airport_lookup module."""

import csv
import time
import urllib.error
from unittest.mock import MagicMock, patch

import pytest

import kml_heatmap.airport_lookup as lookup_module
from kml_heatmap.airport_lookup import (
    MAX_DOWNLOAD_BYTES,
    _download_airport_database,
    _is_cache_valid,
    _is_valid_csv_file,
    _load_airport_database,
    _read_airport_csv,
    extract_icao_codes_from_name,
    get_cache_info,
    lookup_airport_coordinates,
    lookup_airport_country,
    standardize_airport_name,
)

VALID_CSV = (
    b'"id","ident","type","name","latitude_deg","longitude_deg","iso_country"\n'
    b'1,"EDDF","large_airport","Frankfurt Main Airport",50.026706,8.55835,"DE"\n'
    b'2,"TEST","small_airport","Test Airport",50.0,8.5,"DE"\n'
)


def _mock_response(payload):
    response = MagicMock()
    response.read.return_value = payload
    response.__enter__ = MagicMock(return_value=response)
    response.__exit__ = MagicMock(return_value=False)
    return response


class TestLookupAirportCoordinates:
    def test_lookup_existing_airport_from_fixture(self):
        result = lookup_airport_coordinates("EDDP")
        assert result is not None
        lat, lon, name = result
        assert lat == pytest.approx(51.420657)
        assert lon == pytest.approx(12.232705)
        assert name == "Leipzig/Halle Airport"

    def test_lookup_lowercase_icao(self):
        result = lookup_airport_coordinates("eddp")
        assert result is not None
        assert result[2] == "Leipzig/Halle Airport"

    def test_lookup_nonexistent_airport(self):
        assert lookup_airport_coordinates("XXXX") is None

    @pytest.mark.parametrize("code", ["EDD", "EDDDP", "", None])
    def test_lookup_invalid_codes(self, code):
        assert lookup_airport_coordinates(code) is None

    def test_fixture_contains_test_airports(self):
        for code in ("EDAQ", "EDDC", "EDAU", "EDDF", "EDDM", "LOAV", "EDAV", "EDBH"):
            assert lookup_airport_coordinates(code) is not None


class TestLookupAirportCountry:
    def test_country_from_fixture(self):
        assert lookup_airport_country("EDDF") == "DE"
        assert lookup_airport_country("LOAV") == "AT"

    def test_nonexistent_airport(self):
        assert lookup_airport_country("XXXX") is None

    @pytest.mark.parametrize("code", ["", "EDD", None])
    def test_invalid_icao(self, code):
        assert lookup_airport_country(code) is None

    def test_empty_country_is_none(self):
        lookup_module._airport_cache = {"TEST": (50.0, 8.5, "Test Airport", "")}
        assert lookup_airport_country("TEST") is None


class TestCacheInfo:
    def test_get_cache_info_keys(self):
        info = get_cache_info()
        assert info["cache_exists"] is True
        assert info["cache_valid"] is True
        assert info["database_loaded"] is False
        assert info["cache_size_mb"] > 0

    def test_get_cache_info_with_loaded_database(self):
        lookup_module._airport_cache = {
            "TEST": (50.0, 8.5, "Test Airport", "DE"),
            "EDDF": (50.0333, 8.5706, "Frankfurt Airport", "DE"),
        }
        assert get_cache_info()["airport_count"] == 2


class TestIsValidCsvFile:
    def test_valid_file(self, tmp_path):
        path = tmp_path / "airports.csv"
        path.write_bytes(VALID_CSV)
        assert _is_valid_csv_file(path) is True

    def test_empty_file_invalid(self, tmp_path):
        path = tmp_path / "airports.csv"
        path.write_bytes(b"")
        assert _is_valid_csv_file(path) is False

    def test_truncated_file_invalid(self, tmp_path):
        path = tmp_path / "airports.csv"
        path.write_bytes(VALID_CSV[:-10])
        assert _is_valid_csv_file(path) is False

    def test_headerless_file_invalid(self, tmp_path):
        path = tmp_path / "airports.csv"
        path.write_bytes(b"invalid,csv,data\nno,proper,headers\n")
        assert _is_valid_csv_file(path) is False

    def test_missing_file_invalid(self, tmp_path):
        assert _is_valid_csv_file(tmp_path / "missing.csv") is False


class TestIsCacheValid:
    def test_missing_cache(self, tmp_path):
        with patch.object(lookup_module, "CACHE_FILE", tmp_path / "missing.csv"):
            assert _is_cache_valid() is False

    def test_old_cache_invalid(self, tmp_path):
        path = tmp_path / "airports.csv"
        path.write_bytes(VALID_CSV)
        with patch.object(lookup_module, "CACHE_FILE", path):
            mock_stat = MagicMock()
            mock_stat.st_mtime = time.time() - (31 * 24 * 3600)
            with patch.object(type(path), "stat", return_value=mock_stat):
                assert _is_cache_valid() is False

    def test_recent_valid_cache(self):
        assert _is_cache_valid() is True

    def test_recent_but_headerless_cache_invalid(self, tmp_path):
        path = tmp_path / "airports.csv"
        path.write_bytes(b"no,header,here\n")
        with patch.object(lookup_module, "CACHE_FILE", path):
            assert _is_cache_valid() is False


class TestDownloadAirportDatabase:
    def test_successful_download_is_atomic(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(
                lookup_module, "urlopen", return_value=_mock_response(VALID_CSV)
            ),
        ):
            assert _download_airport_database() is True

        assert cache_file.read_bytes() == VALID_CSV
        assert list(tmp_path.glob("*.tmp")) == []

    def test_empty_response_rejected(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        cache_file.write_bytes(VALID_CSV)
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(lookup_module, "urlopen", return_value=_mock_response(b"")),
        ):
            assert _download_airport_database() is False

        # Existing cache is left untouched and no temp file remains
        assert cache_file.read_bytes() == VALID_CSV
        assert list(tmp_path.glob("*.tmp")) == []

    def test_truncated_response_rejected(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(
                lookup_module, "urlopen", return_value=_mock_response(VALID_CSV[:-5])
            ),
        ):
            assert _download_airport_database() is False
        assert not cache_file.exists()

    def test_headerless_response_rejected(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(
                lookup_module,
                "urlopen",
                return_value=_mock_response(b"a,b,c\n1,2,3\n"),
            ),
        ):
            assert _download_airport_database() is False
        assert not cache_file.exists()

    def test_oversized_response_rejected(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        oversized = b"x" * (MAX_DOWNLOAD_BYTES + 1)
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(
                lookup_module, "urlopen", return_value=_mock_response(oversized)
            ),
        ):
            assert _download_airport_database() is False
        assert not cache_file.exists()

    def test_read_is_capped(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        response = _mock_response(VALID_CSV)
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(lookup_module, "urlopen", return_value=response),
        ):
            _download_airport_database()
        response.read.assert_called_once_with(MAX_DOWNLOAD_BYTES + 1)

    def test_url_error_handled(self, tmp_path):
        with (
            patch.object(lookup_module, "CACHE_FILE", tmp_path / "airports.csv"),
            patch.object(
                lookup_module,
                "urlopen",
                side_effect=urllib.error.URLError("offline"),
            ),
        ):
            assert _download_airport_database() is False

    def test_os_error_handled(self, tmp_path):
        with (
            patch.object(lookup_module, "CACHE_FILE", tmp_path / "airports.csv"),
            patch.object(lookup_module, "urlopen", side_effect=OSError("Network")),
        ):
            assert _download_airport_database() is False

    def test_uses_timeout_and_tls_context(self, tmp_path):
        with (
            patch.object(lookup_module, "CACHE_FILE", tmp_path / "airports.csv"),
            patch.object(
                lookup_module, "urlopen", return_value=_mock_response(VALID_CSV)
            ) as mock_urlopen,
        ):
            _download_airport_database()
        _, kwargs = mock_urlopen.call_args
        assert kwargs["timeout"] == lookup_module.DOWNLOAD_TIMEOUT_SECONDS
        assert kwargs["context"] is not None


class TestReadAirportCsv:
    def test_skips_non_numeric_coordinates(self, tmp_path):
        path = tmp_path / "airports.csv"
        path.write_text(
            "ident,latitude_deg,longitude_deg,name\n"
            "XXXX,not_a_number,8.5,Test Airport\n"
            "YYYY,50.0,not_a_number,Test Airport 2\n"
            "ZZZZ,50.0,8.5,Valid Airport\n"
        )
        db = _read_airport_csv(path)
        assert set(db) == {"ZZZZ"}

    def test_skips_short_rows_and_non_icao(self, tmp_path):
        path = tmp_path / "airports.csv"
        path.write_text(
            "ident,latitude_deg,longitude_deg,name\n"
            "ABCDE,50.0,8.5,Too long\n"
            "ABCD\n"
            "EFGH,50.0,8.5,\n"
        )
        assert _read_airport_csv(path) == {}


class TestLoadAirportDatabase:
    def test_loads_fixture_and_caches_instance(self):
        db1 = _load_airport_database()
        db2 = _load_airport_database()
        assert db1 is db2
        assert "EDDP" in db1

    def test_invalid_cache_triggers_redownload(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        cache_file.write_bytes(b"no,header\n")
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(
                lookup_module, "urlopen", return_value=_mock_response(VALID_CSV)
            ) as mock_urlopen,
        ):
            db = _load_airport_database()

        mock_urlopen.assert_called_once()
        assert "TEST" in db
        assert cache_file.read_bytes() == VALID_CSV

    def test_empty_database_on_download_failure(self, tmp_path):
        with (
            patch.object(lookup_module, "CACHE_FILE", tmp_path / "missing.csv"),
            patch.object(lookup_module, "urlopen", side_effect=OSError("offline")),
        ):
            assert _load_airport_database() == {}
            assert lookup_airport_coordinates("EDDP") is None

    def test_csv_error_returns_empty(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        cache_file.write_bytes(VALID_CSV)
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(lookup_module, "_is_cache_valid", return_value=True),
            patch("csv.DictReader", side_effect=csv.Error("CSV error")),
        ):
            assert _load_airport_database() == {}

    def test_works_without_fcntl(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        cache_file.write_bytes(VALID_CSV)
        with (
            patch.object(lookup_module, "HAS_FCNTL", False),
            patch.object(lookup_module, "CACHE_FILE", cache_file),
        ):
            db = _load_airport_database()
        assert "EDDF" in db

    def test_lock_release_failure_is_handled(self):
        original_flock = lookup_module.fcntl.flock

        def flock_side_effect(fd, op):
            if op == lookup_module.fcntl.LOCK_UN:
                raise OSError("mock unlock failure")
            return original_flock(fd, op)

        with patch.object(lookup_module.fcntl, "flock", side_effect=flock_side_effect):
            db = _load_airport_database()
        assert "EDDP" in db


class TestExtractIcaoCodesFromName:
    def test_single_icao_code(self):
        assert extract_icao_codes_from_name("EDDF Frankfurt") == ["EDDF"]

    def test_multiple_icao_codes(self):
        codes = extract_icao_codes_from_name("EDDF Frankfurt - EDDM Munich")
        assert codes == ["EDDF", "EDDM"]

    def test_no_icao_codes(self):
        assert extract_icao_codes_from_name("Log Start: 03 Mar 2025") == []

    def test_invalid_region_prefix_filtered(self):
        assert extract_icao_codes_from_name("JUNE XRAY QUIT") == []

    @pytest.mark.parametrize("value", ["", None])
    def test_empty_input(self, value):
        assert extract_icao_codes_from_name(value) == []


class TestStandardizeAirportName:
    def test_single_airport_from_fixture(self):
        assert standardize_airport_name("EDDP") == "EDDP Leipzig/Halle"

    def test_route_from_fixture(self):
        assert (
            standardize_airport_name("EDDF - EDDM")
            == "EDDF Frankfurt Main - EDDM Munich"
        )

    def test_airfield_suffix_stripped(self):
        assert standardize_airport_name("LOAV") == "LOAV Vöslau-Kottingbrunn"

    def test_no_icao_codes_returns_original(self):
        assert standardize_airport_name("Some Airport") == "Some Airport"

    @pytest.mark.parametrize("value", [None, ""])
    def test_empty_returns_input(self, value):
        assert standardize_airport_name(value) == value

    def test_only_first_airport_found(self):
        result = standardize_airport_name("EDAQ Halle - ZZZZ SomePlace")
        assert result == "EDAQ Halle-Oppin - ZZZZ SomePlace"

    def test_only_second_airport_found(self):
        result = standardize_airport_name("ZZZZ SomePlace - EDMV Vilsh")
        assert result == "ZZZZ SomePlace - EDMV Vilshofen"

    def test_unknown_single_airport_returns_original(self):
        assert standardize_airport_name("ZZZZ Nowhere") == "ZZZZ Nowhere"

    def test_route_with_unknown_airports_returns_original(self):
        assert standardize_airport_name("ZZZZ - YYYY") == "ZZZZ - YYYY"
