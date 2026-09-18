"""Size budgets of the stylesheets that ship with the generated site.

The JavaScript bundles have their budgets in build.js, which every production
build enforces. The stylesheets are minified by the Python side instead (see
``site_assets._copy_and_minify_css``), and failing a user's site generation
over a project policy would be the wrong place for it, so their budgets are a
test: it fails in CI on a regression and leaves ``kml-heatmap`` itself alone.

The measurement goes through the renderer rather than minifying the sources
here, so that the budgets keep covering the files the site actually serves
however the renderer produces them.

Raise a budget on purpose when a change needs the room, not to make the suite
pass. The two are separate on purpose: only styles.css is on the critical
path, so room taken there is not the same as room taken in features.css.
"""

import pytest

from kml_heatmap.site_assets import CSS_FILES, STATIC_DIR, _copy_and_minify_css

# Bytes of each minified stylesheet as the renderer writes it into a site.
#
# styles.css is what every visit loads before the map can be drawn. It was one
# 68 KB sheet until replay and Wrapped moved into features.css, which cut it to
# about 39 KB; the budget keeps that win rather than letting it drain back.
#
# features.css is fetched only when a replay or Wrapped panel is opened, so it
# is the more forgiving of the two.
STYLESHEET_BUDGET_BYTES = {
    "styles.css": 42 * 1024,
    "features.css": 32 * 1024,
}


@pytest.fixture(scope="module")
def stylesheet_sizes(tmp_path_factory):
    out = tmp_path_factory.mktemp("site")
    _copy_and_minify_css(out, STATIC_DIR)
    return {name: (out / name).stat().st_size for name in CSS_FILES}


def test_every_stylesheet_has_a_budget():
    """A new stylesheet is measured rather than quietly shipping unbounded."""
    assert set(CSS_FILES) == set(STYLESHEET_BUDGET_BYTES)


@pytest.mark.parametrize("name", CSS_FILES)
def test_stylesheet_is_within_budget(name, stylesheet_sizes):
    size = stylesheet_sizes[name]
    budget = STYLESHEET_BUDGET_BYTES[name]

    assert size <= budget, (
        f"{name} minifies to {size:,} bytes, over the {budget:,} byte "
        f"budget in {__file__}"
    )
