# KML Heatmap Generator

Create interactive heatmap visualizations from KML files.

## Features

- Interactive density heatmap showing visited locations
- Altitude-colored flight paths
- Airport markers with ICAO codes and visit counts
- Statistics panel (distance, altitude, flight time)
- Automatic privacy protection (individual timestamps removed)
- Mobile-friendly with zoom-based data loading
- Export map as JPG image

## Installation

### Docker (Recommended)

```bash
docker build -t kml-heatmap .
```

### Python

```bash
pip install -r requirements.txt
```

## Usage

### Quick Start

```bash
# Generate
docker run -v $(pwd):/data kml-heatmap your_track.kml

# Serve locally
docker run -p 8000:8000 -v $(pwd):/data --entrypoint python kml-heatmap /app/serve.py
```

Then open http://localhost:8000/

### With Stadia Maps (Optional)

Get a free API key at [stadiamaps.com](https://stadiamaps.com/) for enhanced dark theme tiles:

```bash
docker run -v $(pwd):/data -e STADIA_API_KEY=your_key kml-heatmap *.kml
```

### Python Usage

```bash
python kml-heatmap.py your_track.kml
python -m http.server 8000
```

### Examples

```bash
# Multiple files
docker run -v $(pwd):/data kml-heatmap track1.kml track2.kml track3.kml

# Directory of KML files
docker run -v $(pwd):/data kml-heatmap ./flights/

# Custom options
docker run -v $(pwd):/data kml-heatmap *.kml --output my_map.html --radius 15 --blur 20

# Debug mode
docker run -v $(pwd):/data kml-heatmap --debug your_track.kml
```

## Options

- `--output FILE` - Output filename (default: `index.html`)
- `--data-dir DIR` - Data directory (default: `data`)
- `--radius N` - Heatmap point radius (default: 10)
- `--blur N` - Heatmap blur amount (default: 15)
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

Generates `index.html` (10-20 KB) and a `data/` directory with JSON files:

```
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

Data is loaded based on zoom level for better performance on mobile devices.

## Map Features

### Layers

- **Density Heatmap** (always visible) - Shows frequently visited locations
- **Altitude Profile** (toggle) - Color-coded paths by elevation
- **Airports** (toggle) - Airport markers with ICAO codes

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
