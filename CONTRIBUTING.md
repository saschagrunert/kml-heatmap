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
make hooks                    # pre-push check for real flight dates
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

npm 11 skips the install scripts of dependencies that `allowScripts` in
`package.json` does not list. esbuild is the only dependency with one, and it
is listed, so `npm ci` runs it and prints no warning. A new dependency that
needs its install script has to be added there on purpose
(`npm install-scripts approve <pkg>`).

## Checks

Run the same checks as CI before opening a pull request. They use the tools
from your virtual environment and `node_modules`, the same way CI does, so no
container is involved:

```bash
make lint            # lock files and version pins, ruff (check and format), mypy, bandit, tsc (frontend, build scripts, tests), eslint, knip, prettier, typos
make format          # ruff format, prettier
make test            # vitest and pytest with coverage; pytest flags are in DEVELOPMENT.md
npm run test:e2e     # Playwright: desktop, mobile and WebKit (see DEVELOPMENT.md)
make obfuscate       # after adding flights to data/ (see README.md); rewrites them in place, irreversibly
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
  (a re-run of an older run does not publish). The `unit` and `e2e` jobs
  build their own copies; the e2e jobs test one with a dummy tile API key and
  one without. The repository's Pages source has to be "GitHub Actions"
  (Settings > Pages). Set it by hand: the workflow token is not allowed to
  change it.
- **Never commit un-obfuscated KML files.** Generating a site no longer
  rewrites them: run `make obfuscate` after adding flights to `data/` (or
  pass `--obfuscate-inputs`). The pre-commit hook, `make check-obfuscation`
  and the `obfuscation` CI job verify that every committed file is
  obfuscated, but only the hooks run before the dates would be public. The
  pre-push hook (install it with `make hooks`) checks every commit being
  pushed, needs nothing beyond Python 3.14 and refuses the push when it
  cannot check. The published site carries no flight date finer than the
  year either way; this is about the KML files this repository commits.
- The frontend build output in `kml_heatmap/static/` is gitignored: the four
  bundles (`mapApp.bundle.js`, `features.bundle.js`, `shared.bundle.js`,
  `yearWorker.bundle.js`) with their `.map` files, `vendor/` (the
  third-party code copied out of `node_modules`) and `flags/` (the country
  flags of `flag-icons`). It is built by `npm run build` and, for the image,
  inside the Dockerfile; `make clean` removes it.
- The Python dependencies are declared once, in `pyproject.toml` (runtime
  dependencies plus the `test` and `dev` extras). `requirements.lock` and
  `requirements-test.lock` are compiled from it with `make lock` (pip-compile
  with hashes). Edit `pyproject.toml`, then regenerate the locks; the CI lint
  job fails while the locks no longer satisfy `pyproject.toml`, which is what
  a Dependabot `pip` pull request needs `make lock` for. `make lock`
  compiles the test lock with the runtime lock as a constraint, so the pins
  both files share cannot drift apart. The weekly `lock` workflow
  regenerates them as well and opens a pull request, which needs one of two
  one-time setups. With neither, its pull-request job fails with "GitHub
  Actions is not permitted to create or approve pull requests".
  - Preferred: a `LOCK_PR_TOKEN` repository secret (Settings > Secrets and
    variables > Actions) holding a fine-grained personal access token, or a
    GitHub App token, for this repository only, with read and write access
    to "Contents" and "Pull requests". A pull request opened with it starts
    CI like any other.
  - Or: enable "Allow GitHub Actions to create and approve pull requests"
    (Settings > Actions > General). Without the secret the workflow falls
    back to its own token, and a pull request opened with that one does not
    start CI: close and reopen it to run the checks.
- The published page carries MapLibre GL JS and html-to-image itself:
  `scripts/vendor.js` takes them out of `node_modules` at build time, so
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
there (or with `VISUAL_SNAPSHOTS=1`, for an equivalent setup), so a plain
`npm run test:e2e` leaves it out instead of failing on font rendering that
was never going to match:

```sh
podman run --rm --network host --userns=keep-id --user "$(id -u):$(id -g)" \
  --security-opt label=disable -v "$PWD:/work" -w /work -e HOME=/tmp \
  mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 \
  npx playwright test --project=visual
```

The snapshots are not taken of `docs/`. The statistics rail and the Wrapped
dialog print figures computed from the flights, and `data/` grows all the
time, so the project has a site of its own: `visual-site/`, built from the
few flights in `tests/fixtures/visual/` (obfuscated like the ones in `data/`,
which the hooks, `make check-obfuscation` and the `obfuscation` job check
too), with `tests/fixtures/airports.csv` in place of the OurAirports download
and a fixed build time and commit. Build it before running the command above,
outside the container, since the image has no Python the package runs on:

```sh
npm run build && python scripts/build_visual_site.py
```

The run refuses a `visual-site/` that is older than the sources, the
fixture or that script, and names this command.

Nothing in that site changes on its own and the pinned image renders it the
same on every run, so every snapshot is compared exactly (`maxDiffPixels: 0`).
An earlier tolerance of 1% for the rail and the dialog let a missing control
row and three stale snapshots pass. `PINNED_YEAR` in the spec picks the
earlier of the fixture's two years through the URL.

When a change is meant to alter the look, or the fixture changes, add
`--update-snapshots=all` to the command above and commit the new screenshots.
The plain `--update-snapshots` only rewrites a snapshot whose comparison
fails, and the comparison still ignores a small difference in the colour of a
pixel (Playwright's `threshold`), so a snapshot can be stale and pass; `=all`
rewrites every snapshot that is not identical. The diff of a failing CI run
is in the `visual-diff` artifact.

The image is pinned by tag and digest, in the `visual` job of
`.github/workflows/test.yml` and in the command above alike. The tag has to
match the `@playwright/test` version in `package-lock.json`, and
`scripts/check_locks.py` fails the lint job when the workflow, this file,
`DEVELOPMENT.md` and the lock file disagree. Dependabot opens the
`@playwright/test` bump as a pull request of its own and does not touch the
image: on that branch, set the new tag with the digest of its multi-arch
index in all three places. The registry returns the digest in the
`Docker-Content-Digest` header:

```sh
curl -sI -H "Accept: application/vnd.oci.image.index.v1+json" \
  https://mcr.microsoft.com/v2/playwright/manifests/v1.64.0-noble |
  grep -i docker-content-digest
```

A new image may render differently; regenerate the snapshots on that
branch if the visual job says so.

## Version

There are no releases: the site is deployed from `main` (see the `site` and
`deploy` jobs of `.github/workflows/test.yml`). The version is declared once,
in `kml_heatmap/__init__.py`; `package.json` and `package-lock.json` repeat it
and `scripts/check_locks.py` fails the lint job when the three disagree.
