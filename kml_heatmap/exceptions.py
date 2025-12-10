"""Custom exceptions for KML Heatmap Generator."""


class KMLHeatmapError(Exception):
    """Base exception for all KML Heatmap errors."""
    pass


class KMLParseError(KMLHeatmapError):
    """Raised when KML parsing fails."""
    pass


class AircraftLookupError(KMLHeatmapError):
    """Raised when aircraft lookup fails."""
    pass


class InvalidCoordinateError(KMLHeatmapError):
    """Raised when coordinate data is invalid."""
    pass
