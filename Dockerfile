# KML Heatmap Generator runtime image
#
# Base images carry both the tag and the digest of the multi-arch index, so
# Dependabot bumps the two together and the version stays readable in the FROM
# line itself. Do not restate the tag in a comment: it drifts silently.

# Stage 1: build the JavaScript bundle
FROM docker.io/library/node:26-slim@sha256:65f816afd401c1c4de3293acc46dce115398152af4bdcd73c103b096988922d7 AS js-builder

WORKDIR /build

# Install dependencies first so that source changes do not invalidate this layer
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript sources into the bundles (kml_heatmap/static/*.bundle.js).
# The whole package comes along, so a new module or subpackage reaches the
# runtime image without a Dockerfile change. The TypeScript sources are
# dropped here rather than in .dockerignore, which would hide them from this
# stage as well.
COPY build.js tsconfig.json ./
# The whole directory, not the one file build.js used to need: it imports
# the vendoring and the shared-module list from here as well
COPY scripts/ ./scripts/
COPY kml_heatmap/ ./kml_heatmap/
RUN npm run build && rm -rf kml_heatmap/frontend

# Stage 2: Python runtime
FROM docker.io/library/python:3.14-slim@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install the pinned Python dependencies into a virtual environment
COPY requirements.lock ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --require-hashes -r requirements.lock
ENV PATH="/opt/venv/bin:$PATH"

# The Python package with its templates, static assets and the built bundle
# (and its source map), without the TypeScript sources
COPY --from=js-builder /build/kml_heatmap/ ./kml_heatmap/
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
