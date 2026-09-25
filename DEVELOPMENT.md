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

Install the pre-commit hooks (ruff, prettier, typos, gitleaks, the whitespace
fixers, the merge conflict marker, TOML and YAML checks and, for commits that
touch `data/`, the obfuscation check) with
`pip install pre-commit && pre-commit install`. All but gitleaks and the hooks
of `pre-commit-hooks` run from your own environment rather than a pinned
mirror, so activate the virtual environment and run `npm ci` to get the
versions CI installs. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow
and commit conventions.

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
npm run test:e2e         # Run E2E tests (Playwright; visual only in its image, see CONTRIBUTING.md)
npm run test:e2e:mobile  # Run E2E tests with the mobile project
npm run test:e2e:webkit  # Run E2E tests with the WebKit projects (iPhone and desktop Safari)
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
independent specs (`core`, `layers`, `state`) on a phone viewport. The
`webkit` project runs the same specs as `mobile` on an emulated iPhone, and
`webkit-desktop` runs `orientation` and `replay`, which drive the desktop
controls, in a desktop Safari viewport. The `visual`
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
a site with a dummy key and, for the specs about the base map requests
(`base-style`, `error-free`, `layers`) on the desktop, one without. It builds
both once, in the `e2e-sites` job, and runs every e2e job in the Playwright
image the visual job uses. The `desktop` and `mobile` projects are split into
two shards each (`--shard`), and the relief tests of the 3D view ("on the
relief" in `orientation.spec.ts`) of the `desktop` project run in a job of
their own, with the whole runner to themselves, since software WebGL takes
seconds per frame of the relief. The `webkit-desktop` project runs them with
its other specs.

The tests run against `docs/` (the `visual` project against `visual-site/`,
with the same checks), which must be built from the current sources first. A
fixture every spec gets (`tests/e2e/site-check.ts`) compares the build hash
in `docs/mapApp.bundle.js` with the checkout (the frontend sources, the
stylesheets, the build configuration and the pinned versions of esbuild,
Lucide and the vendored maplibre-gl, html-to-image and flag-icons, see
`scripts/README.md`) and fails the tests with a hint when they
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
# there, but the Playwright container image carries it (the image the e2e
# and visual jobs of .github/workflows/test.yml run; scripts/check_locks.py
# keeps the reference here in step with it)
nix-shell -p chromium python3 --run 'CHROMIUM_PATH=$(which chromium) npm run test:e2e -- --project=desktop --project=mobile'
podman run --rm --userns=keep-id -v "$PWD:/work" -w /work mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 npx playwright test --project=webkit --project=webkit-desktop
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
  map needs WebGL 2
- **Production**: Minified bundles for optimal performance; the build fails
  when `mapApp.bundle.js` and `shared.bundle.js` together,
  `features.bundle.js`, `wrapped.bundle.js`, `yearWorker.bundle.js` or the
  vendored MapLibre and html-to-image files exceed their size budget in
  `build.js`. Each has a
  budget for its bytes as written and one for them gzipped (level 9); the
  comment above the budgets says how much room they leave and why. CI's
  zlib compresses up to about 0.5 % differently from a local build, so go
  by the gzipped sizes CI prints when a budget is close
- **Development**: Unminified for debugging
- Both write a source map next to the bundle; it holds the mappings and file
  names only, not the TypeScript sources

`npm run build` produces five bundles. `mapApp.bundle.js` starts the map,
`features.bundle.js` holds Replay, the flight list of the airport popups,
the relief of the 3D view and the satellite imagery, and `wrapped.bundle.js`
holds Wrapped; the page
imports each of the last two the first time one of its features is opened.
`shared.bundle.js` is the app itself and everything the lazy bundles use of
it. Their styles are split the same way and travel with them:
`kml_heatmap/static/styles.css` is linked in the page, `features.css` and
`wrapped.css` are fetched alongside their bundles (see
`services/featureLoader.ts`), and each has its own budget in
`tests/test_asset_budget.py`. A rule belongs in `features.css` when its
selector names replay and in `wrapped.css` when it names Wrapped; the file
headers spell out the rest, including the one-way dependency on
`styles.css`. The bundler moves the modules the entry points share into a
chunk that each of them imports, because several of them hold state that
has to be a single instance. It makes one chunk for every set of entry
points that reach a module, so both lazy entry points import `mapApp.ts`:
everything the app reaches is then reached by all three and lands in the
one chunk, which has a fixed name that the site publishes and the page
preloads. A module replay and Wrapped share without the app would still get
a chunk of its own, and the build fails if it ever writes another file
(`assertExpectedOutputs` in `build.js`); such a module belongs where the app
reaches it (`segmentBounds` in `utils/geometry.ts` is one).
`yearWorker.bundle.js` is a build of its own and shares nothing with the
others: it is everything that works on the year files. The page imports it
next to the first year file (`services/dataLoader.ts`), and the file then
starts itself a second time as a module worker, which parses and decodes the
year files off the main thread and hands the columns back as typed arrays;
the page builds its dataset from them a few milliseconds at a time
(`services/yearDecoder.ts`, `services/yearDataset.ts`). Where the worker
cannot be used, the same code decodes on the main thread.
The same command takes MapLibre GL JS and html-to-image out of
`node_modules` into `kml_heatmap/static/vendor/`, which is what the published
page loads them from (html-to-image with `import()`, on the first export, as
one module that `scripts/vendor.js` bundles from the package's own), and the
country flags of `flag-icons` into
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
  - Contract tests of the exported data files: `tests/frontend/contract/`
    (Vitest)
  - E2E tests: `tests/e2e/` (Playwright)
- **Stylesheets** in `kml_heatmap/static/` (`styles.css`, `features.css`
  and `wrapped.css`)
- **Build output** in `kml_heatmap/static/` (`mapApp.bundle.js`,
  `features.bundle.js`, `wrapped.bundle.js`, `shared.bundle.js`,
  `yearWorker.bundle.js`, their
  source maps, `vendor/` and `flags/`)
- **Build scripts** `build.js` and `scripts/*.js`, plain JavaScript with
  JSDoc types that `tsconfig.node.json` checks (`npm run typecheck`)

**Replay camera:**

What moves the map during a replay is in `ui/replayCamera.ts`, apart from
the renderer that draws the trail. By default the camera only pans once the
airplane nears the edge of the map, as a critically damped spring
(`dampStep` in `ui/chaseCamera.ts`) moved by one `jumpTo` a frame: an
`easeTo` asked for on every frame starts from rest on every frame and
stutters. Auto-zoom zooms out when the pan cannot keep up.

The chase view (`ui/chaseCamera.ts`) drives bearing, pitch, zoom and centre
on every frame instead, through the same kind of spring, at a tilt of
`CHASE_PITCH` (70 degrees) and a map zoom of `CHASE_ZOOM` (14.5, app zoom
15.5; the map's zoom is the app's minus `ZOOM_OFFSET`). It looks at a point
in the air, at the airplane's height as the ribbons draw it (`elevation` in
the camera options, with `setCenterClampedToGround(false)` while it chases),
so the zoom is the camera's distance to the airplane and does not change
over a valley or a ridge. The airplane sits at `CHASE_SCREEN_Y` (0.6) of the
height between the top of the map and the replay panel; that height is
measured again after a `resize` of the map or a change of the panel's size
(a `ResizeObserver`), not on every frame. MapLibre's `project` knows no
height but the ground's, so the airplane marker, upright
(`pitchAlignment: "viewport"`) while chasing, is placed by the camera's own
projection (`projectRelative`), which matches MapLibre's to a pixel. The
bearing follows the smoothed heading with a time constant of three seconds
of the flight, held between 0.2 and 1 s of the replay, led by the turn rate
(at most `CHASE_MAX_LEAD`, 45 degrees) so a fast replay does not swing
behind a turn. The tilt is held down to keep the camera and its line of
sight 150 m above the relief behind the airplane (`clearPitch`, from
`queryTerrainElevation`), and however far the spring lags, the camera never
goes below the ground. On the globe the zoom goes no lower than
`GLOBE_FLAT_ZOOM` (map zoom 12, app zoom 13), where MapLibre draws the globe
flat and the chase's flat-map maths hold. Any movement of the user's
(`UserMapMovement`) holds the chase; the next frame starts from their view
and keeps their zoom and tilt within `CHASE_ZOOM_RANGE` (map zoom 11 to 16)
and `CHASE_PITCH_RANGE` (45 to 75 degrees). `release()` hands the map back
clamped to the ground without a jump. Switching it on slows a replay faster
than `CHASE_MAX_SPEED` (10x) down to it and switching it off restores the
speed from before; it also eases back to the zoom, bearing and pitch from
before over the airplane, closing the replay back to the whole view, and a
finished replay fits the flight at the bearing and pitch from before. While
it chases, the state manager saves the view from before
(`ReplayManager.userMapView`) to the session and the link, not a camera half
way along a flight. Under `prefers-reduced-motion` it does not start, and a
toast says why.

## Backend (Python)

**Setup:**

```bash
python -m venv .venv && source .venv/bin/activate
pip install --require-hashes -r requirements-test.lock -r requirements-build.lock
pip install --no-deps --no-build-isolation -e .
```

The dependencies are declared once, in `pyproject.toml`: the runtime
dependencies plus the `test` and `dev` extras. CI, the container image and the
setup above install the hashed lock files compiled from it instead
(`requirements.lock`, `requirements-test.lock` and, for the setuptools that
builds the package, `requirements-build.lock`), and the package on top with
`--no-deps`, so nothing is resolved from the ranges. Regenerate the lock
files with `make lock` after changing the dependencies. The test lock is
compiled with the runtime lock as a constraint, so a package both of them
pin has the same version in each. `make lock` runs the pip-tools that
`requirements-tools.in` pins, installed from `requirements-tools.lock` with
the hashes of its dependencies, and recompiles that lock last.

**Testing:**

pytest no longer forces coverage or parallel execution, so a plain `pytest` run
is fast and readable. The flags used by CI and `make test` are:

```bash
pytest                                          # Run all tests
pytest tests/test_parser.py                     # Run specific test file
pytest -x                                       # Stop on first failure
pytest -n auto --cov --cov-branch --cov-report=xml:coverage/coverage.xml --cov-report=term
pytest --cov --cov-report=html                  # HTML coverage report (htmlcov/)
```

A bare `--cov` measures what `[tool.coverage.run]` in `pyproject.toml` names:
the package and `scripts/`, whose pre-push hook and lock check are gates of
their own. A run with `--cov` fails below the `fail_under` floor there, which
is kept one to three points below what the suite reaches.
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

**Year file format and the ground column:**

The year files are data format 4 (`FORMAT_VERSION` in
`kml_heatmap/segment_codec.py`, `DATA_FORMAT_VERSION` in
`services/yearDecode.ts`; bump both together, the page refuses any other).
Format 4 added a `ground` column per path: the ground under every row in
steps of 10 ft, as differences like the other columns, left out for a path
whose ground is not known. `kml_heatmap/terrain.py` computes it at build time
from the Terrarium elevation tiles of AWS, shifted to meet the altitudes the
flight recorded taxiing at both ends, so the correction lives in one place
and the page only reads the result (`groundProfileFt` in
`calculations/lift.ts` falls back to the line between the fields without it).

The tiles (zoom 10, about 100 KB each) are cached as PNGs in `terrain/` of
the cache directory (`KML_HEATMAP_CACHE_DIR`, by default
`~/.cache/kml-heatmap`) and decoded by a small pure-Python PNG reader in a
process pool; `data/` needs 389 of them, 44 MB. Offline, or for a tile that
cannot be fetched, the build goes on and the flights under it get no ground;
one warning says how many. `--no-terrain` skips the tiles altogether, which
`scripts/build_visual_site.py` does: its snapshots show no 3D view. The CI
jobs that build from `data/` restore the tile cache with `actions/cache`.

No test touches the network: `tests/conftest.py` fails any download of a
tile loudly, the pipeline tests pass a tile source of their own
(`create_progressive_heatmap(..., terrain=...)`, see `TileSource`), and
`FlatTiles` stands the flights on a flat model. A decoding pool that dies
leaves the ground out with one warning instead of failing the build.

**The relief of the 3D view:**

At every zoom the 3D view draws the relief with `setTerrain`, from a
`raster-dem` source of the same Terrarium tiles the build samples
(`ui/terrain.ts`, which comes with the feature bundle and is fetched the
first time the 3D view is on). The `fill-extrusion` shader adds the relief
times its exaggeration to every ribbon, so a flight stays at its height
only where the ribbon's lift is exaggerated as much as the relief; the map
takes one exaggeration for the relief, and rebuilds it on every change (a
few milliseconds). Both therefore go by the relief level (`reliefLevel` in
`calculations/lift.ts`, and in the store): the whole level the ribbons are
cut for, up to 11. `liftExaggeration` gives one number per level, 10 out to
level 6 (`z` 7 in the UI), then 7, 4, and 2 from level 9 in. The ribbons
carry it as a property `e` of every feature rather than as a zoom
expression, which MapLibre would evaluate at each tile's zoom, a level or
two further out in the distance of a tilted view. `LayerManager.syncTerrain`
changes the level only as a zoom ends, in the same task as it lets go of
the old ribbons and cuts them once for the new level, and `ui/terrain.ts`
sets the relief's exaggeration then; during a zoom the ribbons and the
relief keep the level they had, so the flights stay on it.

MapLibre raises a ribbon by the relief of the elevation tiles one level
coarser than the ribbon's own tile (`getSourceTile`, `deltaZoom` 1), so at
level 5 the ground under a flight is drawn from tiles of about 3 km pixels
while the build sampled 100 m ones. `groundProfileFt` smooths the sampled
ground along each flight for the level (`reliefPixelM`, `smoothAlong`:
twice a moving average over two pixels), which halved the difference to the
relief MapLibre drew along a flight over the Alps at every level from 4 to 9
(RMS 94 m at level 4, 31 m at 8, 4 m at 11). The rest is the relief beside
the flight, which no smoothing along it knows; times the exaggeration it is
why the ramp stops at 10: with 51 times at level 4 (the ramp before) a level
cruise over the Alps sawed by 3 to 6 pixels and the Alps stood as a wall,
at 10 times it is under a pixel. Mid-zoom the ribbon tiles of the new level
stand on finer elevation tiles than their ground was smoothed for, so a
level flight over mountains shows the saw until the zoom ends.
`ui/terrain.ts` hides the ribbons as the level changes or the relief comes
or goes, until the map has drawn their new tiles and the elevation tiles,
for `SETTLE_MAX_MS` (3 s) at most, since a frame of the relief takes
seconds in software WebGL. A `hillshade` layer from the same source shades the
relief while it is drawn, directly above the base map's last area fill (its
buildings in CARTO's style, so above its roads but below its labels and every
layer of the app) and the satellite imagery, in the colours of
the `--terrain-*` tokens of `styles.css`; a second source would fetch about
2.6 times the tiles, for a sharper shading nobody sees under the dark
style (MapLibre warns about the shared source once). `withDataLayers`
carries the source and the relief across a base style swap and
`ui/terrain.ts` puts the shading back into the new style. The globe gets
the shading alone (`reliefShaded` in the store, set by `syncTerrain` for the
3D view, globe or not) and no relief, since MapLibre
6.10 breaks the ribbons up on the relief of the globe: `terrainActive`, and
with it the ground the ribbons are cut on, stays off there.

The page fetches the tiles from `s3.amazonaws.com`, whose
`elevation-tiles-prod/` bucket alone the CSP names in `connect-src`
(MapLibre fetches raster-dem tiles; `img-src` needs no entry).
`tests/frontend/unit/csp.test.ts` fails when a URL the frontend fetches is
not allowed there.
The e2e fixture (`tests/e2e/fixtures.ts`) answers them itself with a flat
tile 500 m up, so specs and screenshots stay deterministic and a spec can
tell the flights stand on the relief.

**The satellite imagery:**

The Satellite switch (`satelliteVisible` in the store, `s=1` in the link)
fetches `ui/satellite.ts` with the feature bundle the first time it is on
(`followSatelliteSwitch` in `ui/layerVisibility.ts`; a failed fetch turns the
switch back off with a toast, if it is still on). It adds a `raster` source
of EOX's Sentinel-2 cloudless 2024 tiles (`SATELLITE_TILE_MAX_ZOOM`, level 14
of the 256 px tiles at most, `z` 14 in the UI, the last that adds detail over
the one below)
with the credit on the source, so the map shows it only while the layer is
visible, and one `raster` layer directly above the last layer of the base
map's ground (the `landcover`, `landuse`, `park` and `water` source layers of
CARTO's OpenMapTiles schema, or the background of a style without them), so
below its roads and labels, the shading of the relief and every layer of the
app. CARTO draws its county and state borders among those fills; they are
moved above the imagery. Like the shading, the layer is none of the app's:
`withDataLayers` carries its source across a base style swap and
`ui/satellite.ts` puts the layer back on `styledata`. Its paint
(`raster-brightness-max`, `raster-saturation`, `raster-contrast`) comes from
the `--satellite-*` tokens of `styles.css`, darker and paler under
`prefers-contrast: more`. The page fetches the tiles from
`tiles.maps.eox.at`, named in `connect-src` like the other tile hosts; the e2e
fixture answers them with its transparent tile.

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
