#!/usr/bin/env python3
"""Build the site the visual snapshots are compared against.

The snapshots of tests/e2e/visual.spec.ts are compared pixel for pixel, so
nothing they show may depend on when or where the site was built. data/
grows with every flight, which used to move the figures of the statistics
rail and of Wrapped; this builds tests/fixtures/visual/ instead, a handful of
flights that only change on purpose, into visual-site/.

Everything else that varies between builds is pinned here as well: the build
stamp of the statistics panel, the airport database and the tile API key. The
ground under the flights is left out (--no-terrain): sampling it would fetch
elevation tiles, and none of the snapshots shows the 3D view it is for, so a
flat or fixture model would only add a download to avoid. Run `npm run build`
first; the generator needs the bundles.
"""

import os
import shutil
import subprocess  # nosec B404
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "visual"
AIRPORTS = ROOT / "tests" / "fixtures" / "airports.csv"
SITE_DIR = ROOT / "visual-site"

# The statistics panel prints when and from which commit the site was built.
# Both are fixed, to values that are obviously not real: the first second of
# the year the spec pins, and a hash no commit has.
BUILD_ENVIRONMENT = {
    "SOURCE_DATE_EPOCH": "1735689600",
    "KML_HEATMAP_COMMIT": "0000000",
    "KML_HEATMAP_REPOSITORY": "",
    # Without the airport database the build still succeeds, with other
    # airport names in the rail
    "KML_HEATMAP_REQUIRE_AIRPORT_DB": "1",
    # A key in the environment of whoever runs this adds the keyed layers
    "CARTO_API_KEY": "",
}


def main() -> int:
    # A site left over from another fixture or generator would keep files
    # this build no longer writes
    shutil.rmtree(SITE_DIR, ignore_errors=True)
    # The cache directory holds the airport database and the parser cache. A
    # fresh one with a fresh copy of the fixture database keeps the build
    # offline (a copy older than 30 days would be downloaded again) and
    # independent of what earlier builds left in the user's cache.
    with tempfile.TemporaryDirectory(prefix="kml-heatmap-visual-") as cache_dir:
        shutil.copy(AIRPORTS, cache_dir)
        env = {**os.environ, **BUILD_ENVIRONMENT, "KML_HEATMAP_CACHE_DIR": cache_dir}
        return subprocess.run(  # noqa: S603 # nosec B603
            [
                sys.executable,
                "-m",
                "kml_heatmap",
                str(FIXTURE_DIR),
                "--output-dir",
                str(SITE_DIR),
                "--no-terrain",
            ],
            cwd=ROOT,
            env=env,
            check=False,
        ).returncode


if __name__ == "__main__":
    sys.exit(main())
