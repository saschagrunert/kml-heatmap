#!/usr/bin/env python3
"""Simple HTTP server for serving the generated heatmap."""

import http.server
import os
import sys
from urllib.parse import SplitResult, urlsplit

PORT = int(os.environ.get("PORT", "8000"))
BIND_HOST = os.environ.get("BIND_HOST", "127.0.0.1")
# Where a browser reaches the server: in a container that is the host's
# address and port, which `make serve` passes, not the ones bound inside
OPEN_URL = os.environ.get("OPEN_URL") or f"http://localhost:{PORT}/"

CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "")


def _split_origin(value: str) -> tuple[SplitResult, int | None] | None:
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return None
    return parts, port


def cors_origin(value: str) -> str:
    """The Access-Control-Allow-Origin that CORS_ORIGIN asks for, "" for none.

    ``*``, or one origin: a scheme, a host and an optional port, nothing
    after them but a slash, which is dropped (a browser sends the origin
    without it). Anything else is refused rather than sent on as it is: a
    header value with a line break in it would be a header of its own.
    """
    value = value.strip()
    if value in ("", "*"):
        return value
    split = _split_origin(value)
    if (
        split is None
        or split[0].scheme not in ("http", "https")
        or not split[0].hostname
        or split[0].path not in ("", "/")
        or split[0].query
        or split[0].fragment
        or split[0].username is not None
        or not value.isascii()
        or any(char.isspace() for char in value)
    ):
        raise ValueError(
            "CORS_ORIGIN must be * or an origin such as https://example.org, "
            f"not {value!r}"
        )
    parts, port = split
    host = parts.hostname or ""
    # urlsplit drops the brackets of an IPv6 address, which an origin keeps
    if ":" in host:
        host = f"[{host}]"
    origin = f"{parts.scheme}://{host}"
    return f"{origin}:{port}" if port is not None else origin


class CORSHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    #: The validated CORS_ORIGIN (see cors_origin), set by main
    allowed_origin = ""

    # The signature of the method it overrides, whose path it does not need
    def list_directory(self, path: str | os.PathLike[str]) -> None:  # noqa: ARG002
        # The site is addressed by its files; a listing of the data directory
        # is nothing a page needs
        self.send_error(404, "Directory listing not supported")

    def end_headers(self) -> None:
        if self.allowed_origin:
            self.send_header("Access-Control-Allow-Origin", self.allowed_origin)
            self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        # A data file must not be read as a script or a page by type sniffing
        self.send_header("X-Content-Type-Options", "nosniff")
        # As the page's meta tag has it. A worker takes its policy from the
        # header of its script, not from the page: with same-origin here the
        # MapLibre worker would fetch the CARTO tiles without a Referer, which
        # a key restricted to the site's domain refuses.
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        return super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    """Serve requests concurrently and allow an immediate restart on the port."""

    allow_reuse_address = True
    daemon_threads = True


# The directory the image mounts the site at; DATA_DIR points elsewhere, as
# tests/test_serve.py does
DATA_DIR = os.environ.get("DATA_DIR", "/data")


def main() -> int:
    try:
        CORSHTTPRequestHandler.allowed_origin = cors_origin(CORS_ORIGIN)
    except ValueError as e:
        print(f"Error: {e}")
        return 1
    if not os.path.isdir(DATA_DIR):
        print(f"Error: {DATA_DIR} does not exist. Are you running inside Docker?")
        return 1
    os.chdir(DATA_DIR)
    print(f"Starting HTTP server on {BIND_HOST}:{PORT}...")
    print(f"Serving files from: {os.getcwd()}")
    print(f"Open {OPEN_URL} in your browser", flush=True)

    with Server((BIND_HOST, PORT), CORSHTTPRequestHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
