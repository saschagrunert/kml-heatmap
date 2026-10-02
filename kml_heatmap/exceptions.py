"""Custom exceptions for KML Heatmap Generator.

The command line tells three kinds of failure apart by its exit status (see
``cli.main``): a problem with what it was given (``InvalidInputError``,
``OutputRefusedError``: 2), a build that failed on the way (``ExportError``
and every other ``KMLHeatmapError``: 1).
"""

__all__ = [
    "AirportDatabaseError",
    "ExportError",
    "InvalidInputError",
    "KMLHeatmapError",
    "KMLParseError",
    "OutputRefusedError",
    "TerrainUnavailableError",
]


class KMLHeatmapError(Exception):
    """Base exception for all KML Heatmap errors."""


class InvalidInputError(KMLHeatmapError):
    """The inputs cannot make a site: a missing, invalid or empty KML file."""


class OutputRefusedError(KMLHeatmapError):
    """The output directory must not be written (see ``validation``)."""


class ExportError(KMLHeatmapError):
    """Writing the site failed on the way (a full disk, a worker that died)."""


class AirportDatabaseError(KMLHeatmapError):
    """Raised when a required airport database cannot be loaded."""


class TerrainUnavailableError(KMLHeatmapError):
    """Raised when required elevation tiles cannot be fetched or decoded."""


class KMLParseError(KMLHeatmapError):
    """Raised when KML parsing fails.

    The file and the line are kept as attributes, and the message does not
    repeat them: whoever reports the error names the file (see
    ``renderer``), and the message of lxml already holds both.
    """

    def __init__(
        self,
        message: str,
        file_path: str | None = None,
        line_number: int | None = None,
    ):
        self.file_path = file_path
        self.line_number = line_number
        super().__init__(message)
