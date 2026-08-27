"""Tests for validation module."""

import os
import tempfile

from kml_heatmap.validation import validate_kml_file


class TestValidateKmlFile:
    """Tests for validate_kml_file function."""

    def test_valid_kml_file(self):
        """Test validation of valid KML file."""
        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False, mode="w") as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>')
            f.write('<kml xmlns="http://www.opengis.net/kml/2.2">')
            f.write("<Document></Document></kml>")
            temp_path = f.name

        try:
            is_valid, error_msg = validate_kml_file(temp_path)
            assert is_valid is True
            assert error_msg is None
        finally:
            os.unlink(temp_path)

    def test_nonexistent_file(self):
        """Test validation of nonexistent file."""
        is_valid, error_msg = validate_kml_file("/nonexistent/file.kml")
        assert is_valid is False
        assert error_msg is not None

    def test_non_kml_extension(self):
        """Test validation of file without .kml extension."""
        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
            temp_path = f.name

        try:
            is_valid, error_msg = validate_kml_file(temp_path)
            assert is_valid is False
            assert error_msg is not None
            assert ".kml" in error_msg
        finally:
            os.unlink(temp_path)

    def test_empty_file(self):
        """Test validation of empty file."""
        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            temp_path = f.name

        try:
            is_valid, error_msg = validate_kml_file(temp_path)
            assert is_valid is False
            assert error_msg is not None
            assert "empty" in error_msg.lower()
        finally:
            os.unlink(temp_path)

    def test_directory_instead_of_file(self):
        """Test validation with directory path."""
        with tempfile.TemporaryDirectory() as temp_dir:
            is_valid, error_msg = validate_kml_file(temp_dir)
            assert is_valid is False
            assert error_msg is not None

    def test_file_too_large(self, monkeypatch):
        """Test validation rejects files exceeding MAX_KML_FILE_SIZE."""
        import kml_heatmap.validation as val_mod

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False, mode="w") as f:
            f.write('<?xml version="1.0"?><kml/>')
            temp_path = f.name

        try:
            monkeypatch.setattr(val_mod, "MAX_KML_FILE_SIZE", 1)
            is_valid, error_msg = validate_kml_file(temp_path)

            assert is_valid is False
            assert error_msg is not None
            assert "too large" in error_msg.lower()
        finally:
            os.unlink(temp_path)
