"""Tests for logger module."""

import logging
import sys

import pytest

from kml_heatmap.logger import logger, set_debug_mode, setup_logger


@pytest.fixture(autouse=True)
def _restore_level():
    yield
    set_debug_mode(False)


class TestSetupLogger:
    def test_default_logger(self):
        test_logger = setup_logger("test_logger_default")
        assert test_logger.level == logging.INFO
        assert len(test_logger.handlers) == 2

    def test_stdout_and_stderr_handlers(self):
        test_logger = setup_logger("test_logger_streams")
        stdout_handler, stderr_handler = test_logger.handlers
        assert stdout_handler.stream is sys.stdout
        assert stdout_handler.level == logging.INFO
        assert stderr_handler.stream is sys.stderr
        assert stderr_handler.level == logging.WARNING

    def test_logger_with_debug(self):
        test_logger = setup_logger("test_logger_debug", debug=True)
        assert test_logger.level == logging.DEBUG
        assert test_logger.handlers[0].level == logging.DEBUG
        assert test_logger.handlers[1].level == logging.WARNING

    def test_logger_with_custom_level(self):
        assert (
            setup_logger("test_logger_custom", level=logging.WARNING).level
            == logging.WARNING
        )

    def test_logger_avoids_duplicate_handlers(self):
        test_logger = setup_logger("test_logger_duplicate")
        handler_count = len(test_logger.handlers)
        assert len(setup_logger("test_logger_duplicate").handlers) == handler_count

    def test_logger_handler_format(self):
        handler = setup_logger("test_logger_format").handlers[0]
        assert handler.formatter._fmt == "%(levelname)s: %(message)s"

    def test_debug_overrides_level(self):
        test_logger = setup_logger(
            "test_logger_override", level=logging.WARNING, debug=True
        )
        assert test_logger.level == logging.DEBUG


class TestOutputStreams:
    def test_info_goes_to_stdout_only(self, capsys):
        logger.info("hello info")
        captured = capsys.readouterr()
        assert "INFO: hello info" in captured.out
        assert "hello info" not in captured.err

    def test_warning_and_error_go_to_stderr_only(self, capsys):
        logger.warning("hello warning")
        logger.error("hello error")
        captured = capsys.readouterr()
        assert "WARNING: hello warning" in captured.err
        assert "ERROR: hello error" in captured.err
        assert "hello" not in captured.out

    def test_debug_hidden_unless_enabled(self, capsys):
        logger.debug("hidden")
        assert "hidden" not in capsys.readouterr().out
        set_debug_mode(True)
        logger.debug("visible")
        assert "DEBUG: visible" in capsys.readouterr().out


class TestGlobalLogger:
    def test_global_logger_name(self):
        assert isinstance(logger, logging.Logger)
        assert logger.name == "kml_heatmap"


class TestSetDebugMode:
    def test_enable_debug_mode_only_touches_stdout_handler(self):
        set_debug_mode(True)
        assert logger.level == logging.DEBUG
        assert logger.handlers[0].level == logging.DEBUG
        assert logger.handlers[1].level == logging.WARNING

    def test_disable_debug_mode(self):
        set_debug_mode(True)
        set_debug_mode(False)
        assert logger.level == logging.INFO
        assert logger.handlers[0].level == logging.INFO
        assert logger.handlers[1].level == logging.WARNING
