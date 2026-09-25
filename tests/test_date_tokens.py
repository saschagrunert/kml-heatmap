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
            # With slashes, and the year first
            "16/Aug/2024",
            "Aug/16/2024",
            "2024/Aug/16",
            "2024-Aug-16",
            # A day and month name with a two-digit year
            "16 Aug 24",
            "16-AUG-24",
            "16AUG24",
            "16/Aug/24",
            "16MAI24",
            # The date of flight of an ICAO flight plan
            "DOF/240816",
            # Underscores and spaces between the numbers
            "16_08_2024",
            "16 08 2024",
            "16 - 08 - 2024",
            "8 16 2024",
            # The German calendar week with its year
            "KW33 2024",
            "KW 33/2024",
            # "of" between the day and the month
            "16th of August 2024",
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
            "2024/Jan/2",
            "1 JAN 24",
            "01JAN24",
            "DOF/240103",
            "01_01_2024",
            "01 01 2024",
            "KW1 2024",
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
            # A letter before a German month name makes it another word,
            # an umlaut as well; an underscore does not (see below)
            "Ämai 2026",
            "Rosenmai 2026",
            # A time is no two-digit year, nor is anything after other
            # separators than those between the day and the month
            "16 Aug 14:30",
            "16-Aug 26",
            "DOF/261316",
            # Numbers in a row: not both of one digit, a real day and month,
            # and a year of this or the last century
            "1 8 2024",
            "Heading 270 15 2024",
            "16 13 2024",
            "16 08 1024",
            "KW 54 2024",
        ],
    )
    def test_not_a_date_with_a_year(self, text):
        assert find_date_tokens(text) == []

    def test_a_german_month_after_an_underscore(self):
        # File names separate their words with underscores
        assert find_date_tokens("Flug_Mai_2026") == ["Mai_2026"]

    def test_a_time_is_no_year(self):
        # The four digits of a time of day are no year: the day, the month
        # and the two-digit year are the date, and nothing else
        assert find_date_tokens("Local flight 16-AUG-26 1430L") == ["16-AUG-26"]

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
            # Slashes around a month name, and the year first
            ("Rundflug 16/Aug/2026", "Rundflug"),
            ("EDDS Aug/16/2026", "EDDS"),
            ("EDDS 2026/Aug/16", "EDDS"),
            # A two-digit year after a separator, and a local time
            ("Local flight 16-AUG-26 1430L", "Local flight"),
            ("EDDS 16 Aug 26", "EDDS"),
            ("EDDS 1430 LT", "EDDS"),
            # German and French times, the date of an ICAO flight plan
            ("EDDS 14h30", "EDDS"),
            ("EDDS 14.30 Uhr", "EDDS"),
            ("Rundflug 9 Uhr EDDS", "Rundflug EDDS"),
            ("EDDS DOF/260816", "EDDS"),
            ("EDDS 260816", "EDDS"),
            ("EDDS 160826", "EDDS"),
            # A day and month without the last dot or with a hyphen
            ("EDDS 26.08", "EDDS"),
            ("EDDS 16-08 EDDP", "EDDS EDDP"),
            # ... with a month of one digit, and a decimal that looks like one
            ("Flight 16.8", "Flight"),
            ("Fuel 16.8 l", "Fuel l"),
            # Underscores and spaces between the numbers
            ("Flight 16_08_2026", "Flight"),
            ("Log_16_08", "Log"),
            ("EDDS 16_08 EDDP", "EDDS EDDP"),
            ("Flight 16 08 2026", "Flight"),
            ("Flight 16 - 08 - 2026 EDDS", "Flight EDDS"),
            # The German calendar week, with and without the year
            ("Flight KW33 2026", "Flight"),
            ("EDDS KW 33", "EDDS"),
            # "of" between the day and the month
            ("the 16th of August 2026 flight", "the flight"),
            ("EDDS 16th of Aug", "EDDS"),
            # A version is written with dots too
            ("Firmware 12.10 EDDS", "Firmware 12.10 EDDS"),
            ("EDDS app v 16.8", "EDDS app v 16.8"),
            # Runway directions without a word for a runway read as dates
            # ("07/25" is July 25th, and July 2025): the date goes
            ("Stuttgart 07/25", "Stuttgart"),
            ("EDDS 07-25", "EDDS"),
            # No dates: runways, frequencies, squawks, registrations, versions
            ("Runway 08/26 EDDS", "Runway 08/26 EDDS"),
            ("RWY 16/34 EDDS", "RWY 16/34 EDDS"),
            ("EDDS rwy 07/25, 09/27", "EDDS rwy 07/25, 09/27"),
            ("Landebahn 08/26", "Landebahn 08/26"),
            ("EDDS 07L/25R", "EDDS 07L/25R"),
            ("EDDS 118.500", "EDDS 118.500"),
            ("EDDS 118.30", "EDDS 118.30"),
            ("EDDS 1h30 flight", "EDDS 1h30 flight"),
            ("Heading 270-15", "Heading 270-15"),
            ("RWY 08-26 EDDS", "RWY 08-26 EDDS"),
            ("EDDS 5-10 kt", "EDDS 5-10 kt"),
            ("PA-28-181 EDDS", "PA-28-181 EDDS"),
            ("EDDS 1234567", "EDDS 1234567"),
            ("EDDS 999999", "EDDS 999999"),
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
            ("EDDS 1 8 2026", "EDDS 1 8 2026"),
            ("EDDS kW 100", "EDDS kW 100"),
            ("16_34_DA40", "16_34_DA40"),
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
