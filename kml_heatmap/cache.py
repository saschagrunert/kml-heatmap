"""Unified cache directory management for kml-heatmap."""

import contextlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .logger import logger

__all__ = ["CACHE_DIR", "atomic_js_write", "atomic_json_write"]


def _default_cache_dir() -> Path:
    """~/.cache/kml-heatmap, or a temp directory when there is no home."""
    try:
        return Path.home() / ".cache" / "kml-heatmap"
    except RuntimeError:  # no HOME and no passwd entry (containers)
        return Path(tempfile.gettempdir()) / "kml-heatmap-cache"


_cache_dir_env = os.environ.get("KML_HEATMAP_CACHE_DIR")
CACHE_DIR = Path(_cache_dir_env) if _cache_dir_env else _default_cache_dir()


def atomic_js_write(
    path: Path, var_name: str, data: Any, *, sort_keys: bool = False
) -> None:
    """Write ``window.<var_name> = <json>;`` atomically."""
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            dir=path.parent,
            suffix=".tmp",
            delete=False,
            encoding="utf-8",
        ) as tmp:
            tmp_path = tmp.name
            tmp.write(f"window.{var_name} = ")
            json.dump(data, tmp, separators=(",", ":"), sort_keys=sort_keys)
            tmp.write(";")
        os.replace(tmp_path, str(path))
        tmp_path = None
    finally:
        if tmp_path is not None:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)


def atomic_json_write(path: Path, data: Any, directory: Path) -> None:
    """Write JSON data to a file atomically using temp-file + rename."""
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", dir=directory, suffix=".tmp", delete=False, encoding="utf-8"
        ) as tmp:
            tmp_path = tmp.name
            json.dump(data, tmp, separators=(",", ":"))
        os.replace(tmp_path, str(path))
        tmp_path = None
    except OSError as e:
        logger.debug("Failed to write cache file %s: %s", path, e)
    finally:
        if tmp_path is not None:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)
