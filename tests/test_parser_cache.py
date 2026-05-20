"""Tests for parser_cache module."""

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

from kml_heatmap.parser_cache import (
    get_cache_key,
    load_cached_parse,
    save_to_cache,
)


class TestGetCacheKeyWithDefaultDir:
    def test_uses_default_cache_dir_when_none(self):
        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"<kml/>")
            temp_path = f.name

        try:
            cache_path, is_valid = get_cache_key(temp_path)
            assert cache_path is not None
            assert not is_valid
        finally:
            os.unlink(temp_path)

    def test_cleans_old_cache_files(self):
        with tempfile.TemporaryDirectory() as cache_dir:
            cache_dir = Path(cache_dir)
            with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
                f.write(b"<kml/>")
                temp_path = f.name

            try:
                stem = Path(temp_path).stem
                old_cache = cache_dir / f"{stem}_9999999.json"
                old_cache.write_text("{}")

                cache_path, _ = get_cache_key(temp_path, cache_dir=cache_dir)
                assert not old_cache.exists()
            finally:
                os.unlink(temp_path)

    def test_old_cache_cleanup_handles_oserror(self):
        with tempfile.TemporaryDirectory() as cache_dir:
            cache_dir = Path(cache_dir)
            with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
                f.write(b"<kml/>")
                temp_path = f.name

            try:
                stem = Path(temp_path).stem
                old_cache = cache_dir / f"{stem}_9999999.json"
                old_cache.write_text("{}")

                with patch.object(Path, "unlink", side_effect=OSError("mock")):
                    cache_path, _ = get_cache_key(temp_path, cache_dir=cache_dir)
                    assert cache_path is not None
            finally:
                os.unlink(temp_path)


class TestSaveToCache:
    def test_uses_default_cache_dir_when_none(self):
        with tempfile.TemporaryDirectory() as cache_dir:
            cache_dir = Path(cache_dir)
            cache_path = cache_dir / "test_cache.json"

            coords = [[50.0, 8.5]]
            paths = [[[50.0, 8.5, 300.0]]]
            metadata = [{"filename": "test.kml"}]

            save_to_cache(cache_path, coords, paths, metadata, cache_dir=cache_dir)

            loaded = load_cached_parse(cache_path)
            assert loaded is not None
            assert loaded[0] == coords
