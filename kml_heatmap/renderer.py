"""The generation pipeline: parse, deduplicate, export, then package.

The files the site is made of live in ``site_assets``; this module is about
the order the stages run in and what they hand each other.
"""

import logging
import os
import pickle  # nosec B403
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from .aircraft import merge_aircraft_data
from .airport_lookup import load_airport_database
from .airports import deduplicate_airports
from .data_exporter import (
    ExportResult,
    SiteOutput,
    export_all_data,
    is_exportable_path,
)
from .exceptions import KMLHeatmapError, KMLParseError
from .logger import logger
from .parser import load_cached_kml, parse_kml_coordinates
from .parser_cache import prune_stale_cache_entries
from .site_assets import (
    SITE_FILE_PATTERNS,
    SITE_FILES,
    bundle_is_available,
    package_assets,
    render_html,
    warn_about_a_stale_bundle,
)
from .validation import validate_kml_file, validate_output_dir
from .workers import init_worker, parse_worker_count

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

    from .airport_lookup import AirportRecord
    from .types import FlightPathGroup, PathMetadata, TrackPoint

__all__ = [
    "CoordinateExtent",
    "ParsedFile",
    "create_progressive_heatmap",
]

# Files that are not in the parse cache are parsed in this process up to
# this many bytes in total, and in a process pool beyond. Starting the pool
# costs about as much as parsing 4 MB of KML, and 4 MB take about 60 MB of
# memory to parse, which the main process can well afford.
INLINE_PARSE_MAX_BYTES = 4 * 1024 * 1024


@dataclass(frozen=True)
class CoordinateExtent:
    """Bounding box of a set of coordinates.

    Plain minimum and maximum, also for data on both sides of the
    antimeridian: the map draws every path, marker and heat point at its own
    longitude, not where it would be nearest to the others, so a box that
    wrapped around 180 (179 to 181) would open the map on half of the
    flights.
    """

    min_lat: float
    max_lat: float
    min_lon: float
    max_lon: float

    @classmethod
    def of(cls, coordinates: Iterable[TrackPoint]) -> CoordinateExtent | None:
        """The extent of the coordinates, or None when there are none."""
        points = list(coordinates)
        if not points:
            return None
        return cls(
            min(point.lat for point in points),
            max(point.lat for point in points),
            min(point.lon for point in points),
            max(point.lon for point in points),
        )

    def as_map_bounds(self) -> dict[str, float]:
        """The bounds dictionary the map configuration is rendered from."""
        return {
            "min_lat": self.min_lat,
            "max_lat": self.max_lat,
            "min_lon": self.min_lon,
            "max_lon": self.max_lon,
            "center_lat": (self.min_lat + self.max_lat) / 2,
            "center_lon": (self.min_lon + self.max_lon) / 2,
        }


@dataclass
class ParsedFile:
    """What a parse worker sends back to the main process.

    The flat coordinate list stays in the worker: the main process only
    needs its size, which keeps the data crossing the process boundary (and
    held in the parent) to the flight paths themselves.
    """

    kml_file: str
    point_count: int = 0
    path_groups: FlightPathGroup = field(default_factory=list)
    path_metadata: list[PathMetadata] = field(default_factory=list)


def _parse_with_error_handling(kml_file: str) -> ParsedFile:
    """Parse a KML file in a worker and reduce the result for the parent."""
    try:
        coordinates, path_groups, path_metadata = parse_kml_coordinates(kml_file)
    except (OSError, ValueError, TypeError, KMLParseError) as e:
        logger.error("Error processing %s: %s", kml_file, e)
        return ParsedFile(kml_file)
    return ParsedFile(kml_file, len(coordinates), path_groups, path_metadata)


def _load_cached(kml_file: str) -> ParsedFile | None:
    """The parse result of a file from the parse cache, None on a miss."""
    try:
        cached = load_cached_kml(kml_file)
    except OSError:
        return None
    if cached is None:
        return None
    coordinates, path_groups, path_metadata = cached
    return ParsedFile(kml_file, len(coordinates), path_groups, path_metadata)


def _parse_inline(kml_file: str) -> ParsedFile:
    """Parse a file in this process, with the error handling of a worker."""
    try:
        return _parse_with_error_handling(kml_file)
    except KMLHeatmapError:
        raise
    except Exception:
        logger.exception("Unexpected error processing %s", kml_file)
        return ParsedFile(kml_file)


def _uncached_bytes(kml_files: list[str]) -> int:
    total = 0
    for kml_file in kml_files:
        try:
            total += os.path.getsize(kml_file)
        except OSError:
            continue
    return total


def _parse_in_pool(
    kml_files: list[str],
    record: Callable[[ParsedFile], None],
    airports: dict[str, AirportRecord],
) -> None:
    """Parse files in a process pool, handing each result to ``record``.

    The workers get the airport database the parent loaded (see
    ``workers.init_worker``).
    """
    debug = logger.isEnabledFor(logging.DEBUG)
    database = pickle.dumps(airports, protocol=pickle.HIGHEST_PROTOCOL)
    done: set[str] = set()
    pool_broken = False
    with ProcessPoolExecutor(
        max_workers=parse_worker_count(kml_files),
        initializer=init_worker,
        initargs=(debug, database),
    ) as executor:
        future_to_file = {
            executor.submit(_parse_with_error_handling, f): f for f in kml_files
        }
        for future in as_completed(future_to_file):
            try:
                parsed = future.result()
            except BrokenProcessPool:
                # Usually a worker killed for running out of memory while
                # others parsed large files at the same time
                pool_broken = True
                break
            except KMLHeatmapError:
                # Not a problem of this one file (the airport database, say),
                # so every other file would fail the same way
                executor.shutdown(wait=True, cancel_futures=True)
                raise
            except Exception:
                kml_file = future_to_file[future]
                logger.exception("Unexpected error processing %s", kml_file)
                parsed = ParsedFile(kml_file)
            done.add(parsed.kml_file)
            record(parsed)

    if pool_broken:
        remaining = [f for f in kml_files if f not in done]
        logger.warning(
            "  A parser worker process crashed; parsing the %d remaining "
            "file(s) one at a time",
            len(remaining),
        )
        # Still in a worker: a file that is too large to parse must not take
        # the main process down with it, and one at a time names the file
        with ProcessPoolExecutor(
            max_workers=1, initializer=init_worker, initargs=(debug, database)
        ) as executor:
            for kml_file in remaining:
                try:
                    parsed = executor.submit(
                        _parse_with_error_handling, kml_file
                    ).result()
                except BrokenProcessPool:
                    raise KMLHeatmapError(
                        f"A parser worker process crashed on {kml_file}, possibly "
                        "out of memory; run with --debug for details"
                    ) from None
                record(parsed)


def _parse_kml_files(
    valid_files: list[str],
) -> tuple[FlightPathGroup, list[PathMetadata]]:
    """Parse KML files and merge the results in input order.

    Files the parse cache holds are read from it in this process: a worker
    pool takes longer to start than reading them does. Of the rest, a few
    small files are parsed here as well (up to ``INLINE_PARSE_MAX_BYTES``),
    anything more in a process pool.

    The input order decides the path ids, so the merge must not depend on
    which worker finished first or on the file names: two directories may
    well contain files with the same name.
    """
    parse_start = time.time()
    # Load (and if needed download) the airport database once in the parent:
    # the workers get it from here instead of each reading the CSV, and the
    # cache keys below see the same database as they do
    airports = load_airport_database()
    prune_stale_cache_entries()

    results: list[ParsedFile] = []

    def record(parsed: ParsedFile) -> None:
        results.append(parsed)
        logger.info(
            "  [%d/%d] %.0f%% - %s",
            len(results),
            len(valid_files),
            (len(results) / len(valid_files)) * 100,
            Path(parsed.kml_file).name,
        )

    uncached: list[str] = []
    for kml_file in valid_files:
        cached = _load_cached(kml_file)
        if cached is None:
            uncached.append(kml_file)
        else:
            record(cached)

    if uncached and _uncached_bytes(uncached) > INLINE_PARSE_MAX_BYTES:
        _parse_in_pool(uncached, record, airports)
    else:
        for kml_file in uncached:
            record(_parse_inline(kml_file))

    input_order = {kml_file: index for index, kml_file in enumerate(valid_files)}
    results.sort(key=lambda parsed: input_order[parsed.kml_file])
    total_points = 0
    all_path_groups: FlightPathGroup = []
    all_path_metadata: list[PathMetadata] = []
    for parsed in results:
        total_points += parsed.point_count
        all_path_groups.extend(parsed.path_groups)
        all_path_metadata.extend(parsed.path_metadata)

    parse_time = time.time() - parse_start
    logger.info(
        "  Parsing took %.1fs (%.2fs per file)",
        parse_time,
        parse_time / len(valid_files),
    )

    if total_points == 0:
        raise KMLHeatmapError("No coordinates found in any KML files!")
    failed_count = sum(1 for parsed in results if parsed.point_count == 0)
    if failed_count > 0:
        raise KMLHeatmapError(
            f"{failed_count} of {len(valid_files)} file(s) failed to parse "
            "(see above); fix or remove them"
        )

    logger.info("\nTotal points: %d", total_points)
    return all_path_groups, all_path_metadata


def _drop_paths_without_year(
    all_path_groups: FlightPathGroup, all_path_metadata: list[PathMetadata]
) -> tuple[FlightPathGroup, list[PathMetadata]]:
    """Exclude paths whose year cannot be determined, with a warning each."""
    kept_groups: FlightPathGroup = []
    kept_metadata: list[PathMetadata] = []
    for path, metadata in zip(all_path_groups, all_path_metadata, strict=True):
        if metadata.get("year") is None:
            logger.warning(
                "Excluding path without a determinable year: %s (%s)",
                metadata.get("filename") or "unknown file",
                metadata.get("airport_name") or "unnamed",
            )
            continue
        kept_groups.append(path)
        kept_metadata.append(metadata)
    return kept_groups, kept_metadata


def _map_extent(all_path_groups: FlightPathGroup) -> CoordinateExtent:
    """The extent of the exported paths, which the map is fitted to.

    Only exported paths count: an excluded path would widen the map and give
    away where it was. Raises when there is nothing to export at all.
    """
    extent = CoordinateExtent.of(
        point for path in all_path_groups if is_exportable_path(path) for point in path
    )
    if extent is None:
        raise KMLHeatmapError("No flight paths with a determinable year to export")
    return extent


def _export_site(
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    output_file: Path,
    data_dir: Path,
    aircraft_data: dict[str, str] | None = None,
) -> ExportResult:
    """Export the data, render the page and package its assets.

    Everything is staged first and published at the end (see ``SiteOutput``),
    so a failure at any step leaves the previous site in the output as it was.
    """
    all_path_groups, all_path_metadata = _drop_paths_without_year(
        all_path_groups, all_path_metadata
    )
    extent = _map_extent(all_path_groups)

    # Only exported paths contribute airports: a path that gets no id and no
    # segments (a single point, a recording that never moved) would still
    # publish its location and name through the airport list
    exported = [
        (path, metadata)
        for path, metadata in zip(all_path_groups, all_path_metadata, strict=True)
        if is_exportable_path(path)
    ]
    logger.info("\nProcessing %d start points...", len(exported))
    unique_airports = deduplicate_airports(
        [metadata for _, metadata in exported], [path for path, _ in exported]
    )
    logger.info("  Found %d unique airports", len(unique_airports))

    data_dir_name = data_dir.name
    with SiteOutput(
        output_file.parent, data_dir, SITE_FILES, SITE_FILE_PATTERNS
    ) as site:
        result = export_all_data(
            all_path_groups,
            all_path_metadata,
            unique_airports,
            site.data_stage,
            aircraft_data=aircraft_data,
        )
        # The page opens on the latest year, see resolveYearSelection
        render_html(
            site.site_stage / output_file.name,
            data_dir_name,
            max(result.years, default=None),
        )
        package_assets(
            site.site_stage,
            extent.as_map_bounds(),
            data_dir_name,
            result.countries,
        )

        logger.info("\nPublishing the site to %s", output_file.parent)
        site.publish(result.years)

    return result


def create_progressive_heatmap(
    kml_files: list[str],
    output_file: str = "index.html",
    data_dir: str = "data",
    aircraft_files: list[Path] | None = None,
) -> bool:
    """Create a progressive-loading heatmap with external data files.

    Returns False (after logging the reason) when the site could not be
    generated; a previous site in the output is then left as it was. No
    exception escapes for the failure modes the pipeline knows about.
    """
    aircraft_files = aircraft_files or []

    # Stage 0: Refuse output directories that overlap with the inputs, a data
    # directory the page could not reach, and a run that could only produce a
    # page without its application
    output_dir = Path(output_file).resolve().parent
    if Path(data_dir).resolve().parent != output_dir:
        logger.error(
            "The data directory %s must be directly inside the output directory "
            "%s, where the page looks for it",
            data_dir,
            output_dir,
        )
        return False
    is_safe, error_msg = validate_output_dir(output_dir, [*kml_files, *aircraft_files])
    if not is_safe:
        logger.error("%s", error_msg)
        return False

    if not bundle_is_available():
        return False
    warn_about_a_stale_bundle()

    # Stage 1: Validate and parse. A file that cannot be used fails the run:
    # a site published without one of the flights, and exit status 0, would
    # hide it until someone notices the flight is missing.
    valid_files = []
    for kml_file in kml_files:
        is_valid, error_msg = validate_kml_file(kml_file)
        if not is_valid:
            logger.error("  %s", error_msg)
        else:
            valid_files.append(kml_file)

    if not valid_files:
        logger.error("No valid KML files to process!")
        return False
    if len(valid_files) < len(kml_files):
        logger.error(
            "%d of %d input file(s) are not valid KML files (see above); "
            "fix or remove them",
            len(kml_files) - len(valid_files),
            len(kml_files),
        )
        return False

    logger.info("Parsing %d KML file(s)...", len(valid_files))

    try:
        all_path_groups, all_path_metadata = _parse_kml_files(valid_files)
    except (ValueError, OSError, KMLHeatmapError) as e:
        logger.error(str(e))
        return False

    # Stage 2: Export the data, the page and the assets
    aircraft_data = merge_aircraft_data(aircraft_files) if aircraft_files else None
    try:
        _export_site(
            all_path_groups,
            all_path_metadata,
            Path(output_file),
            Path(data_dir),
            aircraft_data=aircraft_data,
        )
    except (ValueError, RuntimeError, OSError, KMLHeatmapError) as e:
        logger.error("Export failed: %s", e)
        return False

    logger.info(
        "  Serve %s over HTTP to view it (e.g. python -m http.server)", output_file
    )

    return True
