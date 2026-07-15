"""Unified cache directory management for kml-heatmap."""

import json
import os
import tempfile
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

from .logger import logger

__all__ = ["CACHE_DIR", "atomic_json_write", "locked_json_read_write"]

if "KML_HEATMAP_TEST_CACHE" in os.environ:
    CACHE_DIR = Path(os.environ["KML_HEATMAP_TEST_CACHE"])
else:
    CACHE_DIR = Path.home() / ".cache" / "kml-heatmap"


def atomic_json_write(path: Path, data: Any, directory: Path) -> None:
    """Write JSON data to a file atomically using temp-file + rename."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", dir=directory, suffix=".tmp", delete=False
        ) as tmp:
            json.dump(data, tmp, separators=(",", ":"))
            tmp_path = tmp.name
        os.replace(tmp_path, str(path))
    except OSError as e:
        logger.debug(f"Failed to write cache file {path}: {e}")
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@contextmanager
def locked_json_read_write(
    path: Path,
) -> Generator[tuple[dict, bool], None, None]:
    """Context manager that acquires an exclusive lock on a JSON cache file.

    Yields a tuple of (data_dict, existed) where data_dict is the current
    contents (empty dict if file doesn't exist) and existed indicates whether
    the file was present.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        yield {}, False
        return

    lock_path = path.with_suffix(path.suffix + ".lock")

    if fcntl is None:  # pragma: no cover
        # Windows fallback: no file locking, concurrent processes may corrupt the cache
        data: dict = {}
        existed = False
        if path.exists():
            try:
                with open(path, "r") as f:
                    data = json.load(f)
                existed = True
            except (json.JSONDecodeError, OSError):
                data = {}

        yield data, existed
        atomic_json_write(path, data, path.parent)
        return

    lock_fd = open(lock_path, "w")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)

        data = {}
        existed = False
        if path.exists():
            try:
                with open(path, "r") as f:
                    data = json.load(f)
                existed = True
            except (json.JSONDecodeError, OSError):
                data = {}

        yield data, existed

        atomic_json_write(path, data, path.parent)
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()
        try:
            lock_path.unlink(missing_ok=True)
        except OSError:
            pass
