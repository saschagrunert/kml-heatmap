"""Runtime input validation for critical functions.

This module provides validation decorators and functions to ensure
function inputs meet expected constraints. Validation happens at runtime
and provides clear error messages when constraints are violated.

Features:
- Type checking decorators
- Range validation for numeric values
- Non-empty validation for collections
- Path existence validation
- Custom validation predicates

Usage:
    @validate_inputs
    def process_coordinates(coords: List[float]) -> None:
        # coords is guaranteed to be a list
        pass
"""

from typing import Any, Callable, List, Dict, TypeVar, Union
from pathlib import Path

from .exceptions import ConfigurationError, InvalidCoordinateError, InvalidAltitudeError
from .constants import LAT_MIN, LAT_MAX, LON_MIN, LON_MAX, ALT_MIN_M, ALT_MAX_M

T = TypeVar("T")


def validate_latitude(lat: float, context: str = "") -> None:
    """
    Validate latitude value.

    Args:
        lat: Latitude value
        context: Optional context for error message

    Raises:
        InvalidCoordinateError: If latitude is out of range
    """
    if not isinstance(lat, (int, float)):
        raise InvalidCoordinateError(f"Latitude must be numeric{context}", latitude=lat)

    if not (LAT_MIN <= lat <= LAT_MAX):
        raise InvalidCoordinateError(
            f"Latitude out of range [{LAT_MIN}, {LAT_MAX}]{context}", latitude=lat
        )


def validate_longitude(lon: float, context: str = "") -> None:
    """
    Validate longitude value.

    Args:
        lon: Longitude value
        context: Optional context for error message

    Raises:
        InvalidCoordinateError: If longitude is out of range
    """
    if not isinstance(lon, (int, float)):
        raise InvalidCoordinateError(
            f"Longitude must be numeric{context}", longitude=lon
        )

    if not (LON_MIN <= lon <= LON_MAX):
        raise InvalidCoordinateError(
            f"Longitude out of range [{LON_MIN}, {LON_MAX}]{context}", longitude=lon
        )


def validate_altitude(alt: float, context: str = "") -> None:
    """
    Validate altitude value.

    Args:
        alt: Altitude in meters
        context: Optional context for error message

    Raises:
        InvalidAltitudeError: If altitude is out of range
    """
    if not isinstance(alt, (int, float)):
        raise InvalidAltitudeError(f"Altitude must be numeric{context}", altitude=alt)

    if not (ALT_MIN_M <= alt <= ALT_MAX_M):
        raise InvalidAltitudeError(
            f"Altitude out of range [{ALT_MIN_M}, {ALT_MAX_M}]m{context}", altitude=alt
        )


def validate_coordinate_pair(lat: float, lon: float, context: str = "") -> None:
    """
    Validate a coordinate pair.

    Args:
        lat: Latitude
        lon: Longitude
        context: Optional context for error message

    Raises:
        InvalidCoordinateError: If either value is invalid
    """
    validate_latitude(lat, context)
    validate_longitude(lon, context)


def validate_path_exists(path: Union[str, Path], must_be_file: bool = True) -> None:
    """
    Validate that a path exists.

    Args:
        path: Path to validate
        must_be_file: If True, path must be a file; if False, can be directory

    Raises:
        ConfigurationError: If path doesn't exist or wrong type
    """
    path_obj = Path(path)

    if not path_obj.exists():
        raise ConfigurationError(f"Path does not exist: {path}")

    if must_be_file and not path_obj.is_file():
        raise ConfigurationError(f"Path is not a file: {path}")

    if not must_be_file and not path_obj.is_dir():
        raise ConfigurationError(f"Path is not a directory: {path}")


def validate_non_empty(value: Union[List, Dict, str], name: str = "value") -> None:
    """
    Validate that a collection is not empty.

    Args:
        value: Collection to check
        name: Name of the value for error message

    Raises:
        ConfigurationError: If collection is empty
    """
    if not value:
        raise ConfigurationError(f"{name} cannot be empty")


def validate_positive(value: Union[int, float], name: str = "value") -> None:
    """
    Validate that a number is positive.

    Args:
        value: Number to check
        name: Name of the value for error message

    Raises:
        ConfigurationError: If value is not positive
    """
    if value <= 0:
        raise ConfigurationError(f"{name} must be positive, got {value}")


def validate_in_range(
    value: Union[int, float],
    min_val: Union[int, float],
    max_val: Union[int, float],
    name: str = "value",
) -> None:
    """
    Validate that a number is within a range.

    Args:
        value: Number to check
        min_val: Minimum allowed value (inclusive)
        max_val: Maximum allowed value (inclusive)
        name: Name of the value for error message

    Raises:
        ConfigurationError: If value is out of range
    """
    if not (min_val <= value <= max_val):
        raise ConfigurationError(
            f"{name} must be in range [{min_val}, {max_val}], got {value}"
        )


def validate_type(value: Any, expected_type: type, name: str = "value") -> None:
    """
    Validate that a value is of expected type.

    Args:
        value: Value to check
        expected_type: Expected type
        name: Name of the value for error message

    Raises:
        ConfigurationError: If value is wrong type
    """
    if not isinstance(value, expected_type):
        raise ConfigurationError(
            f"{name} must be {expected_type.__name__}, got {type(value).__name__}"
        )


class ValidationContext:
    """Context manager for validation error collection.

    Collects multiple validation errors and raises them together.

    Example:
        with ValidationContext("Processing coordinates") as ctx:
            ctx.validate(lat, validate_latitude, "latitude")
            ctx.validate(lon, validate_longitude, "longitude")
    """

    def __init__(self, operation: str):
        """Initialize validation context.

        Args:
            operation: Description of the operation being validated
        """
        self.operation = operation
        self.errors: List[str] = []

    def __enter__(self):
        """Enter the context manager."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Exit the context manager, raising ConfigurationError if any errors occurred.

        Args:
            exc_type: Exception type if raised
            exc_val: Exception value if raised
            exc_tb: Exception traceback if raised

        Returns:
            False to propagate exceptions

        Raises:
            ConfigurationError: If validation errors were collected
        """
        if self.errors:
            error_msg = f"{self.operation} failed:\n" + "\n".join(
                f"  - {err}" for err in self.errors
            )
            raise ConfigurationError(error_msg)
        return False

    def validate(self, value: Any, validator: Callable[[Any], None], name: str) -> None:
        """
        Run a validator and collect any errors.

        Args:
            value: Value to validate
            validator: Validation function to call
            name: Name for error messages
        """
        try:
            validator(value)
        except Exception as e:
            self.errors.append(f"{name}: {str(e)}")
