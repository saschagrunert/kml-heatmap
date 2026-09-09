"""Constants used throughout the KML Heatmap Generator."""

# === Unit Conversions ===
METERS_TO_FEET = 3.28084
FEET_TO_METERS = 1.0 / METERS_TO_FEET

# Nautical mile conversion (1 NM = exactly 1.852 km by definition)
NAUTICAL_MILES_TO_KM = 1.852
KM_TO_NAUTICAL_MILES = 1.0 / NAUTICAL_MILES_TO_KM

# Time conversion
SECONDS_PER_HOUR = 3600

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

# === XML/KML Namespaces ===
KML_NAMESPACE = "http://www.opengis.net/kml/2.2"
GX_NAMESPACE = "http://www.google.com/kml/ext/2.2"

KML_NAMESPACES = {"kml": KML_NAMESPACE, "gx": GX_NAMESPACE}

# === ICAO Region Prefixes ===
# Valid first letters of ICAO airport codes by region.
# Excludes I (not assigned), J (not assigned for airports),
# Q (reserved for non-geographic use), X (not assigned).
ICAO_REGION_PREFIXES = "ABCDEFGHKLMNOPRSTUVWYZ"
