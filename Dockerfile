# KML Heatmap Generator runtime image
#
# Base images carry both the tag and the digest of the multi-arch index, so
# Dependabot bumps the two together and the version stays readable in the FROM
# line itself. Do not restate the tag in a comment: it drifts silently.

# Stage 1: build the JavaScript bundles
FROM docker.io/library/node:26-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS js-builder

WORKDIR /build

# Install dependencies first so that source changes do not invalidate this layer
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript sources into IIFE bundles (kml_heatmap/static/*.js)
COPY build.js tsconfig.json ./
COPY kml_heatmap/frontend/ ./kml_heatmap/frontend/
RUN npm run build

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

# Copy the Python package (no TypeScript sources), templates and static assets
COPY kml_heatmap/*.py kml_heatmap/py.typed ./kml_heatmap/
COPY kml_heatmap/templates/ ./kml_heatmap/templates/
COPY kml_heatmap/static/ ./kml_heatmap/static/
# Built bundles (and their source maps, when present) from the builder stage
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
