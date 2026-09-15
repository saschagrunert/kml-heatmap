"""Initialization and sizing of process pool workers.

Python 3.14 starts workers with the ``forkserver`` method, so the parent's
logging configuration is not inherited. The initializer restores the debug
log level. The airport database is not preloaded: the export workers never
look up an airport, and parse workers with a warm parse cache do not either.
Lookups load it on first use.
"""

import os
from typing import TYPE_CHECKING

from .logger import set_debug_mode

if TYPE_CHECKING:
    from collections.abc import Sequence

__all__ = ["init_worker", "parse_worker_count"]

# Peak memory of a parse worker per byte of its KML file (a 121 MB gx:Track
# file took 1.68 GB), and what the interpreter and its modules take anyway
PARSE_BYTES_PER_FILE_BYTE = 15
WORKER_BASE_BYTES = 100 * 1024 * 1024


def init_worker(debug: bool) -> None:
    """Configure a worker process (log level).

    Any failure here would terminate the worker and break the whole pool,
    so it does nothing that can fail.
    """
    set_debug_mode(debug)


CGROUP_DIR = "/sys/fs/cgroup"


def _host_available_bytes() -> int | None:
    try:
        with open("/proc/meminfo", encoding="ascii") as meminfo:
            for line in meminfo:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
    except OSError, ValueError, IndexError:
        pass
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_AVPHYS_PAGES")
    except AttributeError, ValueError, OSError:
        return None


def _cgroup_available_bytes() -> int | None:
    """What the cgroup v2 memory limit leaves, None without a limit.

    memory.current includes the page cache, which the kernel reclaims before
    it kills a process; the inactive part of it counts as available.
    """
    try:
        with open(f"{CGROUP_DIR}/memory.max", encoding="ascii") as limit_file:
            raw_limit = limit_file.read().strip()
        if raw_limit == "max":
            return None
        limit = int(raw_limit)
        with open(f"{CGROUP_DIR}/memory.current", encoding="ascii") as usage_file:
            usage = int(usage_file.read().strip())
    except OSError, ValueError:
        return None
    reclaimable = 0
    try:
        with open(f"{CGROUP_DIR}/memory.stat", encoding="ascii") as stat_file:
            for line in stat_file:
                name, _, value = line.partition(" ")
                if name == "inactive_file":
                    reclaimable = int(value)
                    break
    except OSError, ValueError:
        pass
    return max(0, limit - usage + reclaimable)


def _available_memory_bytes() -> int | None:
    """Memory available to new processes, or None when it cannot be told.

    /proc/meminfo shows the memory of the host (or VM), not the limit a
    container runs under, so the smaller of the two counts.
    """
    known = [
        value
        for value in (_host_available_bytes(), _cgroup_available_bytes())
        if value is not None
    ]
    return min(known) if known else None


def _file_size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def parse_worker_count(kml_files: Sequence[str]) -> int:
    """The number of parse workers: one per CPU, as far as memory allows.

    Parsing takes about 15 times the file size in memory, and every worker
    may be parsing one of the largest files at the same time. The pool gets
    as many workers as the largest files fit into the available memory, at
    least one; an unknown amount of memory does not limit it.
    """
    # process_cpu_count honors the CPU affinity, and with it a container's
    # CPU quota; cpu_count would start one worker per CPU of the host
    workers = max(1, min(len(kml_files), os.process_cpu_count() or 4))
    available = _available_memory_bytes()
    if available is None:
        return workers

    largest = sorted((_file_size(path) for path in kml_files), reverse=True)
    needed = 0
    for count, size in enumerate(largest[:workers]):
        needed += WORKER_BASE_BYTES + size * PARSE_BYTES_PER_FILE_BYTE
        if needed > available:
            return max(1, count)
    return workers
