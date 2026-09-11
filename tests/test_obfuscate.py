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
from kml_heatmap.obfuscate import (
    GENERIC_CREATOR,
    _extract_frac,
    _is_already_obfuscated,
    check_directory_obfuscated,
    check_kml_obfuscated,
    main,
    obfuscate_kml_content,
    obfuscate_kml_directory,
    obfuscate_kml_file,
    obfuscate_kml_files,
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

    def test_description_date_shifted_with_same_offset(self):
        result = obfuscate_kml_content(CHARTERWARE_KML)
        assert "Flight Jan 01 2026 03:01PM path of OE-AKI" in result
        assert "Jan 12" not in result

    def test_description_is_anchor_without_full_timestamps(self):
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

    def test_route_name_follows_when_offset(self):
        kml = (
            "<kml><name>EDDS to EDDP - 17 Aug 2026</name>"
            "<when>2026-08-16T10:00:00Z</when></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert "<name>EDDS to EDDP - 02 Jan 2026</name>" in result

    def test_all_patterns_are_idempotent(self):
        for kml in (SAMPLE_KML, CHARTERWARE_KML, ROUTE_NAME_KML):
            once = obfuscate_kml_content(kml)
            assert once is not None
            assert obfuscate_kml_content(once) is None


class TestObfuscateFile:
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
        assert any("First timestamp" in v for v in violations)

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


class TestIsAlreadyObfuscated:
    def test_true_when_fully_obfuscated(self):
        dt = datetime(2025, 1, 1, 8, 25, 0, tzinfo=UTC)
        assert _is_already_obfuscated(dt, "<name>Log Start: 2025-01-01</name>") is True

    def test_false_when_date_not_jan_1(self):
        dt = datetime(2025, 3, 3, 8, 25, 0, tzinfo=UTC)
        assert _is_already_obfuscated(dt, "<name>Log Start: 2025-01-01</name>") is False

    def test_false_when_names_not_obfuscated(self):
        dt = datetime(2025, 1, 1, 8, 25, 0, tzinfo=UTC)
        content = "<name>Log Start: 03 Mar 2025 08:25 Z</name>"
        assert _is_already_obfuscated(dt, content) is False

    def test_false_when_description_not_obfuscated(self):
        dt = datetime(2025, 1, 1, 8, 25, 0, tzinfo=UTC)
        assert _is_already_obfuscated(dt, "Flight Mar 03 2025 08:25AM") is False

    def test_false_when_route_date_not_obfuscated(self):
        dt = datetime(2025, 1, 1, 8, 25, 0, tzinfo=UTC)
        assert _is_already_obfuscated(dt, "<name>A - B - 03 Mar 2025</name>") is False


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

    def test_obfuscate_mode(self, tmp_path, capsys):
        (tmp_path / "test.kml").write_text(SAMPLE_KML, encoding="utf-8")
        with patch("sys.argv", ["obfuscate", str(tmp_path)]):
            main()
        assert "Obfuscated 1 of 1" in capsys.readouterr().out

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

    def test_route_only_document_is_anchored_on_the_route_date(self):
        content = "<kml><name>EDDS to EDDP - 16 Aug 2026</name></kml>"
        result = obfuscate_module.obfuscate_kml_content(content)
        assert result == "<kml><name>EDDS to EDDP - 01 Jan 2026</name></kml>"

    def test_unparsable_anchor_dates_give_none(self):
        assert (
            obfuscate_module._find_anchor("<kml><name>X - 31 Feb 2026</name></kml>")
            is None
        )
        assert (
            obfuscate_module._find_anchor(
                "<kml><description>Flight Foo 12 2026 03:01PM</description></kml>"
            )
            is None
        )


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
