"""
KML Heatmap Generator

A tool for creating interactive heatmap visualizations from KML flight data.
"""

__version__ = "1.0.0"

# Export key functions
from .aircraft import lookup_aircraft_model, parse_aircraft_from_filename
from .airports import deduplicate_airports, extract_airport_name
from .exceptions import (
    InvalidCoordinateError,
    KMLHeatmapError,
    KMLParseError,
)
from .geometry import haversine_distance
from .parser import parse_kml_coordinates
from .parser_common import is_mid_flight_start, is_valid_landing
from .renderer import load_template, minify_html
from .statistics import calculate_statistics
from .validation import (
    validate_altitude,
    validate_api_keys,
    validate_coordinates,
    validate_kml_file,
)

__all__ = [
    "InvalidCoordinateError",
    "KMLHeatmapError",
    "KMLParseError",
    "calculate_statistics",
    "deduplicate_airports",
    "extract_airport_name",
    "haversine_distance",
    "is_mid_flight_start",
    "is_valid_landing",
    "load_template",
    "lookup_aircraft_model",
    "minify_html",
    "parse_aircraft_from_filename",
    "parse_kml_coordinates",
    "validate_altitude",
    "validate_api_keys",
    "validate_coordinates",
    "validate_kml_file",
]
