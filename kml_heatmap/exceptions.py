"""Custom exceptions for KML Heatmap Generator."""

__all__ = [
    "KMLHeatmapError",
    "KMLParseError",
    "AircraftLookupError",
    "InvalidCoordinateError",
    "DataExportError",
    "InvalidAltitudeError",
    "ConfigurationError",
]


class KMLHeatmapError(Exception):
    """Base exception for all KML Heatmap errors."""

    pass


class KMLParseError(KMLHeatmapError):
    """Raised when KML parsing fails."""

    def __init__(self, message: str, file_path: str = None, line_number: int = None):
        self.file_path = file_path
        self.line_number = line_number
        super().__init__(self._format_message(message))

    def _format_message(self, message: str) -> str:
        """Format error message with file and line information."""
        parts = [message]
        if self.file_path:
            parts.append(f"File: {self.file_path}")
        if self.line_number:
            parts.append(f"Line: {self.line_number}")
        return " | ".join(parts)


class AircraftLookupError(KMLHeatmapError):
    """Raised when aircraft lookup fails."""

    def __init__(self, message: str, registration: str = None):
        self.registration = registration
        if registration:
            message = f"{message} (Registration: {registration})"
        super().__init__(message)


class InvalidCoordinateError(KMLHeatmapError):
    """Raised when coordinate data is invalid."""

    def __init__(self, message: str, latitude: float = None, longitude: float = None):
        self.latitude = latitude
        self.longitude = longitude
        super().__init__(self._format_message(message))

    def _format_message(self, message: str) -> str:
        """Format error message with coordinate information."""
        if self.latitude is not None and self.longitude is not None:
            return f"{message} (lat: {self.latitude}, lon: {self.longitude})"
        return message


class DataExportError(KMLHeatmapError):
    """Raised when data export fails."""

    def __init__(self, message: str, output_path: str = None):
        self.output_path = output_path
        if output_path:
            message = f"{message} (Output: {output_path})"
        super().__init__(message)


class InvalidAltitudeError(KMLHeatmapError):
    """Raised when altitude data is invalid."""

    def __init__(self, message: str, altitude: float = None):
        self.altitude = altitude
        if altitude is not None:
            message = f"{message} (Altitude: {altitude}m)"
        super().__init__(message)


class ConfigurationError(KMLHeatmapError):
    """Raised when configuration is invalid."""

    def __init__(self, message: str, config_key: str = None):
        self.config_key = config_key
        if config_key:
            message = f"{message} (Key: {config_key})"
        super().__init__(message)
