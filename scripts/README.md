# Scripts

The build helpers `build.js` imports, the repository consistency check and
the test data generator. The JavaScript files are type-checked with
`tsconfig.node.json` (`npm run typecheck`).

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

Generating a site reads the KML files and leaves them alone; only
`--obfuscate-inputs` or `make obfuscate` rewrites them. The generated files
carry no real dates anyway.

```bash
# Build with test data
make build INPUT_DIR=kml_test_10000

# Or with Docker
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

Checks the versions that are written down in more than one place, which
nothing else reads together:

- `requirements.lock` and `requirements-test.lock` still satisfy the ranges
  in `pyproject.toml`, and the two agree on every package both pin (CI
  installs `requirements-test.lock` alone where it needs both). Dependabot
  bumps `pyproject.toml` without recompiling the locks, so this fails such a
  pull request with a hint to run `make lock`.
- The Playwright image of the `visual` job in `.github/workflows/test.yml`
  is pinned by its `@sha256` digest, its tag matches the `@playwright/test`
  version in `package-lock.json`, and `CONTRIBUTING.md` and `DEVELOPMENT.md`
  quote exactly the same image reference.
- `__version__` in `kml_heatmap/__init__.py` matches `version` in
  `package.json` and both version fields of `package-lock.json`.

The pre-commit hook revisions are not checked: the linters and formatters
run from the project environment, so they have no revision of their own to
drift. `make lint` and the CI lint job run it.

## source-hash.js

The content hash of everything that shapes a built site: the TypeScript
sources in `kml_heatmap/frontend/`, the files in `BUILD_FILES` (`build.js`,
`tsconfig.json` and the two stylesheets) and
the versions `package-lock.json` pins for `BUILD_PACKAGES` (esbuild and
Lucide, the one package bundled into the page). `build.js` writes it into
the first line of every bundle. The Playwright global setup
(`tests/e2e/global-setup.ts`) compares that line in `docs/mapApp.bundle.js`
with the checkout, so the e2e tests refuse to run against a stale site, and
the generator warns when the bundle it is about to publish is stale.
`kml_heatmap/site_assets.py` mirrors the hash in Python;
`TestSourceHashParity` in `tests/test_site_assets.py` checks that both
implementations agree.

## vendor.js

Copies the third-party files the published page loads (Leaflet with its
images, leaflet.heat and html-to-image) out of `node_modules` into
`kml_heatmap/static/vendor/`, and every country flag of `flag-icons` into
`kml_heatmap/static/flags/`. Both directories are generated and gitignored,
and each build replaces them, so a file dropped from the list does not
linger. Serving the files from the site keeps the page working during a CDN
outage, keeps visitors' addresses away from CDNs and leaves
`package-lock.json` as the one place their versions are pinned.
`kml_heatmap/site_assets.py` keeps its own list of the files it publishes,
in step with `VENDOR_FILES`; `tests/frontend/unit/vendor.test.ts` checks
`VENDOR_FILES` against `node_modules`. The wheel ships `vendor/` but not
`flags/`, and the Python side publishes only the flags of the countries an
export visited.
