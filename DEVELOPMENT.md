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
npm run typecheck        # Type-check the frontend and the Node.js scripts
npm run typecheck:node   # Type-check build.js, scripts/*.js and the tool configs only
npm run typecheck:tests  # Type-check the unit and e2e tests
npm run lint             # Lint TypeScript code
npm run lint:fix         # Auto-fix linting issues
npm run lint:unused      # Files, exports and dependencies nothing reaches (knip)
npm run format           # Format code with Prettier
npm run format:check     # Check code formatting
```

**E2E Tests:**

End-to-end tests use [Playwright](https://playwright.dev/). They verify the
full map rendering pipeline including map initialization, layer toggles,
filters, statistics panel, wrapped modal, airport markers and replay. The
`desktop` project runs every spec but `mobile.spec.ts` and `visual.spec.ts` in
Chromium. The `mobile` project runs `mobile.spec.ts` and the viewport
independent specs (`core`, `layers`, `state`) on a phone viewport, and the
`webkit` project runs `core` and `mobile` on an emulated iPhone. The `visual`
project compares screenshots of a fixture site and only exists inside the
Playwright image (or with `VISUAL_SNAPSHOTS=1`), so a plain run leaves it out
(see CONTRIBUTING.md). Every page is scanned for accessibility violations with
axe. The suite does not reach the network: the page carries its own JavaScript
and CSS, CARTO's base style is answered with a stub that draws a background and
asks for no glyphs or sprite, every map tile with a transparent pixel, and any
other cross-origin request fails the test that made it (see
`tests/e2e/fixtures.ts`, which every spec imports `test` and `expect` from).
What the specs know about the map library is in `tests/e2e/map.ts`: a spec
asks it for the map's locators, zoom, layers and popups instead of naming a
`.maplibregl-*` class or reaching into `window.mapApp.map`. Its zoom levels
are the ones of shared links, one higher than MapLibre's own (see
`ZOOM_OFFSET` in `utils/constants.ts`). A few specs depend on whether the site
was built with `CARTO_API_KEY` (any value works) and skip otherwise; CI tests
a site with a dummy key and one without.

The tests run against `docs/` (the `visual` project against `visual-site/`,
with the same checks), which must be built from the current sources first. A
fixture every spec gets (`tests/e2e/site-check.ts`) compares the build hash
in `docs/mapApp.bundle.js` with the checkout (the frontend sources, the
stylesheets, the build configuration and the pinned esbuild and Lucide
versions, see `scripts/README.md`) and fails the tests with a hint when they
differ. It also fails them when `docs/index.html` is older than the Python
package, its templates and static assets or `package-lock.json`, and when
`E2E_API_KEYS` (`dummy` or `none`, set by CI) does not match whether
`docs/map_config.js` carries a key:

```bash
# Install Playwright browsers (first time only)
npx playwright install --with-deps chromium webkit

# Build the site from the current sources
npm run build && python -m kml_heatmap data --output-dir docs

# Run E2E tests
npm run test:e2e
npm run test:e2e:mobile

# On NixOS, use the system Chromium; Playwright's WebKit build does not run
# there, but the Playwright container image carries it (the image the visual
# job of .github/workflows/test.yml runs; scripts/check_locks.py keeps the
# reference here in step with it)
nix-shell -p chromium python3 --run 'CHROMIUM_PATH=$(which chromium) npm run test:e2e -- --project=desktop --project=mobile'
podman run --rm --userns=keep-id -v "$PWD:/work" -w /work mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 npx playwright test --project=webkit
```

Tests are located in `tests/e2e/` and configured via `playwright.config.ts`.
The test server starts `python3 -m http.server` serving `docs/` on port 8000,
or on `E2E_PORT` when that is set, and the fixture site of the visual project
on the port after it: two checkouts tested at the same time (git
worktrees, for one) need a port each, or the second would reuse the first
one's server and test the wrong site. The visual project runs in a
container; with `--network host`, as in CONTRIBUTING.md, it shares the host's
ports and needs the variable passed in (`-e E2E_PORT`). Failed tests keep
their traces in `test-results/`, and every run writes an HTML report to
`playwright-report/` (`npx playwright show-report`).

**Build Output:**

- **Format**: ES modules with code splitting; the page has to be served
  over HTTP (`make serve`), it does not work when opened from disk, and the
  map needs WebGL
- **Production**: Minified bundles for optimal performance; the build fails
  when `mapApp.bundle.js` and `shared.bundle.js` together, or
  `features.bundle.js`, exceed their size budget in `build.js`
- **Development**: Unminified for debugging
- Both write a source map next to the bundle; it holds the mappings and file
  names only, not the TypeScript sources

`npm run build` produces three bundles. `mapApp.bundle.js` is the map itself,
and `features.bundle.js` holds Replay, Wrapped and the flight list of the
airport popups, which the page imports the first time one of them is opened.
`shared.bundle.js` is what the two have in common. Their styles are split
the same way and travel with them: `kml_heatmap/static/styles.css` is linked
in the page, `features.css` is fetched alongside the feature bundle (see
`services/featureLoader.ts`), and each has its own budget in
`tests/test_asset_budget.py`. A rule belongs in `features.css` when its
selector names replay or Wrapped; the two file headers spell out the rest,
including the one-way dependency between them. The bundler moves the
modules both entry points use into `shared.bundle.js`, which each of them
imports, because several of them hold state that has to be a single
instance. Two entry points can only share one chunk, so it has a fixed name
that the site publishes and the page preloads; the build fails if it ever
writes another file (`assertExpectedOutputs` in `build.js`).
The same command copies MapLibre GL JS and html-to-image out of
`node_modules` into `kml_heatmap/static/vendor/`, which is what the published
page loads them from, and the country flags of `flag-icons` into
`kml_heatmap/static/flags/` (`scripts/vendor.js`). All of it is gitignored,
and `make clean` removes it.

The flags are the one asset the wheel leaves out: 271 of them are two
megabytes, and any one export visits a handful, so `site_assets.py` publishes
only the countries the flights touched and lists them in `metadata.json`. A
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
    page's CSP allows no external font),
    and emoji render at a different weight, colour and baseline on every
    platform. The shapes come from Lucide, imported by name so the bundler
    keeps only the ones the page draws; the GitHub mark and the top-down
    aircraft are drawn in `utils/icons.ts` because Lucide carries neither
- **Tests**
  - Unit tests: `tests/frontend/unit/` (Vitest)
  - E2E tests: `tests/e2e/` (Playwright)
- **Stylesheets** in `kml_heatmap/static/` (`styles.css` and `features.css`)
- **Build output** in `kml_heatmap/static/` (`mapApp.bundle.js`,
  `features.bundle.js`, `shared.bundle.js`, their source maps, `vendor/` and
  `flags/`)
- **Build scripts** `build.js` and `scripts/*.js`, plain JavaScript with
  JSDoc types that `tsconfig.node.json` checks (`npm run typecheck`)

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
changing the dependencies. The test lock is compiled with the runtime lock
as a constraint, so a package both of them pin has the same version in each.

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

A run with `--cov` fails below the `fail_under` floor in `pyproject.toml`,
which is kept one to three points below what the suite reaches.
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
