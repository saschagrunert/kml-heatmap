"""Custom exceptions for KML Heatmap Generator."""

__all__ = [
    "KMLHeatmapError",
    "KMLParseError",
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

    def __init__(
        self,
        message: str,
        file_path: str | None = None,
        line_number: int | None = None,
    ):
        self.file_path = file_path
        self.line_number = line_number
        super().__init__(self._format_message(message))

    def _format_message(self, message: str) -> str:
        parts = [message]
        if self.file_path:
            parts.append(f"File: {self.file_path}")
        if self.line_number:
            parts.append(f"Line: {self.line_number}")
        return " | ".join(parts)


class InvalidCoordinateError(KMLHeatmapError):
    """Raised when coordinate data is invalid."""

    def __init__(
        self,
        message: str,
        latitude: float | None = None,
        longitude: float | None = None,
    ):
        self.latitude = latitude
        self.longitude = longitude
        super().__init__(self._format_message(message))

    def _format_message(self, message: str) -> str:
        if self.latitude is not None and self.longitude is not None:
            return f"{message} (lat: {self.latitude}, lon: {self.longitude})"
        return message


class DataExportError(KMLHeatmapError):
    """Raised when data export fails."""

    def __init__(self, message: str, output_path: str | None = None):
        self.output_path = output_path
        if output_path:
            message = f"{message} (Output: {output_path})"
        super().__init__(message)


class InvalidAltitudeError(KMLHeatmapError):
    """Raised when altitude data is invalid."""

    def __init__(self, message: str, altitude: float | None = None):
        self.altitude = altitude
        if altitude is not None:
            message = f"{message} (Altitude: {altitude}m)"
        super().__init__(message)


class ConfigurationError(KMLHeatmapError):
    """Raised when configuration is invalid."""

    def __init__(self, message: str, config_key: str | None = None):
        self.config_key = config_key
        if config_key:
            message = f"{message} (Key: {config_key})"
        super().__init__(message)
