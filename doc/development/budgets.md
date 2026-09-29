# Size budgets

What a visit downloads is held to budgets: the JavaScript bundles and the
vendored libraries in `build.js`, which every production build checks, and the
stylesheets in `tests/test_asset_budget.py`, which the Python tests check. This
page says what each budget covers, how a budget is raised and where its history
is kept. The numbers themselves live next to the budgets, in those two files.

## Bundles

A production build (`npm run build`) prints the size of every bundle next to its
budget and fails when `mapApp.bundle.js` and `shared.bundle.js` together,
`features.bundle.js`, `wrapped.bundle.js`, `yearWorker.bundle.js` or the
vendored MapLibre and html-to-image files exceed their size budget in
`build.js`. Each has a budget for its bytes as written and one for them gzipped
(level 9); the comment above the budgets says how much room they leave and why.
CI's zlib compresses up to about 0.5 % differently from a local build, so go by
the gzipped sizes CI prints when a budget is close.

| Budget in `build.js`   | What it covers                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `BUDGET_APP`           | The first visit: `mapApp.bundle.js` and the `shared.bundle.js` it loads with it                  |
| `BUDGET_FEATURES`      | `features.bundle.js`: replay, the 3D view, the imagery, the profile, the cross-section, the tour |
| `BUDGET_WRAPPED`       | `wrapped.bundle.js`: Wrapped, the statistics panel and the flight list                           |
| `BUDGET_WORKER`        | `yearWorker.bundle.js`, fetched next to the first year file                                      |
| `BUDGET_MAPLIBRE`      | The vendored MapLibre GL JS modules and stylesheet                                               |
| `BUDGET_HTML_TO_IMAGE` | The vendored html-to-image module, loaded on the first export                                    |

## Stylesheets

The stylesheets are minified by the Python side, not by `build.js`, so their
budgets are a test, `tests/test_asset_budget.py`, which fails in CI on a
regression and leaves the generator itself alone. `styles.css` is on the
critical path of every visit; `features.css` and `wrapped.css` are fetched with
their lazy bundles (see [Stylesheets](frontend.md#stylesheets)), so room taken
in them is not the same as room taken in `styles.css`, and each has a budget of
its own.

## Raising a budget

The policy is written above the budgets in `build.js`:

- Raise a budget on purpose, in the change that needs the room, and say what it
  paid for in the commit message and in the comment above the budget
- An app bundle gets about 2 KB of raw and 1 KB of gzipped room over its size
  when the budget is set, a vendored file about 1 %
- The gzipped budget catches what the raw one rewards the wrong way: a change
  that saves raw bytes by making the code harder to compress
- Size a raise by the sizes CI prints (the "Build the JavaScript bundle" step of
  any job), not by a local build
- Two pull requests that each fit can still not fit together, since each is
  built against the main branch of its day; the budget is checked again on
  `main`
- A Dependabot bump of MapLibre that makes it noticeably larger fails the build;
  raise its budget in the pull request of the bump, with the new sizes
- The same goes for the stylesheets: raise a budget when a change needs the
  room, not to make the suite pass

## History

The comment above each budget lists every raise and lowering with the sizes
before and after, and `git log -L` on a budget line lists the commits that
changed it and why. Where a change was sized against the budgets, its page says
so as well, for example
[the heat sources in the year worker](heat.md#the-heat-sources-and-the-year-worker)
and [the readout of the heat cloud](heat.md#no-readout-on-the-flat-map).
