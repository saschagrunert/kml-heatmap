# KML Heatmap Generator Docker Image
FROM python:3.14-slim

# Set working directory
WORKDIR /app

# Install Node.js (latest LTS version)
RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application
COPY kml-heatmap.py .
COPY kml_heatmap/ ./kml_heatmap/

# Copy JavaScript/TypeScript build configuration
COPY package.json build.js tsconfig.json tsconfig.eslint.json eslint.config.js ./

# Install Node.js dependencies and build TypeScript bundle
RUN npm install && npm run build

# Copy server script
COPY <<'EOF' /app/serve.py
#!/usr/bin/env python3
"""Simple HTTP server for serving the generated heatmap."""
import http.server
import socketserver
import os
import sys

PORT = int(os.environ.get('PORT', 8000))

class CORSHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
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
