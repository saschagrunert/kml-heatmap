"""The generation pipeline: parse, deduplicate, export, then package.

The module keeps its old name, but it renders nothing itself: the page and
the files the site is made of come from ``site_assets``, the data files from
``data_exporter``. This module is about the order the stages run in, what
they hand each other and how a failure is reported (the exceptions of
``exceptions``, which ``cli`` turns into its exit status).
"""

import contextlib
import gc
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
    ExportSelection,
    export_all_data,
    select_exported_paths,
)
from .exceptions import (
    ExportError,
    InvalidInputError,
    KMLHeatmapError,
    KMLParseError,
    OutputRefusedError,
)
from .export_writers import exported_airport_names, exported_country_codes
from .logger import logger
from .parser import load_cached_kml, parse_kml_file, parse_size
from .parser_cache import prune_stale_cache_entries
from .path_content import is_exportable_path
from .previews import SITE_URL_ENV, normalize_site_url, write_previews
from .site_assets import (
    SITE_FILE_PATTERNS,
    SITE_FILES,
    available_country_flags,
    missing_build_files,
    package_assets,
    render_html,
    warn_about_a_stale_bundle,
)
from .site_output import STABLE_MTIMES_ENV, SiteOutput
from .validation import foreign_site_files, validate_kml_file, validate_output_dir
from .workers import default_worker_count, init_worker, parse_worker_count

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Iterator, Sequence

    from .airport_lookup import AirportRecord
    from .terrain import TileSource
    from .types import FlightPathGroup, PathMetadata, TrackPoint

__all__ = [
    "CoordinateExtent",
    "FlightListing",
    "ParsedFile",
    "create_progressive_heatmap",
    "foreign_output_error",
    "list_flights",
]

# Files that are not in the parse cache are parsed in this process up to
# this many bytes in total, and in a process pool beyond. Starting the pool
# costs about as much as parsing 4 MB of KML, and 4 MB take about 60 MB of
# memory to parse, which the main process can well afford.
INLINE_PARSE_MAX_BYTES = 4 * 1024 * 1024
# Files the parse cache holds are read in this process, unless there is this
# much KML and at least POOLED_CACHE_MIN_WORKERS cores to read their entries
# in the pool: 3090 files (494 MB, 4.7 million points) took 3.4 s here and
# 2.0 s in 16 workers, 1030 of them (165 MB) 1.1 and 0.8 s, and 103 of them
# 0.1 s here and 0.3 s in the pool, which takes time to start.
POOLED_CACHE_MIN_BYTES = 128 * 1024 * 1024
POOLED_CACHE_MIN_WORKERS = 8


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


def _parse_with_error_handling(
    kml_file: str, cache_path: Path | None = None
) -> ParsedFile:
    """Parse a KML file in a worker and reduce the result for the parent.

    ``cache_path`` is the parse cache entry the parent looked up and missed
    (see ``parser.load_cached_kml``); the result is stored there.
    """
    try:
        coordinates, path_groups, path_metadata = parse_kml_file(kml_file, cache_path)
    except (OSError, ValueError, TypeError, KMLParseError) as e:
        logger.error("Error processing %s: %s", kml_file, e)
        return ParsedFile(kml_file)
    return ParsedFile(kml_file, len(coordinates), path_groups, path_metadata)


def _load_cached(kml_file: str) -> ParsedFile | Path | None:
    """The parse result of a file from the parse cache.

    On a miss the cache entry to store the parse in, or None without one.
    """
    try:
        cached, cache_path = load_cached_kml(kml_file)
    except OSError:
        return None
    if cached is None:
        return cache_path
    coordinates, path_groups, path_metadata = cached
    return ParsedFile(kml_file, len(coordinates), path_groups, path_metadata)


def _load_or_parse(kml_file: str, _cache_path: Path | None = None) -> ParsedFile:
    """The parse of a file, from the parse cache if it has it, in a worker.

    The second argument, the cache entry of ``_parse_in_pool``, is not used:
    the worker looks the entry up itself. The collector is paused
    meanwhile, see ``_collector_paused``.
    """
    enabled = gc.isenabled()
    gc.disable()
    try:
        cached = _load_cached(kml_file)
        if isinstance(cached, ParsedFile):
            return cached
        return _parse_with_error_handling(kml_file, cached)
    finally:
        if enabled:
            gc.enable()


def _parse_inline(kml_file: str, cache_path: Path | None) -> ParsedFile:
    """Parse a file in this process, with the error handling of a worker."""
    try:
        return _parse_with_error_handling(kml_file, cache_path)
    except KMLHeatmapError:
        raise
    # A bug in the parser shows on this one file, with its traceback, and
    # the run reports the file as failed instead of dying without a name
    except Exception:  # noqa: BLE001
        logger.exception("Unexpected error processing %s", kml_file)
        return ParsedFile(kml_file)


def _file_bytes(kml_files: list[str]) -> int:
    """The KML the files hold, that inside a KMZ counted uncompressed.

    The pool gates below are about the work and the memory a parse takes,
    which the document decides, not the archive (see ``parse_size``).
    """
    return sum(parse_size(kml_file) for kml_file in kml_files)


def _parse_in_pool(
    uncached: Sequence[tuple[str, Path | None]],
    record: Callable[[ParsedFile], None],
    airports: dict[str, AirportRecord],
    parse: Callable[[str, Path | None], ParsedFile] = _parse_with_error_handling,
) -> None:
    """Parse files in a process pool, handing each result to ``record``.

    ``uncached`` pairs each file with its parse cache entry (see
    ``_parse_with_error_handling``); ``parse`` is what a worker runs for
    each, ``_load_or_parse`` to look the cache up there. The workers get the
    airport database the parent loaded (see ``workers.init_worker``).
    """
    kml_files = [kml_file for kml_file, _ in uncached]
    cache_paths = dict(uncached)
    level = logger.getEffectiveLevel()
    database = pickle.dumps(airports, protocol=pickle.HIGHEST_PROTOCOL)
    done: set[str] = set()
    pool_broken = False
    with ProcessPoolExecutor(
        max_workers=parse_worker_count(kml_files),
        initializer=init_worker,
        initargs=(level, database),
    ) as executor:
        future_to_file = {
            executor.submit(parse, f, cache_paths[f]): f for f in kml_files
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
            # As in _parse_inline: one file's bug, named with its traceback
            except Exception:  # noqa: BLE001
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
            max_workers=1, initializer=init_worker, initargs=(level, database)
        ) as executor:
            for kml_file in remaining:
                try:
                    parsed = executor.submit(
                        parse, kml_file, cache_paths[kml_file]
                    ).result()
                except BrokenProcessPool:
                    raise KMLHeatmapError(
                        f"A parser worker process crashed on {kml_file}, possibly "
                        "out of memory; run with --debug for details"
                    ) from None
                record(parsed)


def _load_or_parse_here(
    valid_files: list[str],
    record: Callable[[ParsedFile], None],
    airports: dict[str, AirportRecord],
) -> None:
    """Read the parse cache in this process and parse what it misses.

    The misses are parsed here as well up to ``INLINE_PARSE_MAX_BYTES``, in
    a process pool beyond.
    """
    # The files to parse, with the cache entry to store each one in
    uncached: list[tuple[str, Path | None]] = []
    for kml_file in valid_files:
        cached = _load_cached(kml_file)
        if isinstance(cached, ParsedFile):
            record(cached)
        else:
            uncached.append((kml_file, cached))

    if (
        uncached
        and _file_bytes([kml_file for kml_file, _ in uncached]) > INLINE_PARSE_MAX_BYTES
    ):
        _parse_in_pool(uncached, record, airports)
    else:
        for kml_file, cache_path in uncached:
            record(_parse_inline(kml_file, cache_path))


@contextlib.contextmanager
def _collector_paused() -> Iterator[None]:
    """Pause the cyclic garbage collector, and freeze what exists after.

    Parsing or loading a few million points creates as many objects, none
    of them part of a cycle, and every few hundred thousand of them the
    collector walks all of them again: at 4.7 million points that took
    close to half the time of loading the parse cache. Afterwards they live
    until the export is written, so they are frozen out of the collector's
    walks (``gc.freeze``) for the rest of the run: sampling the ground under
    them was a third slower otherwise. ``create_progressive_heatmap`` hands
    them back to the collector when it is done.
    """
    enabled = gc.isenabled()
    gc.disable()
    try:
        yield
    finally:
        gc.freeze()
        if enabled:
            gc.enable()


def _parse_kml_files(
    valid_files: list[str],
) -> tuple[FlightPathGroup, list[PathMetadata]]:
    """Parse KML files and merge the results in input order.

    Files the parse cache holds are read from it in this process: a worker
    pool takes longer to start than reading them does, unless there are many
    of them (see ``POOLED_CACHE_MIN_BYTES``), when every file goes to the
    pool. Of the rest, a few small files are parsed here as well (up to
    ``INLINE_PARSE_MAX_BYTES``), anything more in a process pool.

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

    with _collector_paused():
        if (
            default_worker_count() >= POOLED_CACHE_MIN_WORKERS
            and _file_bytes(valid_files) > POOLED_CACHE_MIN_BYTES
        ):
            _parse_in_pool(
                [(kml_file, None) for kml_file in valid_files],
                record,
                airports,
                _load_or_parse,
            )
        else:
            _load_or_parse_here(valid_files, record, airports)

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
        raise InvalidInputError("No coordinates found in any KML files!")
    failed_count = sum(1 for parsed in results if parsed.point_count == 0)
    if failed_count > 0:
        raise InvalidInputError(
            f"{failed_count} of {len(valid_files)} file(s) failed to parse "
            "(see above); fix or remove them"
        )
    without_flight = 0
    for parsed in results:
        reason = _no_flight_reason(parsed)
        if reason is not None:
            logger.error("%s: %s", parsed.kml_file, reason)
            without_flight += 1
    if without_flight > 0:
        raise InvalidInputError(
            f"{without_flight} of {len(valid_files)} file(s) hold no flight to "
            "export (see above); fix or remove them"
        )

    logger.info("\nTotal points: %d", total_points)
    return all_path_groups, all_path_metadata


def _no_flight_reason(parsed: ParsedFile) -> str | None:
    """Why a file with coordinates gives the export no path, None if it does.

    Such a file fails the run like one without coordinates: its points
    count, but the site would be published without its flight. A path
    without a year or one that never moves is only left out while another
    path of the file is exported. A path that the export drops as a
    recording of a flight another file holds as well (see ``duplicates``)
    counts: the flight is on the site.
    """
    if not parsed.path_groups:
        return (
            "no track of two or more points with altitudes above sea level "
            "(a clampToGround or relativeToGround track has none)"
        )
    dated = [
        path
        for path, metadata in zip(parsed.path_groups, parsed.path_metadata, strict=True)
        if metadata.get("year") is not None
    ]
    if not dated:
        return "no track with a determinable year"
    if not any(is_exportable_path(path) for path in dated):
        return "every track with a year stays on one spot"
    return None


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


def _map_extent(
    all_path_groups: FlightPathGroup, exportable: Sequence[bool] | None = None
) -> CoordinateExtent:
    """The extent of the exported paths, which the map is fitted to.

    Only exported paths count: an excluded path would widen the map and give
    away where it was. ``exportable`` tells for every path whether it is
    exported (``is_exportable_path`` when the caller passes nothing). Raises
    when there is nothing to export.
    """
    if exportable is None:
        exportable = [is_exportable_path(path) for path in all_path_groups]
    extent = CoordinateExtent.of(
        point
        for path, exported in zip(all_path_groups, exportable, strict=True)
        if exported
        for point in path
    )
    if extent is None:
        raise InvalidInputError("No flight paths with a determinable year to export")
    return extent


def _export_site(
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    output_file: Path,
    data_dir: Path,
    aircraft_data: dict[str, str] | None = None,
    terrain: TileSource | None = None,
    site_url: str | None = None,
    private: bool = False,
) -> ExportResult:
    """Export the data, render the page and package its assets.

    Everything is staged first and published at the end (see ``SiteOutput``),
    so a failure at any step leaves the previous site in the output as it was.
    ``terrain`` is handed to ``export_all_data``, ``site_url`` (normalized,
    see ``previews.normalize_site_url``) to the link previews.
    """
    all_path_groups, all_path_metadata = _drop_paths_without_year(
        all_path_groups, all_path_metadata
    )
    # Once per path, for every stage that only looks at the exported ones
    exportable = [is_exportable_path(path) for path in all_path_groups]
    # The copies and second recordings of a flight are dropped first: the
    # extent and the airports are those of the paths the site publishes
    selection = select_exported_paths(all_path_groups, all_path_metadata, exportable)
    exported_indices = selection.exported()
    kept = set(exported_indices)
    extent = _map_extent(
        all_path_groups, [index in kept for index in range(len(all_path_groups))]
    )

    # Only exported paths contribute airports: a path that gets no id and no
    # segments (a single point, a recording that never moved, a dropped
    # copy) would still publish its location and name through the airport
    # list
    logger.info("\nProcessing %d start points...", len(exported_indices))
    unique_airports = deduplicate_airports(
        [all_path_metadata[index] for index in exported_indices],
        [all_path_groups[index] for index in exported_indices],
    )
    logger.info("  Found %d unique airports", len(unique_airports))

    # The countries of the exported airports, and the flags the site can
    # publish of them, which metadata.json lists
    countries = exported_country_codes(unique_airports)
    available_flags = available_country_flags(countries)

    data_dir_name = data_dir.name
    with SiteOutput(
        output_file.parent,
        data_dir,
        SITE_FILES,
        SITE_FILE_PATTERNS,
        stable_mtimes=os.environ.get(STABLE_MTIMES_ENV) == "1",
    ) as site:
        result = export_all_data(
            all_path_groups,
            all_path_metadata,
            unique_airports,
            site.data_stage,
            aircraft_data=aircraft_data,
            exportable=exportable,
            terrain=terrain,
            selection=selection,
            available_flags=available_flags,
        )
        # The page opens on the latest year, see resolveYearSelection
        render_html(
            site.site_stage / output_file.name,
            data_dir_name,
            max(result.years, default=None),
            site_url,
            private,
        )
        package_assets(
            site.site_stage,
            extent.as_map_bounds(),
            data_dir_name,
            countries,
        )
        write_previews(
            site.site_stage,
            all_path_groups,
            all_path_metadata,
            result.path_ids,
            exported_airport_names(unique_airports),
            site_url,
        )

        logger.info("\nPublishing the site to %s", output_file.parent)
        site.publish(result.years)

    return result


@dataclass(frozen=True)
class FlightListing:
    """One row of ``--list``: a path of an input file, or a file without one."""

    file: str
    year: int | None = None
    aircraft: str = ""
    airports: str = ""
    points: int = 0
    timed: bool = False
    #: Why the site leaves it out, "" for a path it publishes
    skipped: str = ""


def _listed_airports(metadata: PathMetadata) -> str:
    start, end = metadata.get("start_airport"), metadata.get("end_airport")
    if start or end:
        return f"{start or '?'} - {end or '?'}"
    return metadata.get("airport_name") or ""


def _listed_paths(
    parsed: list[ParsedFile],
) -> tuple[FlightPathGroup, list[PathMetadata], list[str]]:
    """Every path of the parsed files, with the file each came from."""
    paths: FlightPathGroup = []
    metadata: list[PathMetadata] = []
    files: list[str] = []
    for entry in parsed:
        paths.extend(entry.path_groups)
        metadata.extend(entry.path_metadata)
        files.extend([entry.kml_file] * len(entry.path_groups))
    return paths, metadata, files


def _skip_reason(
    index: int,
    exportable: bool,
    selection: ExportSelection,
    exported: set[int],
    metadata: PathMetadata,
) -> str:
    """Why the path at ``index`` is not published, "" when it is."""
    if metadata.get("year") is None:
        return "no determinable year"
    if not exportable:
        return "stays on one spot"
    if index in exported:
        return ""
    # Copies are only looked for within a year (see drop_duplicate_paths)
    content = selection.contents.get(index)
    same_year = selection.paths_by_year.get(metadata.get("year") or 0, [])
    if content is not None and any(
        other in exported and selection.contents.get(other) == content
        for other in same_year
    ):
        return "an exact copy of another file's flight"
    return "the same flight as another recording"


def list_flights(kml_files: Sequence[str]) -> list[FlightListing]:
    """What the site would hold of every file, without writing anything.

    Every path gets a row with its year, aircraft, airports, points and
    whether it has times, and the reason it would be left out; a file that
    is invalid, does not parse or holds no path gets a row of its own. The
    files are parsed as a build parses them (through the parse cache), and
    the copies and second recordings are found the same way
    (``select_exported_paths``). No elevation tile is fetched and nothing
    is written but the parse cache.
    """
    rows: list[FlightListing] = []
    parsed: list[ParsedFile] = []
    # Once, before the files: its download messages come first, and the
    # parse cache keys see the same database as a build
    load_airport_database()
    for kml_file in kml_files:
        is_valid, error_msg = validate_kml_file(kml_file)
        if not is_valid:
            rows.append(FlightListing(kml_file, skipped=error_msg or "not valid"))
            continue
        cached = _load_cached(kml_file)
        entry = (
            cached
            if isinstance(cached, ParsedFile)
            else _parse_inline(kml_file, cached)
        )
        if entry.point_count == 0:
            rows.append(FlightListing(kml_file, skipped="failed to parse"))
        elif not entry.path_groups:
            rows.append(FlightListing(kml_file, skipped=_no_flight_reason(entry) or ""))
        else:
            parsed.append(entry)

    paths, metadata, files = _listed_paths(parsed)
    exportable = [is_exportable_path(path) for path in paths]
    selection = select_exported_paths(paths, metadata, exportable)
    exported = set(selection.exported())
    for index, (path, meta) in enumerate(zip(paths, metadata, strict=True)):
        rows.append(
            FlightListing(
                file=files[index],
                year=meta.get("year"),
                aircraft=meta.get("aircraft_registration")
                or meta.get("aircraft_type")
                or "",
                airports=_listed_airports(meta),
                points=len(path),
                timed=any(point.ts is not None for point in path),
                skipped=_skip_reason(
                    index, exportable[index], selection, exported, meta
                ),
            )
        )
    order = {kml_file: position for position, kml_file in enumerate(kml_files)}
    rows.sort(key=lambda row: order.get(row.file, len(order)))
    return rows


def foreign_output_error(output_file: str | Path, data_dir: str | Path) -> str | None:
    """Why a run must not write into the output directory, None when it may.

    It may not when it would replace files there that no earlier run wrote
    (see ``validation.foreign_site_files``).
    """
    output = Path(output_file)
    found = foreign_site_files(
        output.parent, data_dir, [output.name, *SITE_FILES], SITE_FILE_PATTERNS
    )
    if not found:
        return None
    return (
        f"Refusing to replace {len(found)} file(s) in {output.parent} that no "
        f"earlier run of kml-heatmap wrote, such as {found[0]}: choose another "
        "output directory, or pass --force to replace them"
    )


def create_progressive_heatmap(
    kml_files: list[str],
    output_file: str = "index.html",
    data_dir: str = "data",
    aircraft_files: list[Path] | None = None,
    terrain: TileSource | None = None,
    force: bool = False,
    site_url: str | None = None,
    private: bool = False,
) -> ExportResult:
    """Generate the site: the page, its assets and the data files.

    Returns what the export produced. Raises ``InvalidInputError`` for
    inputs that cannot make a site (a missing or invalid KML file, one
    without a flight, a relative ``site_url``), ``OutputRefusedError`` for an
    output directory it must not write, ``ExportError`` when writing the
    site failed on the way, and ``KMLHeatmapError`` for the rest (a missing
    bundle, a required database or tile that is unavailable). A previous
    site in the output is then left as it was.

    ``terrain`` is where the ground under the flights comes from (see
    ``kml_heatmap.terrain``). The default, None, leaves it out of the year
    files; the command line passes ``TerrariumTiles`` unless told not to.

    An output directory with files of a site that no earlier run wrote (an
    ``index.html`` of its own, see ``foreign_output_error``) is refused
    unless ``force`` is set.

    ``site_url`` is the public address of the site, which its link preview
    images are named by (see ``previews``); None takes it from
    ``KML_HEATMAP_SITE_URL``, and without either the pages go without
    images. ``private`` asks search engines not to index the site (a robots
    meta tag in the page).
    """
    aircraft_files = aircraft_files or []
    try:
        site_url = normalize_site_url(
            site_url if site_url is not None else os.environ.get(SITE_URL_ENV)
        )
    except ValueError as e:
        raise InvalidInputError(str(e)) from None

    # Stage 0: Refuse output directories that overlap with the inputs, a data
    # directory the page could not reach, and a run that could only produce a
    # page without its application
    output_dir = Path(output_file).resolve().parent
    if Path(data_dir).resolve().parent != output_dir:
        raise OutputRefusedError(
            f"The data directory {data_dir} must be directly inside the output "
            f"directory {output_dir}, where the page looks for it"
        )
    is_safe, error_msg = validate_output_dir(output_dir, [*kml_files, *aircraft_files])
    if not is_safe:
        raise OutputRefusedError(error_msg or "Unsafe output directory")
    foreign = None if force else foreign_output_error(output_file, data_dir)
    if foreign:
        raise OutputRefusedError(foreign)

    missing = missing_build_files()
    if missing:
        raise KMLHeatmapError(
            f"JavaScript bundle not found: {', '.join(missing)} (run 'npm run "
            "build' to generate it)"
        )
    warn_about_a_stale_bundle()

    # Stage 1: Validate and parse. A file that cannot be used fails the run:
    # a site published without one of the flights, and exit status 0, would
    # hide it until someone notices the flight is missing. So does a file
    # that parses but holds no flight to export (see _no_flight_reason).
    valid_files = []
    for kml_file in kml_files:
        is_valid, error_msg = validate_kml_file(kml_file)
        if not is_valid:
            logger.error("  %s", error_msg)
        else:
            valid_files.append(kml_file)

    if not valid_files:
        raise InvalidInputError("No valid KML files to process!")
    if len(valid_files) < len(kml_files):
        raise InvalidInputError(
            f"{len(kml_files) - len(valid_files)} of {len(kml_files)} input "
            "file(s) are not valid KML files (see above); fix or remove them"
        )

    logger.info("Parsing %d KML file(s)...", len(valid_files))

    try:
        try:
            all_path_groups, all_path_metadata = _parse_kml_files(valid_files)
        except (ValueError, OSError) as e:
            raise ExportError(str(e)) from e

        # Stage 2: Export the data, the page and the assets
        aircraft_data = merge_aircraft_data(aircraft_files) if aircraft_files else None
        try:
            result = _export_site(
                all_path_groups,
                all_path_metadata,
                Path(output_file),
                Path(data_dir),
                aircraft_data=aircraft_data,
                terrain=terrain,
                site_url=site_url,
                private=private,
            )
        except InvalidInputError, OutputRefusedError:
            raise
        except (ValueError, RuntimeError, OSError, KMLHeatmapError) as e:
            raise ExportError(f"Export failed: {e}") from e

        logger.info(
            "  Serve %s over HTTP to view it (e.g. python -m http.server)", output_file
        )
        return result
    finally:
        # The parsed flights go back to the collector (see _collector_paused)
        gc.unfreeze()
