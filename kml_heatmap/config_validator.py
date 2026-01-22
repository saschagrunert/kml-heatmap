"""Configuration validation for KML Heatmap Generator.

This module validates the runtime environment and configuration to ensure
the application can run successfully. It checks:

1. File System:
   - Input directories exist and are readable
   - Output directories are writable
   - Required files are present

2. Dependencies:
   - Required Python packages are installed
   - Correct versions if version-sensitive

3. API Keys:
   - Optional keys are validated if provided
   - Warnings for missing optional keys

4. System Resources:
   - Sufficient disk space for output
   - Memory availability for large datasets

The validation happens early at startup to fail fast with clear error
messages rather than cryptic failures deep in processing.
"""

import os
from pathlib import Path
from typing import List, Optional, Tuple

from .exceptions import ConfigurationError
from .logger import logger


class ConfigValidator:
    """Validates runtime configuration and environment."""

    def __init__(self) -> None:
        """Initialize the validator with empty error and warning lists."""
        self.errors: List[str] = []
        self.warnings: List[str] = []

    def validate_all(
        self,
        input_path: str,
        output_dir: str,
        stadia_key: Optional[str] = None,
        openaip_key: Optional[str] = None,
    ) -> Tuple[bool, List[str], List[str]]:
        """
        Run all validation checks.

        Args:
            input_path: Path to input KML file or directory
            output_dir: Path to output directory
            stadia_key: Optional Stadia Maps API key
            openaip_key: Optional OpenAIP API key

        Returns:
            Tuple of (is_valid, errors, warnings)
        """
        self.errors = []
        self.warnings = []

        self._validate_input_path(input_path)
        self._validate_output_dir(output_dir)
        self._validate_api_keys(stadia_key, openaip_key)
        self._validate_dependencies()
        self._validate_disk_space(output_dir)

        return len(self.errors) == 0, self.errors, self.warnings

    def _validate_input_path(self, input_path: str) -> None:
        """Validate input KML file or directory."""
        path = Path(input_path)

        if not path.exists():
            self.errors.append(f"Input path does not exist: {input_path}")
            return

        if path.is_file():
            if not path.suffix.lower() == ".kml":
                self.warnings.append(
                    f"Input file doesn't have .kml extension: {input_path}"
                )
            if path.stat().st_size == 0:
                self.errors.append(f"Input file is empty: {input_path}")
            elif path.stat().st_size > 100 * 1024 * 1024:  # 100MB
                self.warnings.append(
                    f"Large input file ({path.stat().st_size / 1024 / 1024:.1f} MB), "
                    "processing may be slow"
                )

        elif path.is_dir():
            kml_files = list(path.glob("**/*.kml"))
            if not kml_files:
                self.errors.append(f"No .kml files found in directory: {input_path}")
            elif len(kml_files) > 1000:
                self.warnings.append(
                    f"Large number of KML files ({len(kml_files)}), "
                    "processing may take a while"
                )

        # Check read permissions
        if not os.access(path, os.R_OK):
            self.errors.append(f"No read permission for: {input_path}")

    def _validate_output_dir(self, output_dir: str) -> None:
        """Validate output directory."""
        path = Path(output_dir)

        # Create if doesn't exist
        if not path.exists():
            try:
                path.mkdir(parents=True, exist_ok=True)
                logger.info(f"Created output directory: {output_dir}")
            except OSError as e:
                self.errors.append(f"Cannot create output directory {output_dir}: {e}")
                return

        if not path.is_dir():
            self.errors.append(f"Output path is not a directory: {output_dir}")
            return

        # Check write permissions
        if not os.access(path, os.W_OK):
            self.errors.append(f"No write permission for: {output_dir}")

    def _validate_api_keys(
        self, stadia_key: Optional[str], openaip_key: Optional[str]
    ) -> None:
        """Validate API keys if provided."""
        if stadia_key:
            if len(stadia_key) < 20:
                self.warnings.append("Stadia API key seems too short, might be invalid")
        else:
            self.warnings.append(
                "STADIA_API_KEY not set - map tiles will use fallback provider"
            )

        if openaip_key:
            if len(openaip_key) < 20:
                self.warnings.append(
                    "OpenAIP API key seems too short, might be invalid"
                )
        else:
            self.warnings.append(
                "OPENAIP_API_KEY not set - aviation data layer will be disabled"
            )

    def _validate_dependencies(self) -> None:
        """Check required Python packages are installed."""
        required_packages = {
            "folium": "Map generation",
            "numpy": "Numerical operations",
        }

        optional_packages = {
            "lxml": "Faster XML parsing (falls back to standard library)",
        }

        for package, purpose in required_packages.items():
            try:
                __import__(package)
            except ImportError:
                self.errors.append(
                    f"Required package '{package}' not installed ({purpose}). "
                    f"Run: pip install {package}"
                )

        for package, purpose in optional_packages.items():
            try:
                __import__(package)
            except ImportError:
                self.warnings.append(
                    f"Optional package '{package}' not installed ({purpose})"
                )

    def _validate_disk_space(self, output_dir: str, min_mb: int = 100) -> None:
        """Check sufficient disk space for output."""
        try:
            path = Path(output_dir)
            stat = os.statvfs(path if path.exists() else path.parent)
            # Available space in MB
            available_mb = (stat.f_bavail * stat.f_frsize) / (1024 * 1024)

            if available_mb < min_mb:
                self.warnings.append(
                    f"Low disk space: {available_mb:.1f} MB available "
                    f"(recommended: {min_mb} MB+)"
                )
        except (OSError, AttributeError):
            # statvfs not available on all platforms
            pass


def validate_environment(
    input_path: str,
    output_dir: str,
    stadia_key: Optional[str] = None,
    openaip_key: Optional[str] = None,
    fail_on_warnings: bool = False,
) -> None:
    """
    Validate environment and raise exception if invalid.

    Args:
        input_path: Input KML file or directory path
        output_dir: Output directory path
        stadia_key: Optional Stadia Maps API key
        openaip_key: Optional OpenAIP API key
        fail_on_warnings: If True, treat warnings as errors

    Raises:
        ConfigurationError: If validation fails

    Example:
        >>> try:
        ...     validate_environment('/path/to/kml', 'output')
        ... except ConfigurationError as e:
        ...     print(f"Configuration error: {e}")
        ...     sys.exit(1)
    """
    validator = ConfigValidator()
    is_valid, errors, warnings = validator.validate_all(
        input_path, output_dir, stadia_key, openaip_key
    )

    # Display warnings
    for warning in warnings:
        logger.warning(warning)

    # Check if we should fail
    if not is_valid or (fail_on_warnings and warnings):
        error_msg = "Configuration validation failed:\n"
        if errors:
            error_msg += "\nErrors:\n" + "\n".join(f"  • {err}" for err in errors)
        if fail_on_warnings and warnings:
            error_msg += "\nWarnings (treated as errors):\n" + "\n".join(
                f"  • {warn}" for warn in warnings
            )
        raise ConfigurationError(error_msg)

    if is_valid and not warnings:
        logger.info("✓ Configuration validation passed")
