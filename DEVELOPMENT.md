<!--
The developer guide. README.md is the user-facing manual and links here;
CONTRIBUTING.md covers the setup, the checks and the commit conventions.
-->

# Development

`make help` lists all targets. `make test`, `make lint`, `make format` and
`make lock` run locally (Python and Node required); `make lock` regenerates the
hashed Python lock files from `pyproject.toml`.

The published site is built on every push to `main` by the `site` and
`deploy` jobs of the `test` workflow, which wait for every test job to pass
and skip a commit that is no longer the head of `main`:
they run the same steps as `make build` (frontend bundle, then
`python -m kml_heatmap data`) and upload the result to GitHub Pages. Nothing
generated is committed; `docs/` is only the default output directory of a
local `make build`.

Install the pre-commit hooks (ruff, prettier, typos, gitleaks, whitespace
fixers and, for commits that touch `data/`, the obfuscation check) with
`pip install pre-commit && pre-commit install`. All but gitleaks and the
whitespace fixers run from your own environment rather than a pinned mirror, so
activate the virtual environment and run `npm ci` to get the versions CI
installs. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and commit conventions.

## Frontend (TypeScript)

The interactive map interface is built with TypeScript and has comprehensive
test coverage.

**Setup:**

```bash
npm ci
```

**Available commands:**

```bash
npm run build            # Build the production bundle (minified, size budget checked)
npm run build:dev        # Build the development bundle (unminified)
npm run build:watch      # Watch mode for development
npm run test             # Run unit tests
npm run test:watch       # Watch mode for tests
npm run test:ui          # Run tests with UI
npm run test:coverage    # Generate coverage report
npm run test:e2e         # Run E2E tests (Playwright, all projects)
npm run test:e2e:mobile  # Run E2E tests with the mobile project
npm run test:e2e:webkit  # Run E2E tests with the WebKit (iPhone) project
npm run test:e2e:ui      # Run E2E tests with interactive UI
npm run typecheck        # Type-check the frontend
npm run typecheck:tests  # Type-check the unit and e2e tests
npm run lint             # Lint TypeScript code
npm run lint:fix         # Auto-fix linting issues
npm run format           # Format code with Prettier
npm run format:check     # Check code formatting
```

**E2E Tests:**

End-to-end tests use [Playwright](https://playwright.dev/). They verify the
full map rendering pipeline including map initialization, layer toggles,
filters, statistics panel, wrapped modal, airport markers and replay. The
`desktop` project runs every spec but `mobile.spec.ts` in Chromium. The
`mobile` project runs `mobile.spec.ts` and the viewport independent specs
(`core`, `layers`, `state`) on a phone viewport, and the `webkit` project runs
`core` and `mobile` on an emulated iPhone. The `visual` project compares
screenshots and only exists inside the Playwright image, so a plain run leaves
it out (see CONTRIBUTING.md). Every page is scanned for accessibility
violations with axe. The suite does not reach the network: the page carries
its own JavaScript and CSS, every map tile is answered locally, and any other
cross-origin request fails the test that made it (see
`tests/e2e/fixtures.ts`). A few specs depend on whether the site was built
with `CARTO_API_KEY` and `OPENAIP_API_KEY` (any value works) and skip
otherwise; CI tests a site with dummy keys and one without.

The tests run against `docs/`, which must be built from the current sources
first. The global setup compares the build hash in `docs/mapApp.bundle.js`
with the frontend sources and stops with a hint when they differ:

```bash
# Install Playwright browsers (first time only)
npx playwright install --with-deps chromium webkit

# Build the site from the current sources
npm run build && python -m kml_heatmap data --output-dir docs

# Run E2E tests
npm run test:e2e
npm run test:e2e:mobile

# On NixOS, use the system Chromium; Playwright's WebKit build does not run
# there, but the Playwright container image carries it (use the image tag of
# the version `npx playwright --version` prints)
nix-shell -p chromium python3 --run 'CHROMIUM_PATH=$(which chromium) npm run test:e2e -- --project=desktop --project=mobile'
podman run --rm --userns=keep-id -v "$PWD:/work" -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test --project=webkit
```

Tests are located in `tests/e2e/` and configured via `playwright.config.ts`.
The test server starts `python3 -m http.server` serving `docs/`. Failed tests
keep their traces in `test-results/`, and every run writes an HTML report to
`playwright-report/` (`npx playwright show-report`).

**Build Output:**

- **Format**: IIFE (Immediately Invoked Function Expression)
- **Protocol**: Compatible with `file://` protocol - open index.html directly in browser
- **Production**: Minified bundles for optimal performance; the build fails
  when either exceeds its size budget in `build.js`
- **Development**: Unminified for debugging
- Both write a source map next to the bundle; it holds the mappings and file
  names only, not the TypeScript sources

`npm run build` produces two bundles. `mapApp.bundle.js` is the map itself,
and `features.bundle.js` holds Replay and Wrapped, which the page fetches the
first time one of them is opened; most visits never do. The modules both use
are resolved to a global the main bundle publishes rather than copied into
the second one (`scripts/shared-modules.js` and
`kml_heatmap/frontend/shared.ts`), because several of them hold state that
has to be a single instance; the build fails when a module ends up in both.
The same command copies Leaflet, leaflet.heat and dom-to-image out of
`node_modules` into `kml_heatmap/static/vendor/`, which is what the published
page loads them from, and the country flags of `flag-icons` into
`kml_heatmap/static/flags/`. All of it is gitignored.

The flags are the one asset the wheel leaves out: 271 of them are two
megabytes, and any one export visits a handful, so `site_assets.py` publishes
only the countries the flights touched and lists them in `metadata.js`. A
site generated from a `pip install`, which has no `static/flags/`, publishes
none and the statistics rail falls back to the ISO country code.

**Architecture:**

- **TypeScript modules** in `kml_heatmap/frontend/`
  - `calculations/` - Statistics and data processing
  - `features/` - Airports, layers, replay, wrapped
  - `services/` - Data loading and caching
  - `state/` - URL state management
  - `ui/` - UI managers for controls and interactions
  - `utils/` - Formatters, colour scales, geometry helpers and the icon set.
    Every mark in the interface is an inline SVG: an icon font is out (the
    page's CSP allows no external font and it has to work from `file://`),
    and emoji render at a different weight, colour and baseline on every
    platform. The shapes come from Lucide, imported by name so the bundler
    keeps only the ones the page draws; the GitHub mark and the top-down
    aircraft are drawn in `utils/icons.ts` because Lucide carries neither
- **Tests**
  - Unit tests: `tests/frontend/unit/` (Vitest)
  - E2E tests: `tests/e2e/` (Playwright)
- **Build output** in `kml_heatmap/static/` (`mapApp.bundle.js`,
  `features.bundle.js` and `vendor/`)

## Backend (Python)

**Setup:**

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e '.[test,dev]'
```

The dependencies are declared once, in `pyproject.toml`: the runtime
dependencies plus the `test` and `dev` extras. The CI and the container images
install the hashed lock files compiled from it (`requirements.lock`,
`requirements-test.lock`) instead; regenerate them with `make lock` after
changing the dependencies.

**Testing:**

pytest no longer forces coverage or parallel execution, so a plain `pytest` run
is fast and readable. The flags used by CI and `make test` are:

```bash
pytest                                          # Run all tests
pytest tests/test_parser.py                     # Run specific test file
pytest -x                                       # Stop on first failure
pytest -n auto --cov=kml_heatmap --cov-branch --cov-report=xml --cov-report=term
pytest --cov=kml_heatmap --cov-report=html      # HTML coverage report (htmlcov/)
```

A run with `--cov` fails below the `fail_under` floor in `pyproject.toml`.
Property-based tests use [Hypothesis](https://hypothesis.readthedocs.io/).

**Checks:**

```bash
python scripts/check_locks.py           # Lock files, Playwright image and version pins
ruff check . && ruff format --check .   # Lint and formatting
mypy .                                  # Type checking
bandit -r kml_heatmap -ll               # Security scan
typos                                   # Spell check (config in _typos.toml)
gitleaks dir .                          # Secret scan (config in .gitleaks.toml)
make check-obfuscation                  # KML files in data/ are obfuscated
```

**Dependencies:**

- `lxml` - Fast XML parsing for KML files
- `rcssmin`, `rjsmin`, `minify-html` - Output minification (HTML/CSS/JS)

## Test Data Generation

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
