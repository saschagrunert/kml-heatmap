"""Smoke test for serve.py, the server `make serve` runs in the image.

It starts the script as the image does, on a free port against a temporary
directory, and fetches a file, a missing file and a directory from it.
"""

import importlib.util
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

SERVE = Path(__file__).parent.parent / "serve.py"


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
        return port


@pytest.fixture
def site(tmp_path):
    """serve.py serving a small site, with CORS for one origin."""
    (tmp_path / "index.html").write_text("<p>flights</p>", encoding="utf-8")
    (tmp_path / "data").mkdir()
    port = _free_port()
    env = {
        **os.environ,
        "DATA_DIR": str(tmp_path),
        "PORT": str(port),
        "BIND_HOST": "127.0.0.1",
        "CORS_ORIGIN": "https://example.org",
    }
    server = subprocess.Popen(  # noqa: S603
        [sys.executable, str(SERVE)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    break
            except OSError:
                if server.poll() is not None or time.monotonic() > deadline:
                    pytest.fail("serve.py did not start listening")
                time.sleep(0.05)
        yield base
    finally:
        server.terminate()
        server.wait(timeout=10)


def test_serves_a_file_without_caching(site):
    with urllib.request.urlopen(f"{site}/index.html", timeout=5) as response:  # noqa: S310
        assert response.status == 200
        assert response.read() == b"<p>flights</p>"
        assert "no-store" in response.headers["Cache-Control"]
        assert response.headers["Access-Control-Allow-Origin"] == (
            "https://example.org"
        )


def test_a_missing_file_is_not_found(site):
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(f"{site}/missing.js", timeout=5)  # noqa: S310
    error.value.close()
    assert error.value.code == 404


def test_lists_no_directory(site):
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(f"{site}/data/", timeout=5)  # noqa: S310
    error.value.close()
    assert error.value.code == 404


def test_sends_the_security_headers(site):
    with urllib.request.urlopen(f"{site}/index.html", timeout=5) as response:  # noqa: S310
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        # The page's own policy, which the map's worker takes from its script
        assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"


def _serve_module():
    """serve.py as a module, which is not in a package."""
    spec = importlib.util.spec_from_file_location("serve", SERVE)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_prints_the_address_it_is_reached_at(monkeypatch):
    monkeypatch.setenv("PORT", "8000")
    monkeypatch.delenv("OPEN_URL", raising=False)
    assert _serve_module().OPEN_URL == "http://localhost:8000/"

    # In the image the port is 8000 inside, and make serve maps another
    monkeypatch.setenv("OPEN_URL", "http://127.0.0.1:9000/")
    assert _serve_module().OPEN_URL == "http://127.0.0.1:9000/"


@pytest.mark.parametrize(
    ("value", "origin"),
    [
        ("", ""),
        ("*", "*"),
        ("https://example.org", "https://example.org"),
        (" https://Example.org:8443 ", "https://example.org:8443"),
        ("http://localhost:3000", "http://localhost:3000"),
        # The slash a copied address ends in, which an Origin header has not
        ("https://example.org/", "https://example.org"),
        ("http://[::1]:8000", "http://[::1]:8000"),
        ("http://[::1]/", "http://[::1]"),
        # The default port of the scheme, which a browser leaves out
        ("https://example.org:443", "https://example.org"),
        ("http://example.org:80/", "http://example.org"),
        ("http://example.org:443", "http://example.org:443"),
    ],
)
def test_a_cors_origin_is_accepted(value, origin):
    assert _serve_module().cors_origin(value) == origin


@pytest.mark.parametrize(
    "value",
    [
        "example.org",
        "https://example.org//",
        "https://example.org/path",
        "https://example.org?x=1",
        "https://example.org#x",
        "ftp://example.org",
        "https://user@example.org",
        "https://example.org\r\nSet-Cookie: x=1",
        "https://exämple.org",
        "https://example.org:99999",
        "null",
    ],
)
def test_anything_else_is_refused(value):
    """Not reflected: a line break in it would be a header of its own."""
    with pytest.raises(ValueError, match="CORS_ORIGIN"):
        _serve_module().cors_origin(value)


def test_refuses_to_start_with_an_invalid_origin(tmp_path):
    result = subprocess.run(  # noqa: S603
        [sys.executable, str(SERVE)],
        env={**os.environ, "DATA_DIR": str(tmp_path), "CORS_ORIGIN": "evil\nx"},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 1
    assert "CORS_ORIGIN" in result.stdout


def test_refuses_to_start_without_the_directory(tmp_path):
    result = subprocess.run(  # noqa: S603
        [sys.executable, str(SERVE)],
        env={**os.environ, "DATA_DIR": str(tmp_path / "missing")},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 1
    assert "does not exist" in result.stdout
