"""Input validation utilities."""

import os
from pathlib import Path
from typing import TYPE_CHECKING

from .helpers import numeric_filename_key
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Iterable

MAX_KML_FILE_SIZE = 100 * 1024 * 1024  # 100 MB

__all__ = [
    "find_kml_files",
    "protected_directories",
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


def find_kml_files(directory: Path) -> list[Path]:
    """List the KML files of a directory tree, the one rule for every caller.

    The generator and the obfuscation pass (with its check) have to agree on
    which files a directory holds: a file the check never saw would otherwise
    be published with its real dates. Files match on the ``.kml`` extension in
    any case and are listed per directory in numeric order (``2_x.kml``
    before ``10_x.kml``), subdirectories after the files of their parent.
    Symlinks to files are listed so that the caller can refuse or skip them;
    symlinks to directories are not followed. A directory that cannot be
    listed yields no files.
    """
    try:
        entries = list(directory.iterdir())
    except OSError as e:
        logger.debug("Cannot list %s: %s", directory, e)
        return []

    kml_files = sorted(
        (
            path
            for path in entries
            if path.suffix.lower() == ".kml" and (path.is_file() or path.is_symlink())
        ),
        key=lambda path: numeric_filename_key(path.name),
    )
    for child in sorted(entries):
        if child.is_dir() and not child.is_symlink():
            kml_files.extend(find_kml_files(child))
    return kml_files


def protected_directories() -> tuple[Path, ...]:
    """Directories that must never be used as an output directory."""
    try:
        return (Path("/"), Path.home())
    except RuntimeError:  # no HOME and no passwd entry (containers)
        return (Path("/"),)


def validate_output_dir(
    output_dir: str | Path, input_paths: Iterable[str | Path]
) -> tuple[bool, str | None]:
    """Refuse output directories that overlap with any input directory.

    The output directory must not be, or contain, the parent directory of
    any input file (KML files or aircraft.json): a run replaces the
    tool-owned files in it, removes the ones it no longer produces and does
    the same below its ``data`` directory. The home directory and the root
    are refused for the same reason. An output directory below an input
    directory is fine: ``kml-heatmap flight.kml --output-dir out`` from the
    file's own directory writes to ``out/`` without touching the inputs.
    """
    output = Path(output_dir).resolve()

    if output in protected_directories():
        return False, f"Refusing to use dangerous output directory: {output_dir}"

    for input_path in input_paths:
        parent = Path(input_path).resolve().parent
        if output == parent or output in parent.parents:
            message = (
                f"Refusing to use output directory '{output}': it is, or "
                f"contains, the input directory '{parent}'. Choose a different "
                "--output-dir."
            )
            return False, message

    return True, None
