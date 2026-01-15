"""Unified cache directory management for kml-heatmap.

This module provides a centralized cache directory configuration
for all caching needs (airports, aircraft, KML parsing, etc.).
"""

import os
from pathlib import Path

__all__ = ["CACHE_DIR"]

# Unified cache directory for all kml-heatmap data
# Use environment variable during testing to avoid writing to user's actual cache
if "KML_HEATMAP_TEST_CACHE" in os.environ:
    CACHE_DIR = Path(os.environ["KML_HEATMAP_TEST_CACHE"])
else:
    CACHE_DIR = Path.home() / ".cache" / "kml-heatmap"
