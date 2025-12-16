"""
KML Heatmap Generator

A tool for creating interactive heatmap visualizations from KML flight data.
"""

__version__ = "1.0.0"

# Export key functions
from .geometry import haversine_distance, downsample_path_rdp, get_altitude_color
from .parser import parse_kml_coordinates, is_mid_flight_start, is_valid_landing
from .aircraft import lookup_aircraft_model, parse_aircraft_from_filename
from .airports import deduplicate_airports, extract_airport_name
from .statistics import calculate_statistics
from .renderer import minify_html, load_template
from .validation import (
    validate_coordinates,
    validate_kml_file,
    validate_api_keys,
    validate_altitude,
)
from .exceptions import (
    KMLHeatmapError,
    KMLParseError,
    AircraftLookupError,
    InvalidCoordinateError,
)
from .frontend_builder import (
    build_frontend,
    ensure_frontend_built,
    run_frontend_tests,
)

__all__ = [
    # Geometry
    "haversine_distance",
    "downsample_path_rdp",
    "get_altitude_color",
    # Parser
    "parse_kml_coordinates",
    "is_mid_flight_start",
    "is_valid_landing",
    # Aircraft
    "lookup_aircraft_model",
    "parse_aircraft_from_filename",
    # Airports
    "deduplicate_airports",
    "extract_airport_name",
    # Statistics
    "calculate_statistics",
    # Renderer
    "minify_html",
    "load_template",
    # Validation
    "validate_coordinates",
    "validate_kml_file",
    "validate_api_keys",
    "validate_altitude",
    # Exceptions
    "KMLHeatmapError",
    "KMLParseError",
    "AircraftLookupError",
    "InvalidCoordinateError",
    # Frontend
    "build_frontend",
    "ensure_frontend_built",
    "run_frontend_tests",
]
