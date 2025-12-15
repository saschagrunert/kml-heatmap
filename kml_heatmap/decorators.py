"""Useful decorators for performance monitoring and debugging.

This module provides decorators that can be applied to functions to add
cross-cutting concerns like timing, logging, and validation without
cluttering the function's core logic.

Available Decorators:

@timed
------
Measures and logs function execution time. Automatically warns if a function
takes longer than 5 seconds, helping identify performance bottlenecks.

Example:
    >>> @timed
    ... def process_large_file(path):
    ...     # Process file...
    ...     pass
    >>> process_large_file('data.kml')
    DEBUG: process_large_file took 2.34s

@log_calls
----------
Logs function calls with arguments and return values. Useful for debugging
complex call chains and understanding program flow. Also logs exceptions
with full context.

Example:
    >>> @log_calls
    ... def calculate_distance(lat1, lon1, lat2, lon2):
    ...     return haversine_distance(lat1, lon1, lat2, lon2)
    >>> result = calculate_distance(50.0, 8.0, 51.0, 9.0)
    DEBUG: Calling calculate_distance(50.0, 8.0, 51.0, 9.0)
    DEBUG: calculate_distance returned 123.45

@validate_not_none
------------------
Validates that specified parameters are not None before function execution.
Raises ValueError with descriptive message if validation fails.

Example:
    >>> @validate_not_none('input_file', 'output_dir')
    ... def convert_file(input_file, output_dir, verbose=False):
    ...     # Convert file...
    ...     pass
    >>> convert_file(None, '/tmp')  # Raises ValueError
    ValueError: Parameter 'input_file' cannot be None in convert_file()

Decorator Stacking:
-------------------
Decorators can be combined for comprehensive monitoring:

    @timed
    @log_calls
    @validate_not_none('data')
    def process_data(data, options=None):
        # Function implementation...
        pass

Note: When stacking decorators, order matters:
- @timed should generally be outermost (applied last) to measure total time
- @validate_not_none should be innermost to fail fast
- @log_calls typically goes in the middle
"""

import time
import functools
from typing import Callable, Any, TypeVar
from .logger import logger

__all__ = [
    "timed",
    "log_calls",
    "validate_not_none",
]

F = TypeVar("F", bound=Callable[..., Any])


def timed(func: F) -> F:
    """Decorator to measure and log function execution time.

    Logs the execution time at INFO level for production monitoring.
    Useful for identifying performance bottlenecks.

    Args:
        func: Function to time

    Returns:
        Wrapped function that logs execution time

    Example:
        >>> @timed
        ... def slow_function():
        ...     time.sleep(1)
        ...     return "done"
        >>> result = slow_function()
        INFO: slow_function took 1.00s
    """

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        start_time = time.perf_counter()
        result = func(*args, **kwargs)
        elapsed = time.perf_counter() - start_time

        logger.debug(f"{func.__name__} took {elapsed:.2f}s")

        # Log warning if function is slow
        if elapsed > 5.0:
            logger.warning(
                f"{func.__name__} took {elapsed:.2f}s (consider optimization)"
            )

        return result

    return wrapper


def log_calls(func: F) -> F:
    """Decorator to log function calls with arguments.

    Logs function entry with arguments and exit with return value.
    Useful for debugging complex call chains.

    Args:
        func: Function to log

    Returns:
        Wrapped function that logs calls

    Example:
        >>> @log_calls
        ... def calculate(x, y):
        ...     return x + y
        >>> result = calculate(3, 4)
        DEBUG: Calling calculate(3, 4)
        DEBUG: calculate returned 7
    """

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        # Format arguments for logging
        args_repr = [repr(a) for a in args]
        kwargs_repr = [f"{k}={v!r}" for k, v in kwargs.items()]
        signature = ", ".join(args_repr + kwargs_repr)

        logger.debug(f"Calling {func.__name__}({signature})")

        try:
            result = func(*args, **kwargs)
            logger.debug(f"{func.__name__} returned {result!r}")
            return result
        except Exception as e:
            logger.error(f"{func.__name__} raised {type(e).__name__}: {e}")
            raise

    return wrapper


def validate_not_none(*param_names: str) -> Callable[[F], F]:
    """Decorator to validate that specified parameters are not None.

    Raises ValueError if any specified parameter is None.
    Useful for ensuring required parameters are provided.

    Args:
        *param_names: Names of parameters to validate

    Returns:
        Decorator function

    Example:
        >>> @validate_not_none('path', 'output_dir')
        ... def process_files(path, output_dir, optional=None):
        ...     pass
        >>> process_files(None, '/tmp')  # Raises ValueError
        ValueError: Parameter 'path' cannot be None
    """

    def decorator(func: F) -> F:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            # Get function signature
            import inspect

            sig = inspect.signature(func)
            bound_args = sig.bind(*args, **kwargs)
            bound_args.apply_defaults()

            # Check each parameter
            for param_name in param_names:
                if param_name in bound_args.arguments:
                    value = bound_args.arguments[param_name]
                    if value is None:
                        raise ValueError(
                            f"Parameter '{param_name}' cannot be None in "
                            f"{func.__name__}()"
                        )

            return func(*args, **kwargs)

        return wrapper

    return decorator
