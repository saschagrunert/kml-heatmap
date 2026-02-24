"""Aircraft registration and model lookup functionality."""

import os
import re
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser
from typing import Dict, List, Optional

from .cache import CACHE_DIR, locked_json_read_write
from .logger import logger

# Minimum delay between HTTP requests to avoid overloading the server
_REQUEST_DELAY_SECONDS = 1.0
_last_request_time = 0.0

__all__ = [
    "AircraftDataParser",
    "lookup_aircraft_model",
    "parse_aircraft_from_filename",
]

# Aircraft cache file
AIRCRAFT_CACHE_FILE = CACHE_DIR / "aircraft.json"


class AircraftDataParser(HTMLParser):
    """HTML parser to extract aircraft model from airport-data.com"""

    def __init__(self) -> None:
        """Initialize the parser with default state."""
        super().__init__()
        self.in_title = False
        self.model: Optional[str] = None

    def handle_starttag(self, tag: str, attrs: List[tuple]) -> None:
        """Handle opening HTML tags.

        Args:
            tag: HTML tag name
            attrs: List of (attribute, value) tuples
        """
        if tag == "title":
            self.in_title = True

    def handle_data(self, data: str) -> None:
        """Handle text data within HTML tags.

        Extracts aircraft model from title tag in both old and new formats:
        - New: "Aircraft Data D-EAGJ, Diamond DA-20A-1 Katana C/N 10115, ..."
        - Old: "Aircraft info for D-EAGJ - 2001 Diamond DA-20A-1 Katana"

        When multiple aircraft are listed (e.g., re-registrations), prefers
        the one without "C/N Not found" as it's likely the current aircraft.

        Args:
            data: Text content from HTML
        """
        if self.in_title:
            # New format: "Aircraft Data D-EAGJ, Diamond DA-20A-1 Katana C/N 10115, ..."
            if "Aircraft Data" in data:
                # Split by comma to get all aircraft (not limiting to 2 splits)
                parts = data.split(",")
                if len(parts) >= 2:
                    # Extract all aircraft models (skip first part which is "Aircraft Data REG")
                    aircraft_models = []
                    for i in range(1, len(parts)):
                        part = parts[i].strip()
                        # Skip if empty or looks like just a registration
                        if not part or part.startswith(("C/N", "D-", "OE-", "N-")):
                            continue

                        # Extract model before C/N if present
                        model = part
                        if " C/N " in model:
                            cn_info = model.split(" C/N ", 1)[1]
                            model = model.split(" C/N ")[0].strip()
                            # Store tuple of (model, has_cn_not_found)
                            has_not_found = "Not found" in cn_info
                            aircraft_models.append((model, has_not_found))
                        else:
                            aircraft_models.append((model, False))

                    # Prefer aircraft WITH "C/N Not found" (current registration, C/N not yet documented)
                    # Otherwise take the last one (most recent)
                    if aircraft_models:
                        current = [m for m, nf in aircraft_models if nf]
                        if current:
                            self.model = current[
                                -1
                            ]  # Take last aircraft with "Not found"
                        else:
                            self.model = aircraft_models[-1][0]  # Take last aircraft
            # Old format: "Aircraft info for D-EAGJ - 2001 Diamond DA-20A-1 Katana"
            elif "Aircraft info for" in data:
                parts = data.split(" - ", 1)
                if len(parts) > 1:
                    # Remove year prefix if present (e.g., "2001 Diamond DA-20A-1 Katana")
                    model = parts[1].strip()
                    model = re.sub(r"^\d{4}\s+", "", model)
                    self.model = model

    def handle_endtag(self, tag: str) -> None:
        """Handle closing HTML tags.

        Args:
            tag: HTML tag name
        """
        if tag == "title":
            self.in_title = False


def _fetch_aircraft_model(registration: str) -> Optional[str]:
    """Fetch aircraft model from airport-data.com with rate limiting.

    Args:
        registration: Aircraft registration (e.g., 'D-EAGJ')

    Returns:
        Aircraft model string, or None if not found or on error.

    Raises:
        _SkipCache: When the result should not be cached (transient errors).
    """
    global _last_request_time

    # Rate-limit: wait at least _REQUEST_DELAY_SECONDS between requests
    elapsed = time.monotonic() - _last_request_time
    if elapsed < _REQUEST_DELAY_SECONDS:
        time.sleep(_REQUEST_DELAY_SECONDS - elapsed)

    model = None
    try:
        url = f"https://airport-data.com/aircraft/{registration}.html"
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "kml-heatmap/1.0 (aircraft model lookup)",
            },
        )
        _last_request_time = time.monotonic()

        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode("utf-8")

        parser = AircraftDataParser()
        parser.feed(html)

        if parser.model:
            model = parser.model
    except urllib.error.HTTPError as e:
        if e.code == 404:
            pass  # Will cache as None
        elif e.code == 429:
            logger.warning(f"Rate limited by aircraft database for {registration}")
            raise _SkipCache()
        else:
            logger.warning(f"HTTP error {e.code} looking up {registration}: {e.reason}")
    except urllib.error.URLError as e:
        logger.warning(f"Network error looking up {registration}: {e.reason}")
        raise _SkipCache()
    except TimeoutError:
        logger.warning(f"Timeout looking up {registration} (server did not respond)")
        raise _SkipCache()
    except Exception as e:
        logger.warning(
            f"Unexpected error looking up {registration}: {type(e).__name__}: {e}"
        )
        raise _SkipCache()

    return model


class _SkipCache(Exception):
    """Raised when a lookup result should not be cached (transient error)."""


def lookup_aircraft_model(registration: str) -> Optional[str]:
    """Look up aircraft model, using cache and optional web lookup.

    Set the environment variable ``KML_HEATMAP_SKIP_AIRCRAFT_LOOKUP=1``
    to disable web lookups entirely (cache-only mode).

    Args:
        registration: Aircraft registration (e.g., 'D-EAGJ')

    Returns:
        Full aircraft model name or None if not found
    """
    cache_file = AIRCRAFT_CACHE_FILE
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    skip_lookup = os.environ.get("KML_HEATMAP_SKIP_AIRCRAFT_LOOKUP", "") == "1"

    with locked_json_read_write(cache_file) as (cache, _existed):
        # Check cache
        if registration in cache:
            cached_value: Optional[str] = cache[registration]
            if cached_value is not None:
                return cached_value

        if skip_lookup:
            return None

        try:
            model = _fetch_aircraft_model(registration)
        except _SkipCache:
            return None

        # Update cache with result (including None for 404s)
        cache[registration] = model

    return model


def parse_aircraft_from_filename(filename: str) -> Dict[str, str | None]:
    """
    Parse aircraft information from KML filename.

    Supports two formats:
    1. SkyDemon: YYYYMMDD_HHMM_AIRPORT_REGISTRATION_TYPE.kml
       Example: 20250822_1013_EDAV_DEHYL_DA40.kml
    2. Charterware: YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE.kml
       Example: 2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml

    Args:
        filename: KML filename (without path)

    Returns:
        Dict with keys: 'registration', 'type' (optional), 'route' (optional), 'format'
        Returns empty dict if parsing fails
    """
    # Remove .kml extension
    name = filename.replace(".kml", "")

    # Split by underscore
    parts = name.split("_")

    # Charterware format detection: date has hyphens (YYYY-MM-DD)
    if len(parts) >= 3 and "-" in parts[0]:
        # Format: YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE
        # Example: 2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml
        if len(parts) >= 4:
            registration = parts[2]  # Already has hyphen (OE-AKI)
            route = parts[3] if len(parts) > 3 else None

            return {
                "registration": registration,
                "type": None,  # Charterware doesn't include type in filename
                "route": route if route else None,  # DEPARTURE-ARRIVAL format
                "format": "charterware",
            }

    # SkyDemon format: YYYYMMDD_HHMM_AIRPORT_REGISTRATION_TYPE
    elif len(parts) >= 5:
        # Format: DATE_TIME_AIRPORT_REGISTRATION_TYPE
        registration_raw = parts[3]
        aircraft_type = parts[4]

        # Format registration: if starts with D, insert hyphen after first char (D-EXXX)
        registration = registration_raw
        if registration_raw.startswith("D") and len(registration_raw) > 1:
            registration = registration_raw[0] + "-" + registration_raw[1:]

        return {
            "registration": registration,
            "type": aircraft_type,
            "format": "skydemon",
        }

    return {}
