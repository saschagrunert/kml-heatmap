# Contributing

Thanks for taking the time to contribute. This document describes the local
setup, the checks that run in CI and the conventions used in this repository.

## Setup

- Python 3.14 (`.python-version`) and Node.js 26 (`.nvmrc`). CI and the
  container image use Node.js 26; Node.js 24 or newer works for local
  development (`engines` in `package.json`).
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
the whitespace fixers on every commit.

## Checks

Run the same checks as CI before opening a pull request. They use the tools
from your virtual environment and `node_modules`, the same way CI does, so no
container is involved:

```bash
make lint            # ruff, mypy, bandit, tsc (frontend and tests), eslint
make format          # ruff format, prettier
make test            # vitest and pytest with coverage; pytest flags are in README.md
npm run test:e2e     # Playwright (see README.md for the prerequisites)
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
  directory of a local `make build`. The `deploy` workflow builds the site
  from the sources and `data/` on every push to `main` and publishes it to
  GitHub Pages; the `unit` and `e2e` CI jobs build their own copy. The
  repository's Pages source has to be "GitHub Actions" (Settings > Pages);
  the workflow switches it over on its first run.
- **Never commit un-obfuscated KML files.** Every run rewrites the files in
  `data/` in place; `make check-obfuscation` (and the `obfuscation` CI job)
  verify that every committed file is obfuscated.
- The frontend bundle in `kml_heatmap/static/` (`mapApp.bundle.js` and its
  `.map` file) is gitignored. It is built by `npm run build` and, for the
  images, inside the Dockerfile.
- The Python dependencies are declared once, in `pyproject.toml` (runtime
  dependencies plus the `test` and `dev` extras). `requirements.lock` and
  `requirements-test.lock` are compiled from it with `make lock` (pip-compile
  with hashes). Edit `pyproject.toml`, then regenerate the locks; the weekly
  `lock` workflow does the same and opens a pull request.
- The e2e suite serves Leaflet, leaflet.heat and dom-to-image from
  `node_modules` in place of the CDN copies the page loads. Their versions in
  `package.json` have to match the URLs and integrity hashes in
  `kml_heatmap/templates/map_template.html`; bump both together.
- AI assistant files (`AGENTS.md`, `.claude/`) are ignored by git and the
  container build context; keep them local.

## Commits and pull requests

- Use conventional prefixes as seen in the history: `fix:`, `feat:`, `chore:`,
  `ci:` (Dependabot uses `npm`, `pip`, `docker` and `ci`).
- Sign off every commit: `git commit -s`. The Developer Certificate of Origin
  applies.
- Keep one commit per branch. Amend it when addressing review feedback and keep
  the message in sync with the final state of the change.
- Keep messages concise and describe what changed and why. Do not reference
  issue or pull request numbers in the commit message; GitHub links them in the
  pull request.
- Write in a plain, direct style. Do not use em dashes or en dashes.
