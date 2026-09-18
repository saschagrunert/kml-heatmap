"""The wire format of the exported segment rows.

A year file is by far the largest thing the page downloads, and it used to
be plain JSON floats: about 41 bytes for every row of
``[lat, lon, altitude_ft, groundspeed_knots, time?]``. Two properties of the
data make that wasteful. Every value is already rounded to a fixed number of
decimals by the exporter, so it is an integer in disguise, and consecutive
rows are contiguous and slow-moving, so the difference between neighbours is
far smaller than the value itself.

Encoding therefore scales each column to an integer and stores the
difference to the previous row. The format is lossless for the values the
exporter produces: every column is scaled by exactly the power of ten it was
rounded to, so ``decode(encode(rows)) == rows``, which
``tests/test_segment_codec.py`` checks over generated data.

``kml_heatmap/frontend/services/dataLoader.ts`` mirrors ``decode_rows``; the
year file carries ``FORMAT_VERSION`` so the two cannot be mismatched
silently.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .types import COORDINATE_DECIMALS

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .types import SegmentRow

__all__ = [
    "ALTITUDE_SCALE",
    "COORDINATE_SCALE",
    "FORMAT_VERSION",
    "SPEED_SCALE",
    "TIME_SCALE",
    "decode_rows",
    "encode_rows",
    "encode_start",
]

# Bumped whenever the layout below changes, so a page never reads a year
# file written by another release's exporter as if it were its own
FORMAT_VERSION = 2

# The scale of each column: the power of ten the exporter rounds it to, so
# scaling by it gives back an exact integer.
# process_path_segments rounds coordinates to COORDINATE_DECIMALS ...
COORDINATE_SCALE = 10**COORDINATE_DECIMALS
# ... altitudes to whole feet (in fact to multiples of 100) ...
ALTITUDE_SCALE = 1
# ... and groundspeeds and relative times to one decimal
SPEED_SCALE = 10
TIME_SCALE = 10

# Column order of a decoded row
LAT, LON, ALTITUDE, SPEED, TIME = range(5)
_SCALES = (COORDINATE_SCALE, COORDINATE_SCALE, ALTITUDE_SCALE, SPEED_SCALE, TIME_SCALE)


def encode_start(start: Sequence[float]) -> list[int]:
    """Scale a path's start point to integers."""
    return [round(value * COORDINATE_SCALE) for value in start]


def encode_rows(start: Sequence[float], rows: Sequence[SegmentRow]) -> list[list[int]]:
    """Scale every column to an integer and store differences.

    ``start`` seeds the coordinate columns, so the first row is a difference
    like every other one. The remaining columns start from zero.

    A row without a relative time stays four columns wide, exactly as in the
    decoded form. The time column then keeps the value of the last row that
    had one, so a gap does not shift the rows after it.
    """
    previous = [
        round(start[LAT] * COORDINATE_SCALE) if start else 0,
        round(start[LON] * COORDINATE_SCALE) if start else 0,
        0,
        0,
        0,
    ]
    encoded: list[list[int]] = []
    for row in rows:
        scaled = [round(value * _SCALES[column]) for column, value in enumerate(row)]
        delta = [scaled[column] - previous[column] for column in range(len(scaled))]
        for column, value in enumerate(scaled):
            previous[column] = value
        encoded.append(delta)
    return encoded


def decode_rows(
    start: Sequence[int], encoded: Sequence[Sequence[int]]
) -> list[SegmentRow]:
    """Undo :func:`encode_rows`. The mirror of the frontend's decoder."""
    previous = [start[LAT] if start else 0, start[LON] if start else 0, 0, 0, 0]
    rows: list[SegmentRow] = []
    for delta in encoded:
        row: SegmentRow = []
        for column, difference in enumerate(delta):
            previous[column] += difference
            row.append(previous[column] / _SCALES[column])
        rows.append(row)
    return rows
