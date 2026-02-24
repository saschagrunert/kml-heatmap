#!/usr/bin/env python3
"""Simple HTTP server for serving the generated heatmap."""

import http.server
import socketserver
import os
import sys

PORT = int(os.environ.get("PORT", 8000))

CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "")


class CORSHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if CORS_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
            self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        return super().end_headers()


os.chdir("/data")
print(f"Starting HTTP server on port {PORT}...")
print(f"Serving files from: {os.getcwd()}")
print(f"Open http://localhost:{PORT}/ in your browser")

with socketserver.TCPServer(("", PORT), CORSHTTPRequestHandler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        sys.exit(0)
