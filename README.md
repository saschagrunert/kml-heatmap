# KML Heatmap Generator

> Create interactive heatmap visualizations from KML files.

[![Demo](https://img.shields.io/badge/live-demo-blue.svg)](https://saschagrunert.github.io/kml-heatmap)
[![Coverage](https://codecov.io/gh/saschagrunert/kml-heatmap/badge.svg?token=AxIuoWeFSy)](https://codecov.io/gh/saschagrunert/kml-heatmap)

## Table of Contents

- [Features](#features)
- [Usage](#usage)
  - [Requirements](#requirements)
  - [Quick Start](#quick-start)
  - [KML File Naming Convention](#kml-file-naming-convention)
  - [Aircraft Model Data](#aircraft-model-data)
  - [Multiple Directories](#multiple-directories)
  - [With API Keys (Optional)](#with-api-keys-optional)
  - [Makefile Variables and Targets](#makefile-variables-and-targets)
  - [Docker Usage](#docker-usage)
  - [Python Usage](#python-usage)
  - [Command-Line Options](#command-line-options)
- [Privacy](#privacy)
- [Output](#output)
- [Map Features](#map-features)
  - [Layers](#layers)
  - [Controls](#controls)
  - [Filtering](#filtering)
  - [Shareable URLs](#shareable-urls)
  - [Smart Features](#smart-features)
- [Technical Details](#technical-details)
- [Development](#development)
- [Contributing and Security](#contributing-and-security)

## Features

- Interactive density heatmap showing visited locations
- Altitude and groundspeed colored flight paths
- Airport markers with ICAO codes and visit counts
- Statistics panel (distance, altitude, flight time)
- Year and aircraft filtering
- Flight replay with animated airplane marker
- Year-in-review "Wrapped" summary
- Shareable URLs that encode the exact map state
- Privacy protection: no flight date finer than the year reaches the
  generated site
- Mobile-friendly with year-based data organization
- Export map as JPG image

## Usage

### Requirements

- Python 3.14 (see `.python-version`) and Node.js 26 or newer (see `.nvmrc`)
- podman or docker for `make build`/`serve` (auto-detected, podman first)

### Quick Start

Place your KML files in a `data/` directory in the repository root (the
`Makefile` requires it to exist), then:

```bash
# Build the container image and generate docs/ from data/
make

# Option 1: open directly in the browser (file:// works)
open docs/index.html

# Option 2: serve over HTTP (does not rebuild)
make serve
# Then open http://127.0.0.1:8000/
```

Both methods work equally well. `make serve` only serves the existing `docs/`
directory; run `make build` (or `make serve-build`) to regenerate it first.
`docs/` is a local build output and is not committed: the published site is
built from the sources in CI once all tests pass (see [Development](#development)).

Your KML files are read and left alone. The generated site carries no flight
date finer than the year whatever they contain, so nothing has to be stripped
from them first (see [Privacy](#privacy)). To scrub the files themselves as well,
pass `--obfuscate-inputs` or run `make obfuscate`; that rewrites them in place
and cannot be undone, so keep a copy of the originals.

### KML File Naming Convention

The tool detects and supports **two KML filename formats**. The extension is
matched case-insensitively (`.kml` and `.KML`).

#### SkyDemon Format

```
N_REGISTRATION_TYPE.kml
```

**Example:** `1_DEHYL_DA40.kml`

Where:

- `N` - Sequential flight number (e.g., `1`, `42`, `87`)
- `REGISTRATION` - Aircraft registration without hyphen. The hyphen is restored
  from a table of ICAO registration prefixes (`DEHYL` becomes `D-EHYL`, `OEAKI`
  becomes `OE-AKI`)
- `TYPE` - Aircraft type (e.g., `DA40`, `C172`)

An extra underscore in the name is tolerated. Flight dates are not included in
filenames for privacy. Files are numbered sequentially in chronological order
and processed in numeric order.

#### Charterware Format

```
YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE.kml
```

**Example:** `2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml`

Where:

- `YYYY-MM-DD` - Flight date with hyphens (validated)
- `HHMMh` - Flight time with 'h' suffix (validated)
- `REGISTRATION` - Aircraft registration with hyphen (e.g., `OE-AKI`, `D-EXYZ`)
- `ROUTE` - Route in DEPARTURE-ARRIVAL format (e.g., `LOAV-LOAV`, `EDDF-EDDM`)

The flight date used for the year filter is taken from the `<description>`
element of the file, not from the filename.

Obfuscating the files renames them (see [Privacy](#privacy)): the date becomes
January 1st of the same year and the time slot a sequence number per year and
directory, written as a time (`0000h`, `0001h`, ..., `0059h`, `0100h`). The
example becomes `2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml`, and the next flight of
2026 in the same directory `2026-01-01_0001h_...`. Files are numbered in the
order of their original names, after the highest number already present, so the
names keep sorting in flight order. An existing file is never replaced.

**Note:** Charterware KML files do not include per-point timestamps. As
coordinates are not at fixed intervals, the tool does not attempt to infer
timing or speed data for Charterware files. The Speed layer and the flight time
statistics are unavailable when viewing Charterware-only data. Altitude
visualization, path selection, and all other features remain available.

### Aircraft Model Data

Aircraft model names are resolved from an `aircraft.json` file, a manually
maintained mapping of registrations to full model names. The file is looked up
in every input directory:

```json
{
  "D-EAGJ": "Diamond DA-20A-1 Katana",
  "D-EHYL": "Diamond DA-40TDI Diamond Star"
}
```

When adding a new aircraft, add its registration and model to this file.

**Why these formats?**

The filename formats enable:

- **Aircraft filtering** - Filter map by specific aircraft registration
- **Per-aircraft statistics** - View distance and flight time per aircraft
- **Aircraft model lookup** - Full model names from `aircraft.json`
- **Route information** - Charterware files include departure and arrival airports

**Without these formats:**

Files will still be processed and paths will be displayed, but:

- Aircraft filtering will not be available
- Per-aircraft statistics will be grouped under "Unknown"
- Aircraft model information will not be available

### Multiple Directories

You can process KML files from several files and directories at once.
Directories are scanned with their subdirectories:

```bash
python -m kml_heatmap data/ data-new/ extra_flight.kml --output-dir combined
```

The tool detects the format of each file and processes them accordingly.

### With API Keys (Optional)

**OpenAIP** - Get a free API key at [openaip.net](https://www.openaip.net/) for
the aviation data overlay (airspaces, airports, navaids). **Required** for the
Aviation Data layer.

**CARTO** - A CARTO API key avoids watermarked base map tiles.

```bash
# Pass the keys on the command line or export them in the environment
make CARTO_API_KEY=your_carto_key OPENAIP_API_KEY=your_openaip_key

# Then serve
make serve
```

The keys are embedded in the generated `map_config.js`, which is published with
the site. Treat them as public client-side keys and restrict them to your
site's domain (referrer restriction) in the CARTO and OpenAIP dashboards. The
`site` job of the `test` workflow reads them from the `CARTO_API_KEY` and
`OPENAIP_API_KEY` repository secrets.

**Note:** OpenAIP tiles return 403 Forbidden without a valid API key. To verify
your key works:

```bash
# Should return HTTP 200 with PNG image
curl -I "https://a.api.tiles.openaip.net/api/data/openaip/8/136/85.png?apiKey=YOUR_KEY"
```

### Makefile Variables and Targets

Variables:

- `CONTAINER_RUNTIME` - Container runtime; auto-detects `podman`, then `docker`
- `INPUT_DIR` - Directory with the KML files (default: `data`)
- `OUTPUT_DIR` - Output directory (default: `docs`); it must not be `INPUT_DIR`,
  lie inside it or contain it, and the two need different base names
- `CACHE_DIR` - Host directory mounted as `/cache` (default: `~/.cache/kml-heatmap`)
- `HOST_BIND` - Address `make serve` binds on the host (default: `127.0.0.1`; use `0.0.0.0` for the local network)
- `PORT` - Host port for `make serve` (default: `8000`)
- `CARTO_API_KEY`, `OPENAIP_API_KEY` - Tile API keys (passed by name, never printed)

Targets (`make help` prints this list with the current variable values):

- `build` - Build the image and generate `OUTPUT_DIR` from `INPUT_DIR` (leaves the input KML files alone)
- `serve` - Serve `OUTPUT_DIR` on `http://HOST_BIND:PORT` (run `make build` first)
- `serve-build` - Run `build`, then `serve`
- `test` - Run the JavaScript and Python test suites with coverage
- `lint` - Run linters and type checkers
- `format` - Run formatters
- `lock` - Regenerate `requirements.lock` and `requirements-test.lock` from `pyproject.toml` with pip-compile
- `obfuscate` - Rewrite the KML files in `INPUT_DIR` in place so they carry no real dates (irreversible)
- `check-obfuscation` - Check that the KML files in `INPUT_DIR` are obfuscated
- `clean` - Remove the container image (when a runtime is available) and local build artifacts
- `help` - Show available targets and variables

Only `build`, `serve` and `clean` need podman or docker. The rest (`test`,
`lint`, `format`, `lock`, `obfuscate`, `check-obfuscation`, `help`) run
locally. With docker the
containers run as your user id so that generated files are not owned by root;
with rootless podman the Makefile adds `--userns=keep-id` so that the same user
id works inside the container.

### Docker Usage

If you prefer using Docker directly. Input files are read and left alone (pass
`--obfuscate-inputs` to rewrite them too). Mount the OurAirports cache so it is
not downloaded on every run, and run as your user id so the output is owned by
you (add `--userns=keep-id` with rootless podman):

```bash
# Build the image
docker build -t kml-heatmap .
mkdir -p out ~/.cache/kml-heatmap

# Generate out/ from the KML files in data/
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD/data:/data/data" -v "$PWD/out:/data/out" \
  -v ~/.cache/kml-heatmap:/cache \
  kml-heatmap data --output-dir out

# With API keys (inherited from the environment, values are not echoed)
docker run --rm --user "$(id -u):$(id -g)" -e CARTO_API_KEY -e OPENAIP_API_KEY \
  -v "$PWD/data:/data/data" -v "$PWD/out:/data/out" \
  -v ~/.cache/kml-heatmap:/cache \
  kml-heatmap data --output-dir out

# Debug output
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD/data:/data/data" -v "$PWD/out:/data/out" \
  -v ~/.cache/kml-heatmap:/cache \
  kml-heatmap --debug data --output-dir out

# Serve the generated site on http://127.0.0.1:8000/ (mounts docs/ only)
docker run --rm -p 127.0.0.1:8000:8000 -e BIND_HOST=0.0.0.0 \
  -v "$PWD/docs:/data:ro" --entrypoint python kml-heatmap /app/serve.py
```

The image runs as an unprivileged user, uses `/data` as its working directory
and `KML_HEATMAP_CACHE_DIR=/cache`. `serve.py` serves `/data` and reads
`BIND_HOST` (default `127.0.0.1`, hence `0.0.0.0` inside the container), `PORT`
(default `8000`) and `CORS_ORIGIN` (unset by default).

### Python Usage

From a fresh clone, build the frontend bundle first (it is not committed, and
the generator refuses to run without it):

```bash
npm ci && npm run build

pip install .                     # the runtime dependencies from pyproject.toml
python -m kml_heatmap your_track.kml   # writes docs/; use --output-dir for another place

# Option 1: open directly
open docs/index.html

# Option 2: serve over HTTP
python -m http.server 8000 --bind 127.0.0.1 -d docs
```

`pip install .` also provides the `kml-heatmap` console script and ships the
templates and static assets. `python kml-heatmap.py` still works as a legacy
wrapper.

### Command-Line Options

```
kml-heatmap [--output-dir DIR] [--debug] [--obfuscate-inputs] [--version] path [path ...]
```

- `path` - KML files and/or directories. Directories are scanned with their
  subdirectories for `.kml` files (case-insensitive) and processed in numeric
  order per directory. `aircraft.json` is looked up in every input directory.
  A path that does not exist is an error.
- `--output-dir DIR` - Output directory (default: `docs`). The tool refuses to
  run if the output directory is the directory of an input file or contains
  one, or is a directory it must never clean out (`/`, the home directory).
  An output directory below the input directory is fine, so
  `kml-heatmap flight.kml` in the file's directory writes to `./docs/`.
- `--debug` - Show debug output
- `--obfuscate-inputs` - Also rewrite the input KML files themselves, in place
  and irreversibly, so that the files on disk carry no real dates either. Off
  by default: the generated site never carries a flight date finer than the
  year whatever the inputs hold (see [Privacy](#privacy)), so this is about the
  KML files, not about what gets published. Keep a copy of the originals first.
- `--version` - Show the version and exit

Every file is written into a hidden staging directory inside the output first
and moved into place only when the whole site was generated, so a run that
fails while generating leaves the previous site untouched. Only a failure
while the finished files are moved into place (a disk filling up in that
moment) can leave a mix, which the next run repairs. Two runs cannot write
to one output directory at the same time; the second one stops. Afterwards the
tool removes only its own files that the new site no longer has (the files of
years that dropped out, a stale `mapApp.bundle.js.map`) and leaves anything
else in the output directory alone. It never writes through a symlink: a
symlink in place of one of its files stops the run.

The exit status is 1 when no site could be generated: a missing input path, a
missing JavaScript bundle, an input file that is not valid KML or cannot be
parsed (such as an empty file or a symlink), no flight with a determinable
year, or an error such as an unwritable output directory.

## Privacy

**The generated site carries no flight date finer than the year.** Flight
paths keep only relative seconds since the start of each flight, which is
enough for the replay and the speed colours; a flight keeps its year, and
nothing else. That holds whatever the input files contain, so nothing has to be
done to them before generating a site. The site shows where you have been and
how much you have flown, but not when.

The one full date it does carry is when it was built: `map_config.js` holds
the build time (UTC, to the minute) and the short hash of the commit it was
built from, and the statistics panel shows both. A site built right after a
flight therefore hints at when that flight was. Set `SOURCE_DATE_EPOCH` to
stamp a different time. The commit is `KML_HEATMAP_COMMIT` (with its remote in
`KML_HEATMAP_REPOSITORY`, which `make build` sets from your checkout), else
`GITHUB_SHA` on GitHub Actions, else `HEAD` of the checkout the tool runs
from. The hash links to the commit on GitHub only when the repository is
known.

**Your input files are read and left alone** unless you pass
`--obfuscate-inputs`, which cannot be undone.

### Obfuscating the KML files themselves

That is a separate need: this repository commits the files in `data/`, and
they must not carry real dates. `--obfuscate-inputs`, or
`python -m kml_heatmap.obfuscate <dir>` on its own, rewrites them in place
(atomically, after validation). Timestamps are shifted to January 1st of their
year while keeping the intervals between points; a file holding flights on
several dates moves each of them to January 1st of its own year. Date-bearing
names, descriptions, Charterware file names and the creator field are
replaced. Read-only files and symlinks are reported instead of rewritten.
Obfuscated KML files still contain:

- The year of each flight
- The UTC time of day and the durations between points
- Full precision coordinates and altitudes
- The order of the flights (from the file numbering)

`python -m kml_heatmap.obfuscate <dir> --check` verifies a directory: every
flight must start on January 1st, and no other date may appear anywhere in a
file or its name, except the two days after January 1st that a flight past
midnight runs into. Timestamps within one Placemark, or no more than 12 hours
apart, count as one flight and are never split; a recording that runs longer
than those days fails the check rather than being cut in two. When a date
cannot be removed (in a file name, say, or an element the tool does not
rewrite), the rewrite lists it and stops rather than leaving a file half
scrubbed.

### What reaches the site

Kept in the site:

- Coordinates, altitudes, distances, groundspeeds
- Airport visit counts
- Flight time per year and per aircraft

Removed from the site:

- Individual flight dates and times

The CARTO and OpenAIP keys are public client-side tile keys. They are embedded
in the generated `map_config.js` and published with the site by design, because
the browser needs them to load the base map and the Aviation Data layer. The
generated site is not committed; the keys live in the repository secrets and in
the deployed site only.

## Output

The output directory contains the page, the frontend bundles with their
source maps, the third-party code the page loads, static assets and a `data/`
directory with one file per year:

```
output-dir/
├── index.html
├── mapApp.bundle.js
├── mapApp.bundle.js.map
├── features.bundle.js     # Replay and Wrapped, fetched on first use
├── features.bundle.js.map
├── map_config.js          # Map defaults, tile API keys and the build stamp
├── styles.css             # Linked in the page
├── features.css           # Replay and Wrapped, fetched with their bundle
├── manifest.json
├── favicon.svg
├── favicon.ico
├── favicon-192.png
├── favicon-512.png
├── apple-touch-icon.png
├── vendor/                # Leaflet, leaflet.heat, dom-to-image
│   ├── leaflet.js
│   ├── leaflet.css
│   ├── leaflet-heat.js
│   ├── dom-to-image.min.js
│   └── images/            # The marker and layer icons leaflet.css asks for
├── flags/                 # One SVG per country the flights touched
└── data/
    ├── airports.js        # window.KML_AIRPORTS: airport markers
    ├── metadata.js        # window.KML_METADATA: years, file sizes, speed range, models, flags
    ├── 2025/
    │   └── data.js        # window.KML_DATA_2025
    └── 2026/
        └── data.js        # window.KML_DATA_2026
```

Each year file sets `window.KML_DATA_<YEAR>` to an object with `format`,
`year`, `original_points`, `path_info` and `segments`. `format` is the wire
format of the rows, which the page checks before reading them so a file
written by another release is refused rather than misread. `path_info` lists
the flights in input order, each with its id, year, airports, aircraft and
exact altitude range; where a flight starts and ends is read from its
segments. `segments` maps a path id to `{"start": [lat, lon], "rows": [...]}`,
where each row is `[lat, lon, altitude_ft, groundspeed_knots, time]` and
`time` (relative seconds) is only present for files with timestamps.

The coordinate in a row is the segment's **end** point. Its start is the end
of the previous row, and the first row continues from `start`, so a shared
point is stored once instead of twice. Coordinates are rounded to five
decimals (about 1 m), and the only segments the exporter drops are the ones
whose two endpoints round to the same coordinate (standing still), which keeps
the rows contiguous.

Every value above is written as an integer difference to the row before it
rather than as the number itself (`kml_heatmap/segment_codec.py`, mirrored by
`expandYearData` in `services/dataLoader.ts`). The exporter has already
rounded each column to a fixed number of decimals, so scaling it by that
power of ten is exact, and neighbouring rows barely differ: the encoding is
lossless and roughly halves a year file. The numbers the page works with are
the ones described above; only the file is written this way.

`metadata.js` lists the available years, the size of each year file
(`year_file_bytes`) so the frontend can show loading progress, the groundspeed
range of the speed scale and the model names `aircraft.json` knows for the
exported aircraft (`aircraft_models`). It carries no statistics: the frontend
computes them from the year files for the active year, aircraft and selection.
Flights without a recognizable year are skipped instead of being grouped under
an "unknown" year, and the map bounds in `map_config.js` cover only the
exported flights. Airport entries carry no flight count: the frontend derives
one per airport from the active year and aircraft filter.

Data is exported as JavaScript files (instead of JSON) for compatibility with
the `file://` protocol. It is organized by year and loaded on demand.

## Map Features

### Layers

- **Density Heatmap** (toggle) - Shows frequently visited locations
- **Altitude** (toggle) - Paths coloured by elevation, on a scale that runs
  purple through magenta to orange
- **Speed** (toggle) - Paths coloured by groundspeed, on a scale that runs
  blue through green to yellow. The two scales share no hue, so a map or an
  exported image says which of them is drawn without its legend; both
  brighten from end to end, so they survive being printed in grey
- **Airports** (toggle) - Airport markers with ICAO codes
- **Aviation Data** (toggle, requires OpenAIP API key) - Airspaces, airports, navaids, and reporting points from OpenAIP

### Controls

- **Stats** - View statistics (distance, altitude, airports, flight time). Flight time runs from the first to the last recorded point that moved at the exported precision (about 1 m), so standing perfectly still before and after is not counted, while GPS noise on the ground still is
- **Export** - Save the current map view as a JPG image
- **Copy link** - Share the current URL (native share dialog where available, otherwise copied to the clipboard)
- **Wrapped** - View the year-in-review summary; Escape closes it
- **Replay** - Animate one flight with adjustable speed (default 50x) and an auto-zoom button that follows the airplane. The whole track is drawn dimmed and the flown part paints over it in the colours of the active scale. Replay needs exactly one selected flight with timing data; a toast explains why it is unavailable otherwise
- A map attribution, on the map at every width; it steps aside only while a sheet or the statistics panel covers the map it credits. There are no zoom buttons: use the scroll wheel, pinch, double click, or the keyboard once the map has focus
- Below 768 px the two control columns are replaced by a bottom bar with five tabs. Layers, Filter and More open a sheet; Stats and Wrapped open their panel directly. Escape closes an open sheet, and Tab stays inside it. Replay takes over the bottom edge and the bar steps aside until it ends

### Filtering

- **Year Filter** - View flights from specific years or all years combined
- **Aircraft Filter** - Filter by aircraft registration to see flights per aircraft
- **Path Selection** - Click paths to highlight and view detailed statistics. A chip at the top of the map says how many flights are selected and clears them again, which is also the only sign of a selection at the zoom levels that draw the heatmap alone
- **Airport Selection** - Click an airport marker to select all flights that visited it; click the map to clear the selection
- **Solo Mode** - Isolate selected paths, hiding all other paths and heatmap data

### Shareable URLs

Map state is encoded in the URL for easy sharing. Copy the URL from your
browser's address bar or use the copy-link button:

- Specific year or all years (`?y=2025` or `?y=all`)
- Aircraft filter (`?a=D-EAGJ`)
- Selected paths (`?p=695806902132,104044549516&sv=3`). A path id is derived
  from the flight's coordinates and altitudes, so a link keeps selecting the
  same flights after the site is regenerated with other flights added or
  removed; a flight that is no longer there is dropped from the selection.
  `sv` is the version of the id scheme: links written before version 3, when
  ids were positions in the export, lose their selection instead of selecting
  different flights
- Layer visibility (9 flags: heatmap, altitude, speed, airports, aviation, stats, wrapped, an unused legacy slot, isolateSelection). The 8th slot belonged to a control-visibility toggle that no longer exists; it is always written as `0` and kept so older shared links still read their isolate flag from the 9th
  - Example: `?v=100100000`
- Map position (`?lat=51.5&lng=13.4&z=10`)
- Debug logging in the browser console (`?debug=true`)

**Example URLs:**

```
?y=all                                   # Show all years
?y=2025&v=010000000                      # 2025 with the altitude layer only
?y=2025&a=D-EAGJ&lat=51.5&lng=13.4&z=10  # Complete state
```

URL parameters take precedence over localStorage, allowing shared links to
override saved preferences.

### Smart Features

- Mid-flight detection - Filters recordings started mid-flight
- Airport deduplication - Merges nearby airports (within 1.5km)
- ICAO validation - Only shows valid airports with ICAO codes
- Parallel processing - Fast parsing and export of multiple files
- State persistence - Saves to localStorage and syncs with URL for shareable links
- Year-based organization - Extracts and organizes flights by year
- Per-aircraft statistics - Tracks flight time and distance per aircraft registration
- Aircraft model lookup - Resolves full aircraft model names from `aircraft.json`

## Technical Details

### Airport Database

Airport names and coordinates come from the
[OurAirports](https://ourairports.com/) CSV, which is downloaded on the first
run and cached for 30 days in `~/.cache/kml-heatmap` (override with
`KML_HEATMAP_CACHE_DIR`; the container image uses `/cache`). Mount the cache
directory as the `Makefile` does (`-v ~/.cache/kml-heatmap:/cache`) to avoid
downloading it on every container run. The same directory holds a per-file
parse cache (`kml/`) keyed by file name and content, the parser code and the
airport database, so unchanged KML files are not parsed again; entries unused
for 30 days are removed.

Without the database the site is still generated, with the airport names as
the KML files spell them and without countries. Set
`KML_HEATMAP_REQUIRE_AIRPORT_DB=1` to fail instead, as CI does for the
published site.

### Data Export

The tool exports all flight data without downsampling:

- **Full fidelity**: Every recorded movement is preserved. Coordinates are
  written with five decimals (about 1 m), far finer than the map can show;
  only points that do not move at that precision (standing still) are dropped
- **Year-based splitting**: Data is organized by year for efficient filtering
- **On-demand loading**: Only requested years are loaded into the browser
- **Compact format**: Paths are stored as a start point plus one row per
  segment, each holding only its end point (see [Output](#output))
- **Stable path ids**: A path id is a 40-bit hash of the path's coordinates,
  rounded as exported, and altitudes; a duplicate flight takes the next free
  id in input order. Ids survive regenerating the site, so shared links and
  saved selections keep their flights
- **Reproducible output**: The files do not depend on the number of CPU cores
  or on how the years were split for the workers

Parsing and the per-year export run in a process pool, so large collections
scale with the number of CPU cores. See
[`scripts/README.md`](scripts/README.md) for the sizes used in performance
testing and the measured processing time for 100,000 files.

Supports KML files from Google Earth, Google Maps, SkyDemon, Charterware, and
other aviation apps.

## Development

`make help` lists all targets. See [DEVELOPMENT.md](DEVELOPMENT.md) for the
frontend and backend workflows, the test commands, the build output and the
test data generator, and [CONTRIBUTING.md](CONTRIBUTING.md) for the local setup
and the commit conventions.

Nothing generated is committed: `docs/` is only the default output directory of
a local `make build`, and the published site is built from the sources on every
push to `main`.

## Contributing and Security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and
[SECURITY.md](SECURITY.md) for how to report vulnerabilities.
