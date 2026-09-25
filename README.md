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
  - [With an API Key (Optional)](#with-an-api-key-optional)
  - [Makefile Variables and Targets](#makefile-variables-and-targets)
  - [Docker Usage](#docker-usage)
  - [Python Usage](#python-usage)
  - [Command-Line Options](#command-line-options)
- [Adding New Flights](#adding-new-flights)
  - [Troubleshooting](#troubleshooting)
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
- A map that turns and tilts, and a globe for flights that span a continent
- A 3D view that lifts the flights to their altitude above the ground they
  flew over, sampled from an elevation model when the site is built, and
  draws the heatmap as a glowing cloud in the air where they flew
- Satellite imagery as the ground under the flights, keyless
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
- To view the site: a current browser with ES modules, `fetch()` and WebGL 2,
  and an HTTP server (`make serve`); the page does not work opened from disk

### Quick Start

Place your KML files in a `data/` directory in the repository root (the
`Makefile` requires it to exist; in this repository it holds the published
flights, see [Adding New Flights](#adding-new-flights)), then:

```bash
# Build the container image and generate docs/ from data/
make

# Serve it over HTTP (does not rebuild)
make serve
# Then open http://127.0.0.1:8000/
```

The page loads its code as ES modules and its data with `fetch()`, so it has
to be served over HTTP; opening `docs/index.html` from disk shows an empty
map. The map is drawn with WebGL 2, which every current browser has; where it
is missing or switched off, the page says so in place of the map. `make serve` only
serves the existing `docs/` directory; run `make build` (or
`make serve-build`) to regenerate it first. `docs/` is a local build output
and is not committed: the published site is built from the sources in CI once
all tests pass (see [Development](#development)).

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

A registration has to look like one (capitals and digits, at least one
letter); a name such as `2025_summer_trip.kml` names no aircraft. An extra underscore in the name is tolerated. Flight dates are not included in
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

The flight date used for the year filter is taken from the file's contents
(the `<description>` element, for a file without timestamps), never from the
filename.

Obfuscating the files renames them (see [Privacy](#privacy)): the date becomes
January 1st of the same year and the time slot a sequence number per year and
directory, written as a time (`0000h`, `0001h`, ..., `0059h`, `0100h`). The
example becomes `2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml`, and the next flight of
2026 in the same directory `2026-01-01_0001h_...`. Files are numbered in the
order of their original names, after the highest number already present, so the
names keep sorting in flight order. An existing file is never replaced.

**Note:** Charterware KML files do not include per-point timestamps. As
coordinates are not at fixed intervals, the tool does not attempt to infer
timing or speed data for Charterware files. The Groundspeed layer and the flight time
statistics are unavailable when viewing Charterware-only data. Altitude
visualization, path selection, and all other features remain available.

### Aircraft Model Data

Aircraft model names are resolved from an `aircraft.json` file, a manually
maintained mapping of registrations (written as the map shows them; a key
without the hyphen, `DEHYL`, is read as `D-EHYL`) to full model names. The file is looked up in every directory that holds an
input file; when two of them name the same registration, the first one found
wins:

```json
{
  "D-EAGJ": "Diamond DA-20A-1 Katana",
  "D-EHYL": "Diamond DA-40TDI Diamond Star"
}
```

When adding a new aircraft, add its registration and model to this file.
Without an entry the aircraft shows the type from the file name instead.

**Why these formats?**

The filename formats enable:

- **Aircraft filtering** - Filter map by specific aircraft registration
- **Per-aircraft statistics** - View distance and flight time per aircraft
- **Aircraft model lookup** - Full model names from `aircraft.json`
- **Route information** - Charterware files include departure and arrival airports

**Without these formats:**

Files will still be processed and paths will be displayed, and they count
towards the totals, but they belong to no aircraft:

- They are not in the aircraft filter, and selecting an aircraft hides them
- They appear in no per-aircraft statistics
- No aircraft model is looked up for them

### Multiple Directories

You can process KML files from several files and directories at once.
Directories are scanned with their subdirectories:

```bash
python -m kml_heatmap data/ data-new/ extra_flight.kml --output-dir combined
```

The tool detects the format of each file and processes them accordingly.

### With an API Key (Optional)

**CARTO** - The base map is CARTO's vector style, drawn by MapLibre GL JS.
It is free within CARTO's fair use limit and works without a key today, but
CARTO asks everyone to get one and may require it for vector tiles as it
already does for raster ones. The key goes on the style request and on every
tile, glyph and sprite request that follows from it.

```bash
# Pass the key on the command line or export it in the environment
make CARTO_API_KEY=your_carto_key

# Then serve
make serve
```

The key is embedded in the generated `map_config.js`, which is published with
the site. Treat it as a public client-side key and restrict it to your site's
domain (referrer restriction) in the CARTO dashboard. The `site` job of the
`test` workflow reads it from the `CARTO_API_KEY` repository secret.

The Aviation Data layer needs no key: its tiles come from
[open flightmaps](https://www.openflightmaps.org/), which covers most of
Europe and a few other regions and is credited on the map. Nor does the
Satellite switch (see [Satellite Imagery](#satellite-imagery)).

### Makefile Variables and Targets

Variables:

- `CONTAINER_RUNTIME` - Container runtime; auto-detects `podman`, then `docker`
- `INPUT_DIR` - Directory with the KML files (default: `data`)
- `OUTPUT_DIR` - Output directory (default: `docs`); it must not be `INPUT_DIR`,
  lie inside it or contain it, and the two need different base names
- `CACHE_DIR` - Host directory mounted as `/cache` (default: `~/.cache/kml-heatmap`)
- `HOST_BIND` - Address `make serve` binds on the host (default: `127.0.0.1`; use `0.0.0.0` for the local network)
- `PORT` - Host port for `make serve` (default: `8000`)
- `CARTO_API_KEY` - Tile API key (passed by name, never printed)

Targets (`make help` prints this list with the current variable values):

- `build` - Build the image and generate `OUTPUT_DIR` from `INPUT_DIR` (leaves the input KML files alone)
- `serve` - Serve `OUTPUT_DIR` on `http://HOST_BIND:PORT` (run `make build` first)
- `serve-build` - Run `build`, then `serve`
- `test` - Build the frontend bundles, then run the JavaScript and Python test suites with coverage
- `lint` - Run the linters, formatters (check only) and type checkers of the CI lint job, plus bandit and typos, which CI runs in the security and typos jobs
- `format` - Run formatters
- `lock` - Regenerate the lock files (`requirements.lock`, `requirements-test.lock`, `requirements-build.lock` and `requirements-tools.lock`) from `pyproject.toml` and `requirements-tools.in` with pip-compile
- `obfuscate` - Rewrite the KML files in `INPUT_DIR` in place so they carry no real dates (irreversible)
- `check-obfuscation` - Check that the KML files in `INPUT_DIR` and the fixture flights of the visual snapshots are obfuscated
- `hooks` - Install the pre-push hook that refuses to push KML files with real dates
- `clean` - Remove the container image (when a runtime is available) and local build artifacts, including the frontend build output in `kml_heatmap/static/` and the fixture site of the visual snapshots (`visual-site/`)
- `help` - Show available targets and variables

Only `build`, `serve` and `serve-build` need podman or docker; `clean`
also removes the image when one of them is installed. The rest (`test`,
`lint`, `format`, `lock`, `obfuscate`, `check-obfuscation`, `hooks`, `help`) run
locally, from the virtual environment and `node_modules` (see
[CONTRIBUTING.md](CONTRIBUTING.md)). With docker the containers run as your
user id so that generated files are not owned by root; with rootless podman
the Makefile adds `--userns=keep-id` so that the same user id works inside the
container.

### Docker Usage

If you prefer using Docker directly. Input files are read and left alone (pass
`--obfuscate-inputs` to rewrite them too). Mount the cache of the OurAirports
database and the elevation tiles so they are not downloaded on every run, and
run as your user id so the output is owned by you (add `--userns=keep-id` with
rootless podman):

```bash
# Build the image
docker build -t kml-heatmap .
mkdir -p out ~/.cache/kml-heatmap

# Generate out/ from the KML files in data/
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD/data:/data/data" -v "$PWD/out:/data/out" \
  -v ~/.cache/kml-heatmap:/cache \
  kml-heatmap data --output-dir out

# With the API key (inherited from the environment, its value is not echoed)
docker run --rm --user "$(id -u):$(id -g)" -e CARTO_API_KEY \
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

# Serve it over HTTP, then open http://127.0.0.1:8000/
python -m http.server 8000 --bind 127.0.0.1 -d docs
```

Opening `docs/index.html` from disk does not work (see
[Quick Start](#quick-start)).

`pip install .` also provides the `kml-heatmap` console script and ships the
templates and static assets. `python kml-heatmap.py` still works as a legacy
wrapper.

### Command-Line Options

```
kml-heatmap [--output-dir DIR] [--debug] [--obfuscate-inputs] [--no-terrain] [--force] [--version] path [path ...]
```

- `path` - KML files and/or directories. Directories are scanned with their
  subdirectories for `.kml` files (case-insensitive) and processed in numeric
  order per directory. `aircraft.json` is looked up in every directory that
  holds an input file. A path that does not exist is an error, and a file
  named twice is read once.
- `--output-dir DIR` - Output directory (default: `docs`). The tool refuses to
  run if the output directory is the directory of an input file or contains
  one, or is a directory it must never clean out (`/`, the home directory).
  An output directory below the input directory is fine, so
  `kml-heatmap flight.kml` in the file's directory writes to `./docs/`. It
  also refuses an output directory that holds files the site is made of (an
  `index.html`, a `styles.css`, a `data/airports.json` and the like) but no
  sign of an earlier run (`map_config.js`, `data/metadata.json`): many a
  project keeps a site of its own in `docs/`, and the run would replace it
  file by file.
- `--debug` - Show debug output
- `--obfuscate-inputs` - Also rewrite the input KML files themselves, in place
  and irreversibly, so that the files on disk carry no real dates either. Off
  by default: the generated site never carries a flight date finer than the
  year whatever the inputs hold (see [Privacy](#privacy)), so this is about the
  KML files, not about what gets published. Keep a copy of the originals first.
- `--no-terrain` - Do not sample the ground under the flights from the
  elevation tiles (see [Elevation Data](#elevation-data)); nothing is
  downloaded for it, and the 3D view puts each flight on a line between its
  airfields
- `--force` - Replace the files of a site in the output directory that no
  earlier run wrote (see `--output-dir`)
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
symlink in place of one of its files stops the run. With
`KML_HEATMAP_STABLE_MTIMES=1` every published file gets a modification time
taken from its content instead of the time of the build (some day between
2001 and 2010), so a server that derives its ETags from it, as GitHub Pages
does, keeps them for the files a new build did not change; CI sets it for the
deployed site. Leave it off for a server that compares the times by age
(`python -m http.server`).

The exit status is 1 when no site could be generated: a missing input path, a
missing JavaScript bundle, an input file that is not valid KML or cannot be
parsed (such as an empty file or a symlink), no flight with a determinable
year, or an error such as an unwritable output directory.

## Adding New Flights

This is the workflow for this repository, whose flights live in `data/` and
whose site is published from it. With your own fork or a local directory the
steps are the same; only the last one (publishing) depends on GitHub Pages.

### 1. Export the flight

- **SkyDemon**: export the flight's track log as a KML file (the Google
  Earth format). SkyDemon writes the track as a `gx:Track` with a time for
  every point, so the speed layer, the flight time and the replay work.
- **Charterware**: download the flight's KML file and keep the name it comes
  with (`YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE.kml`). Charterware tracks carry
  no time per point, so the speed layer, the flight time and the replay are
  not available for them (see
  [KML File Naming Convention](#kml-file-naming-convention)).

Other apps work as long as the file holds the track as a `LineString` or a
`gx:Track` and a date somewhere the parser finds it (see
[Troubleshooting](#troubleshooting)).

### 2. Name the file and put it into `data/`

Rename a SkyDemon export to `N_REGISTRATION_TYPE.kml` and copy it into
`data/`:

- `N` is the next free flight number: one more than the highest number
  already in `data/` (`ls data | sort -n | tail -n 1`). The numbers keep the
  flights in chronological order, and the files are processed in that order.
- `REGISTRATION` is the registration without its hyphen (`DEHYL` for
  `D-EHYL`). The hyphen is put back from a table of nationality prefixes.
- `TYPE` is the aircraft type designator (`DA40`, `C172`).

For example, the flight after `103_DESST_C172.kml` in D-EHYL is
`104_DEHYL_DA40.kml`. A Charterware file keeps its own name. The full rules
are in [KML File Naming Convention](#kml-file-naming-convention).

### 3. Add the aircraft if it is new

The registration in the file name decides which aircraft a flight belongs
to. For a registration that has not flown before, add it with its full
model name to `data/aircraft.json`, written with the hyphen:

```json
{
  "D-EHYL": "Diamond DA-40TDI Diamond Star",
  "D-EXYZ": "Piper PA-28-181 Archer III"
}
```

Without an entry the flight still counts for the aircraft, which then shows
the type from the file name instead of a model name (see
[Aircraft Model Data](#aircraft-model-data)).

### 4. Obfuscate the new files

```bash
make obfuscate          # python -m kml_heatmap.obfuscate data
make check-obfuscation  # every file in data/ passes
```

The published site never carries a date finer than the year, whatever the
KML files hold. The files in `data/` are committed to a public repository,
though, so they must not carry real dates either. `make obfuscate` rewrites
them in place, irreversibly: every timestamp moves to January 1st of its
year (the time of day and the intervals between points stay), dates in
placemark names and descriptions and the creator field are replaced, and a
Charterware file is renamed to `YYYY-01-01_NNNNh_...` with a sequence number
in place of the time. Files that are already obfuscated are left as they
are. Keep a copy of the original export if you want the real dates. It runs
locally and needs the Python environment from
[CONTRIBUTING.md](CONTRIBUTING.md); `--obfuscate-inputs` does the same as
part of a build. See [Privacy](#privacy) for what is kept.

### 5. Build and preview the site

```bash
make build        # builds the container image and generates docs/ from data/
make serve        # http://127.0.0.1:8000/
```

Without podman or docker, build from the checkout instead:

```bash
npm ci && npm run build
python -m kml_heatmap data --output-dir docs
python -m http.server 8000 --bind 127.0.0.1 -d docs
```

A local build has no tile API key unless you pass one (see
[With an API Key](#with-an-api-key-optional)). The base map loads without
one today, and the flights do not depend on it.

### 6. Check the result

In the build output:

- `✓ Loaded N points from <file>` for the new file, and no warning about it
  (see [Troubleshooting](#troubleshooting) for the warnings that matter)
- A `✓` line with the registration and its model in the aircraft list; a
  `⚠` line there means `aircraft.json` has no model for it

On the map:

- The year of the flight is in the year filter, and with that year selected
  the flight count in the statistics went up by one
- The track is drawn where you flew, and clicking it selects it
- The departure and arrival airports have markers with their ICAO codes
- The aircraft appears in the aircraft filter with its model name
- For a SkyDemon flight: the speed layer colours the track and Replay plays
  it with the flight selected

### 7. Commit and publish

```bash
git add data/
git commit -s -m "chore: add flight 104"
```

`git add data/` picks up renamed Charterware files and `aircraft.json` as
well. Install the hooks once: with the pre-commit hooks (see
[CONTRIBUTING.md](CONTRIBUTING.md)) the commit fails while a file in
`data/` is not obfuscated, and the pre-push hook (`make hooks`, which needs
only Python) refuses to push a commit that carries one. The `obfuscation`
CI job catches the same mistake only after the push, when the real dates
are already public.

Open a pull request or push to `main`. On `main`, the `test` workflow runs
every test job against the new data, including the obfuscation check; once
they pass, its `site` job builds the site from `data/` with the tile API
key from the repository secrets and its `deploy` job publishes it to
GitHub Pages. Nothing generated is committed: the local `docs/` stays out of
git. A pull request runs the same tests but publishes nothing.

### Troubleshooting

The build log names the file in every warning. `--debug` (or
`kml-heatmap --debug <file>` on a single file) shows what the parser found.

**A flight is missing.** Look for these lines:

- `Excluding path without a determinable year: <file> (<name>)`: the parser
  found no date. It takes the year from the track's own times (the first
  `<when>` of a `gx:Track` that belongs to a point of the path, so a flight
  across New Year stays in the year it started in, or a `<TimeStamp>`), then
  from a `<TimeSpan>`, then from a date in the track's placemark name
  (`EDDS to EDDP - 16 Aug 2026`), then from a Charterware `<description>`
  and finally from a `<TimeStamp>` or `<TimeSpan>` of the enclosing
  `<Folder>` or `<Document>`, never from the file name. A time that cannot
  be read (neither ISO 8601, `YYYY-MM-DD HH:MM:SSZ` nor a date without a
  time of day such as `2026-08-16`, `2026-08` or `2026`) does not count.
  Export the flight again with its times. When no flight at all has a year,
  the run fails with `No flight paths with a determinable year to export`.
- A `gx:Track` time more than seven days from the track's median, or out of
  order with its neighbours, is a logger glitch: that point loses its time
  (and so its groundspeed), the rest of the track keeps theirs. A position
  of exactly 0,0 is dropped as a missing fix.
- The file is not picked up at all: only files ending in `.kml` (in any
  case) are read. A `.kmz` archive has to be unzipped first.

**The run stops.** One broken file stops the whole run, so a site never
silently misses a flight:

- `<file>: No valid coordinates found` or `Error processing <file>`,
  followed by `<n> of <m> file(s) failed to parse`: the file holds no track
  the parser reads, or it is not valid KML (cut off, or not XML at all).
  Only `LineString` and `gx:Track` geometry (also inside a `MultiGeometry`)
  forms a flight; polygons are skipped with a warning. So is a track whose
  `altitudeMode` is `clampToGround` or `relativeToGround`, because its
  altitudes are not above sea level. A track without `altitudeMode` is read
  as absolute, which is what flight logs write.
- `<n> of <m> input file(s) are not valid KML files`: a file is empty, a
  symlink or larger than 100 MB.

Fix or remove the file and build again.

**The flight shows the wrong aircraft, or none.** The registration comes
only from the file name. Check the name against the pattern:
`N_REGISTRATION_TYPE.kml` with exactly three parts (extra parts are ignored
with a warning), or the Charterware pattern with a valid date and time. The
registration part has to look like one: capitals and digits with at least
one letter, `DEHYL` or `D-EHYL`. A name that does not (`2025_summer_trip.kml`)
names no aircraft, and neither does a four-letter ICAO code after a date
(`20250601_EDDS_EDDP.kml`). The hyphen is only restored
for the nationality prefixes the tool knows (`D`, `OE`, `HB` and other
European ones); any other registration is used as written, so write it the
way it should appear. A model name that is missing or wrong comes from
`data/aircraft.json`; its keys may be written with or without the hyphen.
With several input directories, the first `aircraft.json` found wins.

**An airport is not recognised.** The airport names come from the track's
placemark name (SkyDemon names it after the route, such as
`EDCM Kamenz - EDAC Leipzig-Altenburg Airport`) or from the route in a
Charterware file name (`LOAV-LOAV`), and the ICAO codes in them are looked
up in the [OurAirports](https://ourairports.com/) database:

- `Airport database unavailable`: the database could not be downloaded, so
  the names stay as the KML file spells them and have no country. Run the
  build again with network access; CI refuses to publish without it.
- A code OurAirports does not know keeps the name from the file. A name
  without an ICAO code is shown as an airport only as an end of a route
  (`Home strip - Aunt farm`), and not as a single word (`Home`). Any other
  placemark name without a code (`Flight with Anna`) is free text: its start
  gets no marker and does not count as an airport in the statistics either,
  since a route end counts only where it has a marker.
- A recording that starts in the air (more than 400 m above the airport and
  level) gets no departure marker, and the arrival only gets one when the
  name is a route and the track ends in a landing. A name that is a single
  airport (`EDDS` for a local flight) gets its marker at the start, and the
  flight counts for it.
- Markers with the same ICAO code are merged into one. A name without a
  code is merged with the marker of the same name, wherever that is, or
  else with a marker closer than 1.5 km. Two different ICAO codes are never
  merged, however close the airports are.

**A flight appears twice.** The same file named twice on the command line
(directly and through its directory) is read once, with
`Ignoring duplicate input`. The same flight in two files, such as one
export copied under two numbers, is kept once and the copy is skipped with
a warning. So is the same flight recorded twice, by a phone and the panel
GPS or exported by two tools: two recordings with times that overlap by
more than half of the shorter one, and are in the same place at the times
they share, are one flight. The one whose file name gives the aircraft
stays, otherwise the one with more points, and the warning names both
files. Delete the copy from `data/`.

**One flight shows as several, or two as one.** A logger that writes a
long track as several `LineString`s, each starting where the one before
ended, splits one flight into pieces, and the parser joins them again: a
line continues the one before it when both have the same placemark name,
the one before did not end on the ground, and the line starts within 50 m
of its end, at the same `<TimeSpan>` or within 30 minutes of its end.
Without times, only the point of the split written twice joins them. A
`gx:Track` is never joined. Give the pieces of a flight one name, and
flights of their own different names or times.

**`make check-obfuscation` or the commit hook fails.** Run
`make obfuscate`, then check again. When a date cannot be removed (in a file
name, or in an element the tool does not rewrite), the rewrite names the
file and the date and stops rather than leaving it half scrubbed; remove
the date by hand.

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

**The build asks AWS for the elevation tiles of the area you flew over**
(see [Elevation Data](#elevation-data)): tiles of about 25 km across at
50 degrees north, fetched once and cached, with nothing else in the request.
Pass `--no-terrain` to build without them.

**The page asks AWS for the elevation tiles of the area in view** while the 3D
view is on, at every zoom, to draw or shade the relief: AWS sees the
visitor's address and which tiles, so roughly where on the map they look, as
CARTO does for the base map. Nothing is fetched from AWS otherwise.

**The page asks EOX for the satellite imagery of the area in view** while the
Satellite switch is on (see [Satellite Imagery](#satellite-imagery)): EOX
sees the visitor's address and which tiles, as AWS and CARTO do. Nothing is
fetched from EOX while it is off, and it is off unless the visitor, their
saved state or the link they followed turns it on.

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
file or its name (numeric, or with an English or German month name such as
`16 Aug 2026` or `16. Mai 2026`), except the two days after January 1st that
a flight past midnight runs into. Timestamps within one Placemark, or no more than 12 hours
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
- Airport names: a placemark name that holds an ICAO code (`EDDS`,
  `EDAQ Halle-Oppin`), and the airports of a route name (`Home strip - Aunt
farm`)
- The aircraft registration and type of a file name (`1_DEHYL_DA40.kml`)

Removed from the site:

- Individual flight dates and times
- Any other placemark name: free text such as `Flight with Anna` or
  `Untitled Path` is no airport name, and the start of such a flight gets no
  airport marker at all
- Dates and times of day in placemark and file names (`16 Aug 2026`,
  `the 16th of August 2026`, `16/Aug/2026`, `16/08`, `16-08`, `16_08`,
  `26.08`, `16.8`, `16 08 2026`, `16AUG26`, `16-AUG-26`, `260816`,
  `03/2026`, `2026/8/16`, `KW33 2026`, `14:30`, `1430Z`, `1430L`,
  `14h30`, `14.30 Uhr`, `2026-08-16_1430`), also with German month names
  written day first (`16. Mai 2026`, `16. März`, `16MAI26`, `Mai 2026`); a
  month name alone (`Flugplatz Juli`) stays, and so do runway designators in
  a name that speaks of a runway (`RWY 08/26`, `07L/25R`) and a version
  after a word that says so (`firmware 12.10`), while a bare `26/08` is
  August 26th and `EDDS 07/25` July 25th (or July 2025): where a name could
  hold a date, the date goes
- A registration that holds a date (`1_16AUG26_DA40.kml`), with a warning

The CARTO key is a public client-side tile key. It is embedded in the
generated `map_config.js` and published with the site by design, because the
browser needs it to load the base map. The generated site is not committed;
the key lives in the repository secrets and in the deployed site only.

## Output

The output directory contains the page, the frontend bundles with their
source maps, the third-party code the page loads, static assets and a `data/`
directory with one file per year:

```
output-dir/
├── index.html
├── mapApp.bundle.js
├── mapApp.bundle.js.map
├── features.bundle.js     # Map features a first visit does not need (replay among them), imported on first use
├── features.bundle.js.map
├── wrapped.bundle.js      # Wrapped and the statistics panel, imported on first use
├── wrapped.bundle.js.map
├── shared.bundle.js       # The app, which the three above import
├── shared.bundle.js.map
├── yearWorker.bundle.js   # Decodes the year files, in a worker
├── yearWorker.bundle.js.map
├── map_config.js          # Map defaults, tile API key and the build stamp
├── styles.css             # Linked in the page
├── features.css           # The styles of those features, fetched with their bundle
├── wrapped.css            # Wrapped and the statistics panel, fetched with its bundle
├── manifest.json
├── favicon.svg
├── favicon.ico
├── favicon-192.png
├── favicon-512.png
├── apple-touch-icon.png
├── vendor/                # MapLibre GL JS, html-to-image
│   ├── maplibre-gl.mjs
│   ├── maplibre-gl-shared.mjs   # Imported by the two around it
│   ├── maplibre-gl-worker.mjs   # Started by maplibre-gl.mjs as a module worker
│   ├── maplibre-gl.css
│   └── html-to-image.mjs        # Imported on the first image export
├── flags/                 # One SVG per country the flights touched
└── data/
    ├── airports.json      # Airport markers
    ├── metadata.json      # Years, file sizes, speed range, models, flags
    ├── 2025/
    │   └── data.json
    └── 2026/
        └── data.json
```

Each year file holds an object with `format`,
`year`, `original_points`, `path_info` and `segments`. `format` is the wire
format of the rows, which the page checks before reading them so a file
written by another version is refused rather than misread. `path_info` lists
the flights in input order, each with its id, year, airports, aircraft,
exact altitude range and total climb (`altitude_gain_ft`), the last three written together for every flight with an altitude; where a flight starts and ends is read from its
segments. `segments` maps a path id to
`{"start": [lat, lon], "columns": [lats, lons, altitudes, speeds, times], "ground": [...]}`,
one row per segment, written column by column: the n-th entry of each column
is the n-th row's latitude, longitude, altitude in feet, groundspeed in whole
knots (0 for a speed that is not known, and at least 1 for one that is) and
relative time in seconds. The `times` column is only present for files
with timestamps, and holds `null` for a row without one. `ground` is the
ground under each row in feet (see [Elevation Data](#elevation-data)); a path
whose ground the build does not know has none, and the page takes it from
the airfields.

The coordinate in a row is the segment's **end** point. Its start is the end
of the previous row, and the first row continues from `start`, so a shared
point is stored once instead of twice. Coordinates are rounded to five
decimals (about 1 m), and the only segments the exporter drops are the ones
whose two endpoints round to the same coordinate (standing still), which keeps
the rows contiguous.

Every value above is written as an integer difference to the row before it
rather than as the number itself (`kml_heatmap/segment_codec.py`, mirrored by
`decodeYear` in `services/yearDecode.ts`, which the page runs in a worker).
The exporter has already rounded each column to a fixed step (1e-5 degrees,
100 ft, 1 kt, 0.1 s and 10 ft of ground), so counting in the step of the
format (1e-5 degrees, 100 ft, 0.1 kt, 0.1 s and 10 ft) is exact, and neighbouring rows barely differ: the encoding is lossless and roughly halves
a year file. Writing the rows column by column puts the repeating
differences of one quantity next to each other, which takes another sixth
off the compressed download. The numbers the page works with are the ones
described above; only the file is written this way.
The page skips the rest of a path, with a warning in the console, from the
first value that is not a number.

`metadata.json` lists the available years, the size of each year file
(`year_file_bytes`) so the frontend can show loading progress, the groundspeed
range of the speed scale and the model names `aircraft.json` knows for the
exported aircraft (`aircraft_models`). It carries no statistics: the frontend
computes them from the year files for the active year, aircraft and selection.
Flights without a recognizable year are skipped instead of being grouped under
an "unknown" year, and the map bounds in `map_config.js` cover only the
exported flights. `airports.json` lists every airport marker with its name,
position, the ICAO code in its name (`code`, left out for a name without one)
and its country where the airport database knows it. Airport entries carry no
flight count: the frontend derives one per airport from the active year and
aircraft filter.

The data is plain JSON, organized by year and fetched on demand. The page
preloads the two index files and the latest year's file, which it opens with,
so the downloads start together with the bundles rather than after them. It
preloads CARTO's style and the index of its tiles as well (with the API key
when the site has one), which the map would otherwise only ask for one after
the other once it has started.

## Map Features

### Layers

- **Density Heatmap** (toggle) - Shows frequently visited locations.
  Zoomed in from `z` 12 to 13.5 (the `z` of a
  [shared link](#shareable-urls)) it hands over to heat lines: the tracks
  themselves, coloured and widened by the time spent on each 40 m of them,
  so the taxiways and circuits of a busy airport stay apart. In the 3D view
  the heat is a cloud in the air instead: every flight glows where it flew,
  at its height as the 3D view draws it, along the same curve as its
  ribbon, and brighter the more time was spent there; from `z` 11 in the
  glow narrows to a crisp line along each track, so the roads and place
  names stay readable. A route flown once is a faint blue, the circuits
  and the climbs out of a busy field glow white, and a ridge in front of a
  flight hides its glow. It follows the same switch, filters, Isolate and replay
  as the heatmap, and steps back under a colour layer as it does; it only
  draws, so hovering and clicking still go to the flights. Should the
  browser not run its shaders, the flat heatmap stays
- **Altitude** (toggle) - Paths coloured by elevation, on a scale that runs
  purple through magenta to orange
- **Groundspeed** (toggle) - Paths coloured by groundspeed, on a scale that runs
  blue through green to yellow. The two scales share no hue, so a map or an
  exported image says which of them is drawn without its legend; both
  brighten from end to end, so they survive being printed in grey. Both
  colour layers draw 32 steps of their scale, one line per run of a path in
  the same step, and draw every recorded point, joined by a smooth curve
  through the fixes. The colours are spread by rank rather than evenly over
  the values: every stretch of a scale colours as much of the flying as any
  other, so the climb-out, the cruise and the taxiing each get colours of
  their own, and the middle of the legend names the median. The altitude
  scale runs from the lowest to the highest altitude drawn; the speed scale
  spans the middle nine tenths of the speeds drawn (from the 5th to the
  95th percentile), and the slower and faster ones take the colours of its
  ends, which the legend marks with ≤ and ≥. A selection and a replay are
  coloured on their own flights. Hovering a path shows the
  exact value
- **Airports** (toggle) - Airport markers with their ICAO codes above them.
  The codes are placed together with the place names of the base map, so
  they never cover one another; where two would collide, the home base and
  then the busier airport keep theirs. They are left out below `z` 5, and
  on a map tilted past about 55 degrees the airports more than twice as
  far from the camera as the middle of the map are hidden, markers and
  codes, where they would crowd into a strip along the horizon. Below `z` 3
  the markers are hidden too, a clump of dots on the heat
- **Aviation Data** (toggle) - Airspaces, airports, navaids, and reporting points from open flightmaps, where it has coverage. Drawn from `z` 7 to 14; its charts end at `z` 12, and further in than two levels of upscaling they would only blur the base map

### Controls

- **Stats** - View statistics (distance, altitude, airports, flight time). Flight time runs from the first to the last recorded point that moved at the exported precision (about 1 m), so standing perfectly still before and after is not counted, while GPS noise on the ground still is
- **Export** - Save the current map view as a JPG image
- **Copy link** - Copy the current URL to the clipboard. On a phone, where there is a native share dialog, the More sheet's row says **Share link** and opens that instead
- **Wrapped** - View the year-in-review summary; Escape closes it
- **Replay** - Animate one flight with adjustable speed (1x to 500x, default 50x) and an auto-zoom button that follows the airplane; Escape closes it. The whole track is drawn dimmed and the flown part paints over it in the colours of the active scale. Replay needs exactly one selected flight with timing data; a toast explains why it is unavailable otherwise. The chase button (the target next to auto-zoom) watches the flight from a chase plane: the camera sits behind and above the airplane, tilted to 70 degrees at about `z` 15.5, and turns with it, lagging a little into each turn. The airplane stands upright, a little below the middle of the map above the replay panel. In the 3D view the camera looks at the airplane at its height and tilts down steeper rather than fly into a ridge behind it. Switching it on slows a replay faster than 10x down to 10x, and switching it off brings back the speed from before, unless another one was chosen while it chased. Dragging, zooming or turning the map holds the chase until you let go, and the chase keeps the zoom (`z` 12 to 17) and tilt (45 to 75 degrees) you left it at. On the globe it zooms out no further than `z` 13, where the globe is still drawn flat. Switching it off gives back your zoom, turn and tilt over the airplane, and closing the replay gives back the whole view from before; the link and the saved session keep that view, not the chase camera. It stays off while the system asks for reduced motion, and a toast says why
- **North up** - The map turns and tilts (up to 85 degrees, with a sky above the horizon) by gesture: drag with the right mouse button or with Ctrl held, twist or drag with two fingers, or hold Shift with the arrow keys once the map has focus. The needle on this button points north, and a click turns the map back north up and flat. On a phone the compass floats at the top right of the map while the map is turned or tilted, and the globe switch is in the Layers sheet. Replay keeps the orientation you chose and points the airplane along its track on screen; Wrapped shows its overview north up and flat and gives your view back when it closes. While the map is already north up and flat the button is dimmed and does nothing
- **Globe** - Draw the map as a globe instead of in Mercator. From `z` 13 in the two look the same, which is MapLibre's doing. Airport markers on the far side are hidden, and a popup closes once the globe has turned its place away. The space around the globe is the page background; no atmosphere is drawn
- **3D** - Lift the flights to their altitude, as ribbons about as wide as the lines at every zoom that follow their climbs and descents in 20 ft steps close in (in steps of no more than a pixel further out) and stand on the ground each flight flew over: the build samples it under every logged position from an elevation model (see [Elevation Data](#elevation-data)) and shifts it to meet the altitudes the flight recorded taxiing at the field it left and at the one it landed on, so a flight taxis on the map at both ends even where the model and the recorder disagree by tens of feet, and crosses a ridge at its true height above it. A flight whose ground is not known (a build with `--no-terrain` or without the tiles) stands on a line from the one field to the other instead, and an altitude glitch of the recorder takes no flight up with either. Heights are exaggerated, and the relief under them as much, so a flight still shows its shape on a map of half of Europe: 10 times at `z` 7 and further out, 7 at `z` 8, 4 at `z` 9 and twice from `z` 10 in. Switching it on colours the paths by altitude if neither colour layer is on and tilts a flatter map to 50 degrees. From `z` 18 in, where the camera is lower than a traffic circuit, the flights are drawn flat again. Replay lifts its airplane and its trail with them. The heatmap turns into a cloud of the flights at their heights (see Density Heatmap above), on the relief and on the globe alike, and lies flat from `z` 18 in with the flights. At every zoom the map draws the relief under the flights, shaded faintly (dark slopes, a little light on the others) over the satellite imagery when it is on and under the labels and the flights, and each flight stands on it at its height above the ground it flew over. Further out the map draws the relief from coarser elevation tiles, and the ground under the flights is smoothed as much, so a level flight stays level over the ridges to within about a pixel; the exaggeration stops at 10 times since further out the Alps stood as a wall and a flight over them sawed up and down. While a zoom goes on, and in the distance of a tilted map, the map draws parts of the relief from the elevation tiles of another level, and each flight stands on the ground of the level drawn under it, so it stays level over the ridges there too. The exaggeration of the relief and the flights changes as a zoom ends in another level, not during it, for both at once, and the flights stay in sight. The relief comes from the same elevation tiles as the ground (see [Elevation Data](#elevation-data)), which the browser fetches from AWS while it is drawn. The globe only shades it: the relief itself is left out there, and each flight stands on the line between its fields. As the relief comes or goes, and as a zoom ends in another exaggeration while the map still draws flights cut at `z` 6 or further out or at `z` 11 or further in (after a zoom across more than one level from there, or another zoom before those flights were drawn anew), the flights are hidden until they are drawn on the new ground, for 3 seconds at most (a playing replay's trail, drawn anew in every frame, is not waited for). Tilted past 45 degrees, the map leaves out the place names of its far distance, which stood along the horizon over the fog
- **Satellite** - Draw the ground from satellite imagery (Sentinel-2 cloudless 2024 by EOX, see [Satellite Imagery](#satellite-imagery)) instead of the dark map: over its land and water, under its roads, borders and place names, the flights, the heatmap and the Aviation Data overlay, which works over it too. The imagery is darkened and made paler so the heat, the colour layers and the labels made for the dark map still read. It is sharp to about `z` 14 and stretched further in, where the roads and the Aviation Data layer show the airfields better. In the 3D view it lies on the relief under the shading. Off on a first visit; kept in the link and the saved session. The browser fetches the tiles from EOX only while it is on, and the map credits them only then, in an exported image too. Should its code fail to load, the switch turns back off and says so. On a phone it is in the Layers sheet
- **Reset view** - Go back to what a first visit shows: the newest year and all aircraft, the heatmap and airports on and the other layers, 3D, the globe and the satellite imagery off, nothing selected, the statistics closed, and the map flat and north up over all the flights. The saved session and the link follow. While there is nothing to reset, on a first visit and after a reset until the page or the map changes, it is dimmed and a press does nothing. On a phone it is in the More sheet; during a replay it is disabled like the filters
- A map attribution, on the map at every width; it steps aside only while a sheet or the statistics panel covers the map it credits. It wraps when the relief, the satellite imagery or the aviation layer add their credits; on a phone it shows two lines, and a tap on it shows the rest. There are no zoom buttons: use the scroll wheel, pinch, double click, or the keyboard once the map has focus
- A toggle that is off is drawn at full strength without the blue accent; only a control that cannot act right now (Replay without one timed flight selected, Isolate without a selection, North up and Reset view with nothing to reset, and what a replay disables) is dimmed
- An error stays on screen until it is dismissed or put right (a later load of flights, of Replay's or Wrapped's code or of the satellite imagery, or the map drawing after all); a failed load offers Retry, which a running replay ignores. When the first year cannot be loaded the map says so and offers Retry as well, the year dropdown shows no year (picking one loads it), and Reset view is available
- The controls come before the map in the tab order, and the "Skip to map" link at the start of the page goes past them to the map and its airport markers
- Below 768 px the two control columns are replaced by a bottom bar with five tabs. Layers, Filter and More open a sheet; Stats and Wrapped open their panel directly. Escape closes an open sheet, and Tab stays inside it. Replay takes over the bottom edge and the bar steps aside until it ends

### Filtering

- **Year Filter** - View flights from specific years or all years combined
- **Aircraft Filter** - Filter by aircraft registration to see flights per aircraft
- **Path Selection** - Click paths to highlight and view detailed statistics. A chip at the top of the map says how many flights are selected and clears them again. With neither colour layer on, the selected flights are drawn as thin light lines over the heatmap, which steps back while they show, at every zoom level
- **Airport Selection** - Click an airport marker to select all flights that visited it; click the map to clear the selection. The airport popup lists those flights (route, aircraft and year), each a button that selects that one flight, so a single flight and Replay are reachable from the keyboard: Tab to a marker, Enter opens the popup and moves focus into it, Escape closes it and returns focus to the marker
- **Solo Mode** - Isolate selected paths, hiding all other paths and heatmap data

### Shareable URLs

Map state is encoded in the URL for easy sharing. Copy the URL from your
browser's address bar or use the copy-link button:

- Specific year or all years (`?y=2025` or `?y=all`)
- Aircraft filter (`?a=D-EAGJ`)
- Selected paths (`?p=8vndgpro,1bspfs7g&sv=4`). A path id is derived
  from the flight's coordinates and altitudes, so a link keeps selecting the
  same flights after the site is regenerated with other flights added or
  removed; a flight that is no longer there is dropped from the selection.
  `sv` is the version of the id scheme. Version 4 writes the ids in base 36;
  version 3 links, which wrote the same ids in decimal
  (`?p=695806902132,104044549516&sv=3`), still work. Links written before
  version 3, when ids were positions in the export, lose their selection
  instead of selecting different flights
- Layer visibility (9 flags: heatmap, altitude, speed, airports, aviation, stats, wrapped, an unused legacy slot, isolateSelection). The 8th slot belonged to a control-visibility toggle that no longer exists; it is always written as `0` and not read, and kept so shared links still read their isolate flag from the 9th. The shorter strings of the releases before the isolate flag (6 to 8 flags) are no longer read; such a link opens with the layers of a first visit. The slots and parameters of every toggle are listed in `kml_heatmap/frontend/state/toggles.ts`
  - Example: `?v=100100000`
- Map position (`?lat=51.5&lng=13.4&z=10`). A centre without `z` opens at
  zoom 10. `z` counts in 256 pixel tiles, as links always did, which is one
  more than MapLibre's own zoom for the same view; links shared before the
  switch to MapLibre therefore still show the same area
- Orientation (`?b=-40.5&t=35`): `b` is the bearing, the degrees the top of
  the map is turned clockwise from north (any number, wrapped into -180 to
  180), and `t` the tilt in degrees (held between 0 and 85). Both are
  written to a tenth of a degree and left out while the map is north up and
  flat
- Globe (`?g=1`), left out for Mercator. A link without `b`, `t` and `g`,
  which is every link from before the map could turn, opens north up, flat
  and in Mercator
- 3D view (`?d=1`), left out while the flights are drawn flat
- Satellite imagery (`?s=1`), left out while the ground is the dark map. It
  is a parameter of its own, like `g` and `d`, so the nine flags of `v` and
  every older link stay as they were
- Debug logging in the browser console (`?debug=true`)

**Example URLs:**

```
?y=all                                   # Show all years
?y=2025&v=010000000                      # 2025 with the altitude layer only
?y=2025&a=D-EAGJ&lat=51.5&lng=13.4&z=10  # Complete state
?y=all&lat=48&lng=8&z=4&g=1&b=-30&t=50   # All years on a turned, tilted globe
?y=2025&z=9&t=60&d=1                     # 2025 in 3D
```

URL parameters take precedence over localStorage, allowing shared links to
override saved preferences.

### Smart Features

- Mid-flight detection - A recording started in the air adds no departure
  airport, and an arrival is only added where the track ends in a landing
- Airport deduplication - Merges the entries of one ICAO code, and names
  without a code that lie within 1.5 km of a marker; two different ICAO codes
  stay separate however close they are. A code known to OurAirports places
  the marker at the airport's own coordinates, so every flight to it lands on
  the same marker
- Airport names - Standardized from the ICAO code ("EDDS Stuttgart"); a
  single-word name without a code is not shown or counted as an airport
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
downloading it, and the elevation tiles, on every container run. The same directory holds a per-file
parse cache (`kml/`) keyed by file name and content, the parser code and the
airport database, so unchanged KML files are not parsed again; entries unused
for 30 days are removed.

Without the database the site is still generated, with the airport names as
the KML files spell them and without countries. Set
`KML_HEATMAP_REQUIRE_AIRPORT_DB=1` to fail instead, as CI does for the
published site.

### Elevation Data

The ground under the flights (the 3D view stands them on it) comes from the
[Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS Open
Data, in the Terrarium encoding, at zoom 10: pixels of about 100 m at
50 degrees north, fine enough for the relief under a flight. The build
samples the elevation under every exported position, bilinear across tile
edges, and writes it into the year files; `kml_heatmap/terrain.py` has the
details, including how the model is shifted to meet the altitudes a flight
recorded taxiing at both ends. The 3D view draws the relief from the same
tiles at every zoom (the page fetches them from AWS while the 3D view is on,
a few hundred KB for a view, and credits them on the map while they are
drawn), so the ground a flight is measured against and the ground it is
drawn on are the same model. Zoomed out the map draws it from the tiles of
a coarser level, and the page smooths the sampled ground along each flight
as much before it stands the flight on it.

The tiles are downloaded on the first run, eight at a time, and kept in
`terrain/` of the cache directory (see [Airport Database](#airport-database)),
about 100 KB each: the flights of `data/` touch 389 of them, 44 MB, and the
decoded pixels of each are kept next to it, about as much again. A tile
never changes, so it is never fetched again. A download that fails is tried
again a few times. Offline, or when a tile cannot be fetched, the build goes
on without it: a flight with a position under a missing tile gets no ground
and stands on the line between its airfields, and one warning says how many
flights that affects. Set `KML_HEATMAP_REQUIRE_TERRAIN=1` to fail instead,
as CI does for the published site. `--no-terrain` skips the tiles
altogether.

The terrain tiles are made by Mapzen's
[Joerd](https://github.com/tilezen/joerd) from several sources, which ask for
this [attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md):

- ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery
  and funded under National Science Foundation awards 1043681, 1559691, and
  1542736;
- Australia terrain data © Commonwealth of Australia (Geoscience Australia)
  2017;
- Austria terrain data © offene Daten Österreichs - Digitales Geländemodell
  (DGM) Österreich;
- Canada terrain data contains information licensed under the Open Government
  Licence - Canada;
- Europe terrain data produced using Copernicus data and information funded by
  the European Union - EU-DEM layers;
- Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric
  Administration
- Mexico terrain data source: INEGI, Continental relief, 2016;
- New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information
  New Zealand and the New Zealand Government (All rights reserved);
- Norway terrain data © Kartverket;
- United Kingdom terrain data © Environment Agency copyright and/or database
  right 2015. All rights reserved;
- United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data
  courtesy of the U.S. Geological Survey.

### Satellite Imagery

The Satellite switch draws
[Sentinel-2 cloudless 2024](https://cloudless.eox.at) by EOX IT Services
GmbH, a cloud-free mosaic of the
Copernicus Sentinel-2 images of 2024 with pixels of 10 m, which the page
fetches from `tiles.maps.eox.at` without a key. The map shows it to tile
level 14 (about 6 m a pixel at 50 degrees north, `z` 14 in the UI), the
last that adds detail, and stretches it beyond. It is licensed
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) for
non-commercial use, which this site is; a commercial one would need another
source. The map credits it while it is drawn, and an exported
image carries the credit:

> EOxCloudless [cloudless.eox.at](https://cloudless.eox.at) by EOX IT
> Services GmbH (Contains modified Copernicus Sentinel data 2024)

Nothing about the imagery is part of the build.

### Data Export

The tool exports all flight data without downsampling:

- **Full fidelity**: Every recorded movement is preserved. Coordinates are
  written with five decimals (about 1 m), far finer than the map can show;
  only points that do not move at that precision (standing still) are dropped
- **Year-based splitting**: Data is organized by year for efficient filtering
- **On-demand loading**: Only requested years are loaded into the browser
- **Compact format**: Paths are stored as a start point plus one row per
  segment, each holding only its end point, written column by column (see
  [Output](#output))
- **Duplicates skipped**: A flight whose exported content is identical to an
  earlier one (the same export under two names) is skipped with a warning
  naming both files, so it is not counted twice. So is the same flight
  recorded twice (two devices or two tools), told apart by where each
  recording was when: the one that names the aircraft, or else the one with
  more points, is kept
- **Split tracks joined**: The `LineString`s a logger split one flight into
  are one path again (see
  [Troubleshooting](#troubleshooting))
- **Plausible speeds**: A groundspeed above 600 kt comes from timestamp
  jitter, not from the aircraft; it counts as unknown rather than as 0
- **Stable path ids**: A path id is a 40-bit hash of the path's coordinates,
  rounded as exported, and altitudes; two different flights whose hashes
  collide take the next free id in input order. Ids survive regenerating the site, so shared links and
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
