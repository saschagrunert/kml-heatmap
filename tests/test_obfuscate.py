"""Tests for KML date and timestamp obfuscation."""

import logging
import os
import re
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import Path
from unittest.mock import patch

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

import kml_heatmap.obfuscate as obfuscate_module
from kml_heatmap.aircraft import parse_aircraft_from_filename
from kml_heatmap.obfuscate import (
    GENERIC_CREATOR,
    _extract_frac,
    _find_stray_dates,
    check_directory_obfuscated,
    check_kml_obfuscated,
    find_kml_files,
    main,
    obfuscate_kml_content,
    obfuscate_kml_directory,
    obfuscate_kml_file,
    obfuscate_kml_files,
    rename_charterware_files,
)

SAMPLE_KML = """\
<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"
     xmlns:gx="http://www.google.com/kml/ext/2.2"
     creator="SkyDemon for iPhone v4.2.2.429">
  <Document>
    <name>SkyDemon Track Log</name>
    <Placemark>
      <name>Log Start: 03 Mar 2025 08:25 Z</name>
      <Point><coordinates>12.058459,51.550617,100</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>EDAQ Halle-Oppin - EDAQ Halle-Oppin</name>
      <gx:Track>
        <when>2025-03-03T08:25:15.5848380Z</when>
        <gx:coord>12.058459 51.550617 100</gx:coord>
        <when>2025-03-03T08:25:20.5858380Z</when>
        <gx:coord>12.060145 51.550606 105</gx:coord>
        <when>2025-03-03T08:25:25.5868380Z</when>
        <gx:coord>12.055846 51.551740 110</gx:coord>
      </gx:Track>
    </Placemark>
    <Placemark>
      <name>Takeoff: 03 Mar 2025 08:31 Z</name>
      <Point><coordinates>12.058459,51.550617,100</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Landing: 03 Mar 2025 08:50 Z</name>
      <Point><coordinates>12.058459,51.550617,100</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Log Stop: 03 Mar 2025 08:54 Z</name>
      <Point><coordinates>12.058459,51.550617,100</coordinates></Point>
    </Placemark>
  </Document>
</kml>
"""

CHARTERWARE_KML = """\
<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>OE-AKI</name>
      <description>Flight Jan 12 2026 03:01PM path of OE-AKI</description>
      <TimeSpan><begin>2026-01-12T15:01:00Z</begin><end>2026-01-12T16:11:30Z</end></TimeSpan>
      <LineString><coordinates>16.25,47.96,232.8 16.26,47.97,240.0</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
"""

ROUTE_NAME_KML = """\
<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>EDDS to EDDP - 16 Aug 2026</name>
      <LineString><coordinates>9.22,48.68,300 12.23,51.42,300</coordinates></LineString>
    </Placemark>
  </Document>
</kml>
"""


def _whens(content):
    return re.findall(r"<when>([^<]+)</when>", content)


def _parse_utc(ts):
    dt = datetime.fromisoformat(ts)
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


class TestObfuscateContent:
    def test_shifts_timestamps_to_jan_1(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        assert "2025-01-01T08:25:15.5848380Z" in result
        assert "2025-03-03" not in result

    def test_preserves_time_deltas(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        original = [_parse_utc(ts) for ts in _whens(SAMPLE_KML)]
        shifted = [_parse_utc(ts) for ts in _whens(result)]
        for (o1, o2), (s1, s2) in zip(
            pairwise(original), pairwise(shifted), strict=True
        ):
            assert (o2 - o1) == (s2 - s1)

    def test_strips_name_dates(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        for label in ("Log Start", "Takeoff", "Landing", "Log Stop"):
            assert f"<name>{label}: 2025-01-01</name>" in result

    def test_preserves_route_name_document_name_and_coordinates(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert "<name>EDAQ Halle-Oppin - EDAQ Halle-Oppin</name>" in result
        assert "<name>SkyDemon Track Log</name>" in result
        assert "12.058459 51.550617 100" in result
        assert "12.060145 51.550606 105" in result

    def test_replaces_creator_attribute(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert f'creator="{GENERIC_CREATOR}"' in result
        assert "SkyDemon for iPhone" not in result

    def test_returns_none_for_no_timestamps(self):
        assert (
            obfuscate_kml_content("<kml><Document><name>t</name></Document></kml>")
            is None
        )

    def test_returns_none_for_already_obfuscated(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert obfuscate_kml_content(result) is None

    def test_returns_none_for_unparsable_first_timestamp(self):
        assert obfuscate_kml_content("<kml><when>not-valid</when></kml>") is None

    def test_preserves_unparsable_inner_timestamps(self):
        kml = (
            "<kml><when>2025-03-03T08:25:15.0000000Z</when>"
            "<when>bad-timestamp</when>"
            "<when>2025-03-03T08:30:00.0000000Z</when></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert "<when>bad-timestamp</when>" in result
        assert "<when>2025-01-01T08:30:00.0000000Z</when>" in result


class TestTimezoneHandling:
    def test_naive_when_is_treated_as_utc(self):
        kml = (
            "<kml><when>2025-03-03T08:25:15</when>"
            "<when>2025-03-03T08:26:15</when></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == ["2025-01-01T08:25:15Z", "2025-01-01T08:26:15Z"]

    def test_offset_when_is_converted_to_utc_z(self):
        kml = "<kml><when>2025-03-03T10:25:15+02:00</when></kml>"
        result = obfuscate_kml_content(kml)
        assert _whens(result) == ["2025-01-01T08:25:15Z"]

    def test_fraction_kept_with_offset(self):
        kml = "<kml><when>2025-03-03T10:25:15.25+02:00</when></kml>"
        result = obfuscate_kml_content(kml)
        assert _whens(result) == ["2025-01-01T08:25:15.25Z"]

    def test_unshifted_offset_timestamp_is_written_in_utc(self, tmp_path):
        """Its local date would otherwise stay a day past the accepted window."""
        kml = (
            "<kml><Placemark><when>2025-01-01T08:00:00Z</when>"
            "<when>2025-01-04T01:00:00+02:00</when></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == ["2025-01-01T08:00:00Z", "2025-01-03T23:00:00Z"]
        kml_file = tmp_path / "offset.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_obfuscated_timestamps_are_left_as_written(self):
        kml = (
            "<kml><when>2025-01-01T08:00:00.50Z</when>"
            "<when>2025-01-01T08:01:00</when></kml>"
        )
        assert obfuscate_kml_content(kml) is None

    def test_mixed_naive_and_aware_keep_deltas(self):
        kml = (
            "<kml><when>2025-03-03T08:25:15Z</when>"
            "<when>2025-03-03T08:30:15</when></kml>"
        )
        result = obfuscate_kml_content(kml)
        first, second = (_parse_utc(ts) for ts in _whens(result))
        assert second - first == timedelta(minutes=5)


class TestExtendedPatterns:
    def test_timespan_begin_end_shifted(self):
        result = obfuscate_kml_content(CHARTERWARE_KML)
        assert "<begin>2026-01-01T15:01:00Z</begin>" in result
        assert "<end>2026-01-01T16:11:30Z</end>" in result

    def test_description_date_lands_on_jan_1(self):
        result = obfuscate_kml_content(CHARTERWARE_KML)
        assert "Flight Jan 01 2026 03:01PM path of OE-AKI" in result
        assert "Jan 12" not in result

    def test_description_without_full_timestamps(self):
        kml = (
            "<kml><description>Flight Aug 16 2026 11:45PM path of D-EXYZ"
            "</description></kml>"
        )
        result = obfuscate_kml_content(kml)
        expected = (
            "<kml><description>Flight Jan 01 2026 11:45PM path of D-EXYZ"
            "</description></kml>"
        )
        assert result == expected

    def test_description_long_month_name_preserved(self):
        kml = "<kml><description>Flight August 16 2026 12:05AM x</description></kml>"
        result = obfuscate_kml_content(kml)
        assert "Flight January 01 2026 12:05AM x" in result

    def test_route_name_date_shifted(self):
        result = obfuscate_kml_content(ROUTE_NAME_KML)
        assert "<name>EDDS to EDDP - 01 Jan 2026</name>" in result
        assert "16 Aug 2026" not in result

    def test_local_route_date_lands_on_jan_1_of_its_year(self, tmp_path):
        """A local date a day after the UTC <when> used to stay on Jan 2."""
        kml = (
            "<kml><name>EDDS to EDDP - 17 Aug 2026</name>"
            "<when>2026-08-16T23:30:00Z</when></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert "<name>EDDS to EDDP - 01 Jan 2026</name>" in result
        assert "<when>2026-01-01T23:30:00Z</when>" in result
        assert obfuscate_kml_content(result) is None
        kml_file = tmp_path / "route.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_local_description_date_lands_on_jan_1_of_its_year(self):
        kml = (
            "<kml><description>Flight Jan 13 2026 12:30AM path of OE-AKI"
            "</description><TimeSpan><begin>2026-01-12T23:30:00Z</begin>"
            "</TimeSpan></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert "Flight Jan 01 2026 12:30AM" in result
        assert "<begin>2026-01-01T23:30:00Z</begin>" in result

    def test_namespace_prefixed_elements(self):
        kml = (
            '<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2"><kml:Placemark>'
            "<kml:name>Log Start: 14 Jun 2025 09:12 Z</kml:name>"
            "<kml:name>EDDS to EDDP - 14 Jun 2025</kml:name>"
            '<kml:TimeSpan><kml:begin id="b">2025-06-14T09:12:00Z</kml:begin>'
            "<kml:end>2025-06-14T10:12:00Z</kml:end></kml:TimeSpan>"
            "</kml:Placemark></kml:kml>"
        )
        result = obfuscate_kml_content(kml)
        assert '<kml:begin id="b">2025-01-01T09:12:00Z</kml:begin>' in result
        assert "<kml:end>2025-01-01T10:12:00Z</kml:end>" in result
        assert "<kml:name>Log Start: 2025-01-01</kml:name>" in result
        assert "<kml:name>EDDS to EDDP - 01 Jan 2025</kml:name>" in result
        assert "06-14" not in result

    def test_flights_on_different_dates_each_land_on_jan_1(self, tmp_path):
        """One offset for the file turned the second flight into 2024-03-15."""
        kml = (
            "<kml><Placemark><TimeSpan><begin>2024-12-30T10:00:00Z</begin>"
            "<end>2024-12-30T11:00:00Z</end></TimeSpan></Placemark>"
            "<Placemark><TimeSpan><begin>2025-03-14T10:00:00Z</begin>"
            "<end>2025-03-14T11:30:00Z</end></TimeSpan></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert re.findall(r"<(?:begin|end)>([^<]+)<", result) == [
            "2024-01-01T10:00:00Z",
            "2024-01-01T11:00:00Z",
            "2025-01-01T10:00:00Z",
            "2025-01-01T11:30:00Z",
        ]
        assert obfuscate_kml_content(result) is None
        kml_file = tmp_path / "two.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_a_flight_keeps_its_intervals_across_days(self):
        kml = (
            "<kml><Placemark><when>2025-06-14T22:00:00Z</when>"
            "<when>2025-06-15T09:00:00Z</when>"
            "<when>2025-06-16T21:00:00Z</when></Placemark></kml>"
        )
        assert _whens(obfuscate_kml_content(kml)) == [
            "2025-01-01T22:00:00Z",
            "2025-01-02T09:00:00Z",
            "2025-01-03T21:00:00Z",
        ]

    def test_a_track_with_a_long_pause_never_runs_backwards(self, tmp_path):
        """Splitting it into two flights put the end before the start."""
        kml = (
            "<kml><Placemark><gx:Track>"
            "<when>2025-06-14T10:00:00Z</when><when>2025-06-14T11:00:00Z</when>"
            "<when>2025-06-17T08:00:00Z</when><when>2025-06-17T09:00:00Z</when>"
            "</gx:Track></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == [
            "2025-01-01T10:00:00Z",
            "2025-01-01T11:00:00Z",
            "2025-01-04T08:00:00Z",
            "2025-01-04T09:00:00Z",
        ]
        # Too long for the days after January 1st: the check fails closed
        kml_file = tmp_path / "paused.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file)

    def test_a_flight_on_new_years_day_stays_in_its_year(self, tmp_path):
        """Eight hours after a flight across midnight it still is 2026's."""

        def placemark(*whens):
            return (
                "<Placemark><gx:Track>"
                + "".join(f"<when>{when}</when>" for when in whens)
                + "</gx:Track></Placemark>"
            )

        kml = (
            "<kml>"
            + placemark("2025-12-30T14:00:00Z", "2025-12-30T15:00:00Z")
            + placemark("2025-12-31T23:40:00Z", "2026-01-01T00:40:00Z")
            + placemark("2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z")
            + placemark("2026-01-03T12:00:00Z")
            + "</kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == [
            "2025-01-01T14:00:00Z",
            "2025-01-01T15:00:00Z",
            "2025-01-01T23:40:00Z",
            "2025-01-02T00:40:00Z",
            "2026-01-01T09:00:00Z",
            "2026-01-01T10:00:00Z",
            "2026-01-01T12:00:00Z",
        ]
        assert obfuscate_kml_content(result) is None
        kml_file = tmp_path / "new_year.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_one_recording_across_new_year_is_not_split(self):
        kml = (
            "<kml><when>2025-12-31T23:59:50Z</when>"
            "<when>2026-01-01T00:00:05Z</when></kml>"
        )
        assert _whens(obfuscate_kml_content(kml)) == [
            "2025-01-01T23:59:50Z",
            "2025-01-02T00:00:05Z",
        ]

    def test_a_flight_past_utc_midnight_stays_in_one_piece(self, tmp_path):
        kml = (
            "<kml><Placemark><gx:Track><when>2025-06-14T18:00:00Z</when>"
            "<when>2025-06-14T19:00:00Z</when></gx:Track></Placemark>"
            "<Placemark><gx:Track><when>2025-06-16T23:30:00Z</when>"
            "<when>2025-06-16T23:59:00Z</when><when>2025-06-17T00:10:00Z</when>"
            "<when>2025-06-17T00:30:00Z</when></gx:Track></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == [
            "2025-01-01T18:00:00Z",
            "2025-01-01T19:00:00Z",
            "2025-01-01T23:30:00Z",
            "2025-01-01T23:59:00Z",
            "2025-01-02T00:10:00Z",
            "2025-01-02T00:30:00Z",
        ]
        assert obfuscate_kml_content(result) is None
        kml_file = tmp_path / "evening.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_timestamps_beyond_the_window_start_a_new_flight(self):
        kml = (
            "<kml><when>2025-06-14T22:00:00Z</when>"
            "<when>2025-06-17T00:00:00Z</when></kml>"
        )
        assert _whens(obfuscate_kml_content(kml)) == [
            "2025-01-01T22:00:00Z",
            "2025-01-01T00:00:00Z",
        ]

    def test_date_only_first_when_does_not_block_the_track(self, tmp_path):
        kml = (
            "<kml><Placemark><TimeStamp><when>2025-06-14</when></TimeStamp>"
            "</Placemark><Placemark><gx:Track><when>2025-06-14T09:12:00Z</when>"
            "<gx:coord>9 48 300</gx:coord></gx:Track></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == ["2025-01-01", "2025-01-01T09:12:00Z"]
        kml_file = tmp_path / "date_only.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    @pytest.mark.parametrize(
        "when,expected",
        [
            ("2025-06-14+02:00", "2025-01-01+02:00"),
            ("2025-06", "2025-01"),
            ("2025-06Z", "2025-01Z"),
            ("2025", "2025"),
        ],
    )
    def test_dates_without_time(self, when, expected):
        result = obfuscate_kml_content(f"<kml><when>{when}</when></kml>")
        assert _whens(result or f"<when>{when}</when>") == [expected]

    def test_creator_is_replaced_without_any_date(self):
        result = obfuscate_kml_content('<kml creator="SkyDemon"><name>x</name></kml>')
        assert result == f'<kml creator="{GENERIC_CREATOR}"><name>x</name></kml>'

    def test_single_quoted_creator_is_replaced(self):
        result = obfuscate_kml_content("<kml creator='SkyDemon'><name>x</name></kml>")
        assert result == f"<kml creator='{GENERIC_CREATOR}'><name>x</name></kml>"

    def test_all_patterns_are_idempotent(self):
        for kml in (SAMPLE_KML, CHARTERWARE_KML, ROUTE_NAME_KML):
            once = obfuscate_kml_content(kml)
            assert once is not None
            assert obfuscate_kml_content(once) is None


class TestRewriteGaps:
    """Shapes the check flagged but the rewrite used to leave to the user."""

    @pytest.mark.parametrize(
        "name",
        [
            "Takeoff: 14 Mar 2024 09:12:05 Z",
            "Takeoff: 4 Mar 2024 09:12 Z",
            "Log Stop: 4 Mar 2024 09:12:05 Z",
        ],
    )
    def test_marker_names_with_seconds_or_a_single_digit_day(self, name):
        result = obfuscate_kml_content(f"<kml><name>{name}</name></kml>")
        label = name.split(":")[0]
        assert result == f"<kml><name>{label}: 2024-01-01</name></kml>"

    @pytest.mark.parametrize(
        "when,expected",
        [
            ("2024-03-14 09:12:00", "2024-01-01T09:12:00Z"),
            ("2024-03-14T09:12:00z", "2024-01-01T09:12:00Z"),
            ("<![CDATA[2024-03-14T09:12:00Z]]>", "2024-01-01T09:12:00Z"),
            ("<![CDATA[ 2024-03-14 09:12:00.5z ]]>", "2024-01-01T09:12:00.5Z"),
        ],
    )
    def test_loose_timestamps_are_rewritten_in_the_canonical_form(
        self, tmp_path, when, expected
    ):
        result = obfuscate_kml_content(f"<kml><when>{when}</when></kml>")
        assert result == f"<kml><when>{expected}</when></kml>"
        kml_file = tmp_path / "t.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_loose_timestamp_on_jan_1_is_normalized(self):
        """The parsers read the canonical form; the date does not move."""
        result = obfuscate_kml_content("<kml><when>2025-01-01 10:00:00</when></kml>")
        assert result == "<kml><when>2025-01-01T10:00:00Z</when></kml>"

    def test_route_name_with_a_single_digit_day(self):
        result = obfuscate_kml_content(
            "<kml><name>EDDS to EDDP - 6 Aug 2026</name></kml>"
        )
        assert result == "<kml><name>EDDS to EDDP - 01 Jan 2026</name></kml>"

    def test_description_with_a_single_digit_hour(self):
        result = obfuscate_kml_content(
            "<kml><description>Flight Jan 12 2026 3:01PM path</description></kml>"
        )
        assert result == (
            "<kml><description>Flight Jan 01 2026 03:01PM path</description></kml>"
        )


class TestObfuscateFile:
    def test_crlf_line_endings_are_kept(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_bytes(SAMPLE_KML.replace("\n", "\r\n").encode())
        assert obfuscate_kml_file(kml_file) is True
        content = kml_file.read_bytes()
        assert b"2025-01-01T08:25:15.5848380Z</when>\r\n" in content
        assert content.count(b"\r\n") == SAMPLE_KML.count("\n")

    @pytest.mark.skipif(
        hasattr(os, "geteuid") and os.geteuid() == 0,
        reason="root may write read-only files",
    )
    def test_read_only_file_is_reported_not_replaced(self, tmp_path, capsys):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        kml_file.chmod(0o444)
        try:
            assert obfuscate_kml_file(kml_file) is False
            assert kml_file.read_text(encoding="utf-8") == SAMPLE_KML
            assert kml_file.stat().st_mode & 0o777 == 0o444
        finally:
            kml_file.chmod(0o644)
        assert "not writable" in capsys.readouterr().err

    def test_symlink_is_not_replaced(self, tmp_path, capsys):
        target = tmp_path / "flight.kml.orig"
        target.write_text(SAMPLE_KML, encoding="utf-8")
        link = tmp_path / "flight.kml"
        link.symlink_to(target)

        assert obfuscate_kml_file(link) is False

        assert link.is_symlink()
        assert target.read_text(encoding="utf-8") == SAMPLE_KML
        assert "symlinks are not allowed" in capsys.readouterr().err

    def test_modifies_file_in_place_atomically(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        kml_file.chmod(0o640)

        with patch(
            "kml_heatmap.obfuscate.os.replace", wraps=os.replace
        ) as mock_replace:
            assert obfuscate_kml_file(kml_file) is True

        mock_replace.assert_called_once()
        tmp_name, target = mock_replace.call_args[0]
        assert Path(tmp_name).parent == tmp_path
        assert Path(target) == kml_file
        assert "2025-01-01T08:25:15" in kml_file.read_text(encoding="utf-8")
        assert sorted(p.name for p in tmp_path.iterdir()) == ["test.kml"]
        assert kml_file.stat().st_mode & 0o777 == 0o640

    def test_idempotent(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        assert obfuscate_kml_file(kml_file) is True
        first_content = kml_file.read_text(encoding="utf-8")
        assert obfuscate_kml_file(kml_file) is False
        assert kml_file.read_text(encoding="utf-8") == first_content

    def test_invalid_utf8_is_skipped_with_warning(self, tmp_path, caplog):
        kml_file = tmp_path / "test.kml"
        kml_file.write_bytes(b"\xff\xfe<when>2025-03-03T08:25:15Z</when>")
        with caplog.at_level(logging.WARNING, logger="kml_heatmap"):
            assert obfuscate_kml_file(kml_file) is False
        assert "not valid UTF-8" in caplog.text

    def test_write_failure_leaves_original(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        with patch("kml_heatmap.obfuscate.os.replace", side_effect=OSError("disk")):
            assert obfuscate_kml_file(kml_file) is False
        assert kml_file.read_text(encoding="utf-8") == SAMPLE_KML
        assert sorted(p.name for p in tmp_path.iterdir()) == ["test.kml"]

    def test_missing_file(self, tmp_path):
        assert obfuscate_kml_file(tmp_path / "missing.kml") is False


class TestObfuscateFiles:
    def test_one_bad_file_does_not_abort_the_run(self, tmp_path):
        good1 = tmp_path / "a.kml"
        good2 = tmp_path / "c.kml"
        bad = tmp_path / "b.kml"
        good1.write_text(SAMPLE_KML, encoding="utf-8")
        good2.write_text(SAMPLE_KML, encoding="utf-8")
        bad.write_text(SAMPLE_KML, encoding="utf-8")

        with patch(
            "kml_heatmap.obfuscate.obfuscate_kml_content",
            side_effect=[
                obfuscate_kml_content(SAMPLE_KML),
                RuntimeError("boom"),
                obfuscate_kml_content(SAMPLE_KML),
            ],
        ):
            assert obfuscate_kml_files([good1, bad, good2]) == 2

        assert "2025-01-01" in good2.read_text(encoding="utf-8")
        assert "2025-03-03" in bad.read_text(encoding="utf-8")

    def test_directory_skips_symlinks(self, tmp_path, capsys):
        """The generator rejects symlinks; the standalone tool must agree."""
        target = tmp_path / "real.txt"
        target.write_text(SAMPLE_KML, encoding="utf-8")
        (tmp_path / "link.kml").symlink_to(target)
        (tmp_path / "flight.KML").write_text(SAMPLE_KML, encoding="utf-8")

        assert [p.name for p in find_kml_files(tmp_path)] == ["flight.KML"]
        assert obfuscate_kml_directory(tmp_path) == 1
        assert (tmp_path / "link.kml").is_symlink()
        assert target.read_text(encoding="utf-8") == SAMPLE_KML
        assert "link.kml: symlinks are not allowed" in capsys.readouterr().err

    def test_directory_processes_only_kml(self, tmp_path):
        (tmp_path / "data.json").write_text("{}", encoding="utf-8")
        for i in range(3):
            (tmp_path / f"flight_{i}.kml").write_text(SAMPLE_KML, encoding="utf-8")
        assert obfuscate_kml_directory(tmp_path) == 3
        assert obfuscate_kml_directory(tmp_path) == 0


class TestCheckObfuscated:
    def test_detects_unobfuscated_timestamps_and_names(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        violations = check_kml_obfuscated(kml_file)
        assert any("Name element" in v for v in violations)
        assert any("Flight does not start on Jan 1" in v for v in violations)

    def test_detects_description_and_route_dates(self, tmp_path):
        (tmp_path / "c.kml").write_text(CHARTERWARE_KML, encoding="utf-8")
        (tmp_path / "r.kml").write_text(ROUTE_NAME_KML, encoding="utf-8")
        assert any(
            "Description date" in v for v in check_kml_obfuscated(tmp_path / "c.kml")
        )
        assert any(
            "Route name date" in v for v in check_kml_obfuscated(tmp_path / "r.kml")
        )

    @pytest.mark.parametrize("kml", [SAMPLE_KML, CHARTERWARE_KML, ROUTE_NAME_KML])
    def test_passes_after_obfuscation(self, tmp_path, kml):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(kml, encoding="utf-8")
        obfuscate_kml_file(kml_file)
        assert check_kml_obfuscated(kml_file) == []

    def test_real_creator_is_a_violation(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            '<kml creator="SkyDemon"><when>2025-01-01T08:25:15Z</when></kml>',
            encoding="utf-8",
        )
        violations = check_kml_obfuscated(kml_file)
        assert len(violations) == 1
        assert "SkyDemon" in violations[0]

    def test_generic_creator_is_not_a_violation(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            '<kml creator="kml-heatmap"><when>2025-01-01T08:25:15Z</when></kml>',
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == []

    @pytest.mark.parametrize(
        "kml",
        [
            "<kml><when>2025-01-01T08:25:15.0000000Z</when></kml>",
            "<kml><name>test</name></kml>",
            "<kml><when>not-a-timestamp</when></kml>",
        ],
    )
    def test_clean_edge_cases(self, tmp_path, kml):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(kml, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    @pytest.mark.parametrize(
        "extra",
        [
            "<ExtendedData><value>2025-06-14T09:12:00Z</value></ExtendedData>",
            "<description>logged 2025-06-14T09:12:00.123Z</description>",
            "<description>14.06.2025</description>",
            "<description>June 14, 2025</description>",
            "<when>2025-06</when>",
        ],
    )
    def test_dates_anywhere_are_violations(self, tmp_path, extra):
        """A full timestamp has no word boundary between the date and "T"."""
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            f"<kml><when>2025-01-01T08:00:00Z</when>{extra}</kml>", encoding="utf-8"
        )
        assert check_kml_obfuscated(kml_file) != []

    def test_prefixed_timestamps_are_checked(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            '<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2">'
            "<kml:when>2025-06-14T09:12:00Z</kml:when></kml:kml>",
            encoding="utf-8",
        )
        assert any(
            "Flight does not start on Jan 1" in v
            for v in check_kml_obfuscated(kml_file)
        )

    def test_date_only_timestamps_must_be_on_jan_1(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            "<kml><when>2025-01-02</when><when>2025-01-01</when></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == ["Timestamp not on Jan 1: 2025-01-02"]

    def test_second_flight_on_another_date_is_a_violation(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            "<kml><when>2025-01-01T10:00:00Z</when>"
            "<when>2025-03-14T10:00:00Z</when></kml>",
            encoding="utf-8",
        )
        violations = check_kml_obfuscated(kml_file)
        assert "Flight does not start on Jan 1: 2025-03-14T10:00:00Z" in violations

    @pytest.mark.parametrize(
        "text,stray",
        [
            ("2025-01-01T23:55:00Z 2025-01-02T00:15:00Z", []),
            ("2025-01-03T21:00:00Z", []),
            ("2025-01-04T00:00:00Z", ["2025-01-04"]),
            ("x2025-06-14y", ["2025-06-14"]),
            ("12025-06-145", []),
            ("12.058459 51.550617", []),
            ("02 Jan 2026 and Jan 3 2026", []),
            ("04 Jan 2026", ["04 Jan 2026"]),
            # Only 01.01 passes in the shapes the tool never writes: 02/01 is
            # February 1st in the US
            ("01/01/2026 01.01.2026", []),
            ("02/01/2026", ["02/01/2026"]),
            ("2026/03/10 2026.03.10", ["2026/03/10", "2026.03.10"]),
            ("2026/01/01", []),
            ("10 MAR 2026", ["10 MAR 2026"]),
            ("10-Mar-2026", ["10-Mar-2026"]),
            ("SkyDemon for iPhone v4.2.2.429", []),
            ("2026&#45;03&#45;10T10:00:00Z", ["2026-03-10"]),
            # Dash-separated, single-digit and two-digit-year numeric dates
            ("14-03-2024", ["14-03-2024"]),
            ("3/14/2024", ["3/14/2024"]),
            ("1/1/2026 01-01-2026", []),
            ("14.03.24", ["14.03.24"]),
            ("01.01.26", []),
            ("track_14-03-2024.kml", ["14-03-2024"]),
            # Compact dates, with a real month and day only
            ("20240314", ["20240314"]),
            ("flight_20240314.kml", ["20240314"]),
            ("20260101 20260103 20261301 12345678", []),
            ("20260104", ["20260104"]),
            # A year and month, an ISO week and an ordinal date
            ("2024-03", ["2024-03"]),
            ("2026-01 2023-2024", []),
            ("2024-W11 2024-W11-3", ["2024-W11", "2024-W11-3"]),
            ("2026-W01", []),
            ("2024-074", ["2024-074"]),
            ("2026-002", []),
            # Month names with ordinals, without a day, and in file names
            ("14th March 2024", ["14th March 2024"]),
            ("March 2024", ["March 2024"]),
            ("January 2026", []),
            ("N123AB_Mar14_2024.kml", ["Mar14_2024"]),
            ("Cessna 172 2024", []),
            ("Log Start: 2025-01-01", []),
            ("Flight Jan 01 2026 03:01PM", []),
            # Unix time in a data value
            ("<value>1710406320</value>", ["1710406320"]),
            ("<gx:value>1710406320000</gx:value>", ["1710406320000"]),
            ('<SimpleData name="t">1710406320</SimpleData>', ["1710406320"]),
            ("<value>1735689600</value>", []),
            ("<value>12345</value> 1710406320", []),
            # Ten digits, but not a time of this era
            ("<value>9999999999</value>", []),
        ],
    )
    def test_stray_dates_tolerate_the_days_after_jan_1(self, text, stray):
        assert _find_stray_dates(text) == stray

    @pytest.mark.parametrize(
        "name",
        [
            "flight_20240314.kml",
            "track_14-03-2024.kml",
            "N123AB_Mar14_2024.kml",
            "log 2024-03.kml",
        ],
    )
    def test_other_file_name_shapes_are_violations(self, tmp_path, name):
        kml_file = tmp_path / name
        kml_file.write_text("<kml/>", encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == [
            f"File name contains a date: {_find_stray_dates(name)[0]}"
        ]

    def test_leftover_temp_file_is_a_violation(self, tmp_path):
        """A rewrite killed before the rename leaves the original dates in a
        file the KML listing ignores."""
        (tmp_path / "a.kml").write_text(
            "<kml><when>2025-01-01T10:00:00Z</when></kml>", encoding="utf-8"
        )
        leftover = tmp_path / ".a.kml.x1y2z3.tmp"
        leftover.write_text(SAMPLE_KML, encoding="utf-8")

        violations = check_directory_obfuscated(tmp_path)

        assert list(violations) == [".a.kml.x1y2z3.tmp"]
        assert "Leftover temporary file" in violations[".a.kml.x1y2z3.tmp"][0]

    def test_directory_check_includes_subdirectories(self, tmp_path):
        """The generator reads subdirectories, so the check has to see them."""
        (tmp_path / "sub" / "deeper").mkdir(parents=True)
        (tmp_path / "a.kml").write_text(SAMPLE_KML, encoding="utf-8")
        (tmp_path / "sub" / "b.kml").write_text(SAMPLE_KML, encoding="utf-8")
        (tmp_path / "sub" / "deeper" / "c.kml").write_text(SAMPLE_KML, encoding="utf-8")

        assert set(check_directory_obfuscated(tmp_path)) == {
            "a.kml",
            "sub/b.kml",
            "sub/deeper/c.kml",
        }
        assert obfuscate_kml_directory(tmp_path) == 3
        assert check_directory_obfuscated(tmp_path) == {}

    def test_charterware_file_name_with_date_is_a_violation(self, tmp_path):
        kml_file = tmp_path / "2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml"
        kml_file.write_text(
            "<kml><when>2026-01-01T15:13:00Z</when></kml>", encoding="utf-8"
        )
        assert check_kml_obfuscated(kml_file) == [
            "File name contains the flight date: 2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml"
        ]
        renamed = tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml"
        kml_file.rename(renamed)
        assert check_kml_obfuscated(renamed) == []

    def test_other_file_name_with_date_is_a_violation(self, tmp_path):
        kml_file = tmp_path / "flight 14.06.2025.kml"
        kml_file.write_text("<kml/>", encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == [
            "File name contains a date: 14.06.2025"
        ]

    def test_unreadable_file_is_a_violation(self, tmp_path):
        # A file that cannot be read must not be certified as obfuscated
        violations = check_kml_obfuscated(tmp_path / "missing.kml")
        assert len(violations) == 1
        assert "Cannot read file" in violations[0]

    def test_directory_check(self, tmp_path):
        (tmp_path / "a.kml").write_text(SAMPLE_KML, encoding="utf-8")
        (tmp_path / "b.kml").write_text(SAMPLE_KML, encoding="utf-8")
        assert set(check_directory_obfuscated(tmp_path)) == {"a.kml", "b.kml"}
        obfuscate_kml_directory(tmp_path)
        assert check_directory_obfuscated(tmp_path) == {}


class TestDifferentYearsAndMidnight:
    def test_preserves_different_years(self, tmp_path):
        kml_2026 = SAMPLE_KML.replace("2025-03-03", "2026-06-15").replace(
            "03 Mar 2025", "15 Jun 2026"
        )
        result = obfuscate_kml_content(kml_2026)
        assert "2026-01-01T08:25:" in result
        assert "2026-06-15" not in result

    def test_midnight_crossover(self, tmp_path):
        kml = (
            "<kml><Placemark><name>Log Start: 03 Mar 2025 23:55 Z</name></Placemark>"
            "<when>2025-03-03T23:55:00.0000000Z</when>"
            "<when>2025-03-04T00:15:00.0000000Z</when>"
            "<Placemark><name>Log Stop: 04 Mar 2025 00:15 Z</name></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert "2025-01-01T23:55:00" in result
        assert "2025-01-02T00:15:00" in result
        assert "<name>Log Stop: 2025-01-01</name>" in result
        kml_file = tmp_path / "late.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []


class TestExtractFrac:
    @pytest.mark.parametrize(
        "ts,expected",
        [
            ("2025-03-03T08:25:15.5848385Z", ".5848385"),
            ("2025-03-03T08:25:15.123", ".123"),
            ("2025-03-03T08:25:15.5+02:00", ".5"),
            ("2025-03-03T08:25:15Z", ""),
        ],
    )
    def test_extract(self, ts, expected):
        assert _extract_frac(ts) == expected


class TestProperties:
    @settings(max_examples=100, deadline=None)
    @given(
        st.datetimes(
            min_value=datetime(2000, 1, 2),
            max_value=datetime(2099, 12, 30),
            timezones=st.just(UTC),
        ),
        st.lists(st.integers(min_value=0, max_value=3600), min_size=1, max_size=8),
    )
    def test_idempotent_and_deltas_preserved(self, start, gaps):
        start = start.replace(microsecond=0)
        times = [start]
        for gap in gaps:
            times.append(times[-1] + timedelta(seconds=gap))
        content = (
            "<kml>"
            + "".join(f"<when>{t.strftime('%Y-%m-%dT%H:%M:%S')}Z</when>" for t in times)
            + "</kml>"
        )

        once = obfuscate_kml_content(content)
        if once is None:
            # Already anchored on Jan 1
            assert start.month == 1
            assert start.day == 1
            return

        shifted = [_parse_utc(ts) for ts in _whens(once)]
        assert shifted[0].month == 1
        assert shifted[0].day == 1
        assert shifted[0].year == start.year
        assert shifted[0].time() == start.time()
        for original_gap, (a, b) in zip(gaps, pairwise(shifted), strict=True):
            assert (b - a) == timedelta(seconds=original_gap)
        assert obfuscate_kml_content(once) is None


class TestCLI:
    def test_check_mode_exits_1_on_violations(self, tmp_path, capsys):
        (tmp_path / "test.kml").write_text(SAMPLE_KML, encoding="utf-8")
        with (
            patch("sys.argv", ["obfuscate", str(tmp_path), "--check"]),
            pytest.raises(SystemExit) as e,
        ):
            main()
        assert e.value.code == 1
        assert "violations" in capsys.readouterr().out

    def test_check_mode_exits_0_on_clean(self, tmp_path, capsys):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        obfuscate_kml_file(kml_file)
        with patch("sys.argv", ["obfuscate", str(tmp_path), "--check"]):
            main()
        assert "All 1 KML file(s) are properly obfuscated" in capsys.readouterr().out

    def test_check_mode_reports_leftover_temp_files(self, tmp_path, capsys):
        (tmp_path / ".test.kml.abcd.tmp").write_text(SAMPLE_KML, encoding="utf-8")
        with (
            patch("sys.argv", ["obfuscate", str(tmp_path), "--check"]),
            pytest.raises(SystemExit) as e,
        ):
            main()
        assert e.value.code == 1
        assert ".test.kml.abcd.tmp: Leftover temporary file" in capsys.readouterr().out

    def test_nested_files_are_obfuscated_and_named_by_their_path(
        self, tmp_path, capsys
    ):
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "test.kml").write_text(SAMPLE_KML, encoding="utf-8")
        with patch("sys.argv", ["obfuscate", str(tmp_path)]):
            main()
        assert "Obfuscated 1 of 1" in capsys.readouterr().out
        (tmp_path / "sub" / "test.kml").write_text(SAMPLE_KML, encoding="utf-8")
        with (
            patch("sys.argv", ["obfuscate", str(tmp_path), "--check"]),
            pytest.raises(SystemExit),
        ):
            main()
        assert "  sub/test.kml: " in capsys.readouterr().out

    def test_obfuscate_mode(self, tmp_path, capsys):
        (tmp_path / "test.kml").write_text(SAMPLE_KML, encoding="utf-8")
        with patch("sys.argv", ["obfuscate", str(tmp_path)]):
            main()
        assert "Obfuscated 1 of 1" in capsys.readouterr().out

    def test_obfuscate_mode_exits_1_for_a_file_it_could_not_fix(self, tmp_path, capsys):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        kml_file.chmod(0o444)
        try:
            with (
                patch("sys.argv", ["obfuscate", str(tmp_path)]),
                pytest.raises(SystemExit) as e,
            ):
                main()
        finally:
            kml_file.chmod(0o644)
        assert e.value.code == 1
        assert "test.kml: " in capsys.readouterr().out

    def test_each_date_is_reported_once(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            "<kml><Placemark><when>2025-01-01T10:00:00Z</when></Placemark>"
            "<ExtendedData>2025-09-21 2025-09-21 2025-09-21</ExtendedData></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == ["Date not on Jan 1: 2025-09-21"]

    def test_exits_1_for_invalid_directory(self, tmp_path, capsys):
        with (
            patch("sys.argv", ["obfuscate", str(tmp_path / "nonexistent")]),
            pytest.raises(SystemExit) as e,
        ):
            main()
        assert e.value.code == 1
        assert "not a directory" in capsys.readouterr().err


class TestUnparsableDates:
    """Dates the patterns match but the calendar rejects are left untouched."""

    def test_description_with_unknown_month(self):
        content = (
            "<kml><when>2025-03-03T08:00:00Z</when>"
            "<description>Flight Foo 12 2025 03:01PM</description></kml>"
        )
        result = obfuscate_module.obfuscate_kml_content(content)
        assert "Flight Foo 12 2025 03:01PM" in result
        assert "2025-01-01T08:00:00Z" in result

    def test_description_with_invalid_day(self):
        content = (
            "<kml><when>2025-03-03T08:00:00Z</when>"
            "<description>Flight Feb 31 2025 03:01PM</description></kml>"
        )
        result = obfuscate_module.obfuscate_kml_content(content)
        assert "Flight Feb 31 2025 03:01PM" in result

    def test_route_name_with_unknown_month(self):
        content = (
            "<kml><when>2025-03-03T08:00:00Z</when>"
            "<name>EDDS to EDDP - 16 Foo 2025</name></kml>"
        )
        result = obfuscate_module.obfuscate_kml_content(content)
        assert "16 Foo 2025" in result

    def test_route_name_with_invalid_day(self):
        content = (
            "<kml><when>2025-03-03T08:00:00Z</when>"
            "<name>EDDS to EDDP - 31 Feb 2025</name></kml>"
        )
        result = obfuscate_module.obfuscate_kml_content(content)
        assert "31 Feb 2025" in result

    def test_route_only_document(self):
        content = "<kml><name>EDDS to EDDP - 16 Aug 2026</name></kml>"
        result = obfuscate_module.obfuscate_kml_content(content)
        assert result == "<kml><name>EDDS to EDDP - 01 Jan 2026</name></kml>"

    def test_unparsable_dates_alone_give_none(self):
        assert obfuscate_kml_content("<kml><name>X - 31 Feb 2026</name></kml>") is None
        assert (
            obfuscate_kml_content(
                "<kml><description>Flight Foo 12 2026 03:01PM</description></kml>"
            )
            is None
        )


CHARTERWARE_NAME = "2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml"


class TestRenameCharterwareFiles:
    def _write(self, directory, name):
        path = directory / name
        path.write_text(CHARTERWARE_KML, encoding="utf-8")
        return path

    def test_date_and_time_are_removed(self, tmp_path):
        path = self._write(tmp_path, CHARTERWARE_NAME)
        other = self._write(tmp_path, "1_DEAGJ_DA20.kml")

        result = rename_charterware_files([other, path])

        renamed = tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml"
        assert result == [other, renamed]
        assert renamed.read_text(encoding="utf-8") == CHARTERWARE_KML
        assert not path.exists()
        assert parse_aircraft_from_filename(renamed.name)["route"] == "LOAV-LOAV"

    def test_numbers_follow_the_flight_order_per_year(self, tmp_path):
        names = [
            "2026-03-05_0830h_OE-AKI_LOAV-LOAV.kml",
            "2025-07-01_1200h_D-EXYZ_EDDF-EDDM.kml",
            "2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml",
            "2026-02-01_0900h_D-EXYZ_EDDF-EDDM.KML",
        ]
        paths = [self._write(tmp_path, name) for name in names]

        result = rename_charterware_files(paths)

        assert [p.name for p in result] == [
            "2026-01-01_0002h_OE-AKI_LOAV-LOAV.kml",
            "2025-01-01_0000h_D-EXYZ_EDDF-EDDM.kml",
            "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml",
            "2026-01-01_0001h_D-EXYZ_EDDF-EDDM.KML",
        ]
        assert sorted(p.name for p in tmp_path.iterdir()) == sorted(
            p.name for p in result
        )

    def test_new_files_continue_after_existing_numbers(self, tmp_path):
        self._write(tmp_path, "2026-01-01_0059h_OE-AKI_LOAV-LOAV.kml")
        path = self._write(tmp_path, CHARTERWARE_NAME)

        assert rename_charterware_files([path])[0].name == (
            "2026-01-01_0100h_OE-AKI_LOAV-LOAV.kml"
        )

    def test_existing_files_are_never_replaced(self, tmp_path):
        """A file the scan missed or a dangling symlink still takes the name."""
        (tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml").symlink_to(
            tmp_path / "missing"
        )
        taken = tmp_path / "2026-01-01_0001h_OE-AKI_LOAV-LOAV.kml"
        taken.write_text("other flight", encoding="utf-8")
        path = self._write(tmp_path, CHARTERWARE_NAME)

        with patch.object(
            obfuscate_module, "_used_charterware_slots", return_value=set()
        ):
            result = rename_charterware_files([path])

        assert result[0].name == "2026-01-01_0002h_OE-AKI_LOAV-LOAV.kml"
        assert taken.read_text(encoding="utf-8") == "other flight"

    def test_free_numbers_below_the_highest_are_used_last(self, tmp_path):
        self._write(tmp_path, "2026-01-01_2359h_OE-AKI_LOAV-LOAV.kml")
        path = self._write(tmp_path, CHARTERWARE_NAME)

        assert rename_charterware_files([path])[0].name == (
            "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml"
        )

    def test_no_free_number_keeps_the_file(self, tmp_path, capsys):
        path = self._write(tmp_path, CHARTERWARE_NAME)
        with patch.object(
            obfuscate_module,
            "_used_charterware_slots",
            return_value=set(range(obfuscate_module.MINUTES_PER_DAY)),
        ):
            assert rename_charterware_files([path]) == [path]
        assert path.exists()
        assert "no free January 1st name" in capsys.readouterr().err

    def test_rename_failure_keeps_the_file(self, tmp_path, capsys):
        path = self._write(tmp_path, CHARTERWARE_NAME)
        with (
            patch("kml_heatmap.obfuscate.os.link", side_effect=OSError("denied")),
            patch("kml_heatmap.obfuscate.os.rename", side_effect=OSError("denied")),
        ):
            assert rename_charterware_files([path]) == [path]
        assert "Cannot rename" in capsys.readouterr().err
        assert path.exists()

    def test_a_name_taken_after_the_scan_is_not_overwritten(self, tmp_path):
        """Another run renaming into the directory must not lose a flight."""
        path = self._write(tmp_path, CHARTERWARE_NAME)
        taken = tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml"
        real_link = os.link

        def link_after_other_run(src, dst, **kwargs):
            if Path(dst) == taken and not taken.exists():
                taken.write_text("other flight", encoding="utf-8")
            return real_link(src, dst, **kwargs)

        with patch("kml_heatmap.obfuscate.os.link", side_effect=link_after_other_run):
            renamed = rename_charterware_files([path])

        assert taken.read_text(encoding="utf-8") == "other flight"
        assert renamed == [tmp_path / "2026-01-01_0001h_OE-AKI_LOAV-LOAV.kml"]
        assert not path.exists()

    def test_renames_without_hard_link_support(self, tmp_path):
        path = self._write(tmp_path, CHARTERWARE_NAME)
        with patch("kml_heatmap.obfuscate.os.link", side_effect=OSError("no links")):
            renamed = rename_charterware_files([path])
        assert renamed == [tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml"]
        assert renamed[0].exists()
        assert not path.exists()

    def test_obfuscated_names_and_symlinks_are_left_alone(self, tmp_path):
        done = self._write(tmp_path, "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml")
        target = self._write(tmp_path, "target.txt")
        link = tmp_path / CHARTERWARE_NAME
        link.symlink_to(target)

        assert rename_charterware_files([done, link]) == [done, link]
        assert link.is_symlink()

    def test_unlistable_directory_has_no_used_numbers(self, tmp_path):
        with patch.object(Path, "iterdir", side_effect=OSError("denied")):
            assert obfuscate_module._used_charterware_slots(tmp_path, "2026") == set()

    def test_directory_obfuscation_renames_and_rewrites(self, tmp_path, capsys):
        self._write(tmp_path, CHARTERWARE_NAME)
        (tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml").write_text(
            obfuscate_kml_content(CHARTERWARE_KML), encoding="utf-8"
        )
        with patch("sys.argv", ["obfuscate", str(tmp_path)]):
            main()
        assert "Obfuscated 1 of 2" in capsys.readouterr().out
        assert sorted(p.name for p in tmp_path.iterdir()) == [
            "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml",
            "2026-01-01_0001h_OE-AKI_LOAV-LOAV.kml",
        ]
        assert check_directory_obfuscated(tmp_path) == {}
        assert obfuscate_kml_directory(tmp_path) == 0


class TestErrorBranches:
    def test_exception_in_one_file_is_logged_and_the_rest_continue(
        self, tmp_path, capsys
    ):
        first = tmp_path / "1.kml"
        second = tmp_path / "2.kml"
        for path in (first, second):
            path.write_text(SAMPLE_KML, encoding="utf-8")

        original = obfuscate_module.obfuscate_kml_file

        def flaky(path):
            if path == first:
                raise RuntimeError("boom")
            return original(path)

        with patch.object(obfuscate_module, "obfuscate_kml_file", side_effect=flaky):
            assert obfuscate_module.obfuscate_kml_files([first, second]) == 1
        assert "Failed to obfuscate" in capsys.readouterr().err
        assert "2025-01-01" in second.read_text(encoding="utf-8")

    def test_os_error_is_logged_without_a_traceback(self, tmp_path, capsys):
        path = tmp_path / "1.kml"
        path.write_text(SAMPLE_KML, encoding="utf-8")

        with patch.object(
            obfuscate_module,
            "obfuscate_kml_file",
            side_effect=PermissionError("read-only"),
        ):
            assert obfuscate_module.obfuscate_kml_files([path]) == 0
        err = capsys.readouterr().err
        assert "Failed to obfuscate" in err
        assert "read-only" in err
        assert "Traceback" not in err

    def test_unlistable_directory_yields_no_files(self, tmp_path):
        with patch.object(Path, "iterdir", side_effect=OSError("denied")):
            assert obfuscate_module.find_kml_files(tmp_path) == []

    def test_directory_fsync_tolerates_errors(self, tmp_path):
        obfuscate_module._fsync_directory(tmp_path / "missing")
        with patch("kml_heatmap.obfuscate.os.fsync", side_effect=OSError("nope")):
            obfuscate_module._fsync_directory(tmp_path)

    def test_write_flushes_to_disk_before_replacing(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        calls = []
        real_fsync = os.fsync

        def recording_fsync(fd):
            calls.append(fd)
            return real_fsync(fd)

        with patch("kml_heatmap.obfuscate.os.fsync", side_effect=recording_fsync):
            assert obfuscate_module.obfuscate_kml_file(kml_file) is True
        # Once for the temp file, once for the directory entry
        assert len(calls) == 2
