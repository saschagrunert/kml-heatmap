# Data

The Python side and the data it writes: the package and its locked dependencies,
how the parser joins split tracks and drops second recordings of a flight, how
the groundspeed of a row is averaged, the format of the year files, the
elevation tiles the build samples, and the year worker that decodes the files in
the page. What the files hold is described for users in
[Output and technical details](../output.md).

## Python package and dependencies

The dependencies are declared once, in `pyproject.toml`: the runtime
dependencies plus the `test` and `dev` extras. CI, the container image and the
setup in [CONTRIBUTING.md](../../CONTRIBUTING.md#setup) install the hashed lock
files compiled from it instead (`requirements.lock`, `requirements-test.lock`
and, for the setuptools that builds the package, `requirements-build.lock`), and
the package on top with `--no-deps`, so nothing is resolved from the ranges.
Regenerate the lock files with `make lock` after changing the dependencies. The
test lock is compiled with the runtime lock as a constraint, so a package both
of them pin has the same version in each. `make lock` runs the pip-tools that
`requirements-tools.in` pins, installed from `requirements-tools.lock` with the
hashes of its dependencies, and recompiles that lock last.

### Runtime dependencies

- `lxml` - Fast XML parsing for KML files
- `rcssmin`, `minify-html` - Output minification (HTML/CSS)

## Split tracks and recordings of one flight

`_join_split_lines` in `kml_heatmap/parser_standard.py` joins the `LineString`s
of a file that are one flight in pieces. A line continues the one before it
(`_continues`) when both have the same name, the one before has not landed
(`_ends_on_ground`: it came back down to within 30 m of its lowest altitude
after climbing 150 m above that, or its last three points stand within 15 m of
each other), and the line starts within 50 m of where the one before ended, with
the same time span or within 30 minutes of its end. Without times, or without a
name, only the point of the split written twice (the same longitude, latitude
and altitude) joins them. A document `TimeSpan` over a flight out and one back,
or two untimed flights of a placemark named after the aircraft, stay two
flights. `gx:Track`s are never joined.

After `drop_duplicate_paths` in `kml_heatmap/path_content.py` has dropped the
exact copies, `drop_overlapping_paths` in `kml_heatmap/duplicates.py` drops a
recording of a flight another one of the same year records as well: two timed
recordings are one flight when they overlap in time by more than half of the
shorter one and are within 300 m of each other at 20 moments spread over the
time they share (two of them may be further apart). That holds for recordings on
the real clock, the files of a user who does not obfuscate them. Obfuscated
files, though, start every flight at midnight on January 1st, so two recordings
of one flight line up only if they were started in the same second, and every
flight of a year overlaps every other.

Where one of two recordings starts in the first three days of its year
(`_clock_known`), only the time from its takeoff run to its last landing counts
(`_Timed.moving`, faster than 20 m/s over 10 s), since two flights from one
field stand and taxi in the same places. At 20 moments of the shorter one,
`_clock_shifts` looks up (in a grid of 300 m cells, which also holds the lines
between fixes far apart) when the other passed closest to where it was, and a
shift of the clock that at least three of them agree on to within 5 s is checked
as above, but within 150 m: with the time free, circuits flown at one field on
different days come within 300 m often enough.

The flights of `data/` all start at the same moment, and the two of them that
come closest to one flight (two flights of D-EAGJ at EDAQ) are still apart at 11
of the 20 moments. A copy of each of them with 11 m of noise and a clock of its
own is found for all 103, and for 98 of them when it keeps every tenth fix only.
The recording that names the aircraft stays, its registration first and then its
type, and of two that name as much the one with more points; the warning names
both files. Recordings without times are not compared.

Both drops run in `select_exported_paths` in `kml_heatmap/data_exporter.py`,
before `_export_site` in `kml_heatmap/renderer.py` takes the map extent and the
airports from the paths that are left: a dropped copy or recording neither
widens the map nor adds an airport.

The parser drops XML comments and processing instructions while it reads a file
(`remove_comments` in `_parse_kml_tree`), so a comment inside a `<coordinates>`,
a `<gx:coord>`, a `<when>` or a `<name>` no longer ends its text there; the
obfuscator reads a `<when>` past a comment the same way.

## Groundspeed

The groundspeed of a row is the average over the segments that start within a
minute of it (`SpeedWindow` in `kml_heatmap/segment_calculator.py`,
`SPEED_WINDOW_SECONDS` wide), standing still included. A segment longer than the
window (`outlasts_the_window`: a paused logger, a lost fix) stays out of it,
since it would enter with all of its time and take the minute before it down to
a few knots. Its own row takes the window around its start, or its own speed
where that window is empty, as with a logger that writes a fix every few
minutes. A row without times gets its share of the path's average speed.

## Year file format

The year files are data format 5 (`FORMAT_VERSION` in
`kml_heatmap/segment_codec.py`, `DATA_FORMAT_VERSION` in
`services/yearDecode.ts`; bump both together, the page refuses any other).
Format 5 writes the altitudes in steps of 20 ft instead of 100 ft, which costs
about 4 % more gzipped year files on `data/`, and adds the landings of every
flight with timestamps to its `path_info`: `landings`, `touch_and_goes`,
`go_arounds` and the `touchdowns` as `[airport, runway]`.
`kml_heatmap/landings.py` reads them in the main process of the export from the
full-precision track, with the fields and the runways of the OurAirports
database (`load_runway_database` caches `runways.csv` next to `airports.csv`);
the page only adds them up.

The speed column is written in tenths of a knot, but the exporter rounds the
speeds to whole knots (`exported_knots` in `kml_heatmap/export_pipeline.py`),
which takes an eighth off the compressed year files: the format and the decoder
were the same, so that change took no new version. Times stay at a tenth of a
second, which the replay needs for fixes less than a second apart.

Format 4 added a `ground` column per path: the ground under every row in steps
of 10 ft, as differences like the other columns, left out for a path whose
ground is not known. `kml_heatmap/terrain.py` computes it at build time from the
Terrarium elevation tiles of AWS, shifted to meet the altitudes the flight
recorded taxiing at both ends, so the correction lives in one place and the page
only reads the result (`groundProfileFt` in `calculations/groundProfile.ts`
falls back to the line between the fields without it). The statistics panel
measures the cruise above that ground as well, and says "above field" instead of
AGL when a flight had none and was measured above its own lowest altitude.

### airports.json

`airports.json` is not versioned: the site is always built with its data, and
the page reads it as it is. Its `code` field (the ICAO code in the name,
`airport_icao_code` in `kml_heatmap/airport_lookup.py`, which also merges the
airports) came with format 4 of the year files as an addition: the page shows
the code the export found rather than reading the name again, and an airport
without a code shows none.

## Elevation tiles at build time

The tiles (zoom 10, about 100 KB each) are cached as PNGs in `terrain/` of the
[cache directory](../output.md#cache-directory) and decoded by a small
pure-Python PNG reader in a process pool; `data/` needs 389 of them, 44 MB. The
decoded pixels of a tile are kept next to its PNG (`<tile>.pixels`, compressed
with zstd, checked against its CRC), so a later build reads them in a fraction
of a millisecond instead of decoding the PNG again. A tile is only cached once
its every chunk checks out, so a download cut short is fetched again rather than
kept. A failed request or a server error is tried again three times, with pauses
of 1, 2 and 4 s. When the last attempt could not reach the host at all, the host
is given up for the run. A server error only costs that tile, unless three tiles
in a row (across the fetch threads, without a tile that got through between
them) used up their attempts on server errors: then the host is given up as
well, rather than every tile of the run spending its attempts and pauses. Each
fetch thread keeps one connection to the host, through the proxy that
`HTTPS_PROXY` names unless `NO_PROXY` exempts the host, and a redirect away from
the host or from https is refused. Offline, or for a tile that cannot be
fetched, the build goes on and the flights under it get no ground; one warning
says how many. `KML_HEATMAP_REQUIRE_TERRAIN=1` fails it instead, which the CI
job that deploys the site sets. The ground is sampled once in the main process
and kept as one array of elevations per path, aligned with its points
(`sample_path_elevations`), which is what the export chunks are handed: a
million points take tens of megabytes this way, where a mapping of coordinates
took more than a gigabyte. `--no-terrain` skips the tiles altogether, which
`scripts/build_visual_site.py` does: its snapshots show no 3D view. The CI jobs
that build from `data/` restore the tile cache with `actions/cache`.

## The year worker

`yearWorker.bundle.js` is a build of its own and shares nothing with the others:
it is everything that works on the year files, and on the heat sources made of
them. The page imports it next to the first year file
(`services/dataLoader.ts`), and the file then starts itself a second time as a
module worker, which parses and decodes the year files off the main thread and
hands the columns back as typed arrays; the page builds its dataset from them a
few milliseconds at a time (`services/yearDecoder.ts`,
`services/yearDataset.ts`). The worker also draws the heatmap's heat and writes
the GeoJSON of the heat sources, which MapLibre's worker reads from Blob URLs
(see
[The heat sources and the year worker](heat.md#the-heat-sources-and-the-year-worker)).
Where the worker cannot be used, the same code runs on the main thread.
