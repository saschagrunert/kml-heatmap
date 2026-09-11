"""Tests for workers module."""

import logging
from unittest.mock import patch

import kml_heatmap.airport_lookup as lookup_module
from kml_heatmap.logger import logger, set_debug_mode
from kml_heatmap.workers import init_worker


class TestInitWorker:
    def test_enables_debug_and_preloads_airports(self):
        try:
            init_worker(True)
            assert logger.level == logging.DEBUG
            assert lookup_module._airport_cache is not None
            assert "EDDP" in lookup_module._airport_cache
        finally:
            set_debug_mode(False)

    def test_without_debug_keeps_info_level(self):
        init_worker(False)
        assert logger.level == logging.INFO
        assert lookup_module._airport_cache is not None

    def test_preload_failure_is_logged_not_raised(self, capsys):
        """A raising initializer would take the whole process pool down."""
        with patch(
            "kml_heatmap.workers.load_airport_database",
            side_effect=RuntimeError("boom"),
        ):
            init_worker(False)
        assert "Airport database preload failed in worker: boom" in (
            capsys.readouterr().err
        )
