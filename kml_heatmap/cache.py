"""Unified cache directory management for kml-heatmap."""

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .logger import logger

__all__ = ["CACHE_DIR", "atomic_json_write"]

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
