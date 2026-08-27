"""Input validation utilities."""

import os
from pathlib import Path

MAX_KML_FILE_SIZE = 100 * 1024 * 1024  # 100 MB

__all__ = [
    "validate_kml_file",
]


def validate_kml_file(file_path: str) -> tuple[bool, str | None]:
    """Validate KML file exists and is readable."""
    path = Path(file_path)

    if not path.exists():
        return False, f"File not found: {file_path}"

    if not path.is_file():
        return False, f"Not a file: {file_path}"

    if not os.access(path, os.R_OK):
        return False, f"File not readable: {file_path}"

    if not str(path).lower().endswith(".kml"):
        return False, f"File does not have .kml extension: {file_path}"

    file_size = path.stat().st_size
    if file_size == 0:
        return False, f"File is empty: {file_path}"

    if file_size > MAX_KML_FILE_SIZE:
        size_mb = file_size / 1024 / 1024
        max_mb = MAX_KML_FILE_SIZE / 1024 / 1024
        return (
            False,
            f"File too large ({size_mb:.1f} MB, max {max_mb:.0f} MB): {file_path}",
        )

    return True, None
