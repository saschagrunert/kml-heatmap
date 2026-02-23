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

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application
COPY kml-heatmap.py .
COPY kml_heatmap/ ./kml_heatmap/

# Copy built JavaScript bundles from builder stage
COPY --from=js-builder /build/kml_heatmap/static/bundle.js ./kml_heatmap/static/bundle.js
COPY --from=js-builder /build/kml_heatmap/static/mapApp.bundle.js ./kml_heatmap/static/mapApp.bundle.js

# Copy server script
COPY <<'EOF' /app/serve.py
#!/usr/bin/env python3
"""Simple HTTP server for serving the generated heatmap."""
import http.server
import socketserver
import os
import sys

PORT = int(os.environ.get('PORT', 8000))

CORS_ORIGIN = os.environ.get('CORS_ORIGIN', '')

class CORSHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if CORS_ORIGIN:
            self.send_header('Access-Control-Allow-Origin', CORS_ORIGIN)
            self.send_header('Access-Control-Allow-Methods', 'GET')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        return super().end_headers()

os.chdir('/data')
print(f"Starting HTTP server on port {PORT}...")
print(f"Serving files from: {os.getcwd()}")
print(f"Open http://localhost:{PORT}/ in your browser")

with socketserver.TCPServer(("", PORT), CORSHTTPRequestHandler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        sys.exit(0)
EOF

# Make server script executable
RUN chmod +x /app/serve.py

# Create directory for input/output files
RUN mkdir -p /data

# Set working directory to /data for file operations
WORKDIR /data

# Set the script as entrypoint (can be overridden)
ENTRYPOINT ["python", "/app/kml-heatmap.py"]

# Default command (show help if no arguments)
CMD []
