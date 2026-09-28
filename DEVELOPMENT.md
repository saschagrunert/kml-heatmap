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
filters, statistics panel, flight list, wrapped modal, airport markers and replay. The
`desktop` project runs every spec but `mobile.spec.ts` and `visual.spec.ts` in
Chromium. The `mobile` project runs `mobile.spec.ts` and the viewport
independent specs (`core`, `layers`, `state`) on a phone viewport. The
`webkit` project runs the same specs as `mobile` on an emulated iPhone, and
`webkit-desktop` runs `error-free`, `orientation` and `replay`, which drive
the desktop controls, in a desktop Safari viewport. The `visual`
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
image the visual job uses. The `desktop` project is split into three shards
(`--shard`) and the `mobile` project into two, and the relief tests of the
3D view ("on the relief" in `orientation.spec.ts`) of the `desktop` and
`webkit-desktop` projects run in jobs of their own, with the whole runner to
themselves, since software WebGL takes seconds per frame of the relief. The
desktop one then runs the specs without a key. In CI a failed test of the
`desktop` project is retried once, which only tells a flaky failure from a
steady one: `failOnFlakyTests` fails the run either way. The `mobile`,
`visual`, `webkit` and `webkit-desktop` projects do not retry, and neither
do the relief tests, where one attempt takes minutes.

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
podman run --rm --ipc=host --network host --userns=keep-id --user "$(id -u):$(id -g)" \
  --security-opt label=disable -v "$PWD:/work" -w /work -e HOME=/tmp \
  mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 \
  npx playwright test --project=webkit --project=webkit-desktop
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
`features.bundle.js` holds Replay, the relief, the heat cloud and the
ribbons of a selection of the 3D view, the satellite imagery, the profile
of a single selected flight, the cross-section (`ui/crossSection.ts`; the
first visit carries only its control in the View group and its row in the
phone's More sheet) and the hotspot tour (`ui/hotspotTour.ts`, with its
places found in `calculations/hotspots.ts`, carried the same way), and
`wrapped.bundle.js` holds Wrapped, the content of
the statistics panel and the flight list of its Flights tab (the rail
itself is part of the app, and says it is loading until the bundle is in;
see `ui/statsPanel.ts`); the page
imports each of the last two the first time one of its features is opened,
and both as soon as Wrapped's button is pointed at or focused, for its
intro (`ui/wrappedIntro.ts`), unless the system asks for reduced motion.
`shared.bundle.js` is the app itself and everything the lazy bundles use of
it. Their styles are split the same way and travel with them:
`kml_heatmap/static/styles.css` is linked in the page, `features.css` and
`wrapped.css` are fetched alongside their bundles (see
`services/featureLoader.ts`), and each has its own budget in
`tests/test_asset_budget.py`. A rule belongs in `features.css` when its
selector names replay and in `wrapped.css` when it names Wrapped or what the
statistics rail renders, its tabs and the flight list included; the file headers spell out the rest, including the one-way dependency on
`styles.css`. The bundler moves the modules the entry points share into a
chunk that each of them imports, because several of them hold state that
has to be a single instance. It makes one chunk for every set of entry
points that reach a module, so both lazy entry points import `mapApp.ts`:
everything the app reaches is then reached by all three and lands in the
one chunk, which has a fixed name that the site publishes and the page
preloads. A module replay and Wrapped share without the app would still get
a chunk of its own, and the build fails if it ever writes another file
(`assertExpectedOutputs` in `build.js`); such a module belongs where the app
reaches it (`segmentBounds` in `utils/geometry.ts` is one), or in the
feature bundle, which hands it to Wrapped's code through `FeatureModule`:
the camera moves Wrapped's intro and the hotspot tour share
(`ui/cameraScript.ts`) do that, as the intro waits for the feature bundle
anyway.
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
and `make clean` removes it. MapLibre is copied with three fixes made to
its minified code (`VENDOR_PATCHES`): two for bugs of 6.10, where tiles
under a camera that looks at a point above the relief (the chase view)
were culled and a GeoJSON tile that loads empty kept the raw data of
before, and one for WebKit on Linux (WebKitGTK and WPE, the WebKit of the
e2e tests), whose page process crashed or hung as MapLibre's worker took
apart an elevation tile it was sent as an ImageBitmap: there the tile is
read into plain pixels on the main thread first, as MapLibre does where
OffscreenCanvas is missing. Every other browser keeps the bitmap. Each fix has to
find its code exactly once, or the build fails: after a bump of MapLibre,
drop the fix it has made unnecessary, or match its code again.

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
  - `state/` - The store, the table of toggles (`toggles.ts`, from which
    the saved state, the link, the buttons, the actions and the phone's
    sheet rows are derived), the URL encoding and the site data
    (`airports.json`, `metadata.json`) once loaded
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
  and `wrapped.css`). A surface across the whole width of the map on a
  phone (the tab bar, its sheet, the statistics sheet) takes
  `--color-bg-edge`, the secondary surface at an alpha of 0.99: Chrome
  leaves out the part of the map's canvas an opaque one covers and the same
  strip at the opposite edge, and the top of the map showed the page
  background as high as the bar (`tests/frontend/unit/edgeSurfaces.test.ts`)
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
stutters. Auto-zoom zooms out when the pan cannot keep up. MapLibre ends
every `jumpTo` with `moveend` (and `zoomend` when it zoomed), so the
camera's jumps carry `REPLAY_CAMERA_MOVE` (`utils/mapHelpers.ts`) as event
data, and what the app does once the map comes to rest (the airports
towards the horizon, the markers on the relief, the saved view, the cut of
the ribbons for the zoom) skips them. The camera fires both events itself,
untagged, once a frame passes without a jump, every `CAMERA_REST_MS`
(1 s) while it keeps moving, as a chase does, and as a chase gives the map
back, before the view from before it eases in.

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
is fast and readable. The tests that build a whole site (the renderer and the
golden pipeline among them) need the frontend bundles, so run `npm run build`
first; `make test` does, and a run that fails without them says so above its
summary. The flags used by CI and `make test` are:

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

**Split tracks and recordings of one flight:**

`_join_split_lines` in `kml_heatmap/parser_standard.py` joins the
`LineString`s of a file that are one flight in pieces. A line continues the
one before it (`_continues`) when both have the same name, the one before
has not landed (`_ends_on_ground`: it came back down to within 30 m of its
lowest altitude after climbing 150 m above that, or its last three points
stand within 15 m of each other), and the line starts within 50 m of where
the one before ended, with the same time span or within 30 minutes of its
end. Without times, or without a name, only the point of the split written
twice (the same longitude, latitude and altitude) joins them. A document
`TimeSpan` over a flight out and one back, or two untimed flights of a
placemark named after the aircraft, stay two flights. `gx:Track`s are
never joined.

After `data_exporter.drop_duplicate_paths` has dropped the exact copies,
`drop_overlapping_paths` in `kml_heatmap/duplicates.py` drops a recording
of a flight another one of the same year records as well: two timed
recordings are one flight when they overlap in time by more than half of
the shorter one and are within 300 m of each other at 20 moments spread
over the time they share (two of them may be further apart). The recording
that names the aircraft stays, its registration first and then its type,
and of two that name as much the one with more points; the warning names
both files. Recordings without times are not compared.

**Year file format and the ground column:**

The year files are data format 5 (`FORMAT_VERSION` in
`kml_heatmap/segment_codec.py`, `DATA_FORMAT_VERSION` in
`services/yearDecode.ts`; bump both together, the page refuses any other).
Format 5 writes the altitudes in steps of 20 ft instead of 100 ft, which
costs about 4 % more gzipped year files on `data/`, and adds the landings of
every flight with timestamps to its `path_info`: `landings`,
`touch_and_goes`, `go_arounds` and the `touchdowns` as `[airport, runway]`.
`kml_heatmap/landings.py` reads them in the main process of the export from
the full-precision track, with the fields and the runways of the OurAirports
database (`load_runway_database` caches `runways.csv` next to
`airports.csv`); the page only adds them up.
The speed column is written in tenths of a knot, but the exporter rounds the
speeds to whole knots (`exported_knots` in `kml_heatmap/export_pipeline.py`),
which takes an eighth off the compressed year files: the format and the
decoder were the same, so the version stayed 4. Times stay at a tenth of a
second, which the replay needs for fixes less than a second apart.
Format 4 added a `ground` column per path: the ground under every row in
steps of 10 ft, as differences like the other columns, left out for a path
whose ground is not known. `kml_heatmap/terrain.py` computes it at build time
from the Terrarium elevation tiles of AWS, shifted to meet the altitudes the
flight recorded taxiing at both ends, so the correction lives in one place
and the page only reads the result (`groundProfileFt` in
`calculations/groundProfile.ts` falls back to the line between the fields
without it). The statistics panel measures the cruise above that ground as
well, and says "above field" instead of AGL when a flight had none and was
measured above its own lowest altitude.

`airports.json` is not versioned: the site is always built with its data,
and the page reads it as it is. Its `code` field (the ICAO code in the name,
`airport_icao_code` in `kml_heatmap/airport_lookup.py`, which also merges the
airports) came with format 4 of the year files as an addition: the page
shows the code the export found rather than reading the name again, and an
airport without a code shows none.

The tiles (zoom 10, about 100 KB each) are cached as PNGs in `terrain/` of
the cache directory (`KML_HEATMAP_CACHE_DIR`, by default
`~/.cache/kml-heatmap`) and decoded by a small pure-Python PNG reader in a
process pool; `data/` needs 389 of them, 44 MB. The decoded pixels of a tile
are kept next to its PNG (`<tile>.pixels`, a little smaller than the PNG,
checked against its CRC), so a later build reads them in a fraction of a
millisecond instead of decoding the PNG again. A failed request or a server
error is tried again three times, with pauses of 1, 2 and 4 s, before the
host is given up for the run. Offline, or for a tile that cannot be fetched,
the build goes on and the flights under it get no ground; one warning says
how many. `KML_HEATMAP_REQUIRE_TERRAIN=1` fails it instead, which the CI job
that deploys the site sets. The ground is sampled once in the main process
and kept as one array of elevations per path, aligned with its points
(`sample_path_elevations`), which is what the export chunks are handed: a
million points take tens of megabytes this way, where a mapping of
coordinates took more than a gigabyte. `--no-terrain` skips the tiles
altogether, which `scripts/build_visual_site.py` does: its snapshots show no
3D view. The CI jobs that build from `data/` restore the tile cache with
`actions/cache`.

No test touches the network: `tests/conftest.py` fails any download of a
tile loudly, the pipeline tests pass a tile source of their own
(`create_progressive_heatmap(..., terrain=...)`, see `TileSource`), such as
the flat model of `FlatTiles` in `tests/conftest.py`. A decoding pool that dies
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
level 6 (`z` 7 in the UI), then 7, 4, and 2 from level 9 in.
`LayerManager.syncTerrain` changes the level only as a zoom ends, and
`ui/terrain.ts` sets the relief's exaggeration then; the flights are cut
once for the new level, as wide as it asks, over the cut of before. What
the two share is `ui/reliefState.ts`: it writes the store's relief switches
in the order the map needs them, counts the visits of a level, holds
whether the ribbons show and lists their sources. `calculations/lift.ts` is
the policy of levels and heights; the curve through the fixes, the ground
of a flight, the ribbons and their paint are `smoothing.ts`,
`groundProfile.ts`, `ribbons.ts` and `ribbonPaint.ts` beside it.

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
at 10 times it is under a pixel.

Not every tile is of the level the flights are cut for: while a zoom goes
on the tiles of the next level take over (in the middle of the map from
about a tenth of a level before the next), in the distance of a tilted view
the tiles are a level or two further out, and at a tilt of 75 degrees and
more the nearest ones one or two further in. So a ribbon carries the
ground of the levels around its own (`GROUND_LEVELS`: two out, one out and
one in), as offsets `o-2`, `o-1` and `o1` to the ground its height `h` is
above, beside the level `l` it was cut for (`ribbonProperties`). The paint
(`ribbonHeights`) is a `step` by zoom, which MapLibre works out for each
tile at the tile's own zoom, and takes the ground of the tile's level, the
nearest carried beyond them (the nearest tiles of a steep tilt stand on the
ground of `o1`); the band of height goes by the middle of the tile's level,
as the width does, and on a level further out than the one cut for by the
next level in, as thin as the interpolation by zoom before it had the
distance of a tilted view. The offsets are the smoothed ground of the
other levels worked out in the browser (`groundProfilesFt`, kept per level
for the dataset), rounded to a quarter of a pixel of the level
(`groundOffsetStepFt`) and left out where that is zero, which over flat land
most of them are. Ground of every level from the build would have cost 10
columns of the year files for what the browser smooths from one (the ground
column is about 200 KB of 2025's 1.6 MB, 36 KB gzipped).

The exaggeration is one for the whole map, which a zoom expression would not
give (every tile has its own zoom), so the paint takes it from `l`. As a
zoom ends in a level of another exaggeration, the ribbons of the old cut get
the new one from a feature state in the same task as the relief
(`exaggerateRibbons` in `ui/terrain.ts`), which MapLibre applies to all of
their tiles in the next frame; a new paint would have them cut again tile by
tile. A feature state needs a feature id, which costs every tile a few bytes
per feature (about 5 % of the worker's heap with all years), so only the
levels next to one of another exaggeration have one (`k`, promoted to the
id; `switchesExaggeration`: 6 to 9). The id is a new one for every visit of
a level (`ribbonId`, `ReliefState.epoch`): MapLibre keeps an entry
for every id it was given a state for, even one taken away again, and works
out the paint of every feature of such an id anew, on the main thread, in
each tile it loads, which for the cut of the map's level took seconds per
zoom in software WebGL. So only a cut that has to switch gets a state, and
never the one for the level of the map. The flights stay in sight and on the
relief through a zoom and its end. `ui/terrain.ts` hides them only as the
relief comes or goes, and as a zoom ends in another exaggeration while the
map may still draw a cut without an id (every cut since all the ribbons last
landed, `followsLevel`), until the map has drawn their new tiles and the
elevation tiles, for `SETTLE_MAX_MS` (3 s) at most, since a frame of the
relief takes seconds in software WebGL. The layer manager lets go of such a
cut first, as it does of the ribbons of a mode out of sight at every change
of the level, which would otherwise show the cut of before when the mode
shows again. A `hillshade` layer from the same source shades the
relief while it is drawn, directly above the base map's ground and the
satellite imagery on it (`aboveGround` in `ui/satellite.ts`, see below), so
below its runways, roads, buildings and labels and every layer of the app,
in the colours of the `--terrain-*` tokens of `styles.css`; a second source
would fetch about twice the tiles (89 instead of 41 for a session into the
3D view and two levels in and out, see `shade` in `ui/terrain.ts`), for a
sharper shading nobody sees under the dark style (MapLibre warns about the
shared source once). `withDataLayers`
carries the source and the relief across a base style swap and
`ui/terrain.ts` puts the shading back into the new style. The globe gets
the shading alone (`reliefShaded` in the store, set by `syncTerrain` for the
3D view, globe or not) and no relief, since MapLibre
6.10 breaks the ribbons up on the relief of the globe: `terrainActive`, and
with it the ground the ribbons are cut on, stays off there.

The colour layers' ribbons are cut for the pixels of their level, not for
the data (`screenCut` and `keptPoints` in `calculations/ribbons.ts`): a
flight's curve keeps a point where its height or its ground has changed
by a step since the last one kept, where it has turned by 10 degrees after
1.5 px, and every 16 px, and its pieces are `LIFT_STEP_FT` apart doubled
as long as a step stays within a pixel, merged where their heights span a
step. The relief under a quad is the one of its middle (MapLibre lifts
each polygon by the elevation at its centroid), so the ground criterion
keeps a quad short over the relief and a strip of quads cannot be one
polygon. From level 8 (`z` 9) the layer manager writes only the runs
around the view (`viewBox`: a quarter of the view to each side, and as far
as the highest flight reaches into a tilted view), and again on `moveend`
once the view leaves that. For all years of 103 flights this took the
map's worker from 0.9 to 1.4 GB to 84 to 189 MB, and turning the 3D view
on from a 5.4 s task to 1.4 s on a phone (CPU 6x slower), most of that the
smoothing of every flight. Their sources keep a buffer of 32 px, which a
quad never leaves (a longer one is cut into quads of 24 px at most),
instead of 128, and no simplification: with
it, far tiles of a tilted view dropped the ribbons whose walls still
showed. The replay's trail is cut as the data has it, into a source as
before; the chase camera looks at it from close up.

The lines of a selection over the heatmap (`ui/selectionHighlight.ts`)
lie flat on the ground, and in the 3D view the cloud draws the same
flights at their height beside them. While the 3D view lifts the flights,
`ui/selectionRibbons.ts` (with the feature bundle) draws the selection as
ribbons instead, in the colour of the lines (`selection-highlight-3d`,
among the other ribbons above the cloud), cut for the pixels of the level
as the colour layers' are, and sets `selectionRibbons` in the store, for
which the lines empty their source. The source is one of `RIBBON_SOURCES`,
so its ribbons take the exaggeration of a new level by feature state with
the others, and `ui/terrain.ts` hides them with the trail while they settle
on new ground. They are cut again for a new selection, dataset, ground or
relief level and at the end of a zoom into another whole level, only while
the lines show, and from `CULL_FROM_ZOOM` on only around the view, again
as the view leaves that (`utils/viewBox.ts`, shared with the layer
manager): at map zoom 16 a year's flights, all selected, came to 83,000
pieces and 125 ms of every zoom's end, around the view to 7,000 and
20 ms. A lost context has them written again as they were; hidden by a
colour layer or a replay they stay as long as they still fit. Their curves
are the ones `groundedFlights` holds for the level, or makes where the
selection is more than half of the segments (the flights of the home
field), and otherwise the selected flights smoothed alone
(`smoothGrounded`), each the same curve: smoothing every flight of 2026
again for a level whose cloud points were kept took 35 ms of a zoom's end
on a desktop. Like the lines they are not hit tested.

The page fetches the tiles from `s3.amazonaws.com`, whose
`elevation-tiles-prod/` bucket alone the CSP names in `connect-src`
(MapLibre fetches raster-dem tiles; `img-src` needs no entry).
`tests/frontend/unit/csp.test.ts` fails when a URL the frontend fetches is
not allowed there.
The e2e fixture (`tests/e2e/fixtures.ts`) answers them itself with a flat
tile 500 m up, or with a slope of ridges and valleys for a spec that asks
for one (the `terrain` option), so specs and screenshots stay deterministic
and a spec can tell the flights stand on the relief.

**The heat cloud of the 3D view:**

While the 3D view is on, the heat is drawn as a cloud in the air instead of
the flat heatmap: `ui/heatCloud.ts` (with the feature bundle, started with
the relief's code by `LayerManager.syncTerrain`) puts a MapLibre custom
layer (`ui/heatCloudLayer.ts`, id `heat-cloud`) on the map while the 3D
view is on, and sets `heatCloud` in the
store, for which `followLayerVisibility` hides the flat heatmap and its heat
lines; the Heatmap switch, its button, the sheet row, the saved state and
the link are the heatmap's as before. It draws what the heatmap would: the
flights the year and aircraft filters keep, the selected ones alone while
isolated, nothing while the switch is off, at the heatmap's dimmed opacity
under the aviation chart or a selection's lines (`dimsHeatCloud`; not under
a colour layer as the flat heatmap, since the ribbons are drawn in front of
the cloud, which dimmed for them was a faint halo round the flights),
and at a quarter (`CLOUD_REPLAY_OPACITY`) and without its pulses while a
replay runs, where the flat heatmap is hidden; the Heatmap button stays
pressed then (`heatCloud` and `heatmapVisible`), and disabled as for every
replay. Wrapped's intro forces the cloud on (`forcedHeatCloud`) with a
style of its own: the flights of the year and aircraft filters on flat
ground (it is on the globe), at full strength, whatever the switch,
Isolate, a colour layer or a selection say, and the switches are not
touched. Its button cuts those points ahead of time, in idle callbacks
rather than in the pointer's event, for the whole zoom level of the
overview and the one below (closer in than the last relief level the cloud
is cut for the zoom's own level, see below), of all the map, with that key and with the flights
smoothed aside rather than in `groundedFlights`, whose curves the ribbons
stand on, and kept apart from the 3D view's (shared where both stand on
flat ground with nothing isolated and the other's cut is of the same zoom
level and reaches as far as the view; each cloud keeps its own exposures),
and the intro fits the overview in one
update with the cloud and the globe, so the end of that zoom finds them
rather than cutting the cloud and the ribbons for the relief the globe
leaves out. Points the cloud does not draw (cut ahead, left while the
switch is off, or the other cloud's) go after `CLOUD_IDLE_MS` (15 s). No
style layer draws a glow at a height: `heatmap` lies on the ground,
`circle` has no depth, and deck.gl or three.js would be several hundred
kilobytes for one layer.

`calculations/heatCloud.ts` makes the data, once per dataset, filter,
isolated selection, weighing (the By distance switch), zoom level and
relief on or off, and from `CULL_FROM_ZOOM` in (`z` 9) for the part of the map around the view, as the
ribbons are (`viewBox`) but a whole view to each side of it rather than a
quarter (`CLOUD_VIEW_SPARE`: a pan of a view, or a zoom out of one and a
half levels, shows no edge of it before the map comes to rest; the GPU time
is the same, as the stretches out of the view are dropped before a pixel is
drawn), and again once the map comes to rest with the view out of it, in a
task after the frame the move ends in (the points of the last four zoom
levels are kept, so a zoom back into one takes no work; during a replay,
whose camera moves on its own, they are the relief level's of all the
map), along the curves the
ribbons are cut from: every flight smoothed through its fixes on its ground
at the relief level (`groundedFlights` in `calculations/groundProfile.ts`,
which keeps the last for both; the layer manager lets go of it when no
colour layer draws in 3D and the cloud does not show either, and with the
3D view). A flight's curve and its smoothed altitudes are the same on every
ground and at every level, so the curves of a dataset are smoothed once and
a level only lays its ground along them and lifts the heights, to the bit
what smoothing on that ground gave; the metres, the seconds and the clock
times of each curve's pieces are worked out once as well (`chainPieces` in
`calculations/flightClock.ts`, shared with replay all). The points of a curve are
merged where they are closer than `CLOUD_STEP_PX` (6 px in the middle of the
zoom level) unless the height changed by a pixel. The zoom level is the
relief level, and closer in than the last one (`z` 12) the zoom's own up to
`LIFT_MAX_ZOOM`, on the ground and at the exaggeration of the last relief
level: cut for its pixels, the cloud crossed the corners of a circuit and
the taxiways in chords of about 110 m, 270 px long at `z` 18, where the heat
lines follow them. These steps are merged again along straight runs into
stretches of up to `CLOUD_MERGE_MAX_PX` (64 px) that pass every step on the
way within `CLOUD_MERGE_PX` (1 px) across, in height and on the ground, and
within `CLOUD_MERGE_TIME_PX` (3 px) of where its time puts the pulses, and
whose steps carry a heat per metre within `CLOUD_MERGE_HEAT` (1.5) times of
each other: a quad reaches three blurs past both ends of its stretch, and
those of the steps lay 35 to 55 deep on every pixel the cloud lights at `z`
8 to 10, 100 million pixels of glow a frame on a phone's screen. Merged,
there are a third of the stretches and 2.5 times fewer pixels of glow out to
`z` 10; closer in, where the steps follow the turns of the taxiing, about as
many as before, and a fifth more than the chords had. The points are kept as
x and y in Mercator units from an origin in the middle of them (so 32-bit
floats hold them to a fraction of a pixel), the ground under the point and
the height above it in feet, and the seconds spent on the stretch to the
next point: those of each segment as the heatmap and its lines count them
(`heatWeight` in `calculations/heatLines.ts`: the time spent, or the length
at 100 kt for By distance; steps of no heat are neither merged nor written;
counting fixes, as the heatmap once did, left a cruise logged at an uneven
pace in beads), spread over the stretches of the curve along it by their length (`chainPieces`, kept per
curve, clock and weighing), and the time into its flight the point was flown
at (the clock replay all plays by, from 0 at the flight's first fix, on
across a gap in its log, whatever the weighing), and how strongly the
stretch from it may draw the marks of the way flown (see below;
`CLOUD_POINT_FLOATS`, 7). A stretch is kept where either end is around the
view, or where it crosses it with neither (a fix logged a kilometre or more
after the last does, close in). On the way the heat of each step of the relief level
(whatever zoom level the points are cut for) over its length is added up in
cells of `CLOUD_CELL_PX` (16 px of the relief level), those of every flight
the heatmap shows whether they are around the view or not, and `busiest` is
the 99th percentile of the cells with any, so the exposure is the same
wherever the view is and at every zoom level beyond the last relief level.
It is kept by relief level with the points, and a cut that has it goes
through the flights that reach the view alone: a cut after a move around
the home field takes 25 to 35 ms on a desktop and 100 to 130 ms at a
quarter of its speed, where one that added up the cells again took 35 to 60
and 145 to 215 ms, and came after twice as many moves. The heights are the
ribbons': the smoothed altitude above the ground of the flight at the
relief level, never below it, on the relief standing on that ground, and
exaggerated by the relief's own exaggeration (`map.getTerrain()`), or by
the level's without a relief. A custom layer cannot read the relief MapLibre
draws, so where the ribbons stand on the elevation tiles of the level drawn
under them (see above), the cloud stands on the ground the build sampled,
smoothed for the level: within about a pixel of them, and a flight whose
ground is not known stands on the line between its fields. All years at `z`
12 are about 45,000 points (1.3 MB; 104,000 before the steps were merged), at
`z` 6 about 2,300, and around the view of the home field tilted by 60
degrees 51,000 to 56,000 from `z` 14 to 17.

The layer draws every stretch between two points as one instance of a quad
on the screen, reaching three blurs around it (`CLOUD_STOPS`: 7 CSS px in
the middle of the map out to map zoom 9.5, `z` 10.5, narrowing to 4.5 px at
10.5 and 2.5 px from 13 in, and wider in front and narrower behind in a
tilted view, held between 0.8 device pixels and 3 times that; a far
flight narrower than that is drawn as much fainter, so it fades rather than
sharpening into a flickering line). Close in its gain goes down with it,
to half at 13: at the full width and gain the glow of every track around
a busy field covered twice the map the flat heatmap does at
`z` 12 and 25 times as much at `z` 14, over the roads and place names,
where the flat heatmap has handed over to thin heat lines. Now it covers
about as much as the flat heatmap at `z` 12 (7 % of the map lifted by the
glow against 8.5 %, place names at a contrast of 7.0 against 7.2), and at
`z` 14 a crisp glow along each circuit (8 % against the heat lines' 1 %,
contrast 4.3 against 4.5). A pixel gets the Gaussian of its
distance across the stretch, integrated along it (with `erf`) from the join
with the stretch before to the join with the one after, the bisectors of the
bends, so the stretches of a flight add up to the blur of the whole line
without gaps or beads, and one shorter than its blur is a soft point; the
heat is the seconds over the pixels of the stretch, so a lone track flown at
100 kt is 1 at any zoom and depth, as the heatmap's intensity keeps a lone
track alike by zoom. Each channel is `1 - exp(-heat * k)` of full, blended
as a screen (`ONE, ONE_MINUS_SRC_COLOR`), which adds up the same over every
glow on a pixel whatever the order: blue fills first, then green, then red
(`CLOUD_COLOUR`), a lone cruise faint azure, four cyan, and some sixty white,
the stops of the heatmap's gradient. A dimmed cloud has the strength it is
drawn with as its source factor (`CONSTANT_COLOR` and `blendColor`, which is
`ONE` at full strength): each glow moves a pixel by
`glow * (strength - pixel)`, so however many glows there are, it fills
towards that much of white and no further. A quarter of the heat, which it
was before, still filled the home field to white. The cost is the map under
the brightest of it, which goes towards the same grey: over dark ground a
haze, but over satellite imagery a flat grey where the circuits of the home
field are. The opacity of a layer proper, `map + strength * (screen - map)`,
cannot be blended a glow at a time (it needs the screen of all of them
first, in a texture of its own); a quarter of each glow's colour instead
screens up to white again under enough of them. The vertex shader projects
with the code MapLibre hands a custom layer
(`shaderData.vertexShaderPrelude`, `projectTileFor3D`), so the same shaders
work on the globe, which gets its own matrix and the flat map's
(`fallbackMatrix`, scaled to heights in metres) for the way into and out of
it; a program is compiled per variant.
Where the flights are lifted and the cloud is not dimmed, the same buffers
are drawn a second time first, on the ground (no lift), in a muted grey
blue that fills to 18 % at most (`CLOUD_SHADOW_COLOUR`,
`CLOUD_SHADOW_CEILING`): a shadow that shows how high the glow above it
is. The brightest shadow on a pixel is kept (`blendEquation(MAX)`, put back
to `FUNC_ADD` for the glow) rather than screened: the screen of a busy
field's hundreds of circuits filled to white, most of the white of the
cloud there. A stretch on the ground (the taxiing, the take-off run) casts
none, one 30 to 100 ft up fades in (`CLOUD_SHADOW_LIFT_FT`), and the
shadow is a Gaussian of the distance to its stretch reaching 2 blurs
(`CLOUD_SHADOW_REACH`), with a stretch shorter than its blur as bright as
the glow's `erf` makes it in its middle: on a Radeon RX 9070 XT it took
0.22 to 0.40 ms a frame against 0.27 to 0.90 ms as a copy of the glow.
MapLibre puts the blend equation back to `FUNC_ADD` after every custom
layer (`setBaseState`) and sets its blend function again, so neither leaks
into its own layers or the replay of all flights.

The maximum has a cost: it is taken against what the pixel already has,
the map under the cloud, not against the other shadows alone. The shadow is
a light haze of at most 18 % grey blue, so over ground brighter than that
it is gone: roads and the light parts of the base map, and most satellite
imagery. At EDAQ (`z` 13, pitch 60) the shadow alone lifts 36 % of the
pixels over the dark map and 7 % over the imagery, where the old screen
lifted 49 % of both (and filled the circuits to white). Keeping the
brightest shadow and then screening it onto the map takes a texture of
its own, the size of the canvas: the shadows drawn into it with `MAX`,
then one pass that screens it over the map, a framebuffer to resize with
the canvas and to make again after a lost context. The alpha of the
canvas cannot stand in for it, as the page is composed with it, and the
stencil keeps the first shadow on a pixel, not the brightest. The shadow
is also left out while the cloud is dimmed for what is drawn over it
(`dimsHeatmap`), where it cost as much as the glow for a haze no one could
see.

The exposure (`cloudExposure`) scales the heat so the busiest cells, at
the gain of the zoom, glow no hotter than `CLOUD_WHITE_HEAT` (white), down
to a quarter and never above 1, eased over a fraction of a second as the
level or the zoom changes; the two years of the sample data never reach
it. Weighed by distance, a stretch carries its length at the reference
cruise (`ROUTE_SPEED_MS` is `CLOUD_REFERENCE_SPEED_MS`), so the heat of a
cell is how many flights passed it and the exposure darkens only where
some sixty did. The pulses of the flow brighten and dim the glow by the time of each
pixel's stretch, a comet brightest at its head moving the way the flights
went, about 90 px of a cruise apart at any zoom (two spacings a power of
two apart, blended by the zoom so they do not jump: the longer of one
octave is the shorter of the next, at the same phase) and a mean of 1, so
the heat as a whole stays as it was. A pulse is a raised cosine skewed
forward (`cloudPulse`, `1 - cos(2 pi phase^2)`, scaled by
`1 / (1 - C(2) / 2)` with the Fresnel integral `C`): it rises along its
tail to its head at 0.71 of the period and falls ahead of it a little
quicker, with no step and no kink where one pulse hands over to the next.
The comet before fell from its head to nothing in the last 15 % of the
period, which read as a jerk as each head passed. Along a stretch where
they come closer than 8 blurs on the screen (`CLOUD_FLOW_CLOSEST`), slow
taxiing close in or any track near the horizon, they fade out, gone at 4:
there they ran together into a comb. They fade in while the map is used
(`move` of its camera, `touchstart`; not the pointer moving over it,
which kept the map drawing every frame while it rested on it) and out 8 s
after, and the layer asks for another frame only while they run or fade or
the exposure moves, every frame the screen shows, so an idle map draws
nothing. Frames held to 30 a second (25 ms after the last) moved them
visibly in steps. A frame slower than 100 ms moves them on by 100 ms: they
slow for it rather than jump. They are off
under reduced motion, read in every frame, and during a replay, and hold
still in the frame `withMapStill` takes for an export (`isMapStill`),
whose resizes do not wake them either.

The marks of the way flown take over whenever the pulses do not run: under
reduced motion, on a map at rest, in an exported image and in the faint
cloud of a replay. The glow pass draws them with `u_marks.x` from
`markStrength`, one less the strength the pulses are drawn with in the same
frame, so the two cross-fade as the pulses fade in and out and the cloud
always shows one of them; the shadow pass draws none. In the frame
`withMapStill` takes the layer draws the marks and no pulse, without
touching its fade. The band of heights fades the marks as it fades the glow
under them. They fade in from map zoom 6.5 to 8 (`CLOUD_MARK_ZOOMS`),
further out the routes of a region run together. A mark is a chevron
pointing ahead along a track where it crosses a line of a lattice on the
ground, in Mercator units from the origin of the points. The vertex shader
finds the lattice of a stretch once for all its pixels (`markLattice`,
handed on as `v_lattice`): its lines cross the axis nearest the stretch's
direction, of 16 at every 22.5 degrees. It is one axis and not a blend of
the two either side, as it first was: their lines cross a track at places of
their own, and the blend drew two rows of marks at half their strength along
a track about halfway between two axes, nearly a third of all headings; a
track that turns across that halfway fades its marks out towards the turn
from both sides, where the lattices of both stretches drew a mark each, a
pair of them close together (the snapshot of the cloud showed one). The
lines are a power of two of Mercator units apart, the one nearest
`CLOUD_MARK_SPACING_PX` (64 CSS px) along the stretch on the screen, and
every second one, blended as that goes from one power to the next, so the
marks keep their spacing on the screen at every zoom and depth and do not
jump. Every flight along a track finds the same lines, so where a route is
flown over and over the marks add up to one row: marks timed by each flight,
as the pulses are, added up to a haze of them wherever flights overlapped.
That is one row where the flights are within a stroke of each other: flights
a little apart, side by side or at heights that a tilted map close to the
camera sets apart on the screen, glow as one track and still draw a row of
marks each. The stroke adds a part of the stretch's heat (`CLOUD_MARK_ADD`),
a band as wide around it takes a part of the glow away (`CLOUD_MARK_CUT`),
so a mark shows on a faint track as a brighter chevron and on a white one as
a darker outline; a mark whose arms would be under 2 to 4 CSS px
(`CLOUD_MARK_LEAST`, the far distance of a tilted map) fades out, and a
pixel further across the track than the arms reach keeps its glow without
working a mark out. Only a stretch whose time runs forward draws them. A
stretch that reaches behind the camera's near plane is cut there, and the
ends of the part left have its time, height, marks, heat and place on the
ground, the ground its glow is pulled to among them, so its pulses, its band
of heights, its pull and its marks stay where it was flown and meet those of
the next. Where flights overlap in both directions, a runway or a circuit
used both ways, a route flown out and back, marks both ways at the same
places would be noise, so `markStretches` (`calculations/cloudCells.ts`)
adds up the directions of the stretches written in cells of `CLOUD_CELL_PX`
(16 px of the level the points are cut for) weighed by their heat as the
By distance switch weighs it (their sum S and the sum T of their
outer products), each at two places a cell along it, so a stretch merged
along a straight run counts in every cell it passes and not only where it
starts; a stretch draws its marks by its agreement with the cells it passes,
(d . S) / (d . T d), from none at 0.3 to in full at 0.8
(`MARK_AGREEMENT_RANGE`): the heat along its axis its way less that the
other way, over all of it, where flights across it count for neither. Steps
of no heat are not written, so they take no marks away. The home field of
the sample data flies its circuit both ways and shows almost none; the routes in and out show them. It runs on the
points of each cut, those around the view, and takes about 15 ms for 100,000
stretches on a desktop. How strongly a stretch may draw them is a float of
its own, the seventh of each point, which the vertex shader reads at either
end of the stretch; the last point of a run of stretches has the marks of
the stretch before it. The shaders keep the marks in blocks of their own
(`MARKS_VERTEX`, `MARKS_FRAGMENT`), with their own uniform (`u_marks`: the
strength, the spacing in device pixels, the device pixels of a CSS pixel).
The flat heat lines of the 2D map get no marks: they are drawn on the first
visit, whose budget has no room for an arrow symbol and its placement, and a
symbol placed along lines would show the direction of whichever flight's
line won the collision, both ways on a runway.

It is a 3D layer, right below the first ribbon layer: above every layer
of the app that lies on the ground, the flat lines of the selection, the
flights and the replay's route and trail among them, and below the ribbons
and the labels. On the relief MapLibre draws the layers on the ground into
a texture of each relief tile and the relief with it (`drawTerrain`, with
`depthRangeFor3D`) once for every run of them another layer breaks, so
they are all one run below the ribbons (`mapLayers.ts` puts the flat trail
of the replay below the ribbons too): between the heatmaps and the heat
lines, where it first was, the cloud had the relief drawn three times a
frame instead of once, and a frame of the relief in software WebGL in
Safari's engine (the Playwright image, 800x500) took about 90 ms instead of 30. The cloud tests against the relief's depth
without writing to it, so a ridge in front of a flight hides its glow and no
glow hides another. Each glow is pulled towards the camera by its reach for
the test, so a fix on the ground glows round rather than cut by the ground
in front of it. Near the ground (within its reach) a corner of a quad is
pulled further, to where its ray meets the plane of the ground under its
end, 30 ft higher (`CLOUD_GROUND_SLACK_FT`, where the relief MapLibre draws
can lie over the cloud's ground), and 12 blurs at most
(`CLOUD_GROUND_PULL`), never nearer than its near plane: the steeper the
ground rises into a flat view, the more of a glow it cut, in a straight line
along a runway. The pull only moves the glow in front of ground up to 30 ft
over its own, so a ridge higher than that still hides the glow behind it,
and flights higher up keep their reach. The plane is the ground's through
three points 100 px apart (`u_ground`); where the view runs along it (no
meeting) or its ray meets it behind the camera, the corner keeps its reach.
On the globe the plane is a chord of the curved ground, off by a few
hundredths of a blur at most (about 1 km at `z` 5, where a blur is some 30
km across, and metres at `z` 8). Its GL objects are made in its first frame,
where MapLibre takes up the state of its context anew after a custom layer.
Taken off the map it deletes its buffers and keeps its compiled programs for
its return in the same context (`ui/glLayer.ts`, shared with replay all),
which a context lost meanwhile has invalidated (`isProgram`); a lost context
drops them (`webglcontextlost`), and the style MapLibre gets back has no
custom layers, so `ui/heatCloud.ts` adds the layer again on `style.load`,
and on `styledata` after a new base style. Shaders that do not compile turn
it off with one logged error, and the flat heatmap stays, until the context
is restored, where they are tried again (the replay of all flights alike,
which closes its panel with an error toast in the run that failed). A
program that did not compile is not kept for the layer's return
(`release`): a context lost and restored while the layer was off the map,
which it does not hear of, is the same object, and the kept failure was
handed out there again without a word, the cloud drawing nothing while the
heatmap stood aside for it. What fails while the context is lost
(`isContextLost`: every GL object is null and no shader compiles) is no
failure (`LayerGl`). It only
draws: a custom layer has no features for `queryRenderedFeatures`, and the
ribbons stay what is hovered and clicked (the readout below works out what
the cloud under the pointer is made of from the segments instead). An
exported image has it, without its pulses, since the canvas is read in the
frame that drew it (`withMapStill`). It is drawn in the world copy of the
flights only, where the flat map shows several.

The band of heights (`heightBand` in the store, `h` in the link, the text
`500-3000` or `1000-` of `calculations/heightBand.ts`, empty for every
height) leaves out the heat below and above two heights above ground. It
needs no other points: the fourth float of a point is its height above the
ground in feet, the one the cloud is lifted by, and the shaders get the band
as one uniform (`u_band`, from `heightBandEdgesFt`): where it fades in, where
it is whole, where it starts to fade out and where it is gone, 15 % of each
edge's height past it and at least 50 ft. A stretch with both ends outside
the band on one side is dropped in the vertex shader, and the others are
faded per pixel by the height along them (`smoothstep`), in the glow and in
the shadow alike; the exposure is still that of all the points, so a band is
as bright as in the whole cloud. The band is above ground rather than above
the sea because the ground under every point is known, the relief sampled
by the build or without it the line between the fields, and a circuit is
then at the same height over any field. The control (`ui/heightBand.ts`, in
the feature bundle and started with the cloud) is two range inputs over one
track, each with a label and its height as `aria-valuetext`, at the stops of
`HEIGHT_BAND_STOPS_FT` (the top past the last is no top); it is a row of the
Map group under the 3D switch, a group of its own over the top of the map
in the phone layout (`PHONE_LAYOUT_QUERY`, before the floating compass in
the page, so the keyboard reaches the two in turn), and shown while the 3D
view draws the cloud with the Heatmap switch on, but not over the statistics
(`features.css`). The first visit carries only the parsing of the link
(`HEIGHT_BAND_TEXT` in `state/urlState.ts`, which the saved state checks as
well), the store key and Reset view, about 130 B gzipped. A text that is not
two stops, as a link edited by hand may have, is every height, and the
control writes that back. Wrapped always draws every height
(`wrappedVisible`), its intro included.

The numbers below were measured before the shadow, which draws the cloud a
second time where the flights are lifted, and the pulses, which redraw the
map every frame while they run.
On a desktop GPU (Radeon RX 9070 XT, 1440x900) the cloud's draw took 0.35 ms
of a frame for all years at `z` 6, 0.6 ms for 2025 at `z` 8 and 1.4 ms for
all years at `z` 12, and the camera turned at 60 frames a second with and
without it. Working out the points took 13 ms for 2026 and 31 ms for all
years at `z` 12 with the altitude layer on, which smooths the flights for
its ribbons anyway, and 72 and 131 ms with the heatmap alone, which smooths
them for the cloud; holding the smoothed flights then is 4 MB of the page's
heap for 2026 and 12 MB for all years. A level kept takes none of that. The
upload took under a millisecond. In software WebGL (SwiftShader) it took
28 ms of a frame of
170 to 250 ms. The e2e test (`orientation.spec.ts`, "on the relief") checks
that the layer is on the map and drew stretches (`drawn`, which the layer
counts per frame), not what the pixels look like.

**The heat legend and the heat scale:**

The heat legend (`#heat-legend` in the template, `ui/heatLegend.ts`, in the
first visit's bundle) says what the colours of the flat heatmap, its heat
lines and the cloud stand for: about how many flights' worth of heat, the
heat one flight leaves over a place as a lone cruise at 100 kt does. That
is the time spent there ("Time spent"), or with By distance on the length
counted at that speed ("Distance flown", a flight's worth being one pass of
any flight). It is a `.color-legend`, so it stands where the altitude and
groundspeed legends do and follows their rules beside the rail, the replay panel, the
profile strip, the phone's bar and Wrapped. `followLayerVisibility` shows it
while the heat is the colour the map shows (the Heatmap switch on, no
colour layer, which brings its own legend, and no replay) and fades its bar
with the heat when that steps back for the aviation chart or a selection.
In the 3D view a `<details>` in it (`#heat-cloud-about`) says what the
glow, the shadow (under lifted flights) and the direction flown mean: by
the pulses while the map is in use or the chevrons at rest, and by the
chevrons alone under reduced motion, where the pulses rest (the stylesheet
swaps the two wordings); `followHeatLegend` shows it while `heatCloud` is
set, and `features.css`, which arrives with the cloud, styles it.

What a colour stands for is read through one function, `heatScale(app)` in
`ui/heatScale.ts`: the density on the heat ramp (`HEATMAP_GRADIENT`, 0 to 1)
that one flight's worth is drawn at right now. The heat of flights that
overlap adds up, so n flights' worth is drawn at n times it.

- The flat heatmap weighs its points by their heat and puts the ridge of a
  lone cruise at about the ramp's third colour, 0.015
  (`HEAT_FLIGHT_DENSITY`, which `HEATMAP_REFERENCE_INTENSITY` is chosen
  for; a test holds the two together), at every zoom, times its adaptive
  exposure (`heatExposure`). `DataManager.setHeatmapPoints` writes that
  exposure of the heat drawn, an isolated selection's while there is one,
  to the store (`heatmapExposure`).
- The heat lines colour the seconds around a fix, scaled by the same
  exposure: a lone pass leaves the time between two fixes, about 5 s,
  which they round to 4 s. Their stops (`HEAT_LINE_SECONDS`) are the
  gradient's densities at 4 s per flight's worth, so n passes get the
  heatmap's colour of n flights under any exposure and the hand-over to
  them changes nothing, up to the white of 64.
- The cloud fills its colours so that a lone cruise glows like that density
  (`CLOUD_COLOUR`), and hands the store the factor it draws a flight's
  worth with where the map came to rest (`heatCloudScale`: the gain of
  `CLOUD_STOPS` at that zoom times `cloudExposure` of its busiest cells),
  which `heatScale` reads in place of the flat exposure while `heatCloud`
  is set. The height band leaves that exposure alone.

The heatmap and the cloud count the heat whatever the pace of the fixes.
The lines add it up in 40 m cells, which a lone pass logged every few
seconds leaves the time between two fixes in, so a log of a fix a second
reads there as about a quarter of a flight. The legend's first label says
"≈" for that and for the latitude, which widens or narrows a kernel of
fixed pixels on the ground.

`followHeatLegend` labels the legend anew as the store keys that change
the scale or what is counted do: `heatCloud`, `heatCloudScale`,
`heatmapExposure` and `routeWeighting`.

The labels are four steps of four apart, the step of the ramp's colours:
the first is the power of two nearest the flights' worth of the ramp's
colour of one flight, at least one, so the flat heatmap unscaled and its
lines read "≈1 flight, 4, 16, 64", a logbook drawn at a quarter "≈4
flights, 16, 64, 256" and the cloud closer in, drawn at half, "≈2 flights,
8, 32, 128". Each label sits in the middle of its quarter of the bar, and
the bar is drawn on a scale of those steps from the ramp's own colours
(`heatLegend`), shifted so that the colour under a label is the one its
count is drawn in: the labels stay round numbers and the ramp moves under
them.

**The readout of the heat cloud:**

Pointing at the cloud (a resting mouse, or a tap) shows a box beside the
pointer with the time spent around the place (with By distance, the
distance flown there), the flights that were there and the 400 ft band of
height above the ground most of it was in. `ui/cloudReadout.ts` (feature bundle, started by `followHeatCloud`)
listens to the map's pointer events only while the 3D view draws the cloud
(`threeDVisible` and `heatCloud`, the Heatmap switch on, no replay, not in
Wrapped or its intro's `forcedHeatCloud`, nor while the hotspot tour holds
the map, `tourView` in the store) and looks once per frame at most
(`frameCoalescer`); with the 3D view off it holds nothing but its store
subscription, and lets go of what it kept. `calculations/cloudReadout.ts`
is the maths:

- Under the pointer means along the line of sight through it. The cloud
  adds up every glow on a pixel, so the pixel shows every flight the line
  passes near, at any height; the ground under the pointer alone would miss
  the glow pointed at in a tilted view, where a flight stands up the screen
  from its ground. `sightLine` samples the line from the ground up to the
  highest flight (15,000 ft above the ground at most), a point at a height
  standing on the ground `liftOffsetPx` further down the screen, the
  approximation `PathHover` takes a ribbon down by, at most every radius on
  the screen and 48 times at most. A segment is measured against the place
  of its own height, interpolated between the samples. Looking straight
  down, or with the flights flat from `z` 18 in, it is one place. The
  relief is not asked whether it hides a flight from the pointer.
- A sample is on the ground only where `project` takes the place
  `unproject` gave back to within half a radius of the sample: MapLibre
  answers the sky of a tilted map with ground behind the camera, and the
  space beside the globe with its rim. Neither is a longitude past 180,
  in a world copy the cloud is not drawn in. The pointer on no ground has
  no readout, and the line ends at the first sample on none. It ends too
  where two samples are more than 8 radii apart (`SIGHT_MAX_GAP_RADII`),
  towards the horizon of a steeply tilted map, and has no readout if that
  is the first pair: a radius spans a few pixels there, and the reach of
  the search below grows with the gap. Without the checks a pointer just
  above the horizon searched 2,000 km for 3.7 s per frame (130,000
  synthetic segments, Node).
- The radius is a round one (`READOUT_RADII_M`, 100 m to 50 km) nearest to
  the reach of a stretch's glow in the middle of the map (`cloudReachPx`:
  21 CSS px out to `z` 9.5, narrowing with `CLOUD_STOPS` to 7.5 px from 13
  in), so the box can say "within 1 km".
- The time is the cloud's: the heat of each segment in seconds as
  `heatWeight` weighs it for the By distance switch (by time at most
  120 s, a track without times at a cruise; by distance its length at
  `ROUTE_SPEED_MS`), times the part of it within the circle
  (`insideFraction`), times the part of it the band of heights draws
  (`heightBandEdgesFt`, the fade of the cloud's shaders, at the height of
  the segment). With By distance the box says the distance flown, the
  seconds at `ROUTE_SPEED_MS`. A segment of no heat counts for nothing, as
  the cloud draws nothing of it, and a place with none has no readout. The flights are the path ids with any heat within,
  of those the cloud draws (filters, Isolate, band of heights). The
  heights are above the ground the cloud stands on (`groundProfilesFt` at
  the relief level: the sampled ground on the relief, the line between the
  fields on the globe), added up in 100 ft bins; the box names the run of
  four with the most of it, "mostly" from half of it on. The exposure never
  enters it: the box speaks of time or distance, not of heat. A change of
  the switches tells a resting pointer anew.
- The segments near a place come from a grid made per dataset for each
  radius (`segmentGrid`, a `WeakMap` on `path_segments`, let go with the
  3D view), its cells twice the radius. A segment goes into the cells of
  points along it at most half a cell apart, so a query looks in the
  cells within its reach and one more, and visits each segment once (a
  stamp per segment). The grids of the three radii asked for last are
  kept: the finer the grid, the more cells a segment is in, and for
  130,000 segments the one of 100 m took 13 MB and the one of 1 km
  2.3 MB. The seconds and the heights are kept alike, the
  seconds per weighing (`heatWeight` gives one function per switches), the
  heights per relief level. On 100,000 synthetic segments around one
  field, the grid took 12 to 16 ms to make and a readout 0.5 ms at 500 m
  and 1.6 ms at 5 km (Node, desktop CPU); the 49 `unproject` calls of a
  line of sight took 0.3 ms over the relief in Chrome.

The pointer's frames do little: a move of up to 3 px from where the
readout was last worked out keeps it and moves the box along
(`READOUT_SLACK_PX`), and nothing is worked out while the map moves
(`isMoving`), which tells a resting pointer anew where it comes to rest.
What a readout at a zoom is worked out from (the seconds, the heights and
the grid of its radius, `readoutKept`) is made ahead of the pointer, once
the page has a moment (`requestIdleCallback`, a timeout where Safari lacks
it) after the map comes to rest and as the readout comes on; a hover that
finds it missing hides the box and waits for it, and a click or a tap,
which wants its answer, makes it. A zoom across a step of the radius used
to make the grid in the next hover's frame or in the tap. With the two
years of `data/` (135,000 segments) in the unit tests' jsdom on a desktop
CPU, the frames of the first hover in the 3D view took 70 ms before and 14
to 19 ms after (the rest, 53 to 59 ms, in an idle task), those after a
rest at the next two zoom levels 19 to 29 ms before and 1.5 to 7 ms after
(13 to 27 ms idle), and twenty moves of a pixel 25 ms and 20 readouts
before, 2.3 ms and none after. A readout in the 3D view takes up to 49
`unproject` and `project` pairs.

With a colour layer on, the 3D view draws the flights as ribbons, and
around a busy field the ribbons are within `PathHover`'s few pixels of nearly every point: at
`z` 10.5 around the home field its tooltip showed at 39 of 77 points of a
grid 40 px apart, and a readout that stepped aside for it showed at 5. So
the two show together, and the box goes where it leaves the values of a
flight in sight (`place`): below and to the right of the pointer, then
the other corners, then beside the tooltip or the tapped popup (a
`.segment-tooltip` or `.segment-popup` in the map's container; a
`MutationObserver` places the box again as one opens or closes later,
after a look on idle), and clear of the panels over the map (the control
columns, the selection chip, the flight profile, the phone's bar and the
floating band of heights) where it can, within the map. With it the
readout showed at 44 of the 77 points, at each of the 39 with the tooltip
too, and never over it. It hides over a marker (the event's target is not
the canvas), while a button is held or the map moves, and after Escape
until the pointer moves 8 px; a change of what it is worked out from
(filters, Isolate, the band, the relief) tells a resting pointer anew.

A click or a tap on the map, handled after the app's own click handler,
shows the box there, on a flight as well: a tap on the ribbons of a busy
field nearly always hits one, which selects it and opens its values, and
a readout that left those taps alone never showed on a phone around the
home field. It is read out once (`announceStatus`) unless the click
changed the selection (counted from the `mousedown` or `touchstart`
before it), which the app reads out itself in the same status region,
where the last word is the one heard; the box itself is `aria-hidden`, so
a hover says nothing. A tap is a click less than a second after a
`touchstart` on the map (the browser's mouse events for it are left
alone), and puts the box above the finger; the flight profile that a
selection opens moves the map, and the box of a tap follows the place
tapped. The box takes no pointer events. It is an element of its own in
the map's container, styled like the popups in `features.css`, not a
MapLibre popup, so no spec that counts the popups finds it.

The flat heatmap has no readout. The code comes with the feature bundle,
which a visit that never turns on the 3D view, replay, the satellite
imagery or a single selection does not fetch: in 2D it would be fetched on
every first visit, or add about 3 KB gzipped to a first visit that has no
room left. The flat map's heat lines already show where the time was spent
from `z` 12 in. The feature bundle grew by 8.2 KB raw and 3.3 KB gzipped;
the first visit by a few bytes, the export of `ROUTE_SPEED_MS`: otherwise
the readout imports only what the shared chunk exports already (each new
import from it adds to its export list). `cloud-readout.spec.ts` turns
the altitude colours on and enters the 3D view by its button near the
home field (the button leaves the heatmap alone, which it draws as the
cloud), and rests the pointer on a place a flight passed low over, with
the ribbons and the markers on; it
checks the shape of the words, not the numbers, which the unit tests
check, and that the box covers neither the pointer nor a tooltip. It
waits for the map to stand tilted, not for `map.loaded()`, and points at
the place anew until the box shows, since the relief may land later; a
look into the page took up to 26 s in software WebGL on CI, so every check
after the 3D view comes on has the relief's minute.

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
