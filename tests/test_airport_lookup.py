"""Tests for airport_lookup module."""

import csv
import fcntl
import http.client
import os
import time
import urllib.error
from unittest.mock import MagicMock, patch

import pytest

import kml_heatmap.airport_lookup as lookup_module
from kml_heatmap.airport_lookup import (
    MAX_DOWNLOAD_BYTES,
    REQUIRE_DATABASE_ENV,
    AirportNames,
    AirportRecord,
    _download_airport_database,
    _is_cache_valid,
    _is_valid_csv_file,
    _read_airport_csv,
    _strip_airport_suffix,
    airport_icao_code,
    database_fingerprint,
    extract_icao_codes_from_name,
    load_airport_database,
    lookup_airport_coordinates,
    lookup_airport_country,
    lookup_airport_elevation,
    split_route_name,
    standardize_airport_names,
)
from kml_heatmap.cache import REGULAR_FILE_MODE
from kml_heatmap.exceptions import AirportDatabaseError

VALID_CSV = (
    b'"id","ident","type","name","latitude_deg","longitude_deg","iso_country"\n'
    b'1,"EDDF","large_airport","Frankfurt Main Airport",50.026706,8.55835,"DE"\n'
    b'2,"TEST","small_airport","Test Airport",50.0,8.5,"DE"\n'
)


def _mock_response(payload, content_length=None):
    response = MagicMock()
    response.read.return_value = payload
    length = len(payload) if content_length is None else content_length
    response.headers = {"Content-Length": str(length)}
    response.__enter__ = MagicMock(return_value=response)
    response.__exit__ = MagicMock(return_value=False)
    return response


@pytest.fixture
def small_downloads():
    """Accept the two-row test CSV as a complete download."""
    with patch.object(lookup_module, "MIN_DOWNLOAD_ROWS", 1):
        yield


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
        lookup_module._airport_cache = {
            "TEST": AirportRecord(50.0, 8.5, "Test Airport", "")
        }
        assert lookup_airport_country("TEST") is None


class TestLookupAirportElevation:
    def test_from_fixture(self):
        # EDAQ Halle-Oppin: 348 ft
        assert lookup_airport_elevation("edaq") == pytest.approx(106.07, abs=0.01)

    def test_unknown_or_missing(self, tmp_path):
        assert lookup_airport_elevation("XXXX") is None
        assert lookup_airport_elevation("EDD") is None
        assert lookup_airport_elevation(None) is None
        # A database without the column
        path = tmp_path / "airports.csv"
        path.write_bytes(VALID_CSV)
        assert _read_airport_csv(path)["EDDF"].elevation_m is None


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


@pytest.mark.usefixtures("small_downloads")
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
        # Readable like any other cache file, not the 0600 of the temp file
        assert cache_file.stat().st_mode & 0o777 == REGULAR_FILE_MODE

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

    def test_body_shorter_than_content_length_rejected(self, tmp_path):
        """A cut at a line boundary still ends in a newline and has a header."""
        cache_file = tmp_path / "airports.csv"
        cut = VALID_CSV[: VALID_CSV.index(b"\n", 90) + 1]
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(
                lookup_module,
                "urlopen",
                return_value=_mock_response(cut, content_length=len(VALID_CSV)),
            ),
        ):
            assert _download_airport_database() is False
        assert not cache_file.exists()

    def test_missing_content_length_is_accepted(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        response = _mock_response(VALID_CSV)
        response.headers = {}
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(lookup_module, "urlopen", return_value=response),
        ):
            assert _download_airport_database() is True

    def test_too_few_rows_rejected(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(lookup_module, "MIN_DOWNLOAD_ROWS", 4),
            patch.object(
                lookup_module, "urlopen", return_value=_mock_response(VALID_CSV)
            ),
        ):
            assert _download_airport_database() is False
        assert not cache_file.exists()

    def test_connection_dropped_mid_body_is_handled(self, tmp_path):
        """IncompleteRead is no OSError and used to end the run with a traceback."""
        response = _mock_response(VALID_CSV)
        response.read.side_effect = http.client.IncompleteRead(b"partial", 100)
        with (
            patch.object(lookup_module, "CACHE_FILE", tmp_path / "airports.csv"),
            patch.object(lookup_module, "DOWNLOAD_FAILED_MARKER", tmp_path / "failed"),
            patch.object(lookup_module, "urlopen", return_value=response),
        ):
            assert _download_airport_database() is False
        assert (tmp_path / "failed").exists()
        assert not (tmp_path / "airports.csv").exists()

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


@pytest.mark.usefixtures("small_downloads")
class TestDownloadFailureMarker:
    @pytest.fixture
    def isolated_cache(self, tmp_path):
        with (
            patch.object(lookup_module, "CACHE_FILE", tmp_path / "airports.csv"),
            patch.object(lookup_module, "DOWNLOAD_FAILED_MARKER", tmp_path / "failed"),
        ):
            yield tmp_path

    def test_failure_is_remembered_and_not_retried(self, isolated_cache):
        marker = isolated_cache / "failed"
        with patch.object(
            lookup_module, "urlopen", side_effect=OSError("offline")
        ) as first:
            assert _download_airport_database() is False
        first.assert_called_once()
        assert marker.exists()

        with patch.object(lookup_module, "urlopen") as second:
            assert _download_airport_database() is False
        second.assert_not_called()

    def test_old_failure_is_retried(self, isolated_cache):
        marker = isolated_cache / "failed"
        marker.touch()
        stale = time.time() - lookup_module.DOWNLOAD_RETRY_SECONDS - 1
        os.utime(marker, (stale, stale))

        with patch.object(
            lookup_module, "urlopen", return_value=_mock_response(VALID_CSV)
        ) as mock_urlopen:
            assert _download_airport_database() is True
        mock_urlopen.assert_called_once()
        assert not marker.exists()

    def test_invalid_response_is_remembered_too(self, isolated_cache):
        with patch.object(lookup_module, "urlopen", return_value=_mock_response(b"")):
            assert _download_airport_database() is False
        assert (isolated_cache / "failed").exists()

    def test_workers_share_the_marker(self, isolated_cache):
        """After one failure the other processes of a run skip the download."""
        with patch.object(lookup_module, "urlopen", side_effect=OSError("offline")):
            assert load_airport_database() == {}
        lookup_module._airport_cache = None
        with patch.object(lookup_module, "urlopen") as mock_urlopen:
            assert load_airport_database() == {}
        mock_urlopen.assert_not_called()

    def test_marker_helpers_tolerate_missing_directory(self, tmp_path):
        marker = tmp_path / "missing" / "failed"
        with patch.object(lookup_module, "DOWNLOAD_FAILED_MARKER", marker):
            assert lookup_module._recent_download_failure() is False
            lookup_module._record_download_failure()
            lookup_module._clear_download_failure()
        assert not marker.exists()

    def test_unwritable_cache_directory(self, tmp_path):
        blocker = tmp_path / "file"
        blocker.write_text("not a directory")
        with patch.object(lookup_module, "CACHE_FILE", blocker / "airports.csv"):
            assert _download_airport_database() is False


class TestDatabaseFingerprint:
    def test_nodb_without_cache_file(self, tmp_path):
        with patch.object(lookup_module, "CACHE_FILE", tmp_path / "missing.csv"):
            assert database_fingerprint() == "nodb"

    def test_changes_with_the_file(self, tmp_path):
        database = tmp_path / "airports.csv"
        with patch.object(lookup_module, "CACHE_FILE", database):
            database.write_bytes(VALID_CSV)
            first = database_fingerprint()
            assert first == database_fingerprint()
            database.write_bytes(
                VALID_CSV + b'3,"EDDM","large_airport","Munich",48.35,11.78,"DE"\n'
            )
            second = database_fingerprint()
        assert first != second
        assert len(first) == 8

    def test_same_content_downloaded_again_keeps_the_fingerprint(self, tmp_path):
        """The monthly download must not invalidate every parse cache entry."""
        database = tmp_path / "airports.csv"
        with patch.object(lookup_module, "CACHE_FILE", database):
            database.write_bytes(VALID_CSV)
            os.utime(database, ns=(1_000_000_000, 1_000_000_000))
            first = database_fingerprint()
            database.unlink()
            database.write_bytes(VALID_CSV)
            assert database_fingerprint() == first

    def test_same_size_and_time_with_other_content_differs(self, tmp_path):
        database = tmp_path / "airports.csv"
        with patch.object(lookup_module, "CACHE_FILE", database):
            database.write_bytes(VALID_CSV)
            first = database_fingerprint()
            other = tmp_path / "other.csv"
            other.write_bytes(VALID_CSV.replace(b"TEST", b"TSET"))
            with patch.object(lookup_module, "CACHE_FILE", other):
                assert database_fingerprint() != first


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
        db1 = load_airport_database()
        db2 = load_airport_database()
        assert db1 is db2
        assert "EDDP" in db1

    @pytest.mark.usefixtures("small_downloads")
    def test_invalid_cache_triggers_redownload(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        cache_file.write_bytes(b"no,header\n")
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(
                lookup_module, "urlopen", return_value=_mock_response(VALID_CSV)
            ) as mock_urlopen,
        ):
            db = load_airport_database()

        mock_urlopen.assert_called_once()
        assert "TEST" in db
        assert cache_file.read_bytes() == VALID_CSV

    def test_empty_database_on_download_failure(self, tmp_path):
        with (
            patch.object(lookup_module, "CACHE_FILE", tmp_path / "missing.csv"),
            patch.object(lookup_module, "urlopen", side_effect=OSError("offline")),
        ):
            assert load_airport_database() == {}
            assert lookup_airport_coordinates("EDDP") is None

    def test_csv_error_returns_empty(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        cache_file.write_bytes(VALID_CSV)
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(lookup_module, "_is_cache_valid", return_value=True),
            patch("csv.DictReader", side_effect=csv.Error("CSV error")),
        ):
            assert load_airport_database() == {}

    def test_works_without_fcntl(self, tmp_path):
        cache_file = tmp_path / "airports.csv"
        cache_file.write_bytes(VALID_CSV)
        with (
            patch.object(lookup_module, "HAS_FCNTL", False),
            patch.object(lookup_module, "CACHE_FILE", cache_file),
        ):
            db = load_airport_database()
        assert "EDDF" in db

    def test_unopenable_lock_file_is_tolerated(self, tmp_path):
        lock_file = tmp_path / "missing" / "airports.lock"
        with patch.object(lookup_module, "CACHE_LOCK_FILE", lock_file):
            db = load_airport_database()
        assert "EDDP" in db

    def test_required_database_raises_when_the_download_fails(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv(REQUIRE_DATABASE_ENV, "1")
        with (
            patch.object(lookup_module, "CACHE_FILE", tmp_path / "missing.csv"),
            patch.object(lookup_module, "urlopen", side_effect=OSError("offline")),
            pytest.raises(AirportDatabaseError, match=REQUIRE_DATABASE_ENV),
        ):
            load_airport_database()
        # Nothing is cached, so a later call raises again instead of going on
        assert lookup_module._airport_cache is None

    def test_required_database_rejects_an_invalid_cache(self, tmp_path, monkeypatch):
        monkeypatch.setenv(REQUIRE_DATABASE_ENV, "1")
        cache_file = tmp_path / "airports.csv"
        cache_file.write_bytes(VALID_CSV[:-5])
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(lookup_module, "urlopen", side_effect=OSError("offline")),
            pytest.raises(AirportDatabaseError),
        ):
            load_airport_database()

    def test_required_database_rejects_a_cache_without_airports(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv(REQUIRE_DATABASE_ENV, "1")
        cache_file = tmp_path / "airports.csv"
        cache_file.write_text("ident,name,latitude_deg,longitude_deg\n")
        with (
            patch.object(lookup_module, "CACHE_FILE", cache_file),
            patch.object(lookup_module, "_is_cache_valid", return_value=True),
            pytest.raises(AirportDatabaseError),
        ):
            load_airport_database()

    def test_required_database_loads_a_valid_cache(self, monkeypatch):
        monkeypatch.setenv(REQUIRE_DATABASE_ENV, "1")
        assert "EDDP" in load_airport_database()

    @pytest.mark.parametrize("value", ["", "0", "true"])
    def test_other_values_do_not_require_the_database(
        self, tmp_path, monkeypatch, value
    ):
        monkeypatch.setenv(REQUIRE_DATABASE_ENV, value)
        with (
            patch.object(lookup_module, "CACHE_FILE", tmp_path / "missing.csv"),
            patch.object(lookup_module, "urlopen", side_effect=OSError("offline")),
        ):
            assert load_airport_database() == {}

    def test_lock_release_failure_is_handled(self):
        original_flock = fcntl.flock

        def flock_side_effect(fd, op):
            if op == fcntl.LOCK_UN:
                raise OSError("mock unlock failure")
            return original_flock(fd, op)

        with patch.object(fcntl, "flock", side_effect=flock_side_effect):
            db = load_airport_database()
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


class TestAirportIcaoCode:
    @pytest.mark.parametrize(
        "name,expected",
        [
            ("EDDS Stuttgart", "EDDS"),
            ("EGDY RNAS Yeovilton", "EGDY"),
            ("Flugplatz EDAQ", "EDAQ"),
            ("Near EDDS and EDDP", None),
            ("Some Field", None),
            ("", None),
            (None, None),
        ],
    )
    def test_code(self, name, expected):
        assert airport_icao_code(name) == expected


class TestSplitRouteName:
    @pytest.mark.parametrize(
        "name,expected",
        [
            ("EDDS - EDDP", ("EDDS", "EDDP")),
            (
                "EDDS Stuttgart - EDDP Leipzig/Halle",
                ("EDDS Stuttgart", "EDDP Leipzig/Halle"),
            ),
            ("EDDS to EDDP - 16 Aug 2026", ("EDDS", "EDDP")),
            ("EDDS to EDZZ - 01 Jan 2026", ("EDDS", "EDZZ")),
            ("EDZZ to EDDP - 2026-01-01", ("EDZZ", "EDDP")),
            (
                "EDAQ Halle-Oppin - LFBN Niort - Marais Poitevin",
                ("EDAQ Halle-Oppin", "LFBN Niort - Marais Poitevin"),
            ),
            (
                "LFBN Niort - Marais Poitevin - EDAQ Halle-Oppin",
                ("LFBN Niort - Marais Poitevin", "EDAQ Halle-Oppin"),
            ),
            (
                "Private Strip - EDAQ Halle-Oppin",
                ("Private Strip", "EDAQ Halle-Oppin"),
            ),
            ("Some Field - Other Field", ("Some Field", "Other Field")),
        ],
    )
    def test_routes(self, name, expected):
        assert split_route_name(name) == expected

    @pytest.mark.parametrize(
        "name",
        [
            "EDDS",
            "EDDS Stuttgart",
            "EDDS - 16 Aug 2026",
            # A database name holding " - " followed by four capitals
            "YSNW Naval Air Station Nowra - HMAS Albatross",
            "LFBN Niort - Marais Poitevin",
            "EDAQ Halle-Oppin - Private Strip",
            "EDDF - EDDM - EDDT",
            "A - B - C",
            "Log Start: 03 Mar 2025 08:58 Z",
            "",
            None,
        ],
    )
    def test_not_routes(self, name):
        assert split_route_name(name) is None


class TestStandardizeAirportNames:
    def test_route_keeps_both_airports(self):
        assert standardize_airport_names("EDAQ - LFBN") == AirportNames(
            "EDAQ Halle-Oppin - LFBN Niort - Marais Poitevin",
            "EDAQ Halle-Oppin",
            "LFBN Niort - Marais Poitevin",
        )

    def test_trailing_date_is_neither_airport_nor_name(self):
        """With only EDDS known the date used to become the arrival airport."""
        assert standardize_airport_names("EDDS to EDZZ - 16 Aug 2026") == (
            AirportNames("EDDS Stuttgart - EDZZ", "EDDS Stuttgart", "EDZZ")
        )
        assert standardize_airport_names("EDZZ to EDDP - 16 Aug 2026") == (
            AirportNames("EDZZ - EDDP Leipzig/Halle", "EDZZ", "EDDP Leipzig/Halle")
        )

    def test_date_is_stripped_from_a_single_airport(self):
        assert standardize_airport_names("EDDS - 16 Aug 2026") == AirportNames(
            "EDDS Stuttgart"
        )

    def test_single_airport_has_no_route(self):
        assert standardize_airport_names("EDDP") == AirportNames("EDDP Leipzig/Halle")

    def test_single_database_name_with_dash_stays_one_airport(self):
        names = standardize_airport_names("YSNW")
        assert names == AirportNames("YSNW Naval Air Station Nowra - HMAS Albatross")

    def test_without_database(self):
        lookup_module._airport_cache = {}
        assert standardize_airport_names("EDDS to EDDP - 16 Aug 2026") == (
            AirportNames("EDDS - EDDP", "EDDS", "EDDP")
        )


class TestStandardizedDisplayName:
    def test_single_airport_from_fixture(self):
        assert standardize_airport_names("EDDP").name == "EDDP Leipzig/Halle"

    def test_route_from_fixture(self):
        assert (
            standardize_airport_names("EDDF - EDDM").name
            == "EDDF Frankfurt Main - EDDM Munich"
        )

    def test_airfield_suffix_stripped(self):
        assert standardize_airport_names("LOAV").name == "LOAV Vöslau-Kottingbrunn"

    def test_no_icao_codes_returns_original(self):
        assert standardize_airport_names("Some Airport").name == "Some Airport"

    @pytest.mark.parametrize("value", [None, ""])
    def test_empty_returns_input(self, value):
        assert standardize_airport_names(value).name == value

    def test_only_first_airport_found(self):
        result = standardize_airport_names("EDAQ Halle - ZZZZ SomePlace").name
        assert result == "EDAQ Halle-Oppin - ZZZZ SomePlace"

    def test_only_second_airport_found(self):
        result = standardize_airport_names("ZZZZ SomePlace - EDMV Vilsh").name
        assert result == "ZZZZ SomePlace - EDMV Vilshofen"

    def test_unknown_single_airport_returns_original(self):
        assert standardize_airport_names("ZZZZ Nowhere").name == "ZZZZ Nowhere"

    def test_route_with_unknown_airports_returns_original(self):
        assert standardize_airport_names("ZZZZ - YYYY").name == "ZZZZ - YYYY"


class TestStripAirportSuffix:
    @pytest.mark.parametrize(
        "name,expected",
        [
            ("Frankfurt Main Airport", "Frankfurt Main"),
            ("Vöslau-Kottingbrunn Airfield", "Vöslau-Kottingbrunn"),
            ("John F Kennedy International Airport", "John F Kennedy"),
            ("Springfield Regional Airport", "Springfield"),
            ("Cedar Rapids Municipal Airport", "Cedar Rapids"),
            ("Ramstein Air Base", "Ramstein"),
            ("Hospital Heliport", "Hospital"),
            ("No Suffix Here", "No Suffix Here"),
        ],
    )
    def test_strips_known_suffixes(self, name, expected):
        assert _strip_airport_suffix(name) == expected

    def test_longest_suffix_wins(self):
        assert _strip_airport_suffix("LAX International Airport") == "LAX"
