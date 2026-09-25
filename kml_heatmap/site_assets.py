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
import subprocess  # nosec B404
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import quote

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
    "SHARED_BUNDLE_FILE",
    "SITE_FILES",
    "SITE_FILE_PATTERNS",
    "STATIC_DIR",
    "WRAPPED_BUNDLE_FILE",
    "YEAR_WORKER_BUNDLE_FILE",
    "BuildCommit",
    "available_country_flags",
    "build_commit",
    "build_timestamp",
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
# Replay, imported by the page the first time it is opened, and Wrapped,
# likewise (frontend/services/featureLoader.ts). Built by the same `npm run
# build`, so a site without them is a site built wrong rather than a choice.
FEATURES_BUNDLE_FILE = STATIC_DIR / "features.bundle.js"
WRAPPED_BUNDLE_FILE = STATIC_DIR / "wrapped.bundle.js"
# The app and every module the two above use of it, which all three import
SHARED_BUNDLE_FILE = STATIC_DIR / "shared.bundle.js"
# The year worker, which parses and decodes the year files off the main
# thread; the page imports the same file for what it does to year data itself
# (frontend/services/yearWorker.ts). A build of its own in build.js.
YEAR_WORKER_BUNDLE_FILE = STATIC_DIR / "yearWorker.bundle.js"
BUNDLE_FILES = (
    BUNDLE_FILE,
    FEATURES_BUNDLE_FILE,
    WRAPPED_BUNDLE_FILE,
    SHARED_BUNDLE_FILE,
    YEAR_WORKER_BUNDLE_FILE,
)
# The sources of the bundle; only present in a checkout, not in the image
FRONTEND_DIR = Path(__file__).parent / "frontend"
# First line of the bundle; the group is the source hash (scripts/source-hash.js)
BUNDLE_BANNER = re.compile(rb"/\* kml-heatmap build ([0-9a-f]{12}) \*/")
# Files outside the sources that change what a built site renders, hashed
# after them and in this order. Keep in step with BUILD_FILES in
# scripts/source-hash.js; TestSourceHashParity checks that they agree.
BUILD_HASH_FILES = (
    "build.js",
    "scripts/vendor.js",
    "tsconfig.json",
    "kml_heatmap/static/styles.css",
    "kml_heatmap/static/features.css",
    "kml_heatmap/static/wrapped.css",
)
# Packages whose pinned version changes a built site (the bundler, what it
# bundles and what is vendored as it is), hashed after the files and in this
# order. Keep in step with BUILD_PACKAGES in the same script.
BUILD_HASH_PACKAGES = (
    "esbuild",
    "lucide",
    "maplibre-gl",
    "html-to-image",
    "flag-icons",
)
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
    "maplibre-gl.mjs",
    "maplibre-gl-shared.mjs",
    "maplibre-gl-worker.mjs",
    "maplibre-gl.css",
    # Bundled there from the package's module (VENDOR_MODULES), and imported
    # by the page on the first export
    "html-to-image.mjs",
)
# The stylesheets, in the order the page applies them: styles.css is linked in
# the head, features.css is fetched with the feature bundle the first time
# replay is opened and wrapped.css with the Wrapped bundle the first time
# Wrapped is (see services/featureLoader.ts). The order matters to the
# cascade, so it is the order they are written in; the last two style
# different elements, so which of them lands first does not.
CSS_FILES = ("styles.css", "features.css", "wrapped.css")
# The files the tool owns next to the page. Any of them that a run does not
# produce (the source map of a bundle built without one) is removed.
SITE_FILES = (
    "map_config.js",
    *CSS_FILES,
    *(bundle.name for bundle in BUNDLE_FILES),
    *(f"{bundle.name}.map" for bundle in BUNDLE_FILES),
    *FAVICON_FILES,
    *(f"vendor/{name}" for name in VENDOR_FILES),
)
# Owned files whose names depend on the flights: the flag of every country
# the export visited. The ones a run does not publish are removed.
SITE_FILE_PATTERNS = (f"{FLAGS_DIR_NAME}/*.svg",)


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


def _pinned_build_versions(package_lock: Path) -> list[str]:
    """The versions package-lock.json pins for BUILD_HASH_PACKAGES, as
    source-hash.js reads and writes them ("esbuild 0.28.2")."""
    with package_lock.open(encoding="utf-8") as lock_file:
        lock = json.load(lock_file)
    return [
        f"{name} {lock['packages'][f'node_modules/{name}']['version']}"
        for name in BUILD_HASH_PACKAGES
    ]


def _frontend_source_hash() -> str | None:
    """The hash build.js stamps into the bundle, None without the sources.

    Mirrors scripts/source-hash.js: every .ts file under the frontend
    directory in path order and then each file in BUILD_HASH_FILES, both as
    the path relative to the repository and the content, and finally the
    pinned version of each package in BUILD_HASH_PACKAGES. The build script,
    the vendoring script, the compiler options, the bundler, what it bundles
    from node_modules and what is vendored as it is (the map library, the
    export library, the country flags) shape a built site as much as the
    sources do, so a change to any of them has to invalidate the hash as
    well, and so do the stylesheets: they are not in a bundle, but they are
    part of what a built site renders.

    The two implementations have to agree or the staleness check below is
    meaningless; TestSourceHashParity in tests/test_site_assets.py runs
    the JavaScript one and compares.
    """
    if not FRONTEND_DIR.is_dir():
        return None
    root = FRONTEND_DIR.parent.parent
    digest = hashlib.sha1(usedforsecurity=False)
    try:
        package_versions = _pinned_build_versions(root / "package-lock.json")
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
    for version in package_versions:
        digest.update(version.encode())
        digest.update(b"\0")
    return digest.hexdigest()[:12]


def _missing_vendor_files(static_dir: Path) -> list[str]:
    """The vendored third-party files that are not in ``static_dir``."""
    vendor = static_dir / "vendor"
    return [name for name in VENDOR_FILES if not (vendor / name).is_file()]


def bundle_is_available() -> bool:
    """Whether everything `npm run build` produces is in place.

    The bundles and the vendored third-party files: a site missing any of
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


#: The base style the app fetches (CARTO_STYLE_URL in mapApp.ts), and the
#: index of the vector tiles it names, which MapLibre asks for next
CARTO_STYLE_URL = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
CARTO_TILEJSON_URL = (
    "https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json"
)


def _carto_api_key() -> str:
    """The CARTO API key the site is built with, "" for none."""
    return os.environ.get("CARTO_API_KEY", "")


def _carto_preloads(api_key: str) -> str:
    """Preloads of CARTO's style and tile index, as the page asks for them.

    Without them each is a round trip that only starts once the one before
    has answered: the page's scripts, the map's start, the style and then
    the index. A preload is only used for the very same URL, so the key goes
    on as the page puts it on (encodeURIComponent, see cartoStyleUrl and
    cartoTransformRequest in mapApp.ts), and none goes on without one.
    """
    # encodeURIComponent leaves these as they are, and quote() does not
    query = "?key=" + quote(api_key, safe="!*'()") if api_key else ""
    return "".join(
        '<link rel="preload" as="fetch" crossorigin '
        f'href="{html.escape(url + query)}" />'
        for url in (CARTO_STYLE_URL, CARTO_TILEJSON_URL)
    )


def render_html(
    output_file: Path, data_dir_name: str, latest_year: int | None = None
) -> None:
    """Render and minify the HTML template.

    ``latest_year`` is the year the page opens on, whose data file is
    preloaded; None preloads nothing. CARTO's style and tile index are
    preloaded after the site's own files.
    """
    logger.info("\nGenerating progressive HTML...")

    data_dir = html.escape(data_dir_name)
    year_preload = (
        f'<link rel="preload" as="fetch" crossorigin '
        f'href="{data_dir}/{latest_year}/data.json" />'
        if latest_year is not None
        else ""
    )
    tmpl = string.Template(load_template())
    html_content = tmpl.substitute(
        data_dir_name=data_dir,
        year_preload=year_preload,
        base_style_preload=_carto_preloads(_carto_api_key()),
    )

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


def build_timestamp() -> str:
    """When the site was built, in UTC to the minute.

    Honours SOURCE_DATE_EPOCH so that a build can be reproduced exactly.
    """
    epoch = os.environ.get("SOURCE_DATE_EPOCH", "").strip()
    try:
        built_at = datetime.fromtimestamp(int(epoch), UTC) if epoch else None
    except ValueError, OverflowError, OSError:
        logger.warning("Ignoring SOURCE_DATE_EPOCH=%r: not a Unix timestamp", epoch)
        built_at = None
    if built_at is None:
        built_at = datetime.now(UTC)
    return built_at.strftime("%Y-%m-%dT%H:%MZ")


# A commit hash as git prints it, and the parts of a repository address
_COMMIT_HASH = re.compile(r"[0-9a-f]{7,40}")
_GITHUB_REMOTE = re.compile(
    r"(?:https://|ssh://git@|git@)github\.com[:/]"
    r"(?P<repository>[\w.-]+/[\w.-]+?)(?:\.git)?/?"
)
_SERVER_URL = re.compile(r"https://[\w.-]+(?::\d+)?")
_REPOSITORY_NAME = re.compile(r"[\w.-]+/[\w.-]+")


@dataclass(frozen=True)
class BuildCommit:
    """The commit a site was built from and where it can be looked at."""

    #: Short hash, "" when unknown
    hash: str = ""
    #: The commit's page, "" when it is not known which repository it is in
    url: str = ""


def _build_commit(commit: str, repository_url: str) -> BuildCommit:
    commit = commit.strip().lower()
    if not _COMMIT_HASH.fullmatch(commit):
        return BuildCommit()
    url = f"{repository_url}/commit/{commit}" if repository_url else ""
    return BuildCommit(commit[:7], url)


def _github_repository_url(remote: str) -> str:
    """The web address of a GitHub remote, "" for any other remote."""
    match = _GITHUB_REMOTE.fullmatch(remote.strip())
    if match is None:
        return ""
    return f"https://github.com/{match['repository']}"


def _git(git: str, *args: str) -> str:
    """Run git in the package directory and return what it printed."""
    return subprocess.run(  # noqa: S603 # nosec B603
        [git, *args],
        cwd=Path(__file__).parent,
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
    ).stdout.strip()


def _commit_from_git() -> BuildCommit:
    """HEAD of the checkout the package runs from, if it runs from one.

    Only a repository whose top level holds this package counts: an
    installed package can sit in a virtual environment inside some other
    checkout, whose HEAD says nothing about this build.
    """
    git = shutil.which("git")
    if git is None:
        return BuildCommit()
    try:
        toplevel = _git(git, "rev-parse", "--show-toplevel")
        if Path(toplevel).resolve() != Path(__file__).parent.parent.resolve():
            return BuildCommit()
        commit = _git(git, "rev-parse", "HEAD")
    except OSError, subprocess.SubprocessError:
        return BuildCommit()
    try:
        remote = _git(git, "remote", "get-url", "origin")
    except OSError, subprocess.SubprocessError:
        remote = ""
    return _build_commit(commit, _github_repository_url(remote))


def build_commit() -> BuildCommit:
    """The commit the site was built from.

    KML_HEATMAP_COMMIT wins, with KML_HEATMAP_REPOSITORY as the remote it is
    in (the container has no .git, so `make build` passes both). Then
    GITHUB_SHA on Actions, in the repository the workflow runs in, which is
    not necessarily this project's. Then git, if the package runs from a
    checkout. The hash is only linked when the repository is known.
    """
    explicit = os.environ.get("KML_HEATMAP_COMMIT", "")
    if explicit:
        remote = os.environ.get("KML_HEATMAP_REPOSITORY", "")
        return _build_commit(explicit, _github_repository_url(remote))
    sha = os.environ.get("GITHUB_SHA", "")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    if sha and repository:
        server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
        known = _SERVER_URL.fullmatch(server) and _REPOSITORY_NAME.fullmatch(repository)
        return _build_commit(sha, f"{server}/{repository}" if known else "")
    return _commit_from_git()


def _generate_map_config(
    output_dir: Path,
    bounds: dict[str, float],
    data_dir_name: str,
) -> None:
    """Generate minified map_config.js from template."""
    carto_api_key = _carto_api_key()

    map_config_template_path = TEMPLATES_DIR / "map_config_template.js"
    map_config_dst = output_dir / "map_config.js"

    with open(map_config_template_path, encoding="utf-8") as f:
        map_config_raw = f.read()

    commit = build_commit()
    config_vars = {
        "carto_api_key": _escape_js_string(carto_api_key),
        "data_dir_name": _escape_js_string(data_dir_name),
        "built_at": build_timestamp(),
        "commit": commit.hash,
        "commit_url": _escape_js_string(commit.url),
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
    """Copy and minify every stylesheet to the output directory."""
    for name in CSS_FILES:
        with open(static_dir / name, encoding="utf-8") as f:
            content = f.read()

        destination = output_dir / name
        minified: str = rcssmin.cssmin(content)
        atomic_text_write(destination, minified)

        logger.info("CSS copied: %s (%.1f KB)", name, destination.stat().st_size / 1024)


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
