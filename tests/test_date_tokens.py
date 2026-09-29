"""Tests for date_tokens module."""

import pytest
from hypothesis import given
from hypothesis import strategies as st

from kml_heatmap.date_tokens import (
    find_date_tokens,
    find_time_tokens,
    find_weekday_tokens,
    month_number,
    strip_dates,
)


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
            # A calendar week with its year, and the ISO week without the
            # hyphen
            "KW33 2024",
            "KW 33/2024",
            "Week 33 2024",
            "week 33/2024",
            "W33 2024",
            "2024W33",
            "2024W336",
            # "of" between the day and the month
            "16th of August 2024",
        ],
    )
    def test_every_shape_is_found(self, text):
        assert find_date_tokens(f"x {text} y") == [text]

    @pytest.mark.parametrize(
        "text",
        ["20260816143015", "flight_202608161430", "Log_20260816-1430"],
    )
    def test_a_compact_date_with_its_time_is_found(self, text):
        """The time of day right after it no longer hides the date."""
        assert find_date_tokens(text) == ["20260816"]

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
            "2024W01",
            "202401010000",
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
            # Twelve digits that are no date and time, a week of a
            # registration, and a calendar week without its year
            "EDDS 123456789012",
            "EDDS 202613161430",
            "N2026W33",
            "2024W54",
            "W33",
            "Week 33",
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

    @pytest.mark.parametrize(
        "text",
        [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "SUNDAY",
            "sunday",
            "Sundays",
            "Montag",
            "Dienstag",
            "Mittwoch",
            "Donnerstag",
            "Freitag",
            "Samstag",
            "Sonnabend",
            "Sonntag",
            "sonntags",
            "Sonntagsflug",
            "Samstagnachmittag",
        ],
    )
    def test_a_weekday_in_full(self, text):
        # Reported apart from the dates: the obfuscator rewrites none
        assert find_weekday_tokens(f"x_{text} y") == [text]
        assert find_date_tokens(f"x_{text} y") == []

    @pytest.mark.parametrize(
        "text",
        [
            # Abbreviations alone are words, codes and types of their own
            "Sun n Fun",
            "SAT",
            "Do 27",
            "EDMO",
            "Mo",
            "Wed",
            # Words that begin like a weekday
            "Montage",
            "Sundance",
            "Freitagen",
            # Places named after a weekday
            "KFHR Friday Harbor",
            "Thursday Island",
            "Sunday Creek",
            # A time of day is none either (see find_time_tokens)
            "1513h",
            "14:30",
        ],
    )
    def test_no_weekday(self, text):
        assert find_weekday_tokens(text) == []
        assert find_date_tokens(text) == []


class TestFindTimeTokens:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("1_DEHYL_1513h", ["1513h"]),
            ("1_DEHYL_15h13", ["15h13"]),
            ("EDDS 0930z", ["0930z"]),
            ("EDDS_0930Z", ["0930Z"]),
            ("EDDS 0930UTC", ["0930UTC"]),
            ("EDDS 1430hrs", ["1430hrs"]),
            ("EDDS 1430L", ["1430L"]),
            ("EDDS 15:13", ["15:13"]),
            ("EDDS 1513 Uhr", ["1513 Uhr"]),
            ("1_DEHYL_1513H", ["1513H"]),
            ("EDDS 1513 hrs", ["1513 hrs"]),
            ("EDDS 15.13h", ["15.13h"]),
            ("EDDS 1513 MEZ", ["1513 MEZ"]),
            ("EDDS 15:13 CEST", ["15:13 CEST"]),
            ("EDDS T15:13", ["T15:13"]),
            ("EDDS 3pm", ["3pm"]),
            ("EDDS 3 p.m.", ["3 p.m."]),
            ("EDDS_11.30am", ["11.30am"]),
            ("EDDS-1513Z", ["1513Z"]),
            # After a date in any form, whether or not the date counts
            ("Log_2026-01-01_1430", ["1430"]),
            ("EDDS 20260816T1430", ["T1430"]),
            ("EDDS 16.08.2026, 15.13", ["15.13"]),
            # Zones of other countries, the local time and the hours, whole
            ("Home strip - Aunt farm 1430 GMT", ["1430 GMT"]),
            ("Aunt farm 1430 EST", ["1430 EST"]),
            ("Aunt farm 14:30 BST", ["14:30 BST"]),
            ("Aunt farm 09:30 EDT", ["09:30 EDT"]),
            ("Aunt farm 14:30 AEST", ["14:30 AEST"]),
            ("Aunt farm 14:30 local", ["14:30 local"]),
            ("Aunt farm 1430 local time", ["1430 local time"]),
            ("Aunt farm 0930 hours", ["0930 hours"]),
            ("Aunt farm 14:30 UTC+2", ["14:30 UTC+2"]),
            ("Takeoff 3:15 pm EST", ["3:15 pm EST"]),
            # A fraction of a second and a UTC offset along with the time
            ("Aunt farm 14:30 +02:00", ["14:30 +02:00"]),
            ("Aunt farm 14:30:00+0200", ["14:30:00+0200"]),
            ("Aunt farm 14:30:00.123Z", ["14:30:00.123Z"]),
            ("Aunt farm 14:30:00,5Z", ["14:30:00,5Z"]),
            ("EDDS T1430+0200", ["T1430+0200"]),
            ("EDDS 1430+0200", ["1430+0200"]),
            # After a compact date without a separator, and after a date as
            # hours and minutes with hyphens
            ("20260816143015", ["143015"]),
            ("flight_202608161430", ["1430"]),
            ("log-2026-08-16-14-30", ["14-30"]),
            ("log_2026_08_16_14_30_15", ["14_30_15"]),
            # A range, whole
            ("Block 0930Z-1045Z", ["0930Z-1045Z"]),
            ("Block 0930Z-1045", ["0930Z-1045"]),
            ("EDDS 1430L-1545L", ["1430L-1545L"]),
            ("EDDS 1430 LT-1545 LT", ["1430 LT-1545 LT"]),
            ("EDDS 1430 UTC-1545 UTC", ["1430 UTC-1545 UTC"]),
            ("EDDS 1430Z - 1545Z", ["1430Z", "1545Z"]),
            ("1_DEHYL_DA40-1430Z-1545Z", ["1430Z-1545Z"]),
            # Zulu, and the other common zones
            ("EDDS 1430 Zulu", ["1430 Zulu"]),
            ("EDDS 1430 ZULU", ["1430 ZULU"]),
            ("EDDS 1430 UT", ["1430 UT"]),
            ("EDDS 1430 WET", ["1430 WET"]),
            ("EDDS 1430 WEST", ["1430 WEST"]),
            ("EDDS 1430 LOC", ["1430 LOC"]),
            ("EDDS 1430 lcl", ["1430 lcl"]),
            ("EDDS 14:30 IDT", ["14:30 IDT"]),
            ("EDDS 14:30 SAST", ["14:30 SAST"]),
            ("EDDS 14:30 JST", ["14:30 JST"]),
            ("EDDS 14:30 HKT", ["14:30 HKT"]),
            ("EDDS 14:30 SGT", ["14:30 SGT"]),
            # A dot or an "h" with a zone, the local time or the hours
            ("EDDS 14.30Z", ["14.30Z"]),
            ("EDDS 14.30 UTC", ["14.30 UTC"]),
            ("EDDS 9.30 CET", ["9.30 CET"]),
            ("EDDS 14.30L", ["14.30L"]),
            ("EDDS 14.30 hrs", ["14.30 hrs"]),
            ("EDDS 14h30Z", ["14h30Z"]),
            ("EDDS 9h30 UTC", ["9h30 UTC"]),
        ],
    )
    def test_times(self, text, expected):
        assert find_time_tokens(text) == expected

    @pytest.mark.parametrize(
        "text",
        [
            "1_DEHYL_DA40",
            "1_DEAGJ_C172",
            # Registrations: a letter, or a nationality prefix and its hyphen
            "N1430Z",
            "N1513H",
            "N0930Z",
            "1_N1513H_C172",
            "RA-1513H",
            "HB-1430L",
            "Mi-8AM",
            # Hours and minutes that are no time of day
            "TT 2500h",
            "EDDS 1h30 flight",
            "EDDS 1.5h",
            "Flug 3 am Rhein",
            "Squawk 7000",
            "FL100 1430",
            "2026-08-16",
            "LOAV-LOAV",
            # Frequencies, runways, codes and years, whatever follows them
            "EDDS 123.45 EST",
            "RWY 09/27 local",
            "EDDS 2026",
            "Squawk 7000 hours",
            "EDDS 1200 ist gut",
            "EDDS 1430 ESTATE",
            # "14.30" is a decimal as often (fuel, a distance)
            "Aunt farm 14.30",
            # A frequency, a version, durations and litres
            "EDDS 118.30 UTC",
            "v14.30Z",
            "EDDS 1.30 hrs",
            "Fuel 5.30L",
            "Fuel 14.30 l",
            # Registrations and types with hyphens, ranges and offsets that
            # are none
            "HB-EST",
            "OE-KLT",
            "PA-28-181",
            "A320-214",
            "B737-800",
            "EDDS 1000-2000 ft",
            "EDDS 1200-1400",
            "EDDS 1430+02",
            # Zulu and localizer without a time, METAR winds
            "ATIS Zulu",
            "ILS 27 LOC",
            "27015G25KT",
        ],
    )
    def test_no_times(self, text):
        assert find_time_tokens(text) == []


class TestStripDates:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("EDDS Stuttgart", "EDDS Stuttgart"),
            # Unchanged when there is no date, separators and all
            ("Niort - Marais Poitevin.", "Niort - Marais Poitevin."),
            ("Sunday flight 16 Aug 2026", "flight"),
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
            # Compact times of day, as a file name holds them
            ("1_DEHYL_1513h", "1_DEHYL"),
            ("1_DEHYL_15h13", "1_DEHYL"),
            ("EDDS 0930z", "EDDS"),
            ("EDDS 0930utc - EDDP", "EDDS - EDDP"),
            ("EDDS 1430hrs", "EDDS"),
            ("EDDS 15:13h", "EDDS"),
            ("EDDS 08:50 z", "EDDS"),
            ("EDDS 1513 Uhr", "EDDS"),
            ("Log_2026-08-16_1430hrs", "Log"),
            ("EDDS 16.08.2026, 15.13", "EDDS"),
            ("EDDS 3pm", "EDDS"),
            # Other zones, the local time and the hours go whole, and so do
            # a fraction and an offset: nothing of the time is left behind
            ("Home strip - Aunt farm 1430 GMT", "Home strip - Aunt farm"),
            ("Aunt farm 1430 EST", "Aunt farm"),
            ("Aunt farm 14:30 BST", "Aunt farm"),
            ("Aunt farm 09:30 EDT", "Aunt farm"),
            ("Aunt farm 14:30 AEST - EDDS", "Aunt farm - EDDS"),
            ("Aunt farm 14:30 local", "Aunt farm"),
            ("Aunt farm 0930 hours", "Aunt farm"),
            ("Aunt farm 14:30 hrs", "Aunt farm"),
            ("Aunt farm 14:30 GMT+1", "Aunt farm"),
            ("Aunt farm 14:30 +02:00", "Aunt farm"),
            ("Aunt farm 14:30:00+0200", "Aunt farm"),
            ("Aunt farm 14:30:00.123Z", "Aunt farm"),
            ("EDDS 2026-08-16T14:30:00,5+02:00 - EDDP", "EDDS - EDDP"),
            ("EDDS 16.08.2026 14:30 +02:00", "EDDS"),
            ("EDDS 12:00 +10 min", "EDDS +10 min"),
            ("EDDS 1430+0200", "EDDS"),
            # A compact date with its time, and a date and time all with
            # hyphens: nothing of them is left behind
            ("20260816143015", None),
            ("Log_20260816143015", "Log"),
            ("flight_202608161430", "flight"),
            ("log-2026-08-16-14-30", "log"),
            ("Log_2026_08_16_14_30", "Log"),
            # Both ends of a range
            ("Block 0930Z-1045Z", "Block"),
            ("Block 1430 LT-1545 LT", "Block"),
            ("Block 1430 UTC-1545 UTC", "Block"),
            ("EDDS 1430L-1545L EDDP", "EDDS EDDP"),
            ("1_DEHYL_DA40-1430Z-1545Z", "1_DEHYL_DA40"),
            # Zulu and the other common zones
            ("EDDS 1430 Zulu", "EDDS"),
            ("EDDS 1430 WEST - EDDP", "EDDS - EDDP"),
            ("EDDS 14:30 JST", "EDDS"),
            ("EDDS 1430 UT", "EDDS"),
            ("EDDS 1430 LOC", "EDDS"),
            # A dot or an "h" with a zone, the local time or the hours
            ("EDDS 14.30Z", "EDDS"),
            ("EDDS 14.30 UTC - EDDP", "EDDS - EDDP"),
            ("EDDS 14.30L", "EDDS"),
            ("EDDS 14.30 hrs", "EDDS"),
            ("EDDS 14h30Z", "EDDS"),
            ("EDDS 14h30 UTC", "EDDS"),
            # Weeks: the ISO week without the hyphen, and a week with or
            # without the year
            ("Flight 2026W33", "Flight"),
            ("EDDS Week 33", "EDDS"),
            ("EDDS W33 2026", "EDDS"),
            # Kept: "W33" alone is an airport code in the US, a range is no
            # time with an offset, a frequency or a version no dotted time,
            # and a METAR wind no time either
            ("W33 Friday Harbor", "W33 Friday Harbor"),
            ("EDDS W10", "EDDS W10"),
            ("EDDS 1200-1400", "EDDS 1200-1400"),
            ("EDDS 1000-2000 ft", "EDDS 1000-2000 ft"),
            ("EDDS 118.30 UTC", "EDDS 118.30 UTC"),
            ("EDDS 1.30 hrs", "EDDS 1.30 hrs"),
            ("EDDS 27015G25KT", "EDDS 27015G25KT"),
            ("ATIS Zulu", "ATIS Zulu"),
            ("ILS 27 LOC", "ILS 27 LOC"),
            ("HB-EST EDDS", "HB-EST EDDS"),
            ("A320-214 EDDS", "A320-214 EDDS"),
            ("EDDS 123456789012", "EDDS 123456789012"),
            # A number before "hours" loses it: a time of day as often
            ("Engine 1500 hours", "Engine"),
            # Kept: a decimal is no time ("fuel 14.30"), nor a frequency
            # before a zone's letters
            ("Aunt farm 14.30", "Aunt farm 14.30"),
            ("EDDS 123.45 EST", "EDDS 123.45 EST"),
            # A year before a zone is a time as well (20:26), and the year
            # is no secret
            ("Rundflug 2026 local", "Rundflug"),
            ("1_N1513H_C172", "1_N1513H_C172"),
            ("RA-1513H EDDS", "RA-1513H EDDS"),
            ("Mi-8AM", "Mi-8AM"),
            ("1513h", None),
            # Weekdays in full, English and German, and the forms of them
            ("EDDS - EDDF Saturday", "EDDS - EDDF"),
            ("Friday flight", "flight"),
            ("Sunday's flight EDDS", "flight EDDS"),
            ("Sundays EDDS", "EDDS"),
            ("EDDS_SAMSTAG", "EDDS"),
            ("Rundflug am Sonntag", "Rundflug am"),
            ("Sonntagsflug EDDS", "EDDS"),
            ("Samstagnachmittag EDDS", "EDDS"),
            ("Flight_Saturday_2026-08-16_1430", "Flight"),
            # Abbreviated only next to a date or a time
            ("Sat 16 Aug 2026 EDDS", "EDDS"),
            ("EDDS Sa., 16.08.2026", "EDDS"),
            ("EDDS 16.08.2026 (Sa)", "EDDS"),
            ("EDDS 2026-08-16 Sat", "EDDS"),
            ("EDDS Mo 16.08.", "EDDS"),
            ("EDDS SUN 16AUG26 1430Z", "EDDS"),
            ("Do 14:30 EDDS", "EDDS"),
            # Not weekdays: places, words, types and registrations
            ("KFHR Friday Harbor", "KFHR Friday Harbor"),
            ("Thursday Island", "Thursday Island"),
            ("Sunday Creek Airpark", "Sunday Creek Airpark"),
            ("Montage EDDS", "Montage EDDS"),
            ("Sun n Fun", "Sun n Fun"),
            ("Mo EDDS", "Mo EDDS"),
            ("Do 27 EDDS", "Do 27 EDDS"),
            ("SAT EDDS", "SAT EDDS"),
            ("EDMO 16.08.2026", "EDMO"),
            ("OE-SAT 16.08.2026", "OE-SAT"),
            ("D-EFRI 16.08.2026", "D-EFRI"),
            ("C172", "C172"),
            ("PA28", "PA28"),
            ("DA20", "DA20"),
            ("SR22", "SR22"),
            ("EDMO", "EDMO"),
            ("2026-08-16", None),
            ("16 Aug 2026 08:50 Z", None),
            ("1234", None),
            ("", None),
            (None, None),
        ],
    )
    def test_strip(self, text, expected):
        assert strip_dates(text) == expected

    @given(
        hour=st.integers(min_value=0, max_value=23),
        minute=st.integers(min_value=0, max_value=59),
        form=st.sampled_from(
            [
                "{h}{m}h",
                "{h}{m}H",
                "{h}{m} hrs",
                "{h}h{m}",
                "{h}.{m}h",
                "{h}{m}z",
                "{h}{m}Z",
                "{h}{m}UTC",
                "{h}:{m}",
                "{h}{m} GMT",
                "{h}{m} EST",
                "{h}{m} local",
                "{h}{m} hours",
                "{h}:{m} PDT",
                "{h}:{m} AEST",
                "{h}:{m} local time",
                "{h}:{m}:00.5Z",
                "{h}:{m}:00+02:00",
                "{h}:{m} -0500",
                "{h}{m} Zulu",
                "{h}{m} UT",
                "{h}{m} WEST",
                "{h}{m} JST",
                "{h}{m}+0200",
                "{h}.{m}Z",
                "{h}.{m} UTC",
                "{h}.{m}L",
                "{h}.{m} hrs",
                "{h}h{m}Z",
                "{h}h{m} CET",
            ]
        ),
        separator=st.sampled_from(["_", " ", " - "]),
        head=st.sampled_from(["1_DEHYL", "1_DEAGJ_DA20", "EDDS", "EDDS - EDDP"]),
    )
    def test_no_time_of_day_is_left(self, hour, minute, form, separator, head):
        time = form.format(h=f"{hour:02d}", m=f"{minute:02d}")
        assert strip_dates(f"{head}{separator}{time}") == head
        assert find_time_tokens(f"{head}{separator}{time}") == [time]

    @given(
        weekday=st.sampled_from(
            [
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
                "Sunday",
                "Montag",
                "Dienstag",
                "Mittwoch",
                "Donnerstag",
                "Freitag",
                "Samstag",
                "Sonnabend",
                "Sonntag",
            ]
        ),
        case=st.sampled_from([str, str.upper, str.lower]),
        separator=st.sampled_from(["_", " ", " - "]),
        head=st.sampled_from(["1_DEHYL", "EDDS", "EDDS - EDDP", "Rundflug EDMO"]),
    )
    def test_no_weekday_is_left(self, weekday, case, separator, head):
        assert strip_dates(f"{head}{separator}{case(weekday)}") == head
        assert strip_dates(f"{case(weekday)}{separator}{head}") == head

    @given(
        hour=st.integers(min_value=0, max_value=23),
        minute=st.integers(min_value=0, max_value=59),
        second=st.integers(min_value=0, max_value=59),
        form=st.sampled_from(
            [
                "20260816{h}{m}",
                "20260816{h}{m}{s}",
                "2026-08-16-{h}-{m}",
                "2026_08_16_{h}_{m}_{s}",
            ]
        ),
        separator=st.sampled_from(["_", " ", " - "]),
        head=st.sampled_from(["Log", "1_DEHYL", "EDDS - EDDP"]),
    )
    def test_no_date_and_time_is_left(
        self, hour, minute, second, form, separator, head
    ):
        """A date and time written as one run of digits or with hyphens."""
        stamp = form.format(h=f"{hour:02d}", m=f"{minute:02d}", s=f"{second:02d}")
        assert strip_dates(f"{head}{separator}{stamp}") == head
        assert find_date_tokens(stamp) != []
        assert find_time_tokens(stamp) != []

    @given(
        first=st.integers(min_value=0, max_value=23 * 60 + 59),
        second=st.integers(min_value=0, max_value=23 * 60 + 59),
        zone=st.sampled_from(["Z", "L", "z", " LT", " CET", " local"]),
        head=st.sampled_from(["Block", "1_DEHYL_DA40", "EDDS"]),
    )
    def test_no_end_of_a_range_is_left(self, first, second, zone, head):
        """The second time of a range is no registration after a prefix."""
        start = f"{first // 60:02d}{first % 60:02d}{zone}"
        end = f"{second // 60:02d}{second % 60:02d}{zone}"
        assert strip_dates(f"{head} {start}-{end}") == head
        assert find_time_tokens(f"{head} {start}-{end}") == [f"{start}-{end}"]
        assert find_time_tokens(f"{head} {start} - {end}") == [start, end]

    @given(
        number=st.integers(min_value=0, max_value=9999),
        head=st.sampled_from(["HB", "D", "OE", "N", "RA"]),
        suffix=st.sampled_from(["", "Z", "H", "L"]),
    )
    def test_registrations_are_kept(self, number, head, suffix):
        """A nationality prefix and its hyphen, or a letter, before the
        digits make them a registration."""
        joined = "" if head == "N" else "-"
        registration = f"{head}{joined}{number:04d}{suffix}"
        assert strip_dates(f"{registration} EDDS") == f"{registration} EDDS"


def test_month_number():
    assert month_number("aug") == month_number("August") == 8
    assert month_number("Flight") is None
