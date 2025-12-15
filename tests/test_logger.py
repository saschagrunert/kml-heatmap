"""Tests for logger module."""

import logging
from kml_heatmap.logger import setup_logger, logger, set_debug_mode


class TestSetupLogger:
    """Tests for setup_logger function."""

    def test_default_logger(self):
        """Test creating logger with default settings."""
        test_logger = setup_logger("test_logger_default")
        assert test_logger is not None
        assert test_logger.level == logging.INFO
        assert len(test_logger.handlers) > 0

    def test_logger_with_debug(self):
        """Test creating logger with debug enabled."""
        test_logger = setup_logger("test_logger_debug", debug=True)
        assert test_logger.level == logging.DEBUG
        assert test_logger.handlers[0].level == logging.DEBUG

    def test_logger_with_custom_level(self):
        """Test creating logger with custom level."""
        test_logger = setup_logger("test_logger_custom", level=logging.WARNING)
        assert test_logger.level == logging.WARNING

    def test_logger_with_custom_name(self):
        """Test creating logger with custom name."""
        test_logger = setup_logger("my_custom_logger")
        assert test_logger.name == "my_custom_logger"

    def test_logger_avoids_duplicate_handlers(self):
        """Test that calling setup_logger twice doesn't add duplicate handlers."""
        test_logger = setup_logger("test_logger_duplicate")
        handler_count = len(test_logger.handlers)
        # Call again with same name
        test_logger_again = setup_logger("test_logger_duplicate")
        assert len(test_logger_again.handlers) == handler_count

    def test_logger_handler_format(self):
        """Test that logger handler has correct formatter."""
        test_logger = setup_logger("test_logger_format")
        handler = test_logger.handlers[0]
        assert handler.formatter is not None
        # Check formatter format
        log_format = handler.formatter._fmt
        assert "levelname" in log_format
        assert "message" in log_format

    def test_debug_overrides_level(self):
        """Test that debug=True overrides the level parameter."""
        test_logger = setup_logger(
            "test_logger_override", level=logging.WARNING, debug=True
        )
        assert test_logger.level == logging.DEBUG


class TestGlobalLogger:
    """Tests for global logger instance."""

    def test_global_logger_exists(self):
        """Test that global logger is initialized."""
        assert logger is not None
        assert isinstance(logger, logging.Logger)

    def test_global_logger_name(self):
        """Test global logger has correct name."""
        assert logger.name == "kml_heatmap"


class TestSetDebugMode:
    """Tests for set_debug_mode function."""

    def test_enable_debug_mode(self):
        """Test enabling debug mode."""
        # Enable debug
        set_debug_mode(True)

        # Check global logger is set to DEBUG
        assert logger.level == logging.DEBUG
        for handler in logger.handlers:
            assert handler.level == logging.DEBUG

        # Restore original state
        set_debug_mode(False)

    def test_disable_debug_mode(self):
        """Test disabling debug mode."""
        # Enable debug first
        set_debug_mode(True)

        # Now disable
        set_debug_mode(False)

        # Check global logger is set to INFO
        assert logger.level == logging.INFO
        for handler in logger.handlers:
            assert handler.level == logging.INFO

    def test_toggle_debug_mode(self):
        """Test toggling debug mode multiple times."""
        # Start with info
        set_debug_mode(False)
        assert logger.level == logging.INFO

        # Enable debug
        set_debug_mode(True)
        assert logger.level == logging.DEBUG

        # Disable again
        set_debug_mode(False)
        assert logger.level == logging.INFO
