"""Aircraft registration and model lookup functionality."""

import json
import re
import urllib.request
import urllib.error
from html.parser import HTMLParser
from typing import Optional, Dict, List

from .cache import CACHE_DIR
from .logger import logger

__all__ = [
    "AircraftDataParser",
    "lookup_aircraft_model",
    "parse_aircraft_from_filename",
]

# Aircraft cache file
AIRCRAFT_CACHE_FILE = CACHE_DIR / "aircraft.json"


class AircraftDataParser(HTMLParser):
    """HTML parser to extract aircraft model from airport-data.com"""

    def __init__(self):
        super().__init__()
        self.in_title = False
        self.model = None

    def handle_starttag(self, tag: str, attrs: List[tuple]) -> None:
        if tag == "title":
            self.in_title = True

    def handle_data(self, data: str) -> None:
        if self.in_title:
            # New format: "Aircraft Data D-EAGJ, Diamond DA-20A-1 Katana C/N 10115, ..."
            if "Aircraft Data" in data:
                parts = data.split(",", 2)
                if len(parts) >= 2:
                    # Extract model from second part (before C/N if present)
                    model = parts[1].strip()
                    # Remove C/N and serial number if present
                    if " C/N " in model:
                        model = model.split(" C/N ")[0].strip()
                    self.model = model
            # Old format: "Aircraft info for D-EAGJ - 2001 Diamond DA-20A-1 Katana"
            elif "Aircraft info for" in data:
                parts = data.split(" - ", 1)
                if len(parts) > 1:
                    # Remove year prefix if present (e.g., "2001 Diamond DA-20A-1 Katana")
                    model = parts[1].strip()
                    model = re.sub(r"^\d{4}\s+", "", model)
                    self.model = model

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False


def lookup_aircraft_model(registration: str, cache_file: str = None) -> Optional[str]:
    """
    Look up aircraft model from airport-data.com

    Args:
        registration: Aircraft registration (e.g., 'D-EAGJ')
        cache_file: Path to JSON cache file (deprecated, uses unified cache)

    Returns:
        Full aircraft model name or None if not found
    """
    # Use unified cache directory
    if cache_file is None:
        cache_file = AIRCRAFT_CACHE_FILE
    else:
        # Support legacy cache_file parameter for backward compatibility
        from pathlib import Path

        cache_file = Path(cache_file)

    # Ensure cache directory exists
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Load cache
    cache = {}
    if cache_file.exists():
        try:
            with open(cache_file, "r") as f:
                cache = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            # Cache file is corrupted or unreadable, start with empty cache
            logger.warning(f"Could not load aircraft cache from {cache_file}: {e}")
            cache = {}

    # Check cache
    if registration in cache:
        cached_value = cache[registration]
        # Only use cache if we have a positive result
        # Retry if cached value is None (previous 404 or failure)
        if cached_value is not None:
            return cached_value

    # Fetch from airport-data.com
    model = None
    try:
        url = f"https://airport-data.com/aircraft/{registration}.html"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})

        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode("utf-8")

        parser = AircraftDataParser()
        parser.feed(html)

        if parser.model:
            model = parser.model
    except urllib.error.HTTPError as e:
        if e.code == 404:
            # Aircraft not found in database - cache the negative result
            pass
        elif e.code == 429:
            logger.warning(f"Rate limited by aircraft database for {registration}")
            # Don't cache rate limits - retry next time
            return None
        else:
            logger.warning(f"HTTP error {e.code} looking up {registration}: {e.reason}")
    except urllib.error.URLError as e:
        logger.warning(f"Network error looking up {registration}: {e.reason}")
        # Don't cache network errors - retry next time
        return None
    except TimeoutError:
        logger.warning(f"Timeout looking up {registration} (server did not respond)")
        # Don't cache timeouts - retry next time
        return None
    except Exception as e:
        logger.warning(
            f"Unexpected error looking up {registration}: {type(e).__name__}: {e}"
        )
        # Don't cache unexpected errors - retry next time
        return None

    # Update cache with result (including null for 404s)
    cache[registration] = model
    try:
        with open(cache_file, "w") as f:
            json.dump(cache, f, indent=2)
    except IOError as e:
        logger.warning(f"Could not update aircraft cache: {e}")

    return model


def parse_aircraft_from_filename(filename: str) -> Dict[str, str]:
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
                "route": route,  # DEPARTURE-ARRIVAL format
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
