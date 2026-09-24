# KML Heatmap Generator runtime image
#
# Base images carry both the tag and the digest of the multi-arch index, so
# Dependabot bumps the two together and the version stays readable in the FROM
# line itself. Do not restate the tag in a comment: it drifts silently.

# Stage 1: build the JavaScript bundles
FROM docker.io/library/node:26-slim@sha256:3a771f83944bb763050c23c0225c260638c4b7899e7a72485ef75e5e570499e5 AS js-builder

WORKDIR /build

# Install dependencies first so that source changes do not invalidate this
# layer. The build needs the runtime dependencies (vendored or bundled into
# the page) and two of the development ones: esbuild, which runs it, and
# flag-icons, which scripts/vendor.js copies. The rest of the development
# tools (Playwright, Vitest, jsdom, ESLint) only test and lint, so the
# development dependencies are cut down to those two before installing.
# npm ci would refuse the edited package.json; npm install takes every
# version and integrity hash from the unchanged package-lock.json and
# --no-save leaves it as it is. A package build.js starts to import without
# being listed here fails the image build, not the site.
COPY package.json package-lock.json ./
RUN node -e ' \
      const fs = require("node:fs"); \
      const manifest = JSON.parse(fs.readFileSync("package.json", "utf8")); \
      const build = ["esbuild", "flag-icons"]; \
      manifest.devDependencies = Object.fromEntries( \
        build.map((name) => [name, manifest.devDependencies[name]])); \
      fs.writeFileSync("package.json", JSON.stringify(manifest, null, 2)); \
    ' \
    && npm install --no-save --no-audit --no-fund

# Only what build.js reads: its own scripts, the compiler options, the
# TypeScript sources and the two stylesheets that are part of the source hash
# (scripts/source-hash.js). A change to the Python side or the templates then
# reuses the bundles of the last build.
COPY build.js tsconfig.json ./
COPY scripts/*.js ./scripts/
COPY kml_heatmap/frontend/ ./kml_heatmap/frontend/
COPY kml_heatmap/static/styles.css kml_heatmap/static/features.css ./kml_heatmap/static/
RUN npm run build

# Stage 2: the Python package without the TypeScript sources. A stage of its
# own so the sources never become a layer of the image; they are dropped here
# rather than in .dockerignore, which would hide them from the build as well.
FROM docker.io/library/python:3.14-slim@sha256:caaf356f40667c496d405780745b9ac25771c189a51dfcc42430d531ea09f8a2 AS package
COPY kml_heatmap/ /package/kml_heatmap/
RUN rm -rf /package/kml_heatmap/frontend

# Stage 3: Python runtime
FROM docker.io/library/python:3.14-slim@sha256:caaf356f40667c496d405780745b9ac25771c189a51dfcc42430d531ea09f8a2

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install the pinned Python dependencies into a virtual environment
COPY requirements.lock ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --require-hashes -r requirements.lock
ENV PATH="/opt/venv/bin:$PATH"

# The Python package with its templates and static assets, then the built
# bundles (and their source maps), the vendored files and the flags over its
# static directory
COPY --from=package /package/kml_heatmap/ ./kml_heatmap/
COPY --from=js-builder /build/kml_heatmap/static/ ./kml_heatmap/static/
COPY serve.py ./

# Run as an unprivileged user; /data is the work directory for input and
# output mounts, /cache holds the OurAirports database and the parse cache.
RUN useradd --system --uid 10001 --user-group --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin app \
    && mkdir -p /data /cache \
    && chown app:app /data /cache

ENV PYTHONPATH=/app \
    KML_HEATMAP_CACHE_DIR=/cache

USER app
WORKDIR /data

ENTRYPOINT ["python", "-m", "kml_heatmap"]
# Default command: show the help text
CMD ["--help"]
