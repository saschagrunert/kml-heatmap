"""
KML Heatmap Generator

A tool for creating interactive heatmap visualizations from KML flight data.

Submodules are imported lazily so that ``python -m kml_heatmap --help`` and
``--version`` work without the optional runtime dependencies installed.
"""

import importlib
from typing import Any

__version__ = "1.0.0"

_LAZY_EXPORTS = {
    "KMLHeatmapError": ".exceptions",
    "KMLParseError": ".exceptions",
    "build_statistics": ".statistics",
    "check_kml_obfuscated": ".obfuscate",
    "create_progressive_heatmap": ".renderer",
    "deduplicate_airports": ".airports",
    "extract_airport_name": ".airports",
    "haversine_distance": ".geometry",
    "lookup_aircraft_model": ".aircraft",
    "obfuscate_kml_files": ".obfuscate",
    "parse_aircraft_from_filename": ".aircraft",
    "parse_kml_coordinates": ".parser",
    "validate_kml_file": ".validation",
}

__all__ = ["__version__", *sorted(_LAZY_EXPORTS)]


def __getattr__(name: str) -> Any:
    module_name = _LAZY_EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module = importlib.import_module(module_name, __name__)
    return getattr(module, name)
