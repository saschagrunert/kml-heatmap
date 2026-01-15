"""Constants used throughout the KML Heatmap Generator.

This module centralizes all magic numbers and configuration constants used
across the application. By keeping constants in one place, we ensure:
- Consistency across the codebase
- Easy adjustment of thresholds and limits
- Clear documentation of what each value represents
- Mathematical relationships between related constants

Categories:
- Unit Conversions: Standard unit conversion factors
- Groundspeed Calculations: Thresholds for speed calculations
- Altitude Thresholds: Limits for cruise/landing detection
- Validation Ranges: Min/max bounds for coordinate validation
- Airport Detection: Spatial thresholds for deduplication
- Path Sampling: Sample sizes for altitude analysis
- Mid-Flight Detection: Criteria for detecting non-ground starts
- Landing Detection: Criteria for valid landing endpoints
- Resolution Levels: Multi-resolution export configuration
- Heatmap Configuration: Visual styling parameters
"""

# === Unit Conversions ===
METERS_TO_FEET = 3.28084
FEET_TO_METERS = 1.0 / METERS_TO_FEET

# Nautical mile conversion (1 NM = exactly 1.852 km by definition)
NAUTICAL_MILES_TO_KM = 1.852
KM_TO_NAUTICAL_MILES = 1.0 / NAUTICAL_MILES_TO_KM

# Time conversion
SECONDS_PER_HOUR = 3600
BYTES_PER_KB = 1024

# === Groundspeed Calculations ===
MAX_GROUNDSPEED_KNOTS = 200  # Reasonable max for typical general aviation
MIN_SEGMENT_TIME_SECONDS = 0.1  # Avoid division by very small time differences
SPEED_WINDOW_SECONDS = 120  # 2 minute rolling average window for speed calculation

# === Altitude Thresholds ===
CRUISE_ALTITUDE_THRESHOLD_FT = 1000  # AGL threshold for cruise altitude calculations
ALTITUDE_BIN_SIZE_FT = 100  # Bin size for altitude histograms

# === Validation Ranges ===
LAT_MIN = -90.0
LAT_MAX = 90.0
LON_MIN = -180.0
LON_MAX = 180.0
ALT_MIN_M = -1000.0  # Below sea level limit
ALT_MAX_M = 50000.0  # Upper atmosphere limit

# === Airport Detection ===
AIRPORT_DISTANCE_THRESHOLD_KM = 1.5  # Distance threshold for deduplicating airports
AIRPORT_GRID_SIZE_DEGREES = (
    0.018  # Grid cell size in degrees (~2km at equator) for spatial indexing
)

# === Path Sampling ===
PATH_SAMPLE_MAX_SIZE = 50  # Maximum sample size for path analysis
PATH_SAMPLE_MIN_SIZE = 5  # Minimum sample size for path analysis

# === Mid-Flight Detection ===
MID_FLIGHT_MIN_ALTITUDE_M = 400  # Minimum altitude to consider mid-flight start
MID_FLIGHT_MAX_VARIATION_M = 100  # Maximum altitude variation for stable flight

# === Landing Detection ===
LANDING_MAX_VARIATION_M = 50  # Maximum altitude variation for stable landing
LANDING_MAX_ALTITUDE_M = 600  # Maximum altitude for valid landing endpoint
LANDING_FALLBACK_ALTITUDE_M = 1000  # Fallback altitude threshold for short paths

# === Data Export Resolution Levels ===
RESOLUTION_LEVELS = {
    "z0_4": {
        "factor": 15,
        "epsilon": 0.0008,
        "description": "Zoom 0-4 (continent level)",
    },
    "z5_7": {
        "factor": 10,
        "epsilon": 0.0004,
        "description": "Zoom 5-7 (country level)",
    },
    "z8_10": {
        "factor": 5,
        "epsilon": 0.0002,
        "description": "Zoom 8-10 (regional level)",
    },
    "z11_13": {
        "factor": 2,
        "epsilon": 0.0001,
        "description": "Zoom 11-13 (city level)",
    },
    "z14_plus": {"factor": 1, "epsilon": 0, "description": "Zoom 14+ (full detail)"},
}

# Target maximum points per resolution (for adaptive downsampling)
# These limits ensure reasonable file sizes regardless of dataset size
TARGET_POINTS_PER_RESOLUTION = {
    "z14_plus": 500_000,  # ~40MB per year max
    "z11_13": 100_000,  # ~8MB per year max
    "z8_10": 50_000,  # ~4MB per year max
    "z5_7": 25_000,  # ~2MB per year max
    "z0_4": 10_000,  # ~800KB per year max
}

# === Heatmap Configuration ===
HEATMAP_GRADIENT = {0.0: "blue", 0.3: "cyan", 0.5: "lime", 0.7: "yellow", 1.0: "red"}

# === XML/KML Namespaces ===
KML_NAMESPACE = "http://www.opengis.net/kml/2.2"
GX_NAMESPACE = "http://www.google.com/kml/ext/2.2"

KML_NAMESPACES = {"kml": KML_NAMESPACE, "gx": GX_NAMESPACE}

# === File Size Limits ===
LARGE_FILE_WARNING_MB = 100  # Warn if input file exceeds this size
MAX_KML_FILES_WARNING = 1000  # Warn if processing this many files
