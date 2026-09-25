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
ribbons of a selection of the 3D view and the satellite imagery, and
`wrapped.bundle.js` holds Wrapped and the content of
the statistics panel (the rail itself is part of the app, and says it is
loading until the bundle is in; see `ui/statsPanel.ts`); the page
imports each of the last two the first time one of its features is opened.
`shared.bundle.js` is the app itself and everything the lazy bundles use of
it. Their styles are split the same way and travel with them:
`kml_heatmap/static/styles.css` is linked in the page, `features.css` and
`wrapped.css` are fetched alongside their bundles (see
`services/featureLoader.ts`), and each has its own budget in
`tests/test_asset_budget.py`. A rule belongs in `features.css` when its
selector names replay and in `wrapped.css` when it names Wrapped or what the
statistics panel renders; the file headers spell out the rest, including the one-way dependency on
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

The year files are data format 4 (`FORMAT_VERSION` in
`kml_heatmap/segment_codec.py`, `DATA_FORMAT_VERSION` in
`services/yearDecode.ts`; bump both together, the page refuses any other).
The speed column is written in tenths of a knot, but the exporter rounds the
speeds to whole knots (`exported_knots` in `kml_heatmap/export_pipeline.py`),
which takes an eighth off the compressed year files: the format and the
decoder are the same, so the version stayed 4. Times stay at a tenth of a
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
isolated, nothing while the switch is off or a replay runs, and at the
heatmap's dimmed opacity under a colour layer, the aviation chart or a
selection's lines (`dimsHeatmap`). No style layer draws a glow at a height:
`heatmap` lies on the ground, `circle` has no depth, and deck.gl or
three.js would be several hundred kilobytes for one layer.

`calculations/heatCloud.ts` makes the data, once per dataset, filter,
isolated selection, relief level and relief on or off (the points of the
last four levels are kept, so a zoom back into one takes no work), along the
curves the
ribbons are cut from: every flight smoothed through its fixes on its ground
at the relief level (`groundedFlights` in `calculations/groundProfile.ts`,
which keeps the last smoothing for both, so the flights are smoothed once;
the layer manager lets go of it when no colour layer draws in 3D and the
cloud does not show either, and with the 3D view). The points of a curve are
merged where they are closer than `CLOUD_STEP_PX` (6 px in the middle of the
level) unless the height changed by a pixel, and kept as x and y in Mercator
units from an origin in the middle of them (so 32-bit floats hold them to a
fraction of a pixel), the ground under the point and the height above it in
feet, and the seconds spent on the stretch to the next point: those of each
segment (`segmentSeconds`, as the heat lines count them; counting fixes, as
the heatmap does, left a cruise logged at an uneven pace in beads), spread
over the stretches of the curve along it by their length. The heights are
the ribbons': the smoothed altitude above the ground of the flight at the
relief level, never below it, on the relief standing on that ground, and
exaggerated by the relief's own exaggeration (`map.getTerrain()`), or by the
level's without a relief. A custom layer cannot read the relief MapLibre
draws, so where the ribbons stand on the elevation tiles of the level drawn
under them (see above), the cloud stands on the ground the build sampled,
smoothed for the level: within about a pixel of them, and a flight whose
ground is not known stands on the line between its fields. All years at `z`
12 are about 100,000 points (2 MB), at `z` 6 about 5,000.

The layer draws every stretch between two points as one instance of a quad
on the screen, reaching three blurs around it (`CLOUD_STOPS`: 7 CSS px in
the middle of the map out to map zoom 9.5, `z` 10.5, narrowing to 4.5 px at
10.5 and 2.5 px from 13 in, and wider in front and narrower behind in a
tilted view, held between 0.15 and 3 times that). Close in its gain goes
down with it, to half at 13: at the full width and gain the glow of every
track around a busy field covered twice the map the flat heatmap does at
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
the stops of the heatmap's gradient. The vertex shader projects with the
code MapLibre hands a custom layer (`shaderData.vertexShaderPrelude`,
`projectTileFor3D`), so the same shaders work on the globe, which gets its
own matrix and the flat map's (`fallbackMatrix`, scaled to heights in
metres) for the way into and out of it; a program is compiled per variant.
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
in front of it. Its GL objects are made in its first frame, where MapLibre
takes up the state of its context anew after a custom layer; a lost context
drops them (`webglcontextlost`), and the style MapLibre gets back has no
custom layers, so `ui/heatCloud.ts` adds the layer again on `style.load`,
and on `styledata` after a new base style. Shaders that do not compile turn
it off for good with one logged error, and the flat heatmap stays. It only
draws: a custom layer has no features for `queryRenderedFeatures`, and the
ribbons stay what is hovered and clicked. An exported image has it, since
the canvas is read in the frame that drew it (`withMapStill`). It is drawn
in the world copy of the flights only, where the flat map shows several.

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
