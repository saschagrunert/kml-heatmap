"""Size budget of the stylesheet that ships with the generated site.

The JavaScript bundle has its budget in build.js, which every production
build enforces. The stylesheet is minified by the Python side instead (see
``site_assets._copy_and_minify_css``), and failing a user's site generation over
a project policy would be the wrong place for it, so its budget is a test:
it fails in CI on a regression and leaves ``kml-heatmap`` itself alone.

The measurement goes through the renderer rather than minifying the source
here, so that the budget keeps covering the file the site actually serves
however the renderer produces it.

Raise the budget on purpose when a change needs the room, not to make the
suite pass.
"""

from kml_heatmap.site_assets import STATIC_DIR, _copy_and_minify_css

# Bytes of the minified stylesheet as the renderer writes it into a site.
# Raised from 64 KB for the visual review of 2026-09-18, which spent all but
# 52 bytes of the old one: the selection chip, the compact tablet columns,
# the scroll fades, the placeholder and the raised-contrast block.
STYLESHEET_BUDGET_BYTES = 68 * 1024


def test_stylesheet_is_within_budget(tmp_path):
    _copy_and_minify_css(tmp_path, STATIC_DIR)
    size = (tmp_path / "styles.css").stat().st_size

    assert size <= STYLESHEET_BUDGET_BYTES, (
        f"styles.css minifies to {size:,} bytes, over the "
        f"{STYLESHEET_BUDGET_BYTES:,} byte budget in {__file__}"
    )
