"""Tests for date_tokens module."""

import pytest

from kml_heatmap.date_tokens import find_date_tokens, month_number, strip_dates


class TestFindDateTokens:
    @pytest.mark.parametrize(
        "text",
        [
            "2024-03-14",
            "2024_03_14",
            "2024.03.14",
            "14.03.2024",
            "3/14/2024",
            "20240314",
            "2024-03",
            "2024-W11",
            "2024-074",
            "14 Mar 2024",
            "14 Sept 2024",
            "March 14, 2024",
            "March 2024",
        ],
    )
    def test_every_shape_is_found(self, text):
        assert find_date_tokens(f"x {text} y") == [text]

    @pytest.mark.parametrize(
        "text",
        ["2024-01-02", "2024_01_02", "01.01.2024", "20240101", "2024-01", "1 Jan 2024"],
    )
    def test_the_days_after_jan_first_pass_only_when_asked(self, text):
        assert find_date_tokens(text) != []
        assert find_date_tokens(text, skip_near_jan_first=True) == []

    def test_no_month_no_date(self):
        assert find_date_tokens("Runway 25 2024") == []


class TestStripDates:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("EDDS Stuttgart", "EDDS Stuttgart"),
            # Unchanged when there is no date, separators and all
            ("Niort - Marais Poitevin.", "Niort - Marais Poitevin."),
            ("Sunday flight 16 Aug 2026", "Sunday flight"),
            ("EDDS to EDDP - 16 Aug 2026", "EDDS to EDDP"),
            ("EDDS - 16.08.2026 - EDDP", "EDDS - EDDP"),
            ("EDDS (2026-08-16) Stuttgart", "EDDS Stuttgart"),
            ("Flight 16 August", "Flight"),
            ("August 16th flight", "flight"),
            ("Log_2026_08_16", "Log"),
            ("Sept 16 flight", "flight"),
            ("EDDS 16.08.", "EDDS"),
            ("Version 1.2.3 EDDS", "Version 1.2.3 EDDS"),
            ("Runway 09/27 EDDS 25R", "Runway 09/27 EDDS 25R"),
            ("Flugplatz 2000", "Flugplatz 2000"),
            ("EDDS 08:50 Z", "EDDS"),
            ("Takeoff 3:15 pm", "Takeoff"),
            ("Mayfield 12", "Mayfield 12"),
            ("DA40", "DA40"),
            ("2026-08-16", None),
            ("16 Aug 2026 08:50 Z", None),
            ("1234", None),
            ("", None),
            (None, None),
        ],
    )
    def test_strip(self, text, expected):
        assert strip_dates(text) == expected


def test_month_number():
    assert month_number("aug") == month_number("August") == 8
    assert month_number("Flight") is None
