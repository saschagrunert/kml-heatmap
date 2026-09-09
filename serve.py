#!/usr/bin/env python3
"""Simple HTTP server for serving the generated heatmap."""

import http.server
import os
import socketserver
import sys

PORT = int(os.environ.get("PORT", "8000"))
BIND_HOST = os.environ.get("BIND_HOST", "127.0.0.1")

CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "")


class CORSHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if CORS_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
            self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        return super().end_headers()


data_dir = "/data"
if not os.path.isdir(data_dir):
    print(f"Error: {data_dir} does not exist. Are you running inside Docker?")
    sys.exit(1)
os.chdir(data_dir)
print(f"Starting HTTP server on {BIND_HOST}:{PORT}...")
print(f"Serving files from: {os.getcwd()}")
print(f"Open http://localhost:{PORT}/ in your browser")

with socketserver.TCPServer((BIND_HOST, PORT), CORSHTTPRequestHandler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        sys.exit(0)
