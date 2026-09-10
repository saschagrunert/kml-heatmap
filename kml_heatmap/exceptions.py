"""Custom exceptions for KML Heatmap Generator."""

__all__ = [
    "KMLHeatmapError",
    "KMLParseError",
]


class KMLHeatmapError(Exception):
    """Base exception for all KML Heatmap errors."""


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
        if self.line_number is not None:
            parts.append(f"Line: {self.line_number}")
        return " | ".join(parts)
