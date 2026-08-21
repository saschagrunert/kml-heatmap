"""Input validation utilities."""

import os
from pathlib import Path

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

    if path.stat().st_size == 0:
        return False, f"File is empty: {file_path}"

    return True, None
