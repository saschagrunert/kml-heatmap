"""Smoke test for serve.py, the server `make serve` runs in the image.

It starts the script as the image does, on a free port against a temporary
directory, and fetches a file, a missing file and a directory from it.
"""

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
