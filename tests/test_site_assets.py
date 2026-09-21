"""Tests for the site_assets module: the page, its assets and the bundle."""

import json
import os
import re
import shutil
import string
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

import kml_heatmap.site_assets as assets_module
from kml_heatmap.site_assets import (
    BuildCommit,
    _copy_javascript_bundle,
    _escape_js_string,
    build_commit,
    build_timestamp,
    load_template,
    minify_html,
    package_assets,
    render_html,
)


def _install_vendor_files(tmp_path, monkeypatch):
    """A static directory holding every vendored file, as the build leaves it."""
    static = tmp_path / "static-with-vendor"
    for name in assets_module.VENDOR_FILES:
        path = static / "vendor" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name)
    monkeypatch.setattr("kml_heatmap.site_assets.STATIC_DIR", static)
    return static


BOUNDS = {
    "center_lat": 50.0,
    "center_lon": 8.0,
    "min_lat": 49.0,
    "max_lat": 51.0,
    "min_lon": 7.0,
    "max_lon": 9.0,
}


@pytest.fixture
def bundle(tmp_path_factory, monkeypatch):
    """Stand-ins for the two built JavaScript bundles.

    Returns the main one; the feature bundle sits next to it, the way
    `npm run build` leaves them.
    """
    static = tmp_path_factory.mktemp("static")
    bundle = static / "mapApp.bundle.js"
    bundle.write_text("// bundle\n")
    features = static / "features.bundle.js"
    features.write_text("// features\n")
    monkeypatch.setattr("kml_heatmap.site_assets.BUNDLE_FILE", bundle)
    monkeypatch.setattr("kml_heatmap.site_assets.FEATURES_BUNDLE_FILE", features)
    monkeypatch.setattr("kml_heatmap.site_assets.BUNDLE_FILES", (bundle, features))
    return bundle


class TestEscapeJsString:
    def test_plain_string_unchanged(self):
        assert _escape_js_string("hello") == "hello"

    def test_escapes_quotes_backslash_and_control_chars(self):
        assert _escape_js_string('say "hi"') == 'say \\"hi\\"'
        assert _escape_js_string("it's") == "it\\'s"
        assert _escape_js_string("path\\to") == "path\\\\to"
        assert _escape_js_string("line1\nline2") == "line1\\nline2"
        assert _escape_js_string("col1\tcol2") == "col1\\tcol2"

    def test_xss_payload_neutralized(self):
        result = _escape_js_string("'; alert('xss'); //")
        assert "\\'" in result
        assert "'" not in result.replace("\\'", "")

    def test_empty_and_unicode(self):
        assert _escape_js_string("") == ""
        assert "M\\u00fcnchen" in _escape_js_string("Flughafen München")


class TestLoadTemplate:
    def test_template_content(self):
        template = load_template()
        assert "<html" in template.lower()
        assert "</html>" in template.lower()
        assert "$data_dir_name" in template

    def test_template_has_no_inline_styles_or_scripts(self):
        """minify_html only minifies the markup."""
        template = load_template()
        assert "<style" not in template
        assert all(
            'src="' in tag for tag in re.findall(r"<script[^>]*>", template, re.DOTALL)
        )


class TestMinifyHtml:
    def test_minifies_markup(self):
        html = """<html>
          <body>
            <div id="test">   Content   </div>
          </body>
        </html>"""
        minified = minify_html(html)
        assert "Content" in minified
        assert len(minified) < len(html)

    def test_keeps_script_sources(self):
        minified = minify_html(
            '<script src="a.js" defer></script>\n<script src="b.js" defer></script>'
        )
        assert minified.count("<script") == 2
        assert "a.js" in minified
        assert "b.js" in minified


class TestRenderHtml:
    def test_renders_minified_html_with_data_dir(self, tmp_path):
        output_file = tmp_path / "index.html"
        render_html(output_file, "my_data_dir")
        content = output_file.read_text()
        assert "<!doctype html>" in content.lower()
        assert "my_data_dir" in content
        assert "$data_dir_name" not in content
        substituted = string.Template(load_template()).substitute(
            data_dir_name="my_data_dir", year_preload=""
        )
        assert len(content) < len(substituted)

    def test_data_dir_name_is_html_escaped(self, tmp_path):
        """A quote in the name must not end the href attribute early."""
        from lxml import html as lxml_html

        output_file = tmp_path / "index.html"
        render_html(output_file, 'da"ta<x>')
        content = output_file.read_text()
        assert 'href="da"' not in content
        preloads = [
            link.get("href")
            for link in lxml_html.fromstring(content).iter("link")
            if link.get("rel") == "preload"
        ]
        assert preloads == ['da"ta<x>/metadata.json', 'da"ta<x>/airports.json']

    def test_preloads_the_latest_year(self, tmp_path):
        """The first year the page shows starts downloading with the page."""
        from lxml import html as lxml_html

        output_file = tmp_path / "index.html"
        render_html(output_file, 'da"ta', 2026)
        preloads = [
            (link.get("as"), link.get("crossorigin"), link.get("href"))
            for link in lxml_html.fromstring(output_file.read_text()).iter("link")
            if link.get("rel") == "preload"
        ]
        # The same URL and the same mode the loader's fetch requests, so the
        # preload is what it gets
        assert preloads[-1] == ("fetch", "", 'da"ta/2026/data.json')
        assert {preload[:2] for preload in preloads} == {("fetch", "")}

    def test_preloads_no_year_without_one(self, tmp_path):
        output_file = tmp_path / "index.html"
        render_html(output_file, "data")
        content = output_file.read_text()
        assert "/data.json" not in content
        assert "$year_preload" not in content

    def test_loads_the_bundle_as_a_module(self, tmp_path):
        """The bundles are ES modules, and the shared chunk is on its way
        before the app bundle asks for it."""
        from lxml import html as lxml_html

        output_file = tmp_path / "index.html"
        render_html(output_file, "data")
        page = lxml_html.fromstring(output_file.read_text())
        modules = [
            s.get("src") for s in page.iter("script") if s.get("type") == "module"
        ]
        assert modules == ["./mapApp.bundle.js"]
        assert [
            link.get("href")
            for link in page.iter("link")
            if link.get("rel") == "modulepreload"
        ] == [
            "./shared.bundle.js",
            "./vendor/maplibre-gl.mjs",
            "./vendor/maplibre-gl-shared.mjs",
        ]

    def test_output_is_world_readable(self, tmp_path):
        previous = os.umask(0o022)
        try:
            output_file = tmp_path / "index.html"
            render_html(output_file, "data")
            assert oct(output_file.stat().st_mode & 0o777) == "0o644"
        finally:
            os.umask(previous)


class TestPackageAssets:
    def test_generates_config_css_and_favicons(self, tmp_path, bundle):
        with patch.dict(os.environ, {"CARTO_API_KEY": "test-carto's"}):
            package_assets(tmp_path, BOUNDS, "data")

        config = (tmp_path / "map_config.js").read_text()
        assert "51.0" in config
        assert "test-carto\\'s" in config
        assert "$center_lat" not in config
        assert re.search(r"builtAt:'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z'", config)
        assert re.search(r"commit:'([0-9a-f]{7})?'", config)
        assert re.search(r"commitUrl:'(https://[^']+)?'", config)
        assert (tmp_path / "styles.css").stat().st_size > 0
        assert (tmp_path / "mapApp.bundle.js").read_text() == bundle.read_text()
        assert not (tmp_path / "mapApp.bundle.js.map").exists()
        # Replay and Wrapped are fetched on demand, so the page needs them
        # next to it as well
        assert (tmp_path / "features.bundle.js").read_text() == "// features\n"
        for fname in ("favicon.svg", "manifest.json"):
            assert (tmp_path / fname).exists()
        # The library bundle was removed; it must not reappear in the output
        assert not (tmp_path / "bundle.js").exists()

    def test_bundle_and_source_map_are_copied(self, tmp_path):
        static_dir = tmp_path / "static"
        static_dir.mkdir()
        (static_dir / "mapApp.bundle.js").write_text("bundle")
        (static_dir / "mapApp.bundle.js.map").write_text("{}")
        out = tmp_path / "out"
        out.mkdir()
        _copy_javascript_bundle(out, static_dir / "mapApp.bundle.js")
        assert (out / "mapApp.bundle.js").read_text() == "bundle"
        assert (out / "mapApp.bundle.js.map").read_text() == "{}"


class TestBuildTimestamp:
    def test_is_the_current_time_in_utc(self, monkeypatch):
        monkeypatch.delenv("SOURCE_DATE_EPOCH", raising=False)
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z", build_timestamp())

    def test_honours_source_date_epoch(self, monkeypatch):
        monkeypatch.setenv("SOURCE_DATE_EPOCH", "1790000000")
        assert build_timestamp() == "2026-09-21T14:13Z"

    def test_ignores_a_source_date_epoch_that_is_not_one(self, monkeypatch):
        monkeypatch.setenv("SOURCE_DATE_EPOCH", "yesterday")
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z", build_timestamp())


COMMIT_ENV = (
    "KML_HEATMAP_COMMIT",
    "KML_HEATMAP_REPOSITORY",
    "GITHUB_SHA",
    "GITHUB_REPOSITORY",
    "GITHUB_SERVER_URL",
)
PACKAGE_ROOT = str(Path(assets_module.__file__).parent.parent)


@pytest.fixture
def no_commit_env(monkeypatch):
    for name in COMMIT_ENV:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def _fake_git(**outputs):
    """subprocess.run answering each git command from ``outputs``.

    Keys are the git arguments joined with underscores; a missing key or an
    exception value fails the command.
    """

    def run(args, **_kwargs):
        answer = outputs.get("_".join(args[1:]).replace("-", "_"))
        if answer is None:
            raise subprocess.CalledProcessError(128, args)
        if isinstance(answer, BaseException):
            raise answer
        return subprocess.CompletedProcess(args, 0, stdout=answer + "\n")

    return run


@pytest.fixture
def fake_git(no_commit_env):
    """Installs a git on PATH that answers from the given outputs."""

    def install(**outputs):
        no_commit_env.setattr(
            "kml_heatmap.site_assets.shutil.which", lambda _name: "/usr/bin/git"
        )
        no_commit_env.setattr(
            "kml_heatmap.site_assets.subprocess.run", _fake_git(**outputs)
        )

    return install


class TestBuildCommit:
    def test_prefers_the_explicit_commit(self, no_commit_env):
        no_commit_env.setenv("KML_HEATMAP_COMMIT", "5B3AB4048d1c")
        no_commit_env.setenv("KML_HEATMAP_REPOSITORY", "git@github.com:me/kmls.git")
        no_commit_env.setenv("GITHUB_SHA", "a" * 40)
        no_commit_env.setenv("GITHUB_REPOSITORY", "someone/else")
        assert build_commit() == BuildCommit(
            "5b3ab40", "https://github.com/me/kmls/commit/5b3ab4048d1c"
        )

    @pytest.mark.parametrize(
        "remote",
        [
            "git@github.com:me/kmls.git",
            "git@github.com:me/kmls",
            "https://github.com/me/kmls.git",
            "https://github.com/me/kmls/",
            "ssh://git@github.com/me/kmls.git",
        ],
    )
    def test_links_github_remotes(self, no_commit_env, remote):
        no_commit_env.setenv("KML_HEATMAP_COMMIT", "c" * 40)
        no_commit_env.setenv("KML_HEATMAP_REPOSITORY", remote)
        assert build_commit().url == f"https://github.com/me/kmls/commit/{'c' * 40}"

    @pytest.mark.parametrize(
        "remote",
        ["", "git@gitlab.com:me/kmls.git", "https://github.com.evil/me/kmls"],
    )
    def test_does_not_link_other_remotes(self, no_commit_env, remote):
        no_commit_env.setenv("KML_HEATMAP_COMMIT", "c" * 40)
        no_commit_env.setenv("KML_HEATMAP_REPOSITORY", remote)
        assert build_commit() == BuildCommit("ccccccc", "")

    def test_links_github_sha_to_the_repository_the_workflow_runs_in(
        self, no_commit_env
    ):
        no_commit_env.setenv("GITHUB_SHA", "b" * 40)
        no_commit_env.setenv("GITHUB_REPOSITORY", "someone/their-flights")
        no_commit_env.setenv("GITHUB_SERVER_URL", "https://github.com")
        assert build_commit() == BuildCommit(
            "bbbbbbb", f"https://github.com/someone/their-flights/commit/{'b' * 40}"
        )

    def test_does_not_link_an_unexpected_server(self, no_commit_env):
        no_commit_env.setenv("GITHUB_SHA", "b" * 40)
        no_commit_env.setenv("GITHUB_REPOSITORY", "me/kmls")
        no_commit_env.setenv("GITHUB_SERVER_URL", "javascript:alert(1)//")
        assert build_commit() == BuildCommit("bbbbbbb", "")

    def test_asks_git_in_the_checkout_of_the_package(self, fake_git):
        fake_git(
            rev_parse___show_toplevel=PACKAGE_ROOT,
            rev_parse_HEAD="c" * 40,
            remote_get_url_origin="https://github.com/me/kmls.git",
        )
        assert build_commit() == BuildCommit(
            "ccccccc", f"https://github.com/me/kmls/commit/{'c' * 40}"
        )

    def test_shows_the_hash_of_a_checkout_without_a_remote(self, fake_git):
        fake_git(rev_parse___show_toplevel=PACKAGE_ROOT, rev_parse_HEAD="c" * 40)
        assert build_commit() == BuildCommit("ccccccc", "")

    def test_ignores_a_repository_the_package_is_merely_inside(
        self, fake_git, tmp_path
    ):
        # A virtual environment inside someone else's checkout
        fake_git(rev_parse___show_toplevel=str(tmp_path), rev_parse_HEAD="c" * 40)
        assert build_commit() == BuildCommit()

    def test_is_empty_without_git(self, no_commit_env):
        no_commit_env.setattr("kml_heatmap.site_assets.shutil.which", lambda _: None)
        assert build_commit() == BuildCommit()

    @pytest.mark.parametrize(
        "error", [PermissionError(), subprocess.CalledProcessError(128, "git")]
    )
    def test_is_empty_outside_a_repository(self, fake_git, error):
        fake_git(rev_parse___show_toplevel=error)
        assert build_commit() == BuildCommit()

    @pytest.mark.parametrize("value", ["abc", "'; alert(1)//", "zzzzzzzz"])
    def test_rejects_anything_that_is_not_a_hash(self, no_commit_env, value):
        no_commit_env.setenv("KML_HEATMAP_COMMIT", value)
        no_commit_env.setenv("KML_HEATMAP_REPOSITORY", "git@github.com:me/kmls.git")
        assert build_commit() == BuildCommit()


class TestBundleIsAvailable:
    """A forgotten `npm run build` has to be caught before any work."""

    def test_true_when_both_bundles_and_the_vendored_files_are_there(
        self, tmp_path, monkeypatch, bundle
    ):
        _install_vendor_files(tmp_path, monkeypatch)

        assert assets_module.bundle_is_available() is True

    def test_a_missing_bundle_is_named(self, tmp_path, monkeypatch, bundle, capsys):
        _install_vendor_files(tmp_path, monkeypatch)
        bundle.unlink()

        assert assets_module.bundle_is_available() is False

        assert "mapApp.bundle.js" in capsys.readouterr().err

    def test_a_missing_vendored_file_is_named(
        self, tmp_path, monkeypatch, bundle, capsys
    ):
        """The page has no map without them, so they are part of the gate."""
        static = _install_vendor_files(tmp_path, monkeypatch)
        (static / "vendor" / "maplibre-gl-worker.mjs").unlink()

        assert assets_module.bundle_is_available() is False

        err = capsys.readouterr().err
        assert "vendor/maplibre-gl-worker.mjs" in err
        assert "npm run build" in err


class TestStaleBundleWarning:
    def _frontend(self, tmp_path, monkeypatch):
        """A checkout the hash can be computed from: sources and build files."""
        frontend = tmp_path / "kml_heatmap" / "frontend"
        (frontend / "ui").mkdir(parents=True)
        (frontend / "mapApp.ts").write_text("export {};")
        (frontend / "ui" / "a.ts").write_text("export const a = 1;")
        for name in assets_module.BUILD_HASH_FILES:
            # Some of them sit in subdirectories (the stylesheets)
            path = tmp_path / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}")
        (tmp_path / "package-lock.json").write_text(json.dumps(self._lock()))
        monkeypatch.setattr(assets_module, "FRONTEND_DIR", frontend)
        return frontend

    @staticmethod
    def _lock(**versions):
        """A package-lock.json that pins every package the hash reads"""
        pinned = dict.fromkeys(assets_module.BUILD_HASH_PACKAGES, "1.0.0")
        pinned.update(versions)
        return {
            "packages": {
                f"node_modules/{name}": {"version": version}
                for name, version in pinned.items()
            }
        }

    def test_warns_about_a_bundle_of_other_sources(
        self, tmp_path, monkeypatch, bundle, capsys
    ):
        self._frontend(tmp_path, monkeypatch)
        bundle.write_text("/* kml-heatmap build 000000000000 */\n")

        assets_module.warn_about_a_stale_bundle()

        assert "npm run build" in capsys.readouterr().err

    def test_quiet_for_a_current_bundle(self, tmp_path, monkeypatch, bundle, capsys):
        self._frontend(tmp_path, monkeypatch)
        current = assets_module._frontend_source_hash()
        bundle.write_text(f"/* kml-heatmap build {current} */\n")

        assets_module.warn_about_a_stale_bundle()

        assert capsys.readouterr().err == ""

    def test_quiet_without_the_sources(self, tmp_path, monkeypatch, bundle, capsys):
        monkeypatch.setattr(assets_module, "FRONTEND_DIR", tmp_path / "missing")
        bundle.write_text("no banner")

        assets_module.warn_about_a_stale_bundle()

        assert capsys.readouterr().err == ""

    def test_quiet_when_the_bundle_cannot_be_read(
        self, tmp_path, monkeypatch, bundle, capsys
    ):
        self._frontend(tmp_path, monkeypatch)
        bundle.unlink()

        assets_module.warn_about_a_stale_bundle()

        assert capsys.readouterr().err == ""

    @pytest.mark.parametrize("name", assets_module.BUILD_HASH_FILES)
    def test_the_build_files_are_part_of_the_hash(
        self, tmp_path, monkeypatch, bundle, name
    ):
        """Every file outside the sources that shapes a built site counts.

        The stylesheets are in there because the site renders them: without
        them a stylesheet-only change left a built `docs/` looking current,
        and the visual snapshots compared the old one.
        """
        self._frontend(tmp_path, monkeypatch)
        before = assets_module._frontend_source_hash()

        (tmp_path / name).write_text("/* something else */")

        assert assets_module._frontend_source_hash() != before

    @pytest.mark.parametrize("name", assets_module.BUILD_HASH_PACKAGES)
    def test_the_package_versions_are_part_of_the_hash(
        self, tmp_path, monkeypatch, bundle, name
    ):
        """The bundler and what it bundles from node_modules shape the bundle"""
        self._frontend(tmp_path, monkeypatch)
        before = assets_module._frontend_source_hash()

        (tmp_path / "package-lock.json").write_text(
            json.dumps(self._lock(**{name: "2.0.0"}))
        )

        assert assets_module._frontend_source_hash() != before

    @pytest.mark.parametrize(
        ("name", "content"),
        [
            ("package-lock.json", None),
            ("package-lock.json", "not json"),
            ("package-lock.json", "{}"),
            ("build.js", None),
        ],
        ids=["no-lock", "broken-lock", "lock-without-esbuild", "no-build-script"],
    )
    def test_quiet_without_a_complete_checkout(
        self, tmp_path, monkeypatch, bundle, capsys, name, content
    ):
        """An incomplete checkout says nothing rather than warning every time."""
        self._frontend(tmp_path, monkeypatch)
        if content is None:
            (tmp_path / name).unlink()
        else:
            (tmp_path / name).write_text(content)
        bundle.write_text("/* kml-heatmap build 000000000000 */\n")

        assets_module.warn_about_a_stale_bundle()

        assert assets_module._frontend_source_hash() is None
        assert capsys.readouterr().err == ""


class TestSourceHashParity:
    """The Python mirror of scripts/source-hash.js has to stay a mirror.

    build.js stamps the JavaScript hash into the bundle banner, and
    ``warn_about_a_stale_bundle`` compares that banner against the Python
    one. Two implementations that disagree turn the warning into noise on
    every build, so this checks them against each other rather than letting
    each confirm itself.
    """

    def test_matches_the_javascript_implementation(self):
        repo_root = assets_module.FRONTEND_DIR.parent.parent
        if not (repo_root / "scripts" / "source-hash.js").is_file():
            pytest.skip("not running from a checkout")
        node = shutil.which("node")
        if node is None:
            # CI sets up Node.js for this job, so a missing one there is a
            # broken workflow rather than a reason to pass silently
            if os.environ.get("CI"):
                pytest.fail("node is required to check the source hash parity")
            pytest.skip("node is not installed")

        result = subprocess.run(  # noqa: S603
            [
                node,
                "-e",
                (
                    'import("./scripts/source-hash.js")'
                    ".then((m) => console.log(m.computeSourceHash()))"
                ),
            ],
            capture_output=True,
            text=True,
            cwd=repo_root,
            check=True,
        )

        assert result.stdout.strip() == assets_module._frontend_source_hash()

    def test_covers_the_build_files_the_javascript_side_covers(self):
        """BUILD_HASH_FILES and BUILD_FILES in source-hash.js list the same files."""
        repo_root = assets_module.FRONTEND_DIR.parent.parent
        source_hash_js = repo_root / "scripts" / "source-hash.js"
        if not source_hash_js.is_file():
            pytest.skip("not running from a checkout")

        listed = re.search(
            r"const BUILD_FILES = \[(.*?)\]", source_hash_js.read_text(), re.DOTALL
        )
        assert listed is not None, "BUILD_FILES is no longer a literal list"

        assert tuple(re.findall(r'"([^"]+)"', listed.group(1))) == (
            assets_module.BUILD_HASH_FILES
        )

    def test_covers_the_packages_the_javascript_side_covers(self):
        """BUILD_HASH_PACKAGES and BUILD_PACKAGES in source-hash.js agree."""
        repo_root = assets_module.FRONTEND_DIR.parent.parent
        source_hash_js = repo_root / "scripts" / "source-hash.js"
        if not source_hash_js.is_file():
            pytest.skip("not running from a checkout")

        listed = re.search(
            r"const BUILD_PACKAGES = \[(.*?)\]",
            source_hash_js.read_text(),
            re.DOTALL,
        )
        assert listed is not None, "BUILD_PACKAGES is no longer a literal list"

        assert tuple(re.findall(r'"([^"]+)"', listed.group(1))) == (
            assets_module.BUILD_HASH_PACKAGES
        )


class TestCountryFlags:
    """Publishing a flag per country the export visited, and no other."""

    @pytest.fixture
    def flags(self, tmp_path, monkeypatch):
        """A checkout whose static/flags holds two of the three asked for"""
        static = tmp_path / "static"
        (static / assets_module.FLAGS_DIR_NAME).mkdir(parents=True)
        for code in ("de", "at"):
            (static / assets_module.FLAGS_DIR_NAME / f"{code}.svg").write_text(
                f'<svg xmlns="http://www.w3.org/2000/svg" data-code="{code}"/>'
            )
        monkeypatch.setattr(assets_module, "STATIC_DIR", static)
        return static

    def test_lists_only_the_flags_the_checkout_has(self, flags):
        assert assets_module.available_country_flags(["DE", "AT", "XX"]) == [
            "at",
            "de",
        ]

    def test_lists_nothing_without_the_directory(self, tmp_path, monkeypatch):
        # A wheel leaves the flags out; the frontend falls back to the code
        monkeypatch.setattr(assets_module, "STATIC_DIR", tmp_path)
        assert assets_module.available_country_flags(["DE"]) == []

    def test_publishes_the_flags_of_the_countries_given(self, flags, tmp_path):
        output = tmp_path / "site"
        output.mkdir()

        assets_module._copy_country_flags(output, ["DE", "XX"])

        published = sorted(
            path.name for path in (output / assets_module.FLAGS_DIR_NAME).iterdir()
        )
        assert published == ["de.svg"]

    def test_writes_no_directory_when_nothing_matches(self, flags, tmp_path):
        output = tmp_path / "site"
        output.mkdir()

        assets_module._copy_country_flags(output, ["XX"])

        assert not (output / assets_module.FLAGS_DIR_NAME).exists()
