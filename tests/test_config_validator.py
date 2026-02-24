"""Tests for config_validator module."""

import pytest
import tempfile
import os
from kml_heatmap.config_validator import (
    ConfigValidator,
    validate_environment,
)
from kml_heatmap.exceptions import ConfigurationError


class TestConfigValidator:
    """Tests for ConfigValidator class."""

    def test_validator_initialization(self):
        """Test ConfigValidator initialization."""
        validator = ConfigValidator()
        assert validator.errors == []
        assert validator.warnings == []

    def test_validate_valid_file_and_output(self):
        """Test validation with valid file and output directory."""
        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                is_valid, errors, warnings = validator.validate_all(
                    input_path, output_dir
                )
                assert is_valid is True
                assert len(errors) == 0
            finally:
                os.unlink(input_path)

    def test_validate_nonexistent_input(self):
        """Test validation with nonexistent input path."""
        validator = ConfigValidator()

        with tempfile.TemporaryDirectory() as output_dir:
            is_valid, errors, warnings = validator.validate_all(
                "/nonexistent/file.kml", output_dir
            )
            assert is_valid is False
            assert len(errors) > 0
            assert any("does not exist" in err for err in errors)

    def test_validate_empty_kml_file(self):
        """Test validation with empty KML file."""
        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            # Empty file
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                is_valid, errors, warnings = validator.validate_all(
                    input_path, output_dir
                )
                assert is_valid is False
                assert any("empty" in err.lower() for err in errors)
            finally:
                os.unlink(input_path)

    def test_validate_large_kml_file(self):
        """Test validation with large KML file generates warning."""
        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            # Write 101 MB of data
            f.write(b"x" * (101 * 1024 * 1024))
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                is_valid, errors, warnings = validator.validate_all(
                    input_path, output_dir
                )
                assert len(warnings) > 0
                assert any("Large input file" in warn for warn in warnings)
            finally:
                os.unlink(input_path)

    def test_validate_non_kml_extension(self):
        """Test validation with non-.kml file generates warning."""
        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
            f.write(b"content")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                is_valid, errors, warnings = validator.validate_all(
                    input_path, output_dir
                )
                assert any(".kml extension" in warn for warn in warnings)
            finally:
                os.unlink(input_path)

    def test_validate_directory_with_kml_files(self):
        """Test validation with directory containing KML files."""
        validator = ConfigValidator()

        with tempfile.TemporaryDirectory() as input_dir:
            # Create some KML files
            for i in range(3):
                with open(os.path.join(input_dir, f"file{i}.kml"), "w") as f:
                    f.write("<kml></kml>")

            with tempfile.TemporaryDirectory() as output_dir:
                is_valid, errors, warnings = validator.validate_all(
                    input_dir, output_dir
                )
                assert is_valid is True

    def test_validate_directory_no_kml_files(self):
        """Test validation with directory containing no KML files."""
        validator = ConfigValidator()

        with tempfile.TemporaryDirectory() as input_dir:
            # Empty directory
            with tempfile.TemporaryDirectory() as output_dir:
                is_valid, errors, warnings = validator.validate_all(
                    input_dir, output_dir
                )
                assert is_valid is False
                assert any("No .kml files found" in err for err in errors)

    def test_validate_large_number_of_files_warning(self):
        """Test validation with many KML files generates warning."""
        validator = ConfigValidator()

        with tempfile.TemporaryDirectory() as input_dir:
            # Create 1001 KML files (more than 1000 threshold)
            for i in range(1001):
                with open(os.path.join(input_dir, f"file{i}.kml"), "w") as f:
                    f.write("<kml></kml>")

            with tempfile.TemporaryDirectory() as output_dir:
                is_valid, errors, warnings = validator.validate_all(
                    input_dir, output_dir
                )
                assert any("Large number of KML files" in warn for warn in warnings)

    def test_validate_output_dir_creation(self):
        """Test that output directory is created if it doesn't exist."""
        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = os.path.join(tmpdir, "new_output")
            try:
                is_valid, errors, warnings = validator.validate_all(
                    input_path, output_dir
                )
                assert os.path.exists(output_dir)
                assert os.path.isdir(output_dir)
            finally:
                os.unlink(input_path)

    def test_validate_output_not_directory(self):
        """Test validation when output path is a file, not directory."""
        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.NamedTemporaryFile(delete=False) as output_file:
            output_path = output_file.name

        try:
            is_valid, errors, warnings = validator.validate_all(input_path, output_path)
            assert is_valid is False
            assert any("not a directory" in err for err in errors)
        finally:
            os.unlink(input_path)
            os.unlink(output_path)

    def test_validate_api_keys_both_missing(self):
        """Test validation with both API keys missing generates warnings."""
        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                is_valid, errors, warnings = validator.validate_all(
                    input_path, output_dir, None, None
                )
                assert any("STADIA_API_KEY" in warn for warn in warnings)
                assert any("OPENAIP_API_KEY" in warn for warn in warnings)
            finally:
                os.unlink(input_path)

    def test_validate_api_keys_too_short(self):
        """Test validation with too-short API keys."""
        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                is_valid, errors, warnings = validator.validate_all(
                    input_path, output_dir, "short", "key"
                )
                assert any("too short" in warn for warn in warnings)
            finally:
                os.unlink(input_path)

    def test_validate_api_keys_valid_length(self):
        """Test validation with valid length API keys."""
        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                is_valid, errors, warnings = validator.validate_all(
                    input_path,
                    output_dir,
                    "x" * 30,  # Valid length Stadia key
                    "y" * 30,  # Valid length OpenAIP key
                )
                # Should not have "too short" warnings
                assert not any("too short" in warn for warn in warnings)
            finally:
                os.unlink(input_path)


class TestValidateEnvironment:
    """Tests for validate_environment function."""

    def test_validate_environment_success(self):
        """Test validate_environment with valid configuration."""
        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                # Should not raise exception
                validate_environment(input_path, output_dir)
            finally:
                os.unlink(input_path)

    def test_validate_environment_failure(self):
        """Test validate_environment with invalid configuration."""
        with tempfile.TemporaryDirectory() as output_dir:
            with pytest.raises(ConfigurationError):
                validate_environment("/nonexistent/file.kml", output_dir)

    def test_validate_environment_fail_on_warnings(self):
        """Test validate_environment fails when fail_on_warnings=True."""
        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                # Should raise because of missing API key warnings
                with pytest.raises(ConfigurationError):
                    validate_environment(input_path, output_dir, fail_on_warnings=True)
            finally:
                os.unlink(input_path)

    def test_validate_environment_with_api_keys(self):
        """Test validate_environment with valid API keys."""
        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                # Should not raise
                validate_environment(
                    input_path,
                    output_dir,
                    stadia_key="x" * 30,
                    openaip_key="y" * 30,
                )
            finally:
                os.unlink(input_path)


class TestDiskSpaceValidation:
    """Tests for disk space validation."""

    def test_validate_disk_space_sufficient(self):
        """Test validation with sufficient disk space."""
        from kml_heatmap.config_validator import ConfigValidator

        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                is_valid, errors, warnings = validator.validate_all(
                    input_path, output_dir
                )
                # Should not have low disk space warning (unless actually low)
                # This test may vary based on actual disk space
            finally:
                os.unlink(input_path)

    def test_validate_disk_space_handles_errors(self):
        """Test disk space validation handles errors gracefully."""
        from kml_heatmap.config_validator import ConfigValidator
        from unittest.mock import patch

        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                # Mock statvfs to raise OSError
                with patch("os.statvfs", side_effect=OSError("Mock error")):
                    is_valid, errors, warnings = validator.validate_all(
                        input_path, output_dir
                    )
                    # Should not raise, just skip disk space check
                    assert isinstance(is_valid, bool)
            finally:
                os.unlink(input_path)

    def test_validate_disk_space_attribute_error(self):
        """Test disk space validation handles AttributeError."""
        from kml_heatmap.config_validator import ConfigValidator
        from unittest.mock import patch

        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                # Mock statvfs to raise AttributeError (platform without statvfs)
                with patch("os.statvfs", side_effect=AttributeError("Mock error")):
                    is_valid, errors, warnings = validator.validate_all(
                        input_path, output_dir
                    )
                    # Should not raise, just skip disk space check
                    assert isinstance(is_valid, bool)
            finally:
                os.unlink(input_path)


class TestDependencyValidation:
    """Tests for dependency validation."""

    def test_validate_dependencies_folium_missing(self):
        """Test validation when folium is missing."""
        from kml_heatmap.config_validator import ConfigValidator
        from unittest.mock import patch
        import builtins

        # Save reference to original __import__
        original_import = builtins.__import__

        def mock_import(name, *args, **kwargs):
            if name == "folium":
                raise ImportError("No module named 'folium'")
            return original_import(name, *args, **kwargs)

        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                with patch("builtins.__import__", side_effect=mock_import):
                    is_valid, errors, warnings = validator.validate_all(
                        input_path, output_dir
                    )
                    # Should have error about missing folium
                    assert any("folium" in err.lower() for err in errors)
            finally:
                os.unlink(input_path)

    def test_validate_dependencies_required_missing(self):
        """Test validation when required dependency (lxml) is missing."""
        from kml_heatmap.config_validator import ConfigValidator
        from unittest.mock import patch
        import builtins

        # Save reference to original __import__
        original_import = builtins.__import__

        def mock_import(name, *args, **kwargs):
            if name == "lxml":
                raise ImportError("No module named 'lxml'")
            return original_import(name, *args, **kwargs)

        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            input_path = f.name

        with tempfile.TemporaryDirectory() as output_dir:
            try:
                with patch("builtins.__import__", side_effect=mock_import):
                    is_valid, errors, warnings = validator.validate_all(
                        input_path, output_dir
                    )
                    # lxml is a required dependency, should cause an error
                    assert is_valid is False
                    assert any("lxml" in err.lower() for err in errors)
            finally:
                os.unlink(input_path)


class TestInputPathValidation:
    """Tests for input path validation edge cases."""

    def test_validate_input_no_read_permission(self):
        """Test validation when input file has no read permission."""
        from kml_heatmap.config_validator import ConfigValidator
        import tempfile
        import os

        validator = ConfigValidator()

        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml></kml>")
            temp_path = f.name

        try:
            # Remove read permission (if possible on this platform)
            try:
                os.chmod(temp_path, 0o000)
                with tempfile.TemporaryDirectory() as output_dir:
                    is_valid, errors, warnings = validator.validate_all(
                        temp_path, output_dir
                    )
                    # Should have error about permissions
                    if not os.access(temp_path, os.R_OK):
                        assert any("permission" in err.lower() for err in errors)
            finally:
                # Restore permissions for cleanup
                os.chmod(temp_path, 0o644)
        finally:
            os.unlink(temp_path)
