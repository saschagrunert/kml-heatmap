"""Tests for validation module."""

import os

import kml_heatmap.validation as val_mod
from kml_heatmap.validation import validate_kml_file, validate_output_dir


class TestValidateKmlFile:
    def test_valid_kml_file(self, tmp_path):
        path = tmp_path / "test.kml"
        path.write_text('<?xml version="1.0"?><kml><Document></Document></kml>')
        assert validate_kml_file(str(path)) == (True, None)

    def test_uppercase_extension_accepted(self, tmp_path):
        path = tmp_path / "TEST.KML"
        path.write_text("<kml/>")
        assert validate_kml_file(str(path)) == (True, None)

    def test_nonexistent_file(self, tmp_path):
        is_valid, error = validate_kml_file(str(tmp_path / "missing.kml"))
        assert is_valid is False
        assert "not found" in error

    def test_symlink_rejected(self, tmp_path):
        target = tmp_path / "real.kml"
        target.write_text("<kml/>")
        link = tmp_path / "link.kml"
        os.symlink(target, link)
        is_valid, error = validate_kml_file(str(link))
        assert is_valid is False
        assert "Symlinks" in error

    def test_non_kml_extension(self, tmp_path):
        path = tmp_path / "test.txt"
        path.write_text("<kml/>")
        is_valid, error = validate_kml_file(str(path))
        assert is_valid is False
        assert ".kml" in error

    def test_empty_file(self, tmp_path):
        path = tmp_path / "test.kml"
        path.write_text("")
        is_valid, error = validate_kml_file(str(path))
        assert is_valid is False
        assert "empty" in error.lower()

    def test_directory_instead_of_file(self, tmp_path):
        is_valid, error = validate_kml_file(str(tmp_path))
        assert is_valid is False
        assert "Not a file" in error

    def test_unreadable_file(self, tmp_path):
        path = tmp_path / "test.kml"
        path.write_text("<kml/>")
        path.chmod(0o000)
        try:
            if os.access(path, os.R_OK):
                return  # running as root, permissions are not enforced
            is_valid, error = validate_kml_file(str(path))
            assert is_valid is False
            assert "not readable" in error
        finally:
            path.chmod(0o644)

    def test_file_too_large(self, tmp_path, monkeypatch):
        path = tmp_path / "test.kml"
        path.write_text('<?xml version="1.0"?><kml/>')
        monkeypatch.setattr(val_mod, "MAX_KML_FILE_SIZE", 1)
        is_valid, error = validate_kml_file(str(path))
        assert is_valid is False
        assert "too large" in error.lower()


class TestValidateOutputDir:
    def test_separate_directories_are_fine(self, tmp_path):
        kml = tmp_path / "input" / "a.kml"
        assert validate_output_dir(tmp_path / "out" / "data", [kml]) == (True, None)

    def test_sibling_of_input_dir_is_fine(self, tmp_path):
        kml = tmp_path / "input" / "a.kml"
        assert validate_output_dir(tmp_path / "input-data", [kml])[0] is True

    def test_equal_to_input_dir_refused(self, tmp_path):
        kml = tmp_path / "data" / "a.kml"
        is_valid, error = validate_output_dir(tmp_path / "data", [kml])
        assert is_valid is False
        assert "Refusing" in error
        assert str(tmp_path / "data") in error

    def test_contained_in_input_dir_refused(self, tmp_path):
        kml = tmp_path / "a.kml"
        assert validate_output_dir(tmp_path / "data", [kml])[0] is False

    def test_containing_input_dir_refused(self, tmp_path):
        kml = tmp_path / "out" / "data" / "flights" / "a.kml"
        assert validate_output_dir(tmp_path / "out" / "data", [kml])[0] is False

    def test_aircraft_json_is_checked_too(self, tmp_path):
        kml = tmp_path / "input" / "a.kml"
        aircraft = tmp_path / "out" / "data" / "aircraft.json"
        assert (
            validate_output_dir(tmp_path / "out" / "data", [kml, aircraft])[0] is False
        )

    def test_relative_paths_are_resolved(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        assert validate_output_dir("data", ["data/a.kml"])[0] is False
        assert validate_output_dir("out/data", ["input/a.kml"])[0] is True

    def test_no_inputs(self, tmp_path):
        assert validate_output_dir(tmp_path / "data", []) == (True, None)
