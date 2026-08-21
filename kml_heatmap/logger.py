"""Centralized logging configuration for kml-heatmap."""

import logging
import sys

__all__ = [
    "logger",
    "set_debug_mode",
    "setup_logger",
]


def setup_logger(
    name: str = "kml_heatmap", level: int = logging.INFO, debug: bool = False
) -> logging.Logger:
    """Configure and return a logger instance."""
    logger = logging.getLogger(name)

    if debug:
        logger.setLevel(logging.DEBUG)
    else:
        logger.setLevel(level)

    if logger.handlers:
        return logger

    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.DEBUG if debug else logging.INFO)

    formatter = logging.Formatter("%(levelname)s: %(message)s")
    handler.setFormatter(formatter)

    logger.addHandler(handler)

    return logger


logger = setup_logger()


def set_debug_mode(enabled: bool) -> None:
    """Enable or disable debug logging globally."""
    if enabled:
        logger.setLevel(logging.DEBUG)
        for handler in logger.handlers:
            handler.setLevel(logging.DEBUG)
    else:
        logger.setLevel(logging.INFO)
        for handler in logger.handlers:
            handler.setLevel(logging.INFO)
