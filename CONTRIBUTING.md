# Contributing

Thanks for taking the time to contribute. This document describes the local
setup, the checks that run in CI and the conventions used in this repository.

## Setup

- Python 3.14 (`.python-version`) and Node.js 26 (`.nvmrc`). CI and the
  container image use Node.js 26, and that is the only release the tests
  run on, so `engines` in `package.json` asks for 26 or newer.
- podman or docker for `make build` and `make serve` (optional)

```bash
git clone https://github.com/saschagrunert/kml-heatmap.git
cd kml-heatmap

python -m venv .venv && source .venv/bin/activate
pip install -e '.[test,dev]'
npm ci
npm run build                 # frontend bundles (gitignored)

pip install pre-commit && pre-commit install
```

The pre-commit hooks run ruff (check and format), prettier, typos, gitleaks and
the whitespace fixers on every commit. When a commit touches `data/`, they also
check that the KML files are obfuscated. Apart from gitleaks and the whitespace
fixers, the hooks run the tools from your own environment rather than from a
pinned mirror, so no hook revision can drift on its own. ruff and the
obfuscation check are resolved off `$PATH` and prettier out of `node_modules`,
so commit with the virtual environment active and after `npm ci` to get the
versions CI installs. typos is in neither lock file; the hook skips it when it
is not installed and the CI job is the one that has to pass.

## Checks

Run the same checks as CI before opening a pull request. They use the tools
from your virtual environment and `node_modules`, the same way CI does, so no
container is involved:

```bash
make lint            # lock files and version pins, ruff (check and format), mypy, bandit, tsc (frontend and tests), eslint, prettier, typos
make format          # ruff format, prettier
make test            # vitest and pytest with coverage; pytest flags are in DEVELOPMENT.md
npm run test:e2e     # Playwright: desktop, mobile and WebKit (see DEVELOPMENT.md)
make check-obfuscation
make lock            # regenerates the Python lock files after changing pyproject.toml
```

`make help` lists all targets and the current variable values.

Because the project targets Python 3.14, `ruff format` writes multi-exception
handlers in the PEP 758 style without parentheses (`except ValueError, TypeError:`).
That is the formatter's canonical output here, not an oversight: adding the
parentheses back is undone on the next `make format`.

## Repository rules

- **The generated site is not tracked.** `docs/` is only the default output
  directory of a local `make build`. On every push to `main` the `test`
  workflow builds the site from the sources and `data/` and publishes it to
  GitHub Pages, in its `site` and `deploy` jobs, which only start once every
  test job has passed and only while the commit is still the head of `main`
  (a re-run of an older run does not publish). The `unit` and `e2e` jobs build their own copies; the
  e2e jobs test one with dummy tile API keys and one without. The
  repository's Pages source has to be "GitHub Actions" (Settings > Pages).
  Set it by hand: the workflow token is not allowed to change it.
- **Never commit un-obfuscated KML files.** Every run rewrites the files in
  `data/` in place; the pre-commit hook, `make check-obfuscation` and the
  `obfuscation` CI job verify that every committed file is obfuscated. Only
  the hook runs before the dates would be public.
- The frontend build output in `kml_heatmap/static/` is gitignored: both
  bundles (`mapApp.bundle.js`, `features.bundle.js`) with their `.map` files
  and `vendor/`, the third-party code copied out of `node_modules`. It is
  built by `npm run build` and, for the images, inside the Dockerfile.
- The Python dependencies are declared once, in `pyproject.toml` (runtime
  dependencies plus the `test` and `dev` extras). `requirements.lock` and
  `requirements-test.lock` are compiled from it with `make lock` (pip-compile
  with hashes). Edit `pyproject.toml`, then regenerate the locks; the CI lint
  job fails while the locks no longer satisfy `pyproject.toml`, which is what
  a Dependabot `pip` pull request needs `make lock` for. The weekly `lock`
  workflow regenerates them as well and opens a pull request. That needs
  "Allow GitHub Actions to create and approve pull requests" (Settings >
  Actions > General), and a pull request opened by the workflow token does
  not start CI: close and reopen it to run the checks.
- The published page carries Leaflet, leaflet.heat and dom-to-image itself:
  `scripts/vendor.js` copies them out of `node_modules` at build time, so
  `package-lock.json` is the only place their versions are pinned and
  Dependabot can bump them like anything else. Nothing loads from a CDN, and
  the e2e fixture fails any test whose page reaches a third-party origin.
- AI assistant files (`AGENTS.md`, `.claude/`) are ignored by git and the
  container build context; keep them local.

## Commits and pull requests

- Use conventional prefixes as seen in the history: `fix:`, `feat:`, `chore:`,
  `ci:` (Dependabot uses `npm`, `pip`, `docker`, `pre-commit` and `ci`).
- Sign off every commit: `git commit -s`. The Developer Certificate of Origin
  applies.
- Keep one commit per branch. Amend it when addressing review feedback and keep
  the message in sync with the final state of the change.
- Keep messages concise and describe what changed and why. Do not reference
  issue or pull request numbers in the commit message; GitHub links them in the
  pull request.
- Write in a plain, direct style. Do not use em dashes or en dashes.

## Visual snapshots

`tests/e2e/visual.spec.ts` compares the page's chrome against committed
screenshots. Pixel comparisons only mean anything where the rendering is
fixed, so they run inside the Playwright image rather than against whatever
browser is on the machine, in CI and locally alike. The project only exists
there, so a plain `npm run test:e2e` leaves it out instead of failing on font
rendering that was never going to match:

```sh
podman run --rm --network host --userns=keep-id --user "$(id -u):$(id -g)" \
  --security-opt label=disable -v "$PWD:/work" -w /work -e HOME=/tmp \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  npx playwright test --project=visual
```

Build the site first (`npm run build && python -m kml_heatmap data
--output-dir docs`). When a change is meant to alter the look, add
`--update-snapshots` to that command and commit the new screenshots; the
diff of a failing run is in the `visual-diff` artifact. The image tag has to match the
`@playwright/test` version in `package-lock.json`, which
`scripts/check_locks.py` checks.

## Releasing

The version is declared once, in `kml_heatmap/__init__.py`; `package.json`
and `package-lock.json` repeat it and `scripts/check_locks.py` fails the lint
job when the three disagree. To cut a release: set the version in
`kml_heatmap/__init__.py` and `package.json`, run `npm install` so the lock
file follows, and tag the merged commit `vX.Y.Z`. The tag's release notes
are generated from the commits, so there is no changelog file to keep.
