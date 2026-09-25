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
            "2026/8/16",
            "2026/08/6",
            "2026-8-16",
            "2026_8_6",
            "20240314",
            "2024-03",
            "2024-W11",
            "2024-074",
            "14 Mar 2024",
            "14 Sept 2024",
            "March 14, 2024",
            "March 2024",
            # German, the day first
            "14. März 2024",
            "14. Maerz 2024",
            "14.Mrz.2024",
            "14-Okt-2024",
            "24. Dez. 2024",
            "14 JULI 2024",
            "Mai 2024",
            "Dezember 2024",
        ],
    )
    def test_every_shape_is_found(self, text):
        assert find_date_tokens(f"x {text} y") == [text]

    @pytest.mark.parametrize(
        "text",
        [
            "2024-01-02",
            "2024_01_02",
            "01.01.2024",
            "20240101",
            "2024-01",
            "1 Jan 2024",
            "2024/1/1",
            "2024-1-3",
            "2024_01_2",
            "1. Januar 2024",
            "3. Jänner 2024",
            "Januar 2024",
        ],
    )
    def test_the_days_after_jan_first_pass_only_when_asked(self, text):
        assert find_date_tokens(text) != []
        assert find_date_tokens(text, skip_near_jan_first=True) == []

    def test_no_month_no_date(self):
        assert find_date_tokens("Runway 25 2024") == []

    @pytest.mark.parametrize(
        "text",
        [
            # Versions are written with dots, and 2024.3.1 is one as often
            "ForeFlight 2024.3.1",
            # No month 13, no century before 1900
            "2026/13/1",
            "1234-5-6",
            # Without a year the check has nothing to go by
            "16/08",
            "Runway 08/26",
            "1430Z",
            # German month names only count next to a day or a year
            "Mai 16",
            "Maier 2026",
            "Juli 7000",
            "16. Mai",
        ],
    )
    def test_not_a_date_with_a_year(self, text):
        assert find_date_tokens(text) == []

    def test_a_date_near_jan_first_only_when_it_is_one(self):
        assert find_date_tokens("2024-1-4", skip_near_jan_first=True) == ["2024-1-4"]
        assert find_date_tokens("2024/2/1", skip_near_jan_first=True) == ["2024/2/1"]


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
            # A day and month without the year, in either order
            ("Aunt farm 16/08", "Aunt farm"),
            ("Home strip - Aunt farm 16/08", "Home strip - Aunt farm"),
            ("Aunt farm 08/16", "Aunt farm"),
            ("Aunt farm 16/8", "Aunt farm"),
            ("(16/08) Aunt farm", "Aunt farm"),
            # August 26th, whose day and month are 18 apart like the two
            # directions of a runway: only a name about runways has one
            ("Aunt farm 26/08", "Aunt farm"),
            ("EDDS 07/25", "EDDS"),
            # The aviation form with a two-digit year
            ("EDDS 16AUG26", "EDDS"),
            # German, with and without the year
            ("Rundflug 16. Mai 2026", "Rundflug"),
            ("EDDS 16.Mai.2026 EDDP", "EDDS EDDP"),
            ("EDDS 16-Mai-2026", "EDDS"),
            ("EDDS 16MAI26", "EDDS"),
            ("EDDS 16. Mai", "EDDS"),
            ("EDDS 3. März", "EDDS"),
            ("EDDS 24. Dez. 2026", "EDDS"),
            ("EDDS Mai 2026", "EDDS"),
            ("EDDS 16. August", "EDDS"),
            # A German month name alone is a name
            ("Mai", "Mai"),
            ("Flugplatz Juli", "Flugplatz Juli"),
            ("Juni EDDS", "Juni EDDS"),
            ("Maier 2026", "Maier 2026"),
            ("Mai 16 EDDS", "Mai 16 EDDS"),
            ("Squawk Juli 7000", "Squawk Juli 7000"),
            # A month and year without the day
            ("EDDS 03/2026", "EDDS"),
            ("EDDS 3/2026 EDDP", "EDDS EDDP"),
            ("EDDS 03.2026", "EDDS"),
            ("EDDS 2026/03", "EDDS"),
            # A year first with a month or day of one digit
            ("EDDS 2026/8/16", "EDDS"),
            ("EDDS 2026-8-6 EDDP", "EDDS EDDP"),
            # The time of day after a date, and nothing of it left behind
            ("EDDS 2026-08-16T14:30:00Z", "EDDS"),
            ("EDDS 2026-08-16T14:30:00.5+02:00 - EDDP", "EDDS - EDDP"),
            ("EDDS 20260816-1430", "EDDS"),
            ("Log_2026-08-16_1430", "Log"),
            ("16 Aug 2026 1430 EDDS", "EDDS"),
            ("Aunt farm 16/08 1430", "Aunt farm"),
            # Times of day without a colon
            ("EDDS 1430Z", "EDDS"),
            ("EDDS 1430 UTC", "EDDS"),
            ("EDDS 20260816T1430", "EDDS"),
            ("EDDS 20260816T143000Z", "EDDS"),
            ("EDDS T0850Z - EDDP", "EDDS - EDDP"),
            # No dates: runways, frequencies, squawks, registrations, versions
            ("Runway 08/26 EDDS", "Runway 08/26 EDDS"),
            ("RWY 16/34 EDDS", "RWY 16/34 EDDS"),
            ("EDDS rwy 07/25, 09/27", "EDDS rwy 07/25, 09/27"),
            ("Landebahn 08/26", "Landebahn 08/26"),
            ("EDDS 07L/25R", "EDDS 07L/25R"),
            ("EDDS 118.500", "EDDS 118.500"),
            ("EDDS 123.45/121.5", "EDDS 123.45/121.5"),
            ("Squawk 7000 EDDS", "Squawk 7000 EDDS"),
            ("EDDS FL100 1430", "EDDS FL100 1430"),
            ("N1430Z Cessna", "N1430Z Cessna"),
            ("D-EAGJ EDDS", "D-EAGJ EDDS"),
            ("Half 1/2 tank", "Half 1/2 tank"),
            ("Wind 270/15 EDDS", "Wind 270/15 EDDS"),
            ("Dortmund/Wickede EDLW", "Dortmund/Wickede EDLW"),
            ("ForeFlight 2024.3.1", "ForeFlight 2024.3.1"),
            ("ForeFlight 2026.03", "ForeFlight 2026.03"),
            ("Circuit 3 of 45/60", "Circuit 3 of 45/60"),
            ("Circuits 3-2026", "Circuits 3-2026"),
            ("EDDS 2026 7000 ft", "EDDS 2026 7000 ft"),
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
