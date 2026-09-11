"""Initialization of process pool workers.

Python 3.14 starts workers with the ``forkserver`` method, so the parent's
logging configuration and loaded caches are not inherited. The initializer
restores the debug log level and pre-loads the airport database.
"""

from .airport_lookup import load_airport_database
from .logger import logger, set_debug_mode

__all__ = ["init_worker"]


def init_worker(debug: bool) -> None:
    """Configure a worker process (log level and airport database).

    Any failure here would terminate the worker and break the whole pool, so
    the airport database preload is best effort; lookups fall back to loading
    it on demand.
    """
    set_debug_mode(debug)
    try:
        load_airport_database()
    except Exception as e:
        logger.warning("Airport database preload failed in worker: %s", e)
