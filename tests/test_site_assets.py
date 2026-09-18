"""Tests for the site_assets module: the page, its assets and the bundle."""

import json
import os
import re
import shutil
import string
import subprocess
from unittest.mock import patch

import pytest

import kml_heatmap.site_assets as assets_module
from kml_heatmap.site_assets import (
    _copy_javascript_bundle,
    _escape_js_string,
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
            data_dir_name="my_data_dir"
        )
        assert len(content) < len(substituted)

    def test_data_dir_name_is_html_escaped(self, tmp_path):
        """A quote in the name must not end the src attribute early."""
        from lxml import html as lxml_html

        output_file = tmp_path / "index.html"
        render_html(output_file, 'da"ta<x>')
        content = output_file.read_text()
        assert 'src="da"' not in content
        sources = [
            script.get("src")
            for script in lxml_html.fromstring(content).iter("script")
            if script.get("src")
        ]
        assert 'da"ta<x>/metadata.js' in sources
        assert 'da"ta<x>/airports.js' in sources

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
        with patch.dict(
            os.environ, {"CARTO_API_KEY": "test-carto", "OPENAIP_API_KEY": "it's"}
        ):
            package_assets(tmp_path, BOUNDS, "data")

        config = (tmp_path / "map_config.js").read_text()
        assert "51.0" in config
        assert "test-carto" in config
        assert "it\\'s" in config
        assert "$center_lat" not in config
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
        (static / "vendor" / "leaflet.js").unlink()

        assert assets_module.bundle_is_available() is False

        err = capsys.readouterr().err
        assert "vendor/leaflet.js" in err
        assert "npm run build" in err


class TestStaleBundleWarning:
    def _frontend(self, tmp_path, monkeypatch):
        """A checkout the hash can be computed from: sources and build files."""
        frontend = tmp_path / "kml_heatmap" / "frontend"
        (frontend / "ui").mkdir(parents=True)
        (frontend / "mapApp.ts").write_text("export {};")
        (frontend / "ui" / "a.ts").write_text("export const a = 1;")
        for name in assets_module.BUILD_HASH_FILES:
            (tmp_path / name).write_text("{}")
        (tmp_path / "package-lock.json").write_text(
            json.dumps({"packages": {"node_modules/esbuild": {"version": "0.28.2"}}})
        )
        monkeypatch.setattr(assets_module, "FRONTEND_DIR", frontend)
        return frontend

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

    def test_the_build_files_are_part_of_the_hash(self, tmp_path, monkeypatch, bundle):
        """A rebuild is needed when build.js or tsconfig.json changed, too."""
        self._frontend(tmp_path, monkeypatch)
        before = assets_module._frontend_source_hash()

        (tmp_path / "build.js").write_text("// a different build script")

        assert assets_module._frontend_source_hash() != before

    def test_the_esbuild_version_is_part_of_the_hash(
        self, tmp_path, monkeypatch, bundle
    ):
        self._frontend(tmp_path, monkeypatch)
        before = assets_module._frontend_source_hash()

        (tmp_path / "package-lock.json").write_text(
            json.dumps({"packages": {"node_modules/esbuild": {"version": "0.29.0"}}})
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
