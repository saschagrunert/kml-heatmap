# KML Heatmap Generator Docker Image

# Stage 1: Build JavaScript bundles
FROM node:lts-slim AS js-builder

WORKDIR /build

# Copy JavaScript/TypeScript build configuration
COPY package.json package-lock.json build.js tsconfig.json tsconfig.eslint.json eslint.config.js ./
COPY kml_heatmap/frontend/ ./kml_heatmap/frontend/

# Install Node.js dependencies and build TypeScript bundle
RUN npm ci && npm run build

# Stage 2: Final Python image
FROM python:3.14-slim

WORKDIR /app

# Copy lock file first for better caching
COPY requirements.lock .

# Install pinned Python dependencies
RUN pip install --no-cache-dir -r requirements.lock

# Copy the application
COPY kml-heatmap.py .
COPY kml_heatmap/ ./kml_heatmap/

# Copy built JavaScript bundles from builder stage
COPY --from=js-builder /build/kml_heatmap/static/bundle.js ./kml_heatmap/static/bundle.js
COPY --from=js-builder /build/kml_heatmap/static/mapApp.bundle.js ./kml_heatmap/static/mapApp.bundle.js

# Copy server script
COPY serve.py /app/serve.py

# Create directory for input/output files
RUN mkdir -p /data

# Set working directory to /data for file operations
WORKDIR /data

# Set the script as entrypoint (can be overridden)
ENTRYPOINT ["python", "/app/kml-heatmap.py"]

# Default command (show help if no arguments)
CMD []
