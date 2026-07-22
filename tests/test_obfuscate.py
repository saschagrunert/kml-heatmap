"""Tests for KML timestamp obfuscation."""

from pathlib import Path

import pytest

from kml_heatmap.helpers import parse_iso_timestamp
from kml_heatmap.obfuscate import (
    _extract_frac,
    _is_already_obfuscated,
    check_directory_obfuscated,
    check_kml_obfuscated,
    main,
    obfuscate_kml_content,
    obfuscate_kml_directory,
    obfuscate_kml_file,
)

SAMPLE_KML = """\
<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"
     xmlns:gx="http://www.google.com/kml/ext/2.2">
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


class TestObfuscateContent:
    """Tests for obfuscate_kml_content."""

    def test_shifts_timestamps_to_jan_1(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        assert "2025-01-01T08:25:15" in result
        assert "2025-03-03" not in result

    def test_preserves_year_and_time(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        assert "2025-01-01T08:25:" in result

    def test_preserves_time_deltas(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None

        original_ts = [
            "2025-03-03T08:25:15.5848380Z",
            "2025-03-03T08:25:20.5858380Z",
            "2025-03-03T08:25:25.5868380Z",
        ]
        original_dts = [parse_iso_timestamp(ts) for ts in original_ts]
        original_deltas = [
            (original_dts[i + 1] - original_dts[i]).total_seconds()
            for i in range(len(original_dts) - 1)
        ]

        import re

        shifted_ts = re.findall(r"<when>([^<]+)</when>", result)
        shifted_dts = [parse_iso_timestamp(ts) for ts in shifted_ts]
        shifted_deltas = [
            (shifted_dts[i + 1] - shifted_dts[i]).total_seconds()
            for i in range(len(shifted_dts) - 1)
        ]

        for orig, shifted in zip(original_deltas, shifted_deltas):
            assert abs(orig - shifted) < 0.001

    def test_strips_name_dates(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        assert "<name>Log Start: 2025-01-01</name>" in result
        assert "<name>Takeoff: 2025-01-01</name>" in result
        assert "<name>Landing: 2025-01-01</name>" in result
        assert "<name>Log Stop: 2025-01-01</name>" in result

    def test_preserves_route_name(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        assert "<name>EDAQ Halle-Oppin - EDAQ Halle-Oppin</name>" in result

    def test_preserves_document_name(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        assert "<name>SkyDemon Track Log</name>" in result

    def test_preserves_coordinates(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        assert "12.058459 51.550617 100" in result
        assert "12.060145 51.550606 105" in result

    def test_returns_none_for_no_timestamps(self):
        kml = "<kml><Document><name>test</name></Document></kml>"
        assert obfuscate_kml_content(kml) is None

    def test_returns_none_for_already_obfuscated(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        assert obfuscate_kml_content(result) is None


class TestObfuscateFile:
    """Tests for obfuscate_kml_file."""

    def test_modifies_file_in_place(self, tmp_path: Path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")

        assert obfuscate_kml_file(kml_file) is True

        content = kml_file.read_text(encoding="utf-8")
        assert "2025-01-01T08:25:15" in content
        assert "2025-03-03" not in content

    def test_idempotent(self, tmp_path: Path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")

        assert obfuscate_kml_file(kml_file) is True
        first_content = kml_file.read_text(encoding="utf-8")

        assert obfuscate_kml_file(kml_file) is False
        second_content = kml_file.read_text(encoding="utf-8")

        assert first_content == second_content


class TestObfuscateDirectory:
    """Tests for obfuscate_kml_directory."""

    def test_processes_all_kml_files(self, tmp_path: Path):
        for i in range(3):
            kml_file = tmp_path / f"flight_{i}.kml"
            kml_file.write_text(SAMPLE_KML, encoding="utf-8")

        modified = obfuscate_kml_directory(tmp_path)
        assert modified == 3

        for i in range(3):
            content = (tmp_path / f"flight_{i}.kml").read_text(encoding="utf-8")
            assert "2025-01-01T08:25:" in content

    def test_skips_non_kml_files(self, tmp_path: Path):
        (tmp_path / "data.json").write_text("{}", encoding="utf-8")
        (tmp_path / "flight.kml").write_text(SAMPLE_KML, encoding="utf-8")

        modified = obfuscate_kml_directory(tmp_path)
        assert modified == 1

    def test_returns_zero_for_already_obfuscated(self, tmp_path: Path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")

        obfuscate_kml_directory(tmp_path)
        assert obfuscate_kml_directory(tmp_path) == 0


class TestCheckObfuscated:
    """Tests for check_kml_obfuscated."""

    def test_detects_unobfuscated_timestamps(self, tmp_path: Path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")

        violations = check_kml_obfuscated(kml_file)
        assert len(violations) > 0

    def test_detects_unobfuscated_names(self, tmp_path: Path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")

        violations = check_kml_obfuscated(kml_file)
        name_violations = [v for v in violations if "Name element" in v]
        assert len(name_violations) > 0

    def test_passes_obfuscated_file(self, tmp_path: Path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        obfuscate_kml_file(kml_file)

        violations = check_kml_obfuscated(kml_file)
        assert violations == []


class TestCheckDirectoryObfuscated:
    """Tests for check_directory_obfuscated."""

    def test_detects_unobfuscated_files(self, tmp_path: Path):
        (tmp_path / "a.kml").write_text(SAMPLE_KML, encoding="utf-8")
        (tmp_path / "b.kml").write_text(SAMPLE_KML, encoding="utf-8")

        results = check_directory_obfuscated(tmp_path)
        assert len(results) == 2

    def test_passes_all_obfuscated(self, tmp_path: Path):
        (tmp_path / "a.kml").write_text(SAMPLE_KML, encoding="utf-8")
        obfuscate_kml_directory(tmp_path)

        results = check_directory_obfuscated(tmp_path)
        assert results == {}


class TestDifferentYears:
    """Tests for handling different years."""

    def test_preserves_different_years(self, tmp_path: Path):
        kml_2026 = SAMPLE_KML.replace("2025-03-03", "2026-06-15").replace(
            "03 Mar 2025", "15 Jun 2026"
        )
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(kml_2026, encoding="utf-8")

        obfuscate_kml_file(kml_file)
        content = kml_file.read_text(encoding="utf-8")

        assert "2026-01-01T08:25:" in content
        assert "2026-06-15" not in content


class TestMidnightCrossover:
    """Tests for flights that cross midnight after shifting."""

    LATE_FLIGHT_KML = """\
<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"
     xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>SkyDemon Track Log</name>
    <Placemark>
      <name>Log Start: 03 Mar 2025 23:55 Z</name>
      <Point><coordinates>12.058459,51.550617,100</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>EDAQ Halle-Oppin - EDAQ Halle-Oppin</name>
      <gx:Track>
        <when>2025-03-03T23:55:00.0000000Z</when>
        <gx:coord>12.058459 51.550617 100</gx:coord>
        <when>2025-03-04T00:15:00.0000000Z</when>
        <gx:coord>12.060145 51.550606 105</gx:coord>
      </gx:Track>
    </Placemark>
    <Placemark>
      <name>Log Stop: 04 Mar 2025 00:15 Z</name>
      <Point><coordinates>12.058459,51.550617,100</coordinates></Point>
    </Placemark>
  </Document>
</kml>
"""

    def test_obfuscation_shifts_to_jan_1(self):
        result = obfuscate_kml_content(self.LATE_FLIGHT_KML)
        assert result is not None
        assert "2025-01-01T23:55:00" in result
        assert "2025-01-02T00:15:00" in result

    def test_check_passes_after_obfuscation(self, tmp_path: Path):
        kml_file = tmp_path / "late.kml"
        kml_file.write_text(self.LATE_FLIGHT_KML, encoding="utf-8")
        obfuscate_kml_file(kml_file)

        violations = check_kml_obfuscated(kml_file)
        assert violations == []


class TestParseTimestamp:
    """Tests for parse_iso_timestamp edge cases."""

    def test_returns_none_for_empty_string(self):
        assert parse_iso_timestamp("") is None

    def test_returns_none_for_no_t_separator(self):
        assert parse_iso_timestamp("2025-03-03") is None

    def test_returns_none_for_invalid_iso(self):
        assert parse_iso_timestamp("not-a-dateThh:mm:ss") is None

    def test_parses_valid_timestamp(self):
        dt = parse_iso_timestamp("2025-03-03T08:25:15.5848380Z")
        assert dt is not None
        assert dt.year == 2025
        assert dt.month == 3


class TestIsAlreadyObfuscated:
    """Tests for _is_already_obfuscated."""

    def test_returns_true_when_fully_obfuscated(self):
        from datetime import datetime, timezone

        dt = datetime(2025, 1, 1, 8, 25, 0, tzinfo=timezone.utc)
        content = "<name>Log Start: 2025-01-01</name>"
        assert _is_already_obfuscated(dt, content) is True

    def test_returns_false_when_date_not_jan_1(self):
        from datetime import datetime, timezone

        dt = datetime(2025, 3, 3, 8, 25, 0, tzinfo=timezone.utc)
        content = "<name>Log Start: 2025-01-01</name>"
        assert _is_already_obfuscated(dt, content) is False

    def test_returns_false_when_names_not_obfuscated(self):
        from datetime import datetime, timezone

        dt = datetime(2025, 1, 1, 8, 25, 0, tzinfo=timezone.utc)
        content = "<name>Log Start: 03 Mar 2025 08:25 Z</name>"
        assert _is_already_obfuscated(dt, content) is False


class TestExtractFrac:
    """Tests for _extract_frac."""

    def test_extracts_7_digit_frac(self):
        assert _extract_frac("2025-03-03T08:25:15.5848385Z") == ".5848385"

    def test_extracts_frac_without_z(self):
        assert _extract_frac("2025-03-03T08:25:15.123") == ".123"

    def test_returns_empty_for_no_frac(self):
        assert _extract_frac("2025-03-03T08:25:15Z") == ""


class TestFractionalPrecision:
    """Tests for preserving sub-microsecond fractional seconds."""

    def test_preserves_7_digit_fractional_seconds(self):
        kml = SAMPLE_KML.replace(".5848380Z", ".5848385Z")
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert ".5848385Z" in result

    def test_preserves_original_frac_format(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        assert ".5848380Z" in result
        assert ".5858380Z" in result
        assert ".5868380Z" in result


class TestObfuscateContentEdgeCases:
    """Tests for obfuscate_kml_content edge cases."""

    def test_returns_none_for_unparsable_first_timestamp(self):
        kml = "<kml><when>not-valid</when></kml>"
        assert obfuscate_kml_content(kml) is None

    def test_preserves_unparsable_inner_timestamps(self):
        kml = """\
<kml>
  <when>2025-03-03T08:25:15.0000000Z</when>
  <when>bad-timestamp</when>
  <when>2025-03-03T08:30:00.0000000Z</when>
</kml>"""
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert "<when>bad-timestamp</when>" in result


class TestCheckObfuscatedEdgeCases:
    """Tests for check_kml_obfuscated edge cases."""

    def test_no_violations_when_first_timestamp_on_jan_1(self, tmp_path: Path):
        kml = "<kml><when>2025-01-01T08:25:15.0000000Z</when></kml>"
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(kml, encoding="utf-8")
        violations = check_kml_obfuscated(kml_file)
        assert violations == []

    def test_no_violations_when_no_when_elements(self, tmp_path: Path):
        kml = "<kml><name>test</name></kml>"
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(kml, encoding="utf-8")
        violations = check_kml_obfuscated(kml_file)
        assert violations == []

    def test_no_violations_when_first_timestamp_unparsable(self, tmp_path: Path):
        kml = "<kml><when>not-a-timestamp</when></kml>"
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(kml, encoding="utf-8")
        violations = check_kml_obfuscated(kml_file)
        assert violations == []


class TestCLI:
    """Tests for CLI entry point."""

    def test_check_mode_exits_1_on_violations(self, tmp_path: Path):
        (tmp_path / "test.kml").write_text(SAMPLE_KML, encoding="utf-8")

        from unittest.mock import patch

        with patch("sys.argv", ["obfuscate", str(tmp_path), "--check"]):
            with pytest.raises(SystemExit) as exc_info:
                main()
            assert exc_info.value.code == 1

    def test_check_mode_exits_0_on_clean(self, tmp_path: Path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        obfuscate_kml_file(kml_file)

        from unittest.mock import patch

        with patch("sys.argv", ["obfuscate", str(tmp_path), "--check"]):
            main()

    def test_obfuscate_mode(self, tmp_path: Path, capsys):
        (tmp_path / "test.kml").write_text(SAMPLE_KML, encoding="utf-8")

        from unittest.mock import patch

        with patch("sys.argv", ["obfuscate", str(tmp_path)]):
            main()

        output = capsys.readouterr().out
        assert "Obfuscated 1 of 1" in output

    def test_exits_1_for_invalid_directory(self, tmp_path: Path):
        from unittest.mock import patch

        with patch("sys.argv", ["obfuscate", str(tmp_path / "nonexistent")]):
            with pytest.raises(SystemExit) as exc_info:
                main()
            assert exc_info.value.code == 1
