# Scripts

Utility scripts for testing and development.

## generate_test_data.py

Generates realistic test KML files with curved flight paths between major European airports.

### Features

- Curved flight paths using quadratic Bezier curves (not straight lines)
- Random deviations to spread data across Germany for better heatmap visualization
- Realistic altitude profiles (climb, cruise, descend)
- SkyDemon-compatible KML format with proper timestamps

### Usage

```bash
# Generate 1000 files (default)
python3 scripts/generate_test_data.py

# Generate 10000 files
python3 scripts/generate_test_data.py 10000

# Generate 5000 files to custom directory
python3 scripts/generate_test_data.py 5000 --output custom_test_data

# See all options
python3 scripts/generate_test_data.py --help
```

### Testing Generated Data

```bash
# Build with test data
make build INPUT_DIR=kml_test_10000

# Or with Docker
docker run --rm -v $(pwd):/data kml-heatmap kml_test_10000
```

### Performance Testing

Recommended test sizes:

- **1k flights**: Quick test, ~50MB source data
- **10k flights**: Standard test, ~500MB source data
- **100k flights**: Stress test, ~5GB source data, takes ~10 minutes to process

The system has been tested and optimized to handle 100k+ flights smoothly.
