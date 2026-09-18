"""Tests for the wire format of the exported segment rows.

The encoding only pays off if it is lossless for the values the exporter
actually writes, so the round trip is checked over generated data as well as
over the fixed cases below. ``tests/frontend/unit/services/dataLoader.test.ts``
and the contract test cover the decoder the browser runs.
"""

import pytest
from hypothesis import given
from hypothesis import strategies as st

from kml_heatmap.segment_codec import (
    COORDINATE_SCALE,
    FORMAT_VERSION,
    decode_rows,
    encode_rows,
    encode_start,
)
from kml_heatmap.types import COORDINATE_DECIMALS

# The exporter's own rounding, which is what the format relies on
coordinates = st.floats(-180, 180).map(lambda v: round(v, COORDINATE_DECIMALS))
altitudes = st.integers(-1_000, 60_000).map(lambda v: float(v * 100))
speeds = st.floats(0, 1000).map(lambda v: round(v, 1))
times = st.floats(0, 100_000).map(lambda v: round(v, 1))


@st.composite
def rows(draw, with_time=None):
    """A list of rows the way process_path_segments builds them."""
    timed = draw(st.booleans()) if with_time is None else with_time
    row = st.tuples(coordinates, coordinates, altitudes, speeds).map(list)
    if timed:
        row = st.tuples(coordinates, coordinates, altitudes, speeds, times).map(list)
    return draw(st.lists(row, max_size=30))


class TestRoundTrip:
    @given(start=st.tuples(coordinates, coordinates).map(list), path_rows=rows())
    def test_decoding_gives_the_rows_back(self, start, path_rows):
        encoded = encode_rows(start, path_rows)

        assert decode_rows(encode_start(start), encoded) == path_rows

    @given(start=st.tuples(coordinates, coordinates).map(list), path_rows=rows())
    def test_everything_written_is_an_integer(self, start, path_rows):
        """Integers are the point: floats would undo the size win."""
        assert all(isinstance(value, int) for value in encode_start(start))
        for row in encode_rows(start, path_rows):
            assert all(isinstance(value, int) for value in row)

    @given(start=st.tuples(coordinates, coordinates).map(list), path_rows=rows())
    def test_the_row_width_is_kept(self, path_rows, start):
        """A row without a relative time stays four columns wide."""
        encoded = encode_rows(start, path_rows)

        assert [len(row) for row in encoded] == [len(row) for row in path_rows]


class TestEncoding:
    def test_the_first_row_is_a_difference_to_the_start(self):
        start = [50.0, 8.0]
        encoded = encode_rows(start, [[50.00001, 8.00002, 500.0, 1.5, 2.0]])

        assert encoded == [[1, 2, 500, 15, 20]]

    def test_a_still_aircraft_encodes_to_zeros(self):
        """Repetition is what makes the format small."""
        row = [50.1, 8.1, 500.0, 0.0, 10.0]
        encoded = encode_rows([50.1, 8.1], [row, row, row])

        assert encoded[1] == [0, 0, 0, 0, 0]
        assert encoded[2] == [0, 0, 0, 0, 0]

    def test_the_start_is_scaled_to_integers(self):
        assert encode_start([50.0, 8.0]) == [
            50 * COORDINATE_SCALE,
            8 * COORDINATE_SCALE,
        ]

    def test_an_empty_path_encodes_to_nothing(self):
        assert encode_rows([], []) == []
        assert encode_start([]) == []

    def test_a_gap_in_the_time_column_does_not_shift_the_rows_after_it(self):
        """A row without a time keeps the running time where it was."""
        path_rows = [
            [50.0, 8.0, 500.0, 1.0, 10.0],
            [50.1, 8.1, 500.0, 1.0],
            [50.2, 8.2, 500.0, 1.0, 30.0],
        ]
        encoded = encode_rows([50.0, 8.0], path_rows)

        assert decode_rows(encode_start([50.0, 8.0]), encoded) == path_rows

    @pytest.mark.parametrize("value", [0.0, -0.00001, 179.99999, -179.99999])
    def test_coordinate_extremes_survive(self, value):
        row = [value, value, 0.0, 0.0]

        decoded = decode_rows(encode_start([0.0, 0.0]), encode_rows([0.0, 0.0], [row]))

        assert decoded == [row]


def test_the_format_version_is_pinned():
    """Bumping it is a deliberate act; the frontend checks the same number."""
    assert FORMAT_VERSION == 2
