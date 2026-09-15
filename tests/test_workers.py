"""Tests for workers module."""

import logging
from unittest.mock import mock_open, patch

import kml_heatmap.airport_lookup as lookup_module
import kml_heatmap.workers as workers_module
from kml_heatmap.logger import logger, set_debug_mode
from kml_heatmap.workers import init_worker, parse_worker_count

MB = 1024 * 1024


class TestInitWorker:
    def test_enables_debug(self):
        try:
            init_worker(True)
            assert logger.level == logging.DEBUG
        finally:
            set_debug_mode(False)

    def test_without_debug_keeps_info_level(self):
        init_worker(False)
        assert logger.level == logging.INFO

    def test_does_not_load_the_airport_database(self):
        """Export workers never look up airports; lookups load it lazily."""
        init_worker(False)
        assert lookup_module._airport_cache is None


class TestParseWorkerCount:
    def _files(self, tmp_path, *sizes):
        paths = []
        for index, size in enumerate(sizes):
            path = tmp_path / f"{index}.kml"
            path.write_bytes(b"x" * size)
            paths.append(str(path))
        return paths

    def test_one_worker_per_cpu_when_memory_suffices(self, tmp_path):
        files = self._files(tmp_path, 10, 10, 10)
        with (
            patch("os.process_cpu_count", return_value=2),
            patch.object(
                workers_module, "_available_memory_bytes", return_value=64_000 * MB
            ),
        ):
            assert parse_worker_count(files) == 2

    def test_never_more_workers_than_files(self, tmp_path):
        files = self._files(tmp_path, 10)
        with patch("os.process_cpu_count", return_value=8):
            assert parse_worker_count(files) == 1

    def test_large_files_limit_the_pool(self, tmp_path):
        """A 121 MB gx:Track took 1.68 GB; eight at once must not start."""
        files = self._files(tmp_path, 1000, 10, 10, 10)
        per_large = workers_module.WORKER_BASE_BYTES + 1000 * 15
        per_small = workers_module.WORKER_BASE_BYTES + 10 * 15
        available = per_large + per_small + per_small // 2
        with (
            patch("os.process_cpu_count", return_value=8),
            patch.object(
                workers_module, "_available_memory_bytes", return_value=available
            ),
        ):
            assert parse_worker_count(files) == 2

    def test_at_least_one_worker(self, tmp_path):
        files = self._files(tmp_path, 1000, 1000)
        with patch.object(workers_module, "_available_memory_bytes", return_value=1):
            assert parse_worker_count(files) == 1

    def test_unknown_memory_does_not_limit(self, tmp_path):
        files = self._files(tmp_path, 10, 10, 10)
        with (
            patch("os.process_cpu_count", return_value=4),
            patch.object(workers_module, "_available_memory_bytes", return_value=None),
        ):
            assert parse_worker_count(files) == 3

    def test_missing_file_counts_as_empty(self, tmp_path):
        with patch.object(
            workers_module, "_available_memory_bytes", return_value=64_000 * MB
        ):
            assert parse_worker_count([str(tmp_path / "missing.kml")]) == 1


class TestAvailableMemory:
    def test_reads_meminfo(self):
        meminfo = "MemTotal: 16000000 kB\nMemAvailable:    2048 kB\n"
        with patch("builtins.open", mock_open(read_data=meminfo)):
            assert workers_module._available_memory_bytes() == 2048 * 1024

    def test_falls_back_to_sysconf(self):
        with (
            patch("builtins.open", side_effect=OSError("no /proc")),
            patch(
                "os.sysconf", side_effect=lambda name: 4096 if "SIZE" in name else 10
            ),
        ):
            assert workers_module._available_memory_bytes() == 40960

    def test_unknown_without_meminfo_and_sysconf(self):
        with (
            patch("builtins.open", mock_open(read_data="MemTotal: 1 kB\n")),
            patch("os.sysconf", side_effect=ValueError("unsupported")),
        ):
            assert workers_module._available_memory_bytes() is None

    def test_container_limit_wins_over_host_memory(self, tmp_path):
        (tmp_path / "memory.max").write_text(f"{2048 * MB}\n")
        (tmp_path / "memory.current").write_text(f"{768 * MB}\n")
        # Page cache the kernel can drop counts as available
        (tmp_path / "memory.stat").write_text(
            f"anon {512 * MB}\ninactive_file {256 * MB}\nactive_file 0\n"
        )
        with (
            patch.object(workers_module, "CGROUP_DIR", str(tmp_path)),
            patch.object(
                workers_module, "_host_available_bytes", return_value=64_000 * MB
            ),
        ):
            assert workers_module._available_memory_bytes() == 1536 * MB

    def test_unlimited_cgroup_keeps_host_memory(self, tmp_path):
        (tmp_path / "memory.max").write_text("max\n")
        with (
            patch.object(workers_module, "CGROUP_DIR", str(tmp_path)),
            patch.object(workers_module, "_host_available_bytes", return_value=MB),
        ):
            assert workers_module._available_memory_bytes() == MB

    def test_container_limit_without_memory_stat(self, tmp_path):
        (tmp_path / "memory.max").write_text(f"{1024 * MB}\n")
        (tmp_path / "memory.current").write_text(f"{1024 * MB}\n")
        with (
            patch.object(workers_module, "CGROUP_DIR", str(tmp_path)),
            patch.object(workers_module, "_host_available_bytes", return_value=None),
        ):
            assert workers_module._available_memory_bytes() == 0
