"""Unified cache directory management for kml-heatmap.

This module provides a centralized cache directory configuration
for all caching needs (airports, aircraft, KML parsing, etc.).
"""

from pathlib import Path

__all__ = ["CACHE_DIR"]

# Unified cache directory for all kml-heatmap data
CACHE_DIR = Path.home() / ".cache" / "kml-heatmap"
