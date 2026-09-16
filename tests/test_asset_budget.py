"""Size budget of the stylesheet that ships with the generated site.

The JavaScript bundle has its budget in build.js, which every production
build enforces. The stylesheet is minified by the Python side instead (see
``renderer._copy_and_minify_css``), and failing a user's site generation over
a project policy would be the wrong place for it, so its budget is a test:
it fails in CI on a regression and leaves ``kml-heatmap`` itself alone.

Raise the budget on purpose when a change needs the room, not to make the
suite pass.
"""

import rcssmin

from kml_heatmap.renderer import STATIC_DIR

# Bytes of the minified stylesheet. rcssmin is what the renderer ships, so
# this is the size of the styles.css the site actually serves.
STYLESHEET_BUDGET_BYTES = 64 * 1024


def test_stylesheet_is_within_budget():
    source = (STATIC_DIR / "styles.css").read_text(encoding="utf-8")
    minified: str = rcssmin.cssmin(source)
    size = len(minified.encode("utf-8"))

    assert size <= STYLESHEET_BUDGET_BYTES, (
        f"styles.css minifies to {size:,} bytes, over the "
        f"{STYLESHEET_BUDGET_BYTES:,} byte budget in {__file__}"
    )
