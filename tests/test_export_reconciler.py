"""Tests for export_reconciler module."""

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from kml_heatmap.constants import FEET_TO_METERS, KM_TO_NAUTICAL_MILES
from kml_heatmap.export_reconciler import YearAggregate
from kml_heatmap.geometry import haversine_distance

START = (50.0, 8.0)
STEP = 0.01


# Exported row: [lat, lon, altitude_ft, groundspeed_knots, time?] where the
# coordinate is the segment's END point (see types.SegmentRow). A row without
# an explicit latitude is placed on a chain by _resolve, one STEP per row, so
# that every segment has a real length.
def _row(alt_ft, gs, time=None, lat=None, lon=None):
    row = [lat, lon, alt_ft, gs]
    if time is not None:
        row.append(time)
    return row


def _resolve(rows, start=START):
    """Fill in the end point of every row that did not name one."""
    resolved = []
    lat, lon = start
    for index, row in enumerate(rows, start=1):
        filled = list(row)
        if filled[0] is None:
            filled[0] = lat + index * STEP
        if filled[1] is None:
            filled[1] = lon
        resolved.append(filled)
    return resolved


def _distances(rows, start=START):
    """Segment distances of a contiguous row list, starting from ``start``."""
    distances = []
    previous = start
    for row in _resolve(rows, start):
        distances.append(haversine_distance(previous[0], previous[1], row[0], row[1]))
        previous = (row[0], row[1])
    return distances


def _add(aggregate, rows, registration=None):
    aggregate.add_path(_resolve(rows), _distances(rows), registration)


class TestAddPath:
    def test_altitude_min_max_from_feet(self):
        agg = YearAggregate()
        _add(agg, [_row(1600, 100), _row(3300, 120), _row(700, 90)])
        assert agg.min_altitude_ft == 700
        assert agg.max_altitude_ft == 3300

    def test_altitude_gain_resets_at_path_boundary(self):
        agg = YearAggregate()
        _add(agg, [_row(100, 100), _row(300, 100), _row(200, 100), _row(500, 100)])
        gain_one_path = (200 + 300) * FEET_TO_METERS
        assert agg.total_altitude_gain_m == pytest.approx(gain_one_path)

        # Second path starts lower: no gain may be counted across the boundary
        _add(agg, [_row(0, 100), _row(100, 100)])
        assert agg.total_altitude_gain_m == pytest.approx(
            gain_one_path + 100 * FEET_TO_METERS
        )

    def test_average_groundspeed_excludes_zero(self):
        agg = YearAggregate()
        _add(agg, [_row(100, 100), _row(100, 150), _row(100, 0)])
        assert agg.groundspeed_sum / agg.groundspeed_count == pytest.approx(125.0)
        assert agg.max_groundspeed_knots == 150
        assert agg.min_groundspeed_knots == 100

    def test_cruise_speed_weighted_by_distance(self):
        agg = YearAggregate()
        rows = [
            _row(100, 80, lat=50.0),
            _row(1200, 150, lat=50.01),
            _row(1300, 100, lat=50.03),
        ]
        _add(agg, rows)
        d1, d2 = _distances(rows)[1:]
        nm1, nm2 = d1 * KM_TO_NAUTICAL_MILES, d2 * KM_TO_NAUTICAL_MILES
        assert agg.cruise_distance_nm == pytest.approx(nm1 + nm2)
        assert agg.cruise_time_hours == pytest.approx(nm1 / 150 + nm2 / 100)

    def test_cruise_uses_per_path_ground_level(self):
        agg = YearAggregate()
        # Path at 2000..2500 ft: only 2500 - 2000 = 500 ft AGL -> no cruise
        _add(agg, [_row(2000, 100), _row(2500, 100)])
        assert agg.cruise_altitude_bins == {}
        # Path from 0 to 1100 ft -> 1100 ft AGL is cruise
        _add(agg, [_row(0, 100), _row(1100, 100)])
        assert agg.cruise_altitude_bins == {1100: 1}

    def test_cruise_requires_groundspeed(self):
        agg = YearAggregate()
        _add(agg, [_row(0, 0), _row(2000, 0)])
        assert agg.cruise_altitude_bins == {}

    def test_flight_time_per_path(self):
        agg = YearAggregate()
        _add(agg, [_row(100, 100, 0.0), _row(100, 100, 100.0)])
        _add(agg, [_row(100, 100, 0.0), _row(100, 100, 200.0)])
        _add(agg, [_row(100, 100, 50.0)])
        _add(agg, [_row(100, 100)])
        assert agg.total_flight_time_seconds == pytest.approx(300.0)
        assert agg.num_paths == 4

    def test_per_aircraft_totals(self):
        agg = YearAggregate()
        rows = [_row(100, 100, 0.0), _row(100, 100, 300.0)]
        _add(agg, rows, "D-EAGJ")
        _add(agg, rows, "D-EAGJ")
        _add(agg, rows, None)
        assert agg.aircraft_time_seconds == {"D-EAGJ": 600.0}
        assert agg.aircraft_distance_km["D-EAGJ"] == pytest.approx(
            2 * sum(_distances(rows))
        )

    def test_longest_flight_and_total_distance(self):
        agg = YearAggregate()
        short = [_row(100, 100)]
        long = [_row(100, 100, lat=50.5)]
        _add(agg, short)
        _add(agg, long)
        assert agg.longest_flight_km == pytest.approx(sum(_distances(long)))
        assert agg.total_distance_km == pytest.approx(
            sum(_distances(short)) + sum(_distances(long))
        )

    def test_empty_path_counts_but_adds_nothing(self):
        agg = YearAggregate()
        agg.add_path([], [], "D-EAGJ")
        assert agg.num_paths == 1
        assert agg.min_altitude_ft is None
        assert agg.aircraft_time_seconds == {}


class TestMerge:
    def test_merge_combines_everything(self):
        a = YearAggregate(total_points=3)
        _add(a, [_row(100, 100, 0.0), _row(300, 120, 60.0)], "D-EAGJ")
        b = YearAggregate(total_points=4)
        _add(b, [_row(50, 90, 0.0), _row(2000, 130, 120.0)], "D-EAGJ")
        _add(b, [_row(500, 0)], "D-EHYL")

        merged = YearAggregate()
        merged.merge(a)
        merged.merge(b)

        assert merged.total_points == 7
        assert merged.num_paths == 3
        assert merged.min_altitude_ft == 50
        assert merged.max_altitude_ft == 2000
        assert merged.min_groundspeed_knots == 90
        assert merged.max_groundspeed_knots == 130
        assert merged.groundspeed_count == 4
        assert merged.total_flight_time_seconds == pytest.approx(180.0)
        assert merged.aircraft_time_seconds == {"D-EAGJ": 180.0, "D-EHYL": 0.0}
        assert merged.cruise_altitude_bins == b.cruise_altitude_bins
        assert merged.total_distance_km == pytest.approx(
            a.total_distance_km + b.total_distance_km
        )

    def test_merge_into_empty_keeps_none_values(self):
        merged = YearAggregate()
        merged.merge(YearAggregate())
        assert merged.min_altitude_ft is None
        assert merged.min_groundspeed_or_zero == 0.0


def _as_dict(aggregate):
    return {
        field: getattr(aggregate, field) for field in YearAggregate.__dataclass_fields__
    }


_rows = st.lists(
    st.tuples(
        st.integers(min_value=0, max_value=50).map(lambda n: n * 100),
        st.floats(min_value=0.0, max_value=200.0),
    ).map(lambda pair: _row(*pair)),
    min_size=0,
    max_size=6,
)
_paths = st.lists(
    st.tuples(_rows, st.sampled_from([None, "D-EAGJ", "D-EHYL"])),
    min_size=0,
    max_size=8,
)


class TestMergeProperties:
    @settings(max_examples=150, deadline=None)
    @given(_paths, st.integers(min_value=0, max_value=8))
    def test_merging_chunks_equals_a_single_pass(self, paths, split):
        """The chunked export merges partial aggregates; the result must not
        depend on where the year was cut."""
        split = min(split, len(paths))
        whole = YearAggregate()
        for rows, registration in paths:
            _add(whole, rows, registration)

        first, second = YearAggregate(), YearAggregate()
        for rows, registration in paths[:split]:
            _add(first, rows, registration)
        for rows, registration in paths[split:]:
            _add(second, rows, registration)
        merged = YearAggregate()
        merged.merge(first)
        merged.merge(second)

        expected = _as_dict(whole)
        actual = _as_dict(merged)
        for field, value in expected.items():
            if isinstance(value, dict):
                assert actual[field].keys() == value.keys()
                for key in value:
                    assert actual[field][key] == pytest.approx(value[key])
            elif isinstance(value, float):
                assert actual[field] == pytest.approx(value)
            else:
                assert actual[field] == value

    @settings(max_examples=50, deadline=None)
    @given(_paths)
    def test_merge_is_associative(self, paths):
        parts = []
        for rows, registration in paths:
            part = YearAggregate()
            _add(part, rows, registration)
            parts.append(part)

        left = YearAggregate()
        for part in parts:
            left.merge(part)

        right = YearAggregate()
        for part in reversed(parts):
            right.merge(part)

        assert left.num_paths == right.num_paths
        assert left.total_distance_km == pytest.approx(right.total_distance_km)
        assert left.min_altitude_ft == right.min_altitude_ft
        assert left.max_altitude_ft == right.max_altitude_ft
        assert left.cruise_altitude_bins == right.cruise_altitude_bins
        assert left.total_flight_time_seconds == pytest.approx(
            right.total_flight_time_seconds
        )
