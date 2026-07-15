"""Decorators for performance monitoring and debugging."""

import time
import functools
from collections.abc import Callable
from typing import Any, TypeVar, cast

from .logger import logger

__all__ = [
    "timed",
    "log_calls",
    "validate_not_none",
]

F = TypeVar("F", bound=Callable[..., Any])


def timed(func: F) -> F:
    """Decorator to measure and log function execution time."""

    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        start_time = time.perf_counter()
        result = func(*args, **kwargs)
        elapsed = time.perf_counter() - start_time

        logger.debug(f"{func.__name__} took {elapsed:.2f}s")

        if elapsed > 5.0:
            logger.warning(
                f"{func.__name__} took {elapsed:.2f}s (consider optimization)"
            )

        return result

    return cast(F, wrapper)


def log_calls(func: F) -> F:
    """Decorator to log function calls with arguments."""

    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
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

    return cast(F, wrapper)


def validate_not_none(*param_names: str) -> Callable[[F], F]:
    """Decorator to validate that specified parameters are not None."""

    def decorator(func: F) -> F:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            import inspect

            sig = inspect.signature(func)
            bound_args = sig.bind(*args, **kwargs)
            bound_args.apply_defaults()

            for param_name in param_names:
                if param_name in bound_args.arguments:
                    value = bound_args.arguments[param_name]
                    if value is None:
                        raise ValueError(
                            f"Parameter '{param_name}' cannot be None in "
                            f"{func.__name__}()"
                        )

            return func(*args, **kwargs)

        return cast(F, wrapper)

    return decorator
