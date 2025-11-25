# KML Heatmap Generator

Create interactive heatmap visualizations from KML files with **progressive loading** for mobile-friendly, lightweight maps.

## 🚀 What's New: Progressive Loading

The generator now uses **progressive loading** by default, which:
- ✨ Creates a lightweight, minified HTML file (~10-20 KB instead of several MB)
- 📊 Stores data in external JSON files at 5 resolution levels (continent → country → regional → city → full detail)
- 🔄 Loads appropriate data based on zoom level dynamically
- 📱 Significantly reduces initial load time and memory usage on mobile devices
- 🌐 Perfect for hosting on GitHub Pages or any static web server
- 🗜️ Automatic HTML minification for 30-40% smaller file sizes

## Installation

### Option 1: Using Docker (Recommended)

```bash
# Build the Docker image
docker build -t kml-heatmap .

# Generate the heatmap from your KML files
docker run -v $(pwd):/data kml-heatmap your_track.kml

# Serve the heatmap locally with built-in HTTP server
docker run -p 8000:8000 -v $(pwd):/data --entrypoint python kml-heatmap /app/serve.py

# Then open http://localhost:8000/ in your browser

# Optional: Use Stadia Maps for detailed dark tiles (requires free API key)
docker run -v $(pwd):/data -e STADIA_API_KEY=your_api_key_here kml-heatmap your_track.kml
```

### Option 2: Local Python Installation

```bash
pip install -r requirements.txt
```

### Stadia Maps API Key (Optional)

For enhanced map detail with Stadia Maps' Alidade Smooth Dark tiles:
1. Get a free API key at [stadiamaps.com](https://stadiamaps.com/)
2. Set the `STADIA_API_KEY` environment variable when running

Without an API key, the tool falls back to CartoDB dark_matter tiles.

## Usage

### Using Docker

```bash
# Show help
docker run kml-heatmap --help

# Basic workflow - generate and serve
docker run -v $(pwd):/data kml-heatmap your_track.kml
docker run -p 8000:8000 -v $(pwd):/data --entrypoint python kml-heatmap /app/serve.py

# With Stadia Maps API key for enhanced detail
docker run -v $(pwd):/data -e STADIA_API_KEY=your_api_key_here kml-heatmap your_track.kml

# Process all KML files in a directory
docker run -v $(pwd):/data -e STADIA_API_KEY=your_api_key_here kml-heatmap ./flights/

# Multiple files
docker run -v $(pwd):/data kml-heatmap track1.kml track2.kml track3.kml

# With custom options
docker run -v $(pwd):/data kml-heatmap *.kml --output my_routes.html --radius 15

# Debug mode (troubleshoot parsing issues)
docker run -v $(pwd):/data kml-heatmap --debug your_track.kml
```

### Using Python Directly

#### Basic usage (single file):
```bash
python kml-heatmap.py your_track.kml

# Serve the files locally
python -m http.server 8000

# Then open http://localhost:8000/ in your browser
```

This creates `index.html` and a `data/` directory with JSON files.

#### With Stadia Maps API key:
```bash
export STADIA_API_KEY=your_api_key_here
python kml-heatmap.py your_track.kml
```

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

- `--output FILE` - Specify output HTML filename (default: `index.html`)
- `--data-dir DIR` - Directory for JSON data files (default: `data`)
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
- ✓ **Image export** - Export current viewport as high-quality JPG image (95% quality, 2x resolution) with timestamped filename (no UI controls)
- ✓ Interactive map with zoom and pan
- ✓ **Enhanced dark theme** - Stadia Maps Alidade Smooth Dark tiles (with API key) or CartoDB dark_matter fallback
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
- Capture the current viewport as a high-quality JPG image (95% quality, 2x resolution)
- Download the image with a timestamped filename (e.g., `heatmap_export_2025-11-05T14-30-00.jpg`)
- Export includes all visible layers (density heatmap, altitude profile, airports) in their current state
- UI controls (buttons, zoom, layers) are automatically hidden during export
- Perfect for sharing specific views of your flight data on social media or in reports

## How It Works

### Progressive Loading (Technical Details)

The generator uses a multi-resolution approach similar to map tile servers:

1. **Data Processing**:
   - Parses all KML files and extracts coordinates and altitude data
   - Generates 5 resolution levels using Ramer-Douglas-Peucker algorithm:
     - **Zoom 0-4** (Continent): ~93% reduction, epsilon 0.0008
     - **Zoom 5-7** (Country): ~90% reduction, epsilon 0.0004
     - **Zoom 8-10** (Regional): ~80% reduction, epsilon 0.0002
     - **Zoom 11-13** (City): ~50% reduction, epsilon 0.0001
     - **Zoom 14+** (Full detail): No reduction, full precision

2. **File Structure**:
   ```
   ├── index.html          (~10-20 KB - minified HTML)
   └── data/
       ├── data_z0_4.json    (Continent level)
       ├── data_z5_7.json    (Country level)
       ├── data_z8_10.json   (Regional level)
       ├── data_z11_13.json  (City level)
       ├── data_z14_plus.json (Full detail)
       ├── airports.json     (Airport markers)
       └── metadata.json     (Statistics & config)
   ```

3. **Dynamic Loading**:
   - HTML loads only the appropriate resolution based on current zoom level
   - Switches resolution automatically when user zooms
   - Caches loaded data to avoid re-fetching
   - Reduces mobile data usage and memory consumption

4. **Benefits**:
   - Initial page load: ~10-20 KB instead of several MB (99%+ reduction)
   - Automatic HTML minification removes unnecessary whitespace
   - Mobile-friendly with minimal memory usage
   - Fast loading on slow connections
   - Can be hosted on any static web server or CDN

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
Visualize your flight logs with enhanced detail:
```bash
docker run -v $(pwd):/data -e STADIA_API_KEY=your_api_key_here kml-heatmap ./flight_logs/
```

View specific flights:
```bash
docker run -v $(pwd):/data -e STADIA_API_KEY=your_api_key_here kml-heatmap flight1.kml flight2.kml flight3.kml
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
