"""Cache directory management and atomic file writes for kml-heatmap."""

import contextlib
import json
import os
import tempfile
from pathlib import Path
from typing import IO, TYPE_CHECKING, Any

from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = [
    "CACHE_DIR",
    "REGULAR_FILE_MODE",
    "atomic_data_write",
    "atomic_json_write",
    "atomic_text_write",
    "atomic_write",
]


def _default_cache_dir() -> Path:
    """~/.cache/kml-heatmap, or a temp directory when there is no home."""
    try:
        return Path.home() / ".cache" / "kml-heatmap"
    except RuntimeError:  # no HOME and no passwd entry (containers)
        return Path(tempfile.gettempdir()) / "kml-heatmap-cache"


_cache_dir_env = os.environ.get("KML_HEATMAP_CACHE_DIR")
CACHE_DIR = Path(_cache_dir_env) if _cache_dir_env else _default_cache_dir()


def _regular_file_mode() -> int:
    """The mode a plain ``open(path, "w")`` would give a new file.

    Reading the umask means setting it, which briefly changes the mode of
    every file another thread creates in the meantime. It is therefore read
    once at import, before any pool or thread exists.
    """
    umask = os.umask(0)
    os.umask(umask)
    return 0o666 & ~umask


REGULAR_FILE_MODE = _regular_file_mode()


def atomic_write(path: Path, write: Callable[[IO[str]], object]) -> None:
    """Write a text file atomically through a temp file in the same directory.

    ``write`` receives the open temp file. The temp file is created with mode
    0600, which is what NamedTemporaryFile does; the finished file gets the
    mode a regular write would have produced, so a generated site stays
    readable for a web server running as another user. The temp file is
    removed when anything fails.
    """
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
            encoding="utf-8",
        ) as tmp:
            tmp_path = tmp.name
            write(tmp)
        os.chmod(tmp_path, REGULAR_FILE_MODE)
        os.replace(tmp_path, path)
        tmp_path = None
    finally:
        if tmp_path is not None:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)


def atomic_text_write(path: Path, content: str) -> None:
    """Write ``content`` to ``path`` atomically."""
    atomic_write(path, lambda tmp: tmp.write(content))


def atomic_data_write(path: Path, data: Any, *, sort_keys: bool = False) -> None:
    """Write a data file of the site as compact JSON atomically."""
    # One dumps call uses the C encoder; dump streams through the much
    # slower pure-Python one
    content = json.dumps(data, separators=(",", ":"), sort_keys=sort_keys)
    atomic_write(path, lambda tmp: tmp.write(content))


def atomic_json_write(path: Path, data: Any) -> None:
    """Write a cache file as compact JSON atomically; failures are logged only."""
    try:
        content = json.dumps(data, separators=(",", ":"))
        atomic_write(path, lambda tmp: tmp.write(content))
    except OSError as e:
        logger.debug("Failed to write cache file %s: %s", path, e)
