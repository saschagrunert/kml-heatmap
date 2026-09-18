"""The files the site is made of: the page, its assets and the bundle.

Everything the tool puts next to the data, and nothing about the flights
themselves. ``renderer`` orchestrates the pipeline and calls
``package_assets`` at the end of it; splitting the two apart keeps the
template, the stylesheet, the favicons and the vendored third-party files in
one place, the way ``export_writers`` holds the data files.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import shutil
import string
from pathlib import Path
from typing import TYPE_CHECKING

import minify_html as mh
import rcssmin
import rjsmin

from .cache import atomic_text_write
from .exceptions import KMLHeatmapError
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Iterable

__all__ = [
    "BUNDLE_FILE",
    "BUNDLE_FILES",
    "FEATURES_BUNDLE_FILE",
    "FLAGS_DIR_NAME",
    "SITE_FILES",
    "STATIC_DIR",
    "available_country_flags",
    "bundle_is_available",
    "load_template",
    "minify_html",
    "package_assets",
    "render_html",
    "warn_about_a_stale_bundle",
]

#: Where the flags live, in the checkout and in a published site alike
FLAGS_DIR_NAME = "flags"


STATIC_DIR = Path(__file__).parent / "static"
TEMPLATES_DIR = Path(__file__).parent / "templates"
# Built by `npm run build` and not committed
BUNDLE_FILE = STATIC_DIR / "mapApp.bundle.js"
# Replay and Wrapped, fetched by the page the first time one of them is
# opened (frontend/services/featureLoader.ts). Built by the same `npm run
# build`, so a site without it is a site built wrong rather than a choice.
FEATURES_BUNDLE_FILE = STATIC_DIR / "features.bundle.js"
BUNDLE_FILES = (BUNDLE_FILE, FEATURES_BUNDLE_FILE)
# The sources of the bundle; only present in a checkout, not in the image
FRONTEND_DIR = Path(__file__).parent / "frontend"
# First line of the bundle; the group is the source hash (scripts/source-hash.js)
BUNDLE_BANNER = re.compile(rb"/\* kml-heatmap build ([0-9a-f]{12}) \*/")
# Files outside the sources that change the bundle, hashed after them and in
# this order. Keep in step with BUILD_FILES in scripts/source-hash.js.
BUILD_HASH_FILES = ("build.js", "tsconfig.json")
FAVICON_FILES = (
    "favicon.svg",
    "favicon.ico",
    "favicon-192.png",
    "favicon-512.png",
    "apple-touch-icon.png",
    "manifest.json",
)
# Third-party files the page loads from the site itself, copied out of
# node_modules by scripts/vendor.js and published next to the page. Keep in
# step with VENDOR_FILES there; tests/frontend/unit/vendor.test.ts checks
# that list against node_modules and tests/test_site_assets.py that a
# missing file is caught before a run does any work.
VENDOR_FILES = (
    "leaflet.js",
    "leaflet.css",
    "leaflet-heat.js",
    "dom-to-image.min.js",
    "images/layers.png",
    "images/layers-2x.png",
    "images/marker-icon.png",
    "images/marker-icon-2x.png",
    "images/marker-shadow.png",
)
# The files the tool owns next to the page. Any of them that a run does not
# produce (the source map of a bundle built without one) is removed.
SITE_FILES = (
    "map_config.js",
    "styles.css",
    *(bundle.name for bundle in BUNDLE_FILES),
    *(f"{bundle.name}.map" for bundle in BUNDLE_FILES),
    *FAVICON_FILES,
    *(f"vendor/{name}" for name in VENDOR_FILES),
)


def _escape_js_string(value: str) -> str:
    """Escape a value for safe embedding in a single-quoted JS string."""
    escaped: str = json.dumps(value)
    return escaped[1:-1].replace("'", "\\'")


def load_template() -> str:
    """Load the HTML template from file."""
    template_path = TEMPLATES_DIR / "map_template.html"
    with open(template_path, encoding="utf-8") as f:
        return f.read()


def minify_html(html_content: str) -> str:
    """Minify the HTML page.

    Only the markup: the template has no inline styles or scripts (its CSP
    blocks inline scripts), the stylesheet and the config are minified as
    separate files.
    """
    minified: str = mh.minify(html_content)
    return minified


def _pinned_esbuild_version(package_lock: Path) -> str:
    """The esbuild version package-lock.json pins, as source-hash.js reads it."""
    with package_lock.open(encoding="utf-8") as lock_file:
        lock = json.load(lock_file)
    return str(lock["packages"]["node_modules/esbuild"]["version"])


def _frontend_source_hash() -> str | None:
    """The hash build.js stamps into the bundle, None without the sources.

    Mirrors scripts/source-hash.js: every .ts file under the frontend
    directory in path order and then each file in BUILD_HASH_FILES, both as
    the path relative to the repository and the content, and finally the
    pinned esbuild version. The build script, the compiler options and the
    bundler shape the bundle as much as the sources do, so a change to any of
    them has to invalidate the hash as well.

    The two implementations have to agree or the staleness check below is
    meaningless; TestSourceHashParity in tests/test_site_assets.py runs
    the JavaScript one and compares.
    """
    if not FRONTEND_DIR.is_dir():
        return None
    root = FRONTEND_DIR.parent.parent
    digest = hashlib.sha1(usedforsecurity=False)
    try:
        esbuild_version = _pinned_esbuild_version(root / "package-lock.json")
        sources = sorted(FRONTEND_DIR.rglob("*.ts"), key=str)
        for path in [*sources, *(root / name for name in BUILD_HASH_FILES)]:
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    except OSError, KeyError, TypeError, ValueError:
        # Not a checkout the bundle could be rebuilt from, so there is
        # nothing to compare the bundle against
        return None
    digest.update(f"esbuild {esbuild_version}".encode())
    digest.update(b"\0")
    return digest.hexdigest()[:12]


def _missing_vendor_files(static_dir: Path) -> list[str]:
    """The vendored third-party files that are not in ``static_dir``."""
    vendor = static_dir / "vendor"
    return [name for name in VENDOR_FILES if not (vendor / name).is_file()]


def bundle_is_available() -> bool:
    """Whether everything `npm run build` produces is in place.

    Both bundles and the vendored third-party files: a site missing any of
    them has no map at all. Checked together and before the run does any
    work, so a forgotten build costs a message rather than a full export.

    Asked through this module rather than by reading BUNDLE_FILE elsewhere:
    a `from .site_assets import BUNDLE_FILE` binds the path at import time,
    so a caller that holds its own reference would not see a redirected one.
    """
    missing = [str(bundle) for bundle in BUNDLE_FILES if not bundle.is_file()]
    missing += [f"vendor/{name}" for name in _missing_vendor_files(STATIC_DIR)]
    if not missing:
        return True
    logger.error(
        "JavaScript bundle not found: %s (run 'npm run build' to generate it)",
        ", ".join(missing),
    )
    return False


def warn_about_a_stale_bundle() -> None:
    """Warn when the bundle was built from other sources than the checkout's.

    An old bundle left over from before a pull reads a data format the new
    generator no longer writes; the page then breaks in ways that are hard to
    trace back to a missing ``npm run build``.
    """
    try:
        current = _frontend_source_hash()
        with BUNDLE_FILE.open("rb") as bundle:
            match = BUNDLE_BANNER.match(bundle.readline())
    except OSError:
        return
    if current is not None and (match is None or match.group(1).decode() != current):
        logger.warning(
            "The JavaScript bundle was built from other frontend sources; "
            "run 'npm run build' to rebuild it"
        )


def render_html(output_file: Path, data_dir_name: str) -> None:
    """Render and minify the HTML template."""
    logger.info("\nGenerating progressive HTML...")

    tmpl = string.Template(load_template())
    html_content = tmpl.substitute(data_dir_name=html.escape(data_dir_name))

    logger.info("\nMinifying HTML...")
    minified_html = minify_html(html_content)

    atomic_text_write(output_file, minified_html)

    file_size = output_file.stat().st_size
    original_size = len(html_content)
    minified_size = len(minified_html)
    reduction = (1 - minified_size / original_size) * 100

    logger.info(
        "Progressive HTML saved: %s (%.1f KB)", output_file.name, file_size / 1024
    )
    logger.info(
        "  Minification: %.1f KB -> %.1f KB (%.1f%% reduction)",
        original_size / 1024,
        minified_size / 1024,
        reduction,
    )


def _generate_map_config(
    output_dir: Path,
    bounds: dict[str, float],
    data_dir_name: str,
) -> None:
    """Generate minified map_config.js from template."""
    carto_api_key = os.environ.get("CARTO_API_KEY", "")
    openaip_api_key = os.environ.get("OPENAIP_API_KEY", "")

    map_config_template_path = TEMPLATES_DIR / "map_config_template.js"
    map_config_dst = output_dir / "map_config.js"

    with open(map_config_template_path, encoding="utf-8") as f:
        map_config_raw = f.read()

    config_vars = {
        "carto_api_key": _escape_js_string(carto_api_key),
        "openaip_api_key": _escape_js_string(openaip_api_key),
        "data_dir_name": _escape_js_string(data_dir_name),
        "center_lat": str(bounds["center_lat"]),
        "center_lon": str(bounds["center_lon"]),
        "min_lat": str(bounds["min_lat"]),
        "max_lat": str(bounds["max_lat"]),
        "min_lon": str(bounds["min_lon"]),
        "max_lon": str(bounds["max_lon"]),
    }
    map_config_content = string.Template(map_config_raw).substitute(config_vars)
    map_config_minified: str = rjsmin.jsmin(map_config_content)

    atomic_text_write(map_config_dst, map_config_minified)

    map_config_size = map_config_dst.stat().st_size
    logger.info(
        "Configuration generated: %s (%.1f KB)",
        map_config_dst.name,
        map_config_size / 1024,
    )


def _copy_javascript_bundle(output_dir: Path, bundle: Path) -> None:
    """Copy one bundle (and its source map, if any) to the output."""
    dst = output_dir / bundle.name
    shutil.copy2(bundle, dst)
    logger.info("JavaScript copied: %s (%.1f KB)", dst.name, dst.stat().st_size / 1024)
    source_map = bundle.with_name(f"{bundle.name}.map")
    if source_map.exists():
        shutil.copy2(source_map, output_dir / source_map.name)


def _copy_and_minify_css(output_dir: Path, static_dir: Path) -> None:
    """Copy and minify CSS to output directory."""
    styles_css_src = static_dir / "styles.css"
    styles_css_dst = output_dir / "styles.css"

    with open(styles_css_src, encoding="utf-8") as f:
        styles_css_content = f.read()

    styles_css_minified: str = rcssmin.cssmin(styles_css_content)

    atomic_text_write(styles_css_dst, styles_css_minified)

    styles_css_size = styles_css_dst.stat().st_size
    logger.info("CSS copied: %s (%.1f KB)", styles_css_dst.name, styles_css_size / 1024)


def _copy_vendor_files(output_dir: Path, static_dir: Path) -> None:
    """Copy the vendored third-party files to the output.

    They are a build output like the bundle: `npm run build` fills
    static/vendor/ from node_modules. A site generated without them has no
    map at all, so a missing directory is an error rather than a warning.
    """
    vendor_src = static_dir / "vendor"
    missing = _missing_vendor_files(static_dir)
    if missing:
        raise KMLHeatmapError(
            f"The vendored third-party files are missing ({', '.join(missing)}); "
            "run 'npm run build' to copy them out of node_modules"
        )

    total = 0
    for name in VENDOR_FILES:
        dst = output_dir / "vendor" / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(vendor_src / name, dst)
        total += dst.stat().st_size
    logger.info(
        "Vendored files copied: %d files (%.1f KB)", len(VENDOR_FILES), total / 1024
    )


def _copy_favicon_files(output_dir: Path, static_dir: Path) -> None:
    """Copy favicon and manifest files to output directory."""
    for favicon_file in FAVICON_FILES:
        src = static_dir / favicon_file
        if src.exists():
            shutil.copy2(src, output_dir / favicon_file)

    logger.info("Favicon files copied")


def available_country_flags(codes: Iterable[str]) -> list[str]:
    """The given country codes that this checkout can publish a flag for.

    `npm run build` fills ``static/flags/`` from node_modules, and the wheel
    leaves it out: two megabytes of flags for the handful of countries any
    one export visits would be a poor trade. A site built without them shows
    the country code instead, so this returns what is actually there rather
    than what was asked for.
    """
    flag_dir = STATIC_DIR / FLAGS_DIR_NAME
    return sorted(
        {code.lower() for code in codes if (flag_dir / f"{code.lower()}.svg").is_file()}
    )


def _copy_country_flags(output_dir: Path, codes: Iterable[str]) -> None:
    """Publish the flag of every country the export visited, and no other."""
    published = available_country_flags(codes)
    if not published:
        return

    destination = output_dir / FLAGS_DIR_NAME
    destination.mkdir(parents=True, exist_ok=True)
    total = 0
    for code in published:
        target = destination / f"{code}.svg"
        shutil.copy2(STATIC_DIR / FLAGS_DIR_NAME / f"{code}.svg", target)
        total += target.stat().st_size
    logger.info("Country flags copied: %d (%.1f KB)", len(published), total / 1024)


def package_assets(
    output_dir: Path,
    bounds: dict[str, float],
    data_dir_name: str,
    country_codes: Iterable[str] = (),
) -> None:
    """Generate config and copy static assets (pre-built JS bundles, CSS, icons)."""
    _generate_map_config(output_dir, bounds, data_dir_name)
    for bundle in BUNDLE_FILES:
        _copy_javascript_bundle(output_dir, bundle)
    _copy_and_minify_css(output_dir, STATIC_DIR)
    _copy_vendor_files(output_dir, STATIC_DIR)
    _copy_favicon_files(output_dir, STATIC_DIR)
    _copy_country_flags(output_dir, country_codes)
