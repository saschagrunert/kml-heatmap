# KML Heatmap Generator

> Create interactive heatmap visualizations from KML files.

[![Demo](https://img.shields.io/badge/live-demo-blue.svg)](https://saschagrunert.github.io/kml-heatmap)
[![Coverage](https://codecov.io/gh/saschagrunert/kml-heatmap/badge.svg?token=AxIuoWeFSy)](https://codecov.io/gh/saschagrunert/kml-heatmap)

## Table of Contents

- [Features](#features)
- [Usage](#usage)
  - [Quick Start](#quick-start)
  - [KML File Naming Convention](#kml-file-naming-convention)
  - [Multiple Directories](#multiple-directories)
  - [With API Keys (Optional)](#with-api-keys-optional)
  - [Makefile Variables](#makefile-variables)
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
  - [Adaptive Downsampling](#adaptive-downsampling)
- [Development](#development)
  - [Frontend (TypeScript)](#frontend-typescript)
  - [Backend (Python)](#backend-python)
  - [Test Data Generation](#test-data-generation)

## Features

- Interactive density heatmap showing visited locations
- Altitude-colored flight paths
- Airport markers with ICAO codes and visit counts
- Statistics panel (distance, altitude, flight time)
- Year and aircraft filtering
- Flight replay with animated airplane marker
- Year-in-review "Wrapped" summary
- Shareable URLs - Copy URL to share exact map state
- Automatic privacy protection (individual timestamps removed)
- Mobile-friendly with zoom-based data loading
- Export map as JPG image

## Usage

### Quick Start

Place your KML files in a `kml/` directory, then:

```bash
# Build and generate heatmap
make

# Option 1: Open directly in browser (works with file:// protocol)
open docs/index.html

# Option 2: Serve via HTTP
make serve
# Then open http://localhost:8000/
```

Both methods work equally well. Opening directly is simpler, while serving via HTTP allows for easier sharing on your local network.

### KML File Naming Convention

The tool automatically detects and supports **two KML filename formats**:

#### SkyDemon Format

```
YYYYMMDD_HHMM_AIRPORT_REGISTRATION_TYPE.kml
```

**Example:** `20250822_1013_EDAV_DEHYL_DA40.kml`

Where:

- `YYYYMMDD` - Flight date (e.g., `20250822`)
- `HHMM` - Flight time (e.g., `1013`)
- `AIRPORT` - Airport ICAO code (e.g., `EDAV`)
- `REGISTRATION` - Aircraft registration without hyphen (e.g., `DEHYL` becomes `D-EHYL`)
- `TYPE` - Aircraft type (e.g., `DA40`, `C172`)

#### Charterware Format

```
YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE.kml
```

**Example:** `2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml`

Where:

- `YYYY-MM-DD` - Flight date with hyphens (e.g., `2026-01-12`)
- `HHMMh` - Flight time with 'h' suffix (e.g., `1513h`)
- `REGISTRATION` - Aircraft registration with hyphen (e.g., `OE-AKI`, `D-EXYZ`)
- `ROUTE` - Route in DEPARTURE-ARRIVAL format (e.g., `LOAV-LOAV`, `EDDF-EDDM`)

**Note:** Charterware KML files use a 2-second logging interval. The tool automatically generates synthetic timestamps for each coordinate point, enabling speed calculations, flight duration tracking, and time-based statistics even though Charterware files don't include per-point timestamps in the KML data.

**Why these formats?**

The filename formats enable:

- **Aircraft filtering** - Filter map by specific aircraft registration
- **Per-aircraft statistics** - View distance and flight time per aircraft
- **Aircraft model lookup** - Automatic lookup of aircraft make/model from registration (SkyDemon only; Charterware files don't include aircraft type in filename)
- **Route information** - Charterware files include departure and arrival airports

**Without these formats:**

Files will still be processed and paths will be displayed, but:

- Aircraft filtering will not be available
- Per-aircraft statistics will be grouped under "Unknown"
- Aircraft model information will not be fetched

If you have KML files with different naming conventions, they will work fine for basic visualization - you just won't get aircraft-specific features.

### Multiple Directories

You can process KML files from multiple directories at once:

```bash
python kml-heatmap.py kml/ kml-new/ --output-dir combined_output
```

The tool will automatically detect the format of each file and process them accordingly.

### With API Keys (Optional)

**Stadia Maps** - Get a free API key at [stadiamaps.com](https://stadiamaps.com/) for enhanced dark theme tiles

**OpenAIP** - Get a free API key at [openaip.net](https://www.openaip.net/) for aviation data overlay (airspaces, airports, navaids). **Required** for the Aviation Data layer.

```bash
# With one or both API keys
make STADIA_API_KEY=your_stadia_key OPENAIP_API_KEY=your_openaip_key

# Then serve
make serve
```

**Note:** OpenAIP tiles return 403 Forbidden without a valid API key. To verify your key works:

```bash
# Should return HTTP 200 with PNG image
curl -I "https://a.api.tiles.openaip.net/api/data/openaip/8/136/85.png?apiKey=YOUR_KEY"
```

### Makefile Variables

- `STADIA_API_KEY` - Stadia Maps API key for enhanced base tiles (optional)
- `OPENAIP_API_KEY` - OpenAIP API key for aviation data overlay (required for Aviation Data layer)
- `OUTPUT_DIR` - Output directory (default: `docs`)
- `CONTAINER_RUNTIME` - Container runtime to use (default: `docker`)

### Docker Usage

If you prefer using Docker directly:

```bash
# Build
docker build -t kml-heatmap .

# Generate from specific files
docker run -v $(pwd):/data kml-heatmap your_track.kml

# With API keys
docker run -v $(pwd):/data -e STADIA_API_KEY=key -e OPENAIP_API_KEY=key kml-heatmap *.kml

# Custom output directory
docker run -v $(pwd):/data kml-heatmap *.kml --output-dir mymap

# Debug mode
docker run -v $(pwd):/data kml-heatmap --debug your_track.kml

# Serve (optional - can also open index.html directly)
docker run -p 8000:8000 -v $(pwd):/data --entrypoint python kml-heatmap /app/serve.py
```

### Python Usage

```bash
pip install -r requirements.txt
python kml-heatmap.py your_track.kml

# Option 1: Open directly
open index.html

# Option 2: Serve via HTTP
python -m http.server 8000
```

### Command-Line Options

When using Docker or Python directly:

- `--output-dir DIR` - Output directory (default: current directory)
- `--debug` - Show debug output

## Privacy

Individual flight timestamps are automatically removed from exported data. The map shows where you've been and how much you've flown, but not when.

Kept:

- Coordinates, altitudes, distances
- Airport visit counts
- Total flight time

Removed:

- Individual flight dates/times

## Output

Creates `index.html` (10-20 KB) and a `data/` subdirectory with JavaScript files organized by year:

```
output-dir/
├── index.html
└── data/
    ├── 2025/
    │   ├── z0_4.js       # Low zoom data
    │   ├── z5_7.js       # Medium zoom data
    │   ├── z8_10.js      # Regional data
    │   ├── z11_13.js     # City-level data
    │   └── z14_plus.js   # Full detail data
    ├── 2026/
    │   └── (same structure)
    ├── airports.js       # Airport markers
    └── metadata.js       # Statistics and available years
```

Data is exported as JavaScript files (instead of JSON) for compatibility with the `file://` protocol (opening index.html directly in browser). Data is loaded progressively based on zoom level and filtered by year for better performance on mobile devices.

## Map Features

### Layers

- **Density Heatmap** (always visible) - Shows frequently visited locations
- **Altitude Profile** (toggle) - Color-coded paths by elevation
- **Airspeed Profile** (toggle) - Color-coded paths by groundspeed
- **Airports** (toggle) - Airport markers with ICAO codes
- **Aviation Data** (toggle, requires OpenAIP API key) - Airspaces, airports, navaids, and reporting points from OpenAIP

### Controls

- **Stats Button** - View statistics (distance, altitude, airports, flight time)
- **Export Button** - Save current map view as JPG image
- **Wrapped Button** - View year-in-review summary with fun facts
- **Replay Controls** - Animate flight paths with adjustable speed (default 50x)

### Filtering

- **Year Filter** - View flights from specific years or all years combined
- **Aircraft Filter** - Filter by aircraft registration to see flights per aircraft
- **Path Selection** - Click paths to highlight and view detailed statistics

### Shareable URLs

Map state is automatically encoded in the URL for easy sharing. Copy the URL from your browser's address bar to share:

- Specific year or all years (`?y=2025` or `?y=all`)
- Aircraft filter (`?a=D-EAGJ`)
- Selected paths (`?p=1,5,12`)
- Layer visibility (8 flags: heatmap, altitude, airspeed, airports, aviation, stats, wrapped, buttonsHidden)
  - Example: `?v=10010000`
- Map position (`?lat=51.5&lng=13.4&z=10`)

**Example URLs:**

```
?y=all                                   # Show all years
?y=2025&v=01000000                       # 2025 with altitude view only
?y=2025&a=D-EAGJ&lat=51.5&lng=13.4&z=10  # Complete state
```

URL parameters take precedence over localStorage, allowing shared links to override saved preferences.

### Smart Features

- Mid-flight detection - Filters recordings started mid-flight
- Airport deduplication - Merges nearby airports (within 1.5km)
- ICAO validation - Only shows valid airports with ICAO codes
- Parallel processing - Fast parsing of multiple files
- State persistence - Saves to localStorage and syncs with URL for shareable links
- Year-based organization - Automatically extracts and organizes flights by year
- Per-aircraft statistics - Tracks flight time and distance per aircraft registration
- Aircraft model lookup - Automatically fetches aircraft make/model from airport-data.com, with smart handling of re-registered callsigns (prefers current registration)

## Technical Details

### Adaptive Downsampling

The tool automatically scales output file sizes based on dataset size:

- **Small datasets** (< target): Uses standard epsilon values, preserves all detail
- **Large datasets** (> target): Applies logarithmic scaling to stay under size limits

Target limits per resolution (per year):

- z14_plus: 100k points (~8.3MB max) - Full resolution detail
- z11_13: 50k points (~4.1MB max) - High detail for city level
- z8_10: 30k points (~2.5MB max) - Enhanced regional detail
- z5_7: 15k points (~1.2MB max) - Improved country level
- z0_4: 10k points (~830KB max) - Better continent view

**Example scaling**: 100,000 KML files (5M points)

- Processing time: ~11 minutes
- Total output: ~100MB (all zoom levels)
- Compression ratio: 50:1 (5M points → 100k in browser)

Uses Ramer-Douglas-Peucker algorithm to generate 5 resolution levels. With adaptive downsampling, output size is predictable regardless of input size.

Supports KML files from Google Earth, Google Maps, SkyDemon, and other aviation apps.

## Development

### Frontend (TypeScript)

The interactive map interface is built with TypeScript and has comprehensive test coverage.

**Setup:**

```bash
npm install
```

**Available commands:**

```bash
npm run build          # Build production bundles (minified)
npm run build:dev      # Build development bundles (with sourcemaps)
npm run build:watch    # Watch mode for development
npm test               # Run tests
npm run test:watch     # Watch mode for tests
npm run test:ui        # Run tests with UI
npm run test:coverage  # Generate coverage report
npm run typecheck      # Type checking
npm run lint           # Lint TypeScript code
npm run lint:fix       # Auto-fix linting issues
npm run format         # Format code with Prettier
npm run format:check   # Check code formatting
npm run update-deps    # Update dependencies to latest versions
```

**Build Output:**

- **Format**: IIFE (Immediately Invoked Function Expression)
- **Protocol**: Compatible with `file://` protocol - open index.html directly in browser
- **Production**: Minified bundles for optimal performance
- **Development**: Unminified with sourcemaps for debugging

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
- **Build output** in `kml_heatmap/static/` (bundle.js, mapApp.bundle.js)

### Backend (Python)

**Setup:**

```bash
pip install -r requirements.txt
pip install -r requirements-test.txt
```

**Testing:**

```bash
pytest --cov=kml_heatmap --cov-report=term
```

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

See `scripts/README.md` for more details.
