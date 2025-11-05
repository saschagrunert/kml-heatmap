# KML Heatmap Generator

Create interactive heatmap visualizations from KML files overlaid on real map tiles.

## Installation

### Option 1: Using Docker (Recommended)

```bash
# Build the Docker image
docker build -t kml-heatmap .

# Run with your KML files
docker run -v $(pwd):/data kml-heatmap your_track.kml
```

### Option 2: Local Python Installation

```bash
pip install -r requirements.txt
```

## Usage

### Using Docker

```bash
# Show help
docker run kml-heatmap --help

# Basic usage (single file)
docker run -v $(pwd):/data kml-heatmap your_track.kml

# Process all KML files in a directory
docker run -v $(pwd):/data kml-heatmap ./flights/

# Multiple files
docker run -v $(pwd):/data kml-heatmap track1.kml track2.kml track3.kml

# Mix files and directories
docker run -v $(pwd):/data kml-heatmap flight.kml ./more_flights/ another.kml

# With custom options
docker run -v $(pwd):/data kml-heatmap *.kml --output my_routes.html --radius 15

# Debug mode (troubleshoot parsing issues)
docker run -v $(pwd):/data kml-heatmap --debug your_track.kml

# If your KML files are in a different directory
docker run -v /path/to/kml/files:/data kml-heatmap .
```

### Using Python Directly

#### Basic usage (single file):
```bash
python kml-heatmap.py your_track.kml
```

This creates `heatmap.html` in the current directory.

#### Multiple files:
```bash
python kml-heatmap.py track1.kml track2.kml track3.kml
```

#### Custom output file:
```bash
python kml-heatmap.py *.kml --output my_routes.html
```

#### Customize heatmap appearance:
```bash
python kml-heatmap.py track.kml --radius 15 --blur 20 --output custom.html
```

## Options

- `--output FILE` - Specify output HTML filename (default: `heatmap.html`)
- `--radius N` - Heatmap point radius in pixels (default: 10)
- `--blur N` - Heatmap blur amount (default: 15)
- `--debug` - Enable debug output to diagnose parsing issues

## Features

### Data Processing
- ✓ Parses KML files and extracts GPS coordinates
- ✓ Supports both single points (Placemarks) and paths (LineStrings, tracks)
- ✓ Handles Google Earth Track extensions (gx:coord)
- ✓ **Smart mid-flight detection** - Automatically filters out recordings that started mid-flight
- ✓ **Directory support** - Process entire folders of KML files at once
- ✓ **Parallel processing** - Fast concurrent parsing of multiple files (up to 8 simultaneous)
- ✓ Works with KML files from Google Earth, Google Maps, SkyDemon, and other aviation apps

### Visualizations
- ✓ **Altitude visualization** - Color-coded paths showing elevation changes (rounded to 100ft)
- ✓ **Airport markers** - Automatically detects and marks airports with flight counts and dates
- ✓ **ICAO code labels** - Airport ICAO codes displayed next to markers for easy identification
- ✓ **Altitude legend** - Gradient legend showing actual color-to-altitude mapping
- ✓ **Flight statistics panel** - Shows distance, altitude, airports visited, and more
- ✓ **Image export** - Export current viewport as PNG image with timestamped filename (no UI controls)
- ✓ Interactive map with zoom and pan
- ✓ Dark theme optimized for map viewing
- ✓ Toggle-able layers for different visualizations
- ✓ Customizable heatmap colors (blue → cyan → lime → yellow → red)
- ✓ **Leaflet tile rendering fix** - Eliminates gaps/lines between map tiles in dark mode

### Smart Filtering
- ✓ Filters out logging event markers (Log Start, Log Stop)
- ✓ Validates airport names using ICAO codes
- ✓ Removes duplicate airports within 1.5km radius
- ✓ Works with airports at any elevation (sea level to high altitude)

## Output

The script generates an interactive HTML file that you can open in any web browser with multiple layers and features:

### Layers

#### Density Heatmap (enabled by default)
- Shows where you've been most frequently
- High-density areas in red/yellow (most visited locations)
- Medium-density areas in green/cyan
- Low-density areas in blue

#### Altitude Profile (toggle-able layer)
- Color-coded paths showing elevation changes
- Blue segments = low altitude
- Cyan/Green segments = medium altitude
- Yellow/Orange/Red segments = high altitude
- Click on path segments to see exact altitude
- Includes gradient legend showing actual color mapping (automatically shown when layer is enabled)

#### Airports (enabled by default)
- Green airplane markers at visited airports
- ICAO codes displayed in white text next to each marker
- Shows airport ICAO code and name in popup
- Displays number of flights and dates
- Click markers to see detailed information
- Only shows valid airports (filters out mid-flight recording starts)

### Statistics Panel
Click the "📊 Stats" button to view:
- Total data points and number of paths
- **Airports Visited** - Count and scrollable list of all airports
- Total distance flown (in nautical miles)
- Maximum altitude reached
- Total elevation gain

### Image Export
Click the "📷 Export" button to:
- Capture the current viewport as a PNG image (2x resolution for high quality)
- Download the image with a timestamped filename (e.g., `heatmap_export_2025-11-05T14-30-00.png`)
- Export includes all visible layers (density heatmap, altitude profile, airports) in their current state
- UI controls (buttons, zoom, layers) are automatically hidden during export
- Perfect for sharing specific views of your flight data on social media or in reports

## How It Works

### Mid-Flight Detection
The script automatically detects and filters out recordings that started mid-flight by analyzing altitude patterns:
- If a path starts at high altitude (>400m) AND doesn't show significant altitude change in the first 25% of the path, it's flagged as a mid-flight start
- This works for airports at any elevation, from sea level to high-altitude airports
- Landing locations are still shown even if the recording started mid-flight

### Airport Recognition
Airports are identified and validated using several criteria:
- Must contain an ICAO code (4-letter code like EDMV, EDAQ, EDDC) OR be a multi-word name
- Single-word names without ICAO codes are filtered (e.g., "Unknown", "Hinding")
- Duplicates within 1.5km radius are merged (handles large airports with multiple runways)
- Route names like "EDMV Vilshofen - EDAQ Halle-Oppin" are split to show departure and arrival separately

## Examples

### Aviation
Visualize your flight logs:
```bash
docker run -v $(pwd):/data kml-heatmap ./flight_logs/
```

View specific flights:
```bash
docker run -v $(pwd):/data kml-heatmap flight1.kml flight2.kml flight3.kml
```

### Running/Hiking
View your running routes:
```bash
python kml-heatmap.py running_*.kml --output running_heatmap.html
```

Combine all your GPS tracks:
```bash
python kml-heatmap.py *.kml --output all_tracks.html --radius 12
```
