# Scripts

Utility scripts for testing and development.

## generate_test_data.py

Generates realistic test KML files with curved flight paths between major
European airports.

### Features

- Curved flight paths using quadratic Bezier curves (not straight lines)
- Random deviations to spread data across Germany for better heatmap visualization
- Realistic altitude profiles (climb, cruise, descend)
- SkyDemon-style filenames (`N_REGISTRATION_TYPE.kml`) with one flight date
  per file (a `<TimeStamp>` element) and no per-point times, so the speed
  layer falls back to path averages

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
# Build with test data (obfuscates the generated files in place)
make build INPUT_DIR=kml_test_10000

# Or with Docker (also obfuscates the generated files in place)
mkdir -p out
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD/kml_test_10000:/data/kml_test_10000" -v "$PWD/out:/data/out" \
  -v ~/.cache/kml-heatmap:/cache \
  kml-heatmap kml_test_10000 --output-dir out
```

### Performance Testing

Recommended test sizes:

Every file holds 50 points and takes about 3.4 KB.

- **1k flights**: Quick test, ~3.4 MB source data
- **10k flights**: Standard test, ~34 MB source data
- **100k flights**: Stress test, ~340 MB source data (about 5M points),
  processed in about 10 minutes with parallel parsing and export

These numbers are the reference for the processing time mentioned in the main
`README.md`. The system has been tested and optimized to handle 100k+ flights.

## check_locks.py

Checks that `requirements.lock` and `requirements-test.lock` still satisfy
the ranges in `pyproject.toml` and agree on the shared pins. Dependabot bumps
`pyproject.toml` without recompiling the locks, so this fails such a pull
request with a hint to run `make lock`. `make lint` and the CI lint job run
it.

It also checks the versions that are written down in two places: the ruff,
prettier and typos revs in `.pre-commit-config.yaml` against the lock files,
`package-lock.json` and the typos action in the test workflow, and
`__version__` in `kml_heatmap/__init__.py` against `version` in
`package.json`.

## source-hash.js

The content hash of `kml_heatmap/frontend/`. `build.js` writes it into the
first line of the bundle, and the Playwright global setup
(`tests/e2e/global-setup.ts`) compares that line in `docs/mapApp.bundle.js`
with the sources, so the e2e tests refuse to run against a stale site.
