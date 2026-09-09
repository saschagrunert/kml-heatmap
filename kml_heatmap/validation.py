"""Input validation utilities."""

import os
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable

MAX_KML_FILE_SIZE = 100 * 1024 * 1024  # 100 MB

__all__ = [
    "validate_kml_file",
    "validate_output_dir",
]


def validate_kml_file(file_path: str) -> tuple[bool, str | None]:
    """Validate KML file exists and is readable."""
    path = Path(file_path)

    if path.is_symlink():
        return False, f"Symlinks are not allowed: {file_path}"

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


def validate_output_dir(
    data_dir: str | Path, input_paths: Iterable[str | Path]
) -> tuple[bool, str | None]:
    """Refuse output data directories that overlap with any input directory.

    The output data directory must not equal, contain, or be contained in the
    parent directory of any input file (KML files or aircraft.json), because
    tool-owned files inside it are removed before every export.
    """
    output = Path(data_dir).resolve()

    for input_path in input_paths:
        parent = Path(input_path).resolve().parent
        if output == parent or output in parent.parents or parent in output.parents:
            message = (
                f"Refusing to use output data directory '{output}': it overlaps "
                f"with the input directory '{parent}'. Choose a different "
                "--output-dir."
            )
            return False, message

    return True, None
