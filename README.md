# KML Heatmap Generator

[![codecov](https://codecov.io/gh/saschagrunert/kml-heatmap/graph/badge.svg?token=AxIuoWeFSy)](https://codecov.io/gh/saschagrunert/kml-heatmap)

Create interactive heatmap visualizations from KML files.

**[Live Demo](https://saschagrunert.github.io/kml-heatmap)**

## Features

- Interactive density heatmap showing visited locations
- Altitude-colored flight paths
- Airport markers with ICAO codes and visit counts
- Statistics panel (distance, altitude, flight time)
- Automatic privacy protection (individual timestamps removed)
- Mobile-friendly with zoom-based data loading
- Export map as JPG image

## Usage

### Quick Start

Place your KML files in a `kml/` directory, then:

```bash
# Build and generate heatmap
make

# Serve locally
make serve
```

Then open http://localhost:8000/

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

# Serve
docker run -p 8000:8000 -v $(pwd):/data --entrypoint python kml-heatmap /app/serve.py
```

### Python Usage

```bash
pip install -r requirements.txt
python kml-heatmap.py your_track.kml
python -m http.server 8000
```

### Command-Line Options

When using Docker or Python directly:

- `--output-dir DIR` - Output directory (default: current directory)
- `--debug` - Show debug output

### Flight Time Offsets (Optional)

Add non-recorded flight time to specific aircraft by creating a `flight_time_offsets.json` file:

```json
{
  "D-EAGJ": {
    "2025": 10.5,
    "2024": 15.0
  },
  "D-EHYL": {
    "2025": 5.0
  }
}
```

- Aircraft registration → Year → Hours to add
- Offsets are applied silently to displayed flight times
- File is gitignored by default (private data)
- Useful for including non-GPS flights, simulator time, or manual logbook entries

## Privacy

Individual flight timestamps are automatically removed from exported data. The map shows where you've been and how much you've flown, but not when.

Kept:

- Coordinates, altitudes, distances
- Airport visit counts
- Total flight time

Removed:

- Individual flight dates/times

## Output

Creates `index.html` (10-20 KB) and a `data/` subdirectory with JSON files in the output directory:

```
output-dir/
├── index.html
└── data/
    ├── data_z0_4.json      # Low zoom data
    ├── data_z5_7.json      # Medium zoom data
    ├── data_z8_10.json     # Regional data
    ├── data_z11_13.json    # City-level data
    ├── data_z14_plus.json  # Full detail data
    ├── airports.json       # Airport markers
    └── metadata.json       # Statistics
```

Data is loaded progressively based on zoom level for better performance on mobile devices.

## Map Features

### Layers

- **Density Heatmap** (always visible) - Shows frequently visited locations
- **Altitude Profile** (toggle) - Color-coded paths by elevation
- **Airports** (toggle) - Airport markers with ICAO codes
- **Aviation Data** (toggle, requires OpenAIP API key) - Airspaces, airports, navaids, and reporting points from OpenAIP

### Controls

- **Stats Button** - View statistics (distance, altitude, airports, flight time)
- **Export Button** - Save current map view as JPG image

### Smart Features

- Mid-flight detection - Filters recordings started mid-flight
- Airport deduplication - Merges nearby airports (within 1.5km)
- ICAO validation - Only shows valid airports with ICAO codes
- Parallel processing - Fast parsing of multiple files

## Technical Details

Uses Ramer-Douglas-Peucker algorithm to generate 5 resolution levels, reducing data size by 50-95% depending on zoom level. HTML is automatically minified.

Supports KML files from Google Earth, Google Maps, SkyDemon, and other aviation apps.
