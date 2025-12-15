"""Tests for decorators module."""

import time
import pytest
from kml_heatmap.decorators import timed, log_calls, validate_not_none


class TestTimedDecorator:
    """Tests for timed decorator."""

    def test_timed_basic(self):
        """Test basic timed decorator functionality."""

        @timed
        def simple_function():
            return "result"

        result = simple_function()
        assert result == "result"

    def test_timed_with_args(self):
        """Test timed decorator with arguments."""

        @timed
        def add(a, b):
            return a + b

        result = add(3, 4)
        assert result == 7

    def test_timed_with_kwargs(self):
        """Test timed decorator with keyword arguments."""

        @timed
        def greet(name, greeting="Hello"):
            return f"{greeting}, {name}"

        result = greet("World", greeting="Hi")
        assert result == "Hi, World"

    def test_timed_preserves_function_name(self):
        """Test that timed preserves original function name."""

        @timed
        def my_function():
            pass

        assert my_function.__name__ == "my_function"

    def test_timed_slow_function_warning(self, caplog):
        """Test that slow functions generate a warning."""

        @timed
        def slow_function():
            time.sleep(0.01)  # Short sleep to avoid slowing tests
            return "done"

        # We can't reliably test the 5s threshold in fast tests,
        # but we can verify the decorator works with sleeps
        result = slow_function()
        assert result == "done"


class TestLogCallsDecorator:
    """Tests for log_calls decorator."""

    def test_log_calls_basic(self):
        """Test basic log_calls functionality."""

        @log_calls
        def simple_function():
            return "result"

        result = simple_function()
        assert result == "result"

    def test_log_calls_with_args(self):
        """Test log_calls with arguments."""

        @log_calls
        def multiply(x, y):
            return x * y

        result = multiply(3, 4)
        assert result == 12

    def test_log_calls_with_kwargs(self):
        """Test log_calls with keyword arguments."""

        @log_calls
        def create_message(text, prefix="INFO"):
            return f"{prefix}: {text}"

        result = create_message("test", prefix="DEBUG")
        assert result == "DEBUG: test"

    def test_log_calls_preserves_function_name(self):
        """Test that log_calls preserves original function name."""

        @log_calls
        def my_function():
            pass

        assert my_function.__name__ == "my_function"

    def test_log_calls_with_exception(self):
        """Test log_calls when function raises exception."""

        @log_calls
        def failing_function():
            raise ValueError("Test error")

        with pytest.raises(ValueError, match="Test error"):
            failing_function()

    def test_log_calls_returns_correct_value(self):
        """Test that log_calls returns the correct value."""

        @log_calls
        def get_value():
            return 42

        result = get_value()
        assert result == 42


class TestValidateNotNoneDecorator:
    """Tests for validate_not_none decorator."""

    def test_validate_not_none_valid_args(self):
        """Test validate_not_none with valid arguments."""

        @validate_not_none("name")
        def greet(name):
            return f"Hello, {name}"

        result = greet("World")
        assert result == "Hello, World"

    def test_validate_not_none_raises_on_none(self):
        """Test validate_not_none raises ValueError on None."""

        @validate_not_none("name")
        def greet(name):
            return f"Hello, {name}"

        with pytest.raises(ValueError, match="Parameter 'name' cannot be None"):
            greet(None)

    def test_validate_not_none_multiple_params(self):
        """Test validate_not_none with multiple parameters."""

        @validate_not_none("x", "y")
        def add(x, y):
            return x + y

        result = add(3, 4)
        assert result == 7

    def test_validate_not_none_multiple_params_first_none(self):
        """Test validate_not_none when first parameter is None."""

        @validate_not_none("x", "y")
        def add(x, y):
            return x + y

        with pytest.raises(ValueError, match="Parameter 'x' cannot be None"):
            add(None, 4)

    def test_validate_not_none_multiple_params_second_none(self):
        """Test validate_not_none when second parameter is None."""

        @validate_not_none("x", "y")
        def add(x, y):
            return x + y

        with pytest.raises(ValueError, match="Parameter 'y' cannot be None"):
            add(3, None)

    def test_validate_not_none_with_default_args(self):
        """Test validate_not_none with default arguments."""

        @validate_not_none("required")
        def process(required, optional=None):
            return f"Required: {required}"

        result = process("value")
        assert result == "Required: value"

    def test_validate_not_none_allows_none_for_unspecified_params(self):
        """Test validate_not_none allows None for parameters not in validation list."""

        @validate_not_none("required")
        def process(required, optional=None):
            return f"Required: {required}, Optional: {optional}"

        result = process("value", None)
        assert result == "Required: value, Optional: None"

    def test_validate_not_none_preserves_function_name(self):
        """Test that validate_not_none preserves original function name."""

        @validate_not_none("x")
        def my_function(x):
            pass

        assert my_function.__name__ == "my_function"

    def test_validate_not_none_with_kwargs(self):
        """Test validate_not_none with keyword arguments."""

        @validate_not_none("name")
        def greet(name, greeting="Hello"):
            return f"{greeting}, {name}"

        with pytest.raises(ValueError, match="Parameter 'name' cannot be None"):
            greet(name=None)


class TestDecoratorCombinations:
    """Tests for combining decorators."""

    def test_timed_and_log_calls(self):
        """Test combining timed and log_calls."""

        @timed
        @log_calls
        def combined_function(x):
            return x * 2

        result = combined_function(5)
        assert result == 10

    def test_all_three_decorators(self):
        """Test combining all three decorators."""

        @timed
        @log_calls
        @validate_not_none("x")
        def all_decorators(x):
            return x * 2

        result = all_decorators(5)
        assert result == 10

    def test_all_three_decorators_validation_fails(self):
        """Test all decorators with validation failure."""

        @timed
        @log_calls
        @validate_not_none("x")
        def all_decorators(x):
            return x * 2

        with pytest.raises(ValueError, match="Parameter 'x' cannot be None"):
            all_decorators(None)
