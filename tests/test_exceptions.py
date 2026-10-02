"""Tests for exceptions module."""

import pytest

from kml_heatmap.exceptions import KMLHeatmapError, KMLParseError


class TestKMLHeatmapError:
    def test_base_exception(self):
        with pytest.raises(KMLHeatmapError):
            raise KMLHeatmapError("Test error")

    def test_base_exception_message(self):
        assert str(KMLHeatmapError("Test message")) == "Test message"

    def test_base_inherits_from_exception(self):
        assert isinstance(KMLHeatmapError("test"), Exception)


class TestKMLParseError:
    def test_simple_parse_error(self):
        assert str(KMLParseError("Parse failed")) == "Parse failed"

    def test_parse_error_keeps_the_file_and_the_line_apart(self):
        """The message does not repeat them: the caller names the file."""
        error = KMLParseError("Parse failed", file_path="test.kml", line_number=42)
        assert str(error) == "Parse failed"
        assert error.file_path == "test.kml"
        assert error.line_number == 42

    def test_parse_error_inheritance(self):
        assert isinstance(KMLParseError("Test"), KMLHeatmapError)

    def test_parse_error_can_be_caught(self):
        with pytest.raises(KMLParseError):
            raise KMLParseError("Test error")
