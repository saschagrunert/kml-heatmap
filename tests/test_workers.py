"""Tests for workers module."""

import logging

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
