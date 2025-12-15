"""Aircraft registration and model lookup functionality."""

import os
import json
import re
import urllib.request
import urllib.error
from html.parser import HTMLParser
from typing import Optional, Dict, List
from .logger import logger

__all__ = [
    "AircraftDataParser",
    "lookup_aircraft_model",
    "parse_aircraft_from_filename",
]


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
        if self.in_title and "Aircraft info for" in data:
            # Extract from title like: "Aircraft info for D-EAGJ - 2001 Diamond DA-20A-1 Katana"
            parts = data.split(" - ", 1)
            if len(parts) > 1:
                # Remove year prefix if present (e.g., "2001 Diamond DA-20A-1 Katana")
                model = parts[1].strip()
                model = re.sub(r"^\d{4}\s+", "", model)
                self.model = model

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False


def lookup_aircraft_model(
    registration: str, cache_file: str = "aircraft_cache.json"
) -> Optional[str]:
    """
    Look up aircraft model from airport-data.com

    Args:
        registration: Aircraft registration (e.g., 'D-EAGJ')
        cache_file: Path to JSON cache file

    Returns:
        Full aircraft model name or None if not found
    """
    # Load cache
    cache = {}
    if os.path.exists(cache_file):
        try:
            with open(cache_file, "r") as f:
                cache = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            # Cache file is corrupted or unreadable, start with empty cache
            logger.warning(f"Could not load aircraft cache from {cache_file}: {e}")
            cache = {}

    # Check cache
    if registration in cache:
        return cache[registration]

    # Fetch from airport-data.com
    try:
        url = f"https://airport-data.com/aircraft/{registration}.html"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})

        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode("utf-8")

        parser = AircraftDataParser()
        parser.feed(html)

        if parser.model:
            # Update cache
            cache[registration] = parser.model
            try:
                with open(cache_file, "w") as f:
                    json.dump(cache, f, indent=2)
            except IOError as e:
                logger.warning(f"Could not update aircraft cache: {e}")

            return parser.model
    except urllib.error.HTTPError as e:
        if e.code == 404:
            # Aircraft not found in database - this is normal, not an error
            pass
        elif e.code == 429:
            logger.warning(f"Rate limited by aircraft database for {registration}")
        else:
            logger.warning(f"HTTP error {e.code} looking up {registration}: {e.reason}")
    except urllib.error.URLError as e:
        logger.warning(f"Network error looking up {registration}: {e.reason}")
    except TimeoutError:
        logger.warning(f"Timeout looking up {registration} (server did not respond)")
    except Exception as e:
        logger.warning(
            f"Unexpected error looking up {registration}: {type(e).__name__}: {e}"
        )

    return None


def parse_aircraft_from_filename(filename: str) -> Dict[str, str]:
    """
    Parse aircraft information from KML filename.

    Expected format: YYYYMMDD_HHMM_AIRPORT_REGISTRATION_TYPE.kml
    Example: 20250822_1013_EDAV_DEHYL_DA40.kml

    Args:
        filename: KML filename (without path)

    Returns:
        Dict with 'registration' and 'type' keys, or empty dict if parsing fails
    """
    # Remove .kml extension
    name = filename.replace(".kml", "")

    # Pattern: YYYYMMDD_HHMM_AIRPORT_REGISTRATION_TYPE
    # Registration is typically D-EXXX format (but stored as DEEXXX in filename)
    # Type is typically letters/numbers like DA20, DA40, C172, etc.
    parts = name.split("_")

    if len(parts) >= 5:
        # Format: DATE_TIME_AIRPORT_REGISTRATION_TYPE
        registration_raw = parts[3]
        aircraft_type = parts[4]

        # Format registration: if starts with D, insert hyphen after first char (D-EXXX)
        registration = registration_raw
        if registration_raw.startswith("D") and len(registration_raw) > 1:
            registration = registration_raw[0] + "-" + registration_raw[1:]

        return {"registration": registration, "type": aircraft_type}

    return {}
