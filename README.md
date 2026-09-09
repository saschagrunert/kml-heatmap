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
  - [Frontend (TypeScript)](#frontend-typescript)
  - [Backend (Python)](#backend-python)
  - [Test Data Generation](#test-data-generation)
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
- Privacy protection: absolute timestamps never reach the generated site
- Mobile-friendly with year-based data organization
- Export map as JPG image

## Usage

### Requirements

- Python 3.14 (see `.python-version`) and Node.js 24 (see `.nvmrc`)
- podman or docker for the `make` targets (auto-detected, podman first)

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

**Warning:** the tool rewrites the KML files in `data/` in place to remove
flight dates (see [Privacy](#privacy)). Keep a copy of the originals if you
need the real timestamps.

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
Directories are scanned non-recursively:

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

The keys are embedded in `docs/map_config.js`, which is published with the site
and committed to git. Treat them as public client-side keys and restrict them to
your site's domain (referrer restriction) in the CARTO and OpenAIP dashboards.

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
- `OUTPUT_DIR` - Output directory (default: `docs`)
- `CACHE_DIR` - Host directory mounted as `/cache` (default: `~/.cache/kml-heatmap`)
- `HOST_BIND` - Address `make serve` binds on the host (default: `127.0.0.1`; use `0.0.0.0` for the local network)
- `PORT` - Host port for `make serve` (default: `8000`)
- `CARTO_API_KEY`, `OPENAIP_API_KEY` - Tile API keys (passed by name, never printed)

Targets (`make help` prints this list with the current variable values):

- `build` - Build the image and generate `OUTPUT_DIR` from `INPUT_DIR` (obfuscates the input KML files in place)
- `serve` - Serve `OUTPUT_DIR` on `http://HOST_BIND:PORT` (run `make build` first)
- `serve-build` - Run `build`, then `serve`
- `test-image` - Build the test image (Python and Node toolchain)
- `test` - Run the JavaScript and Python test suites in the test image
- `lint` - Run linters and type checkers in the test image
- `format` - Run formatters in the test image
- `lock` - Regenerate `requirements.lock` and `requirements-test.lock` with pip-compile in the test image
- `check-obfuscation` - Check that the KML files in `INPUT_DIR` are obfuscated (in the test image)
- `check-obfuscation-local` - Same check with the local Python
- `lint-local`, `format-local`, `test-local` - Same as above with local tools
- `verify` - Rebuild `OUTPUT_DIR` and fail if it differs from git (modified or untracked files)
- `clean` - Remove container images (when a runtime is available) and local build artifacts
- `help` - Show available targets and variables

Only the container based targets need podman or docker; `help` and the `*-local`
targets work without one. With docker the containers run as your user id so
that generated files are not owned by root; with rootless podman the Makefile
adds `--userns=keep-id` so that the same user id works inside the container.

### Docker Usage

If you prefer using Docker directly. Input files are obfuscated in place. Mount
the OurAirports cache so it is not downloaded on every run, and run as your user
id so the output is owned by you (add `--userns=keep-id` with rootless podman):

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

From a fresh clone, build the frontend bundles first (they are not committed):

```bash
npm ci && npm run build

pip install -r requirements.txt   # or: pip install .
python -m kml_heatmap your_track.kml --output-dir out

# Option 1: open directly
open out/index.html

# Option 2: serve over HTTP
python -m http.server 8000 --bind 127.0.0.1 -d out
```

`pip install .` also provides the `kml-heatmap` console script and ships the
templates and static assets. `python kml-heatmap.py` still works as a legacy
wrapper.

### Command-Line Options

```
kml-heatmap [--output-dir DIR] [--debug] [--version] path [path ...]
```

- `path` - KML files and/or directories. Directories are scanned
  non-recursively for `.kml` files (case-insensitive) and processed in numeric
  order. `aircraft.json` is looked up in every input directory.
- `--output-dir DIR` - Output directory (default: current directory). The tool
  refuses to run if the output `data/` directory would overlap any input
  directory, and it deletes only its own files there (`airports.js`,
  `metadata.js`, `<year>/data.js`). From the repository root use
  `--output-dir docs`, as the `Makefile` does.
- `--debug` - Show debug output
- `--version` - Show the version and exit

## Privacy

**The tool rewrites your input KML files in place** (atomically, after
validation) so that the files committed to this repository never contain real
flight dates. Timestamps are shifted to January 1st of their year while keeping
the intervals between points, and date-bearing names, descriptions and the
creator field are replaced.
Obfuscated KML files still contain:

- The year of each flight
- The UTC time of day and the durations between points
- Full precision coordinates and altitudes
- The order of the flights (from the file numbering)

The generated site in `docs/` contains no absolute timestamps at all. Flight
paths carry only relative seconds since the start of each flight, which is
enough for the replay and speed features. The site shows where you have been
and how much you have flown, but not when.

Kept in the site:

- Coordinates, altitudes, distances, groundspeeds
- Airport visit counts
- Flight time per year and per aircraft

Removed from the site:

- Individual flight dates and times

The CARTO and OpenAIP keys are public client-side tile keys. They are embedded
in `docs/map_config.js`, published with the site and committed to git by design,
because the browser needs them to load the base map and the Aviation Data layer.

## Output

The output directory contains the page, the frontend bundles with their source
maps, static assets and a `data/` directory with one file per year:

```
output-dir/
├── index.html
├── bundle.js
├── bundle.js.map
├── mapApp.bundle.js
├── mapApp.bundle.js.map
├── map_config.js          # Map defaults and the tile API keys
├── styles.css
├── manifest.json
├── favicon.svg
├── favicon.ico
├── favicon-192.png
├── favicon-512.png
├── apple-touch-icon.png
└── data/
    ├── airports.js        # window.KML_AIRPORTS: airport markers
    ├── metadata.js        # window.KML_METADATA: statistics, years, year_file_bytes
    ├── 2025/
    │   └── data.js        # window.KML_DATA_2025
    └── 2026/
        └── data.js        # window.KML_DATA_2026
```

Each year file sets `window.KML_DATA_<YEAR>` to an object with `year`,
`original_points`, `path_info` and `segments`. `segments` maps a path id to a
list of `[lat1, lon1, lat2, lon2, altitude_ft, groundspeed_knots, time]`
entries, where `time` (relative seconds) is only present for files with
timestamps. `metadata.js` lists the available years, the statistics and the
size of each year file (`year_file_bytes`) so the frontend can show loading
progress. Flights without a recognizable year are skipped instead of being
grouped under an "unknown" year.

Data is exported as JavaScript files (instead of JSON) for compatibility with
the `file://` protocol. It is organized by year and loaded on demand.

## Map Features

### Layers

- **Density Heatmap** (toggle) - Shows frequently visited locations
- **Altitude** (toggle) - Color-coded paths by elevation
- **Speed** (toggle) - Color-coded paths by groundspeed
- **Airports** (toggle) - Airport markers with ICAO codes
- **Aviation Data** (toggle, requires OpenAIP API key) - Airspaces, airports, navaids, and reporting points from OpenAIP

### Controls

- **Stats** - View statistics (distance, altitude, airports, flight time)
- **Export** - Save the current map view as a JPG image
- **Share** - Share the current URL (native share dialog where available, otherwise copied to the clipboard)
- **Wrapped** - View the year-in-review summary; Escape closes it
- **Replay** - Animate one flight with adjustable speed (default 50x) and an auto-zoom button that follows the airplane. Replay needs exactly one selected flight with timing data; a toast explains why it is unavailable otherwise
- **Hide buttons** - Hide the control buttons for an unobstructed map
- **Zoom control** and a visible map attribution
- Below 768 px the layout switches to a mobile arrangement of the panels and buttons

### Filtering

- **Year Filter** - View flights from specific years or all years combined
- **Aircraft Filter** - Filter by aircraft registration to see flights per aircraft
- **Path Selection** - Click paths to highlight and view detailed statistics
- **Airport Selection** - Click an airport marker to select all flights that visited it; click the map to clear the selection
- **Solo Mode** - Isolate selected paths, hiding all other paths and heatmap data

### Shareable URLs

Map state is encoded in the URL for easy sharing. Copy the URL from your
browser's address bar or use the Share button:

- Specific year or all years (`?y=2025` or `?y=all`)
- Aircraft filter (`?a=D-EAGJ`)
- Selected paths (`?p=1,5,12`)
- Layer visibility (9 flags: heatmap, altitude, speed, airports, aviation, stats, wrapped, buttonsHidden, isolateSelection)
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
parse cache (`kml/`) keyed by path and modification time, so unchanged KML
files are not parsed again.

### Data Export

The tool exports all flight data at full resolution without downsampling:

- **Full fidelity**: All coordinate points are preserved
- **Year-based splitting**: Data is organized by year for efficient filtering
- **On-demand loading**: Only requested years are loaded into the browser
- **Compact format**: Paths are stored as segment lists per path id (see [Output](#output))

Parsing and the per-year export run in a process pool, so large collections
scale with the number of CPU cores. See
[`scripts/README.md`](scripts/README.md) for the sizes used in performance
testing and the measured processing time for 100,000 files.

Supports KML files from Google Earth, Google Maps, SkyDemon, Charterware, and
other aviation apps.

## Development

`make help` lists all targets. The container based targets (`make test`,
`make lint`, `make format`, `make lock`) run inside the test image and need no
local toolchain; the `*-local` variants use your local Python and Node
installation. `make verify` rebuilds `docs/` and fails if the result differs
from git, and `make lock` regenerates the hashed Python lock files.

Install the pre-commit hooks (ruff, prettier, typos, gitleaks, whitespace
fixers) with `pip install pre-commit && pre-commit install`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and commit conventions.

### Frontend (TypeScript)

The interactive map interface is built with TypeScript and has comprehensive
test coverage.

**Setup:**

```bash
npm ci
```

**Available commands:**

```bash
npm run build            # Build production bundles (minified)
npm run build:dev        # Build development bundles (with sourcemaps)
npm run build:watch      # Watch mode for development
npm run test             # Run unit tests
npm run test:watch       # Watch mode for tests
npm run test:ui          # Run tests with UI
npm run test:coverage    # Generate coverage report
npm run test:e2e         # Run E2E tests (Playwright, desktop Chromium)
npm run test:e2e:mobile  # Run E2E tests with the mobile project
npm run test:e2e:ui      # Run E2E tests with interactive UI
npm run typecheck        # Type-check the frontend
npm run typecheck:tests  # Type-check the unit and e2e tests
npm run lint             # Lint TypeScript code
npm run lint:fix         # Auto-fix linting issues
npm run format           # Format code with Prettier
npm run format:check     # Check code formatting
```

**E2E Tests:**

End-to-end tests use [Playwright](https://playwright.dev/) with Chromium. They
verify the full map rendering pipeline including map initialization, layer
toggles, filters, statistics panel, wrapped modal, airport markers and replay.
A mobile project runs the suite with a phone viewport, and every page is
scanned for accessibility violations with axe.

The tests run against `docs/`, which must be built from the current sources
first:

```bash
# Install Playwright browsers (first time only)
npx playwright install --with-deps chromium

# Build the site from the current sources
npm run build && python -m kml_heatmap data --output-dir docs

# Run E2E tests
npm run test:e2e
npm run test:e2e:mobile

# On NixOS, use the system Chromium
nix-shell -p chromium python3 --run 'CHROMIUM_PATH=$(which chromium) npm run test:e2e'
```

Tests are located in `tests/e2e/` and configured via `playwright.config.ts`.
The test server starts `python3 -m http.server` serving `docs/`. Failed runs
leave traces in `test-results/` and a report in `playwright-report/`.

**Build Output:**

- **Format**: IIFE (Immediately Invoked Function Expression)
- **Protocol**: Compatible with `file://` protocol - open index.html directly in browser
- **Production**: Minified bundles for optimal performance
- **Development**: Unminified with sourcemaps for debugging

The bundles in `kml_heatmap/static/` (`bundle.js`, `mapApp.bundle.js` and
their `.map` files) are gitignored and created by `npm run build`.

**Architecture:**

- **TypeScript modules** in `kml_heatmap/frontend/`
  - `calculations/` - Statistics and data processing
  - `features/` - Airports, layers, replay, wrapped
  - `services/` - Data loading and caching
  - `state/` - URL state management
  - `ui/` - UI managers for controls and interactions
  - `utils/` - Formatters, colors, geometry helpers
- **Tests**
  - Unit tests: `tests/frontend/unit/` (Vitest)
  - E2E tests: `tests/e2e/` (Playwright)
- **Build output** in `kml_heatmap/static/` (bundle.js, mapApp.bundle.js)

### Backend (Python)

**Setup:**

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-test.txt
```

The CI and the container images install the hashed lock files
(`requirements.lock`, `requirements-test.lock`) instead; regenerate them with
`make lock` after changing `requirements*.txt`.

**Testing:**

pytest no longer forces coverage or parallel execution, so a plain `pytest` run
is fast and readable. The flags used by CI and `make test-local` are:

```bash
pytest                                          # Run all tests
pytest tests/test_parser.py                     # Run specific test file
pytest -x                                       # Stop on first failure
pytest -n auto --cov=kml_heatmap --cov-branch --cov-report=xml --cov-report=term
coverage report                                 # Enforces fail_under = 90
pytest --cov=kml_heatmap --cov-report=html      # HTML coverage report (htmlcov/)
```

Property-based tests use [Hypothesis](https://hypothesis.readthedocs.io/).

**Checks:**

```bash
ruff check . && ruff format --check .   # Lint and formatting
mypy .                                  # Type checking
bandit -r kml_heatmap -ll               # Security scan
typos                                   # Spell check (config in _typos.toml)
gitleaks dir .                          # Secret scan (config in .gitleaks.toml)
make check-obfuscation-local            # KML files in data/ are obfuscated
```

**Dependencies:**

- `lxml` - Fast XML parsing for KML files
- `rcssmin`, `rjsmin`, `minify-html` - Output minification (HTML/CSS/JS)

### Test Data Generation

Generate realistic test KML files for performance testing:

```bash
# Generate 10,000 files (default: 1,000)
python3 scripts/generate_test_data.py 10000

# Custom output directory
python3 scripts/generate_test_data.py 5000 --output custom_test_data

# Test with generated data
make build INPUT_DIR=kml_test_10000
```

Features:

- Curved flight paths using Bezier curves (not straight lines)
- Realistic altitude profiles (climb, cruise, descend)
- Random deviations across Germany for better heatmap visualization
- Supports stress testing up to 100k+ flights

See [`scripts/README.md`](scripts/README.md) for more details.

## Contributing and Security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and
[SECURITY.md](SECURITY.md) for how to report vulnerabilities.
