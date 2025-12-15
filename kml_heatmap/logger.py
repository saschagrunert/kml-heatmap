"""Centralized logging configuration for kml-heatmap."""

import logging
import sys

__all__ = [
    'setup_logger',
    'logger',
    'set_debug_mode',
]


def setup_logger(name: str = 'kml_heatmap', level: int = logging.INFO, debug: bool = False) -> logging.Logger:
    """
    Configure and return a logger instance.

    Args:
        name: Logger name
        level: Base logging level
        debug: If True, set level to DEBUG

    Returns:
        Configured logger instance
    """
    logger = logging.getLogger(name)

    # Set level
    if debug:
        logger.setLevel(logging.DEBUG)
    else:
        logger.setLevel(level)

    # Avoid duplicate handlers
    if logger.handlers:
        return logger

    # Create console handler with formatting
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.DEBUG if debug else logging.INFO)

    # Create formatter
    formatter = logging.Formatter(
        '%(levelname)s: %(message)s'
    )
    handler.setFormatter(formatter)

    # Add handler to logger
    logger.addHandler(handler)

    return logger


# Global logger instance
logger = setup_logger()


def set_debug_mode(enabled: bool) -> None:
    """Enable or disable debug logging globally.

    Args:
        enabled: True to enable debug mode
    """
    global logger
    if enabled:
        logger.setLevel(logging.DEBUG)
        for handler in logger.handlers:
            handler.setLevel(logging.DEBUG)
    else:
        logger.setLevel(logging.INFO)
        for handler in logger.handlers:
            handler.setLevel(logging.INFO)
