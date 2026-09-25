"""Dates written into free text: finding them and taking them out.

The obfuscator's check looks for dates that give a flight away
(``find_date_tokens`` with ``skip_near_jan_first``), and the export takes
every date out of the names it publishes (``strip_dates``): placemark names
and file names are free text, and "Sunday flight 16 Aug 2026" would publish
the day of the flight.

Numeric dates: 2024-03-14, 2024.03.14, 14.03.2024, 14/03/2024, 14-03-2024,
3/14/2024, 14.03.24, 2024/3/14, 2024-3-4, the compact 20240314, the year
and month 2024-03, the ISO week 2024-W11 and the ordinal date 2024-074.
With a month name: "14 Mar 2024", "14th March 2024", "14-MAR-2024",
"March 14, 2024", "Mar14_2024" and "March 2024", and in German, day first:
"14. März 2024", "14.Mrz.2024", "14-Okt-2024" and "Mai 2024".

Names lose more than that (``strip_dates``): a day and month without the
year ("16 Aug", "16. Mai", "16AUG26", "16.08.", "16/08"), which the year of
the flight completes, a month and year ("03/2026", "03.2026", "2026/03")
and a time of day ("14:30", "1430Z", the time after a date as in
20260816T1430 or 2026-08-16_1430).
"""

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = [
    "MAX_DAYS_AFTER_JAN_1",
    "MONTHS_LONG",
    "MONTHS_SHORT",
    "find_date_tokens",
    "month_number",
    "near_jan_first",
    "strip_dates",
]

# The obfuscator moves a flight to January 1st, and a flight keeps its
# intervals, so after the shift its timestamps may run into the following
# days. Dates up to this many days after January 1st are no giveaway.
MAX_DAYS_AFTER_JAN_1 = 2

MONTHS_SHORT = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)
MONTHS_LONG = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
_MONTH_NUMBERS = {name.lower(): i + 1 for i, name in enumerate(MONTHS_LONG)}
_MONTH_NUMBERS.update({name.lower(): i + 1 for i, name in enumerate(MONTHS_SHORT)})
# The four-letter abbreviation that is common in English as well
_MONTH_NUMBERS["sept"] = 9
# The German names that English does not share (Aug, Nov and the like it
# does), with the Austrian Jänner. Only read in the shapes German writes a
# date in, the day first ("16. Mai 2026") or a month and year ("Mai 2026"):
# "Mai" or "Juli" alone is a name as often.
_GERMAN_MONTH_NUMBERS = {
    "januar": 1,
    "jänner": 1,
    "jaenner": 1,
    "jän": 1,
    "februar": 2,
    "märz": 3,
    "maerz": 3,
    "mär": 3,
    "mrz": 3,
    "mai": 5,
    "juni": 6,
    "juli": 7,
    "oktober": 10,
    "okt": 10,
    "dezember": 12,
    "dez": 12,
}

_DAYS_AFTER_JAN_1 = "|".join(f"{day:02d}" for day in range(1, MAX_DAYS_AFTER_JAN_1 + 2))


def _numeric_patterns(skip_near_jan_first: bool) -> tuple[re.Pattern[str], ...]:
    """The numeric date shapes, with or without the days after January 1st.

    The obfuscator's check leaves those days out in the patterns themselves:
    every timestamp holds such a date, and testing each one in Python
    doubled the time of the check. The shapes other than ISO only pass as
    01.01, since the tool never writes them and 02/01 is February 1st in the
    US.
    """

    def unless(lookahead: str) -> str:
        return f"(?!{lookahead})" if skip_near_jan_first else ""

    days = _DAYS_AFTER_JAN_1
    short_days = "|".join(str(day) for day in range(1, MAX_DAYS_AFTER_JAN_1 + 2))
    return (
        # 2024-03-14, and 2024_03_14 from a file name
        re.compile(
            r"(?<!\d)\d{4}(?P<sep>[-_])"
            + unless(rf"01(?P=sep)(?:{days})(?!\d)")
            + r"\d{2}(?P=sep)\d{2}(?!\d)"
        ),
        re.compile(
            r"(?<![\d.])\d{4}(?P<sep>[./])"
            + unless(r"01(?P=sep)01(?!\d)")
            + r"\d{2}(?P=sep)\d{2}(?!\d|\.\d)"
        ),
        # 2024/3/14 and 2024-3-4: a year first and a month or day of one
        # digit (two of each are the shapes above). Only a real month and
        # day of this or the last century, and not with dots: 2024.3.1 is a
        # version number as often as a date.
        re.compile(
            r"(?<![\d.])(?:19|20)\d{2}(?P<sep>[-_/])"
            + unless(rf"0?1(?P=sep)0?(?:{short_days})(?!\d)")
            + r"(?=\d(?!\d)|\d{2}(?P=sep)\d(?!\d))"
            + r"(?:0?[1-9]|1[0-2])(?P=sep)(?:0?[1-9]|[12]\d|3[01])(?!\d|\.\d)"
        ),
        # Day first or month first, with a two- or four-digit year
        re.compile(
            r"(?<![\d.])"
            + unless(r"0?1(?P<skip>[./-])0?1(?P=skip)\d{2}(?:\d{2})?(?!\d|\.\d)")
            + r"\d{1,2}(?P<sep>[./-])\d{1,2}(?P=sep)\d{2}(?:\d{2})?(?!\d|\.\d)"
        ),
        # 2024-03 (a year and month), 2024-W11 (an ISO week) and 2024-074 (an
        # ordinal date); January, the first week and the first days pass
        re.compile(
            r"(?<!\d)\d{4}-" + unless(r"01(?![\d-])") + r"(?:0[1-9]|1[0-2])(?![\d-])"
        ),
        re.compile(
            r"(?<!\d)\d{4}-W"
            + unless(r"01(?!\d)")
            + r"(?:0[1-9]|[1-4]\d|5[0-3])(?:-[1-7])?(?!\d)"
        ),
        re.compile(
            r"(?<!\d)\d{4}-"
            + unless(rf"0(?:{days})(?!\d)")
            + r"(?:00[1-9]|0[1-9]\d|[12]\d\d|3[0-5]\d|36[0-6])(?![\d-])"
        ),
        # 20240314: only years of this and the last century, and a real month
        # and day, so that a serial number rarely passes as a date
        re.compile(
            r"(?<!\d)(?:19|20)\d{2}"
            + unless(rf"01(?:{days})(?!\d)")
            + r"(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?!\d)"
        ),
    )


_NUMERIC_STRAY = _numeric_patterns(skip_near_jan_first=True)
_NUMERIC_ALL = _numeric_patterns(skip_near_jan_first=False)

_MONTH_RE = r"[A-Za-z]{3,9}"
_DAY_RE = r"\d{1,2}(?:st|nd|rd|th)?"
_SEP_RE = r"[\s_.,-]"
_TEXT_MONTH = re.compile(
    rf"(?<![A-Za-z\d])(?P<day1>{_DAY_RE}){_SEP_RE}*(?P<month1>{_MONTH_RE})"
    rf"{_SEP_RE}*(?P<year1>\d{{4}})(?!\d)|"
    rf"(?<![A-Za-z])(?P<month2>{_MONTH_RE}){_SEP_RE}*(?P<day2>{_DAY_RE})"
    rf"{_SEP_RE}*(?P<year2>\d{{4}})(?!\d)|"
    rf"(?<![A-Za-z])(?P<month3>{_MONTH_RE}){_SEP_RE}+(?P<year3>\d{{4}})(?!\d)"
)
# Only taken out of names: a day and a month without the year ("16 Aug",
# "August 16th"), which the year of the flight completes, and a time of day
# ("Flight 16 August" must not match "Flight 16" first, so only month names)
_MONTH_NAME_RE = "(?i:" + "|".join(sorted(_MONTH_NUMBERS, key=len, reverse=True)) + ")"
# The day-first form takes a two-digit year written right after the month
# along ("16AUG26"), or the year would be left behind on its own.
_TEXT_MONTH_WITHOUT_YEAR = re.compile(
    rf"(?<![A-Za-z\d])(?P<day1>{_DAY_RE}){_SEP_RE}*(?P<month1>{_MONTH_NAME_RE})"
    r"(?![A-Za-z])(?:\d{2}(?!\d))?|"
    rf"(?<![A-Za-z])(?P<month2>{_MONTH_NAME_RE}){_SEP_RE}*(?P<day2>{_DAY_RE})"
    r"(?![A-Za-z\d])"
)
# The same in German: a day and month with a year ("16. Mai 2026",
# "16.Mai.2026", "16-Mai-2026") or without one ("16. Mai", "16MAI26" with its
# two-digit year), and a month with a year ("Mai 2026"). No letter may touch
# the name on either side, umlauts included ("Maier 2026" is no date).
# Only years of this and the last century: "Juli 7000" is a squawk
_YEAR_RE = r"(?:19|20)\d{2}"
_GERMAN_MONTH_RE = (
    "(?i:" + "|".join(sorted(_GERMAN_MONTH_NUMBERS, key=len, reverse=True)) + ")"
)
_GERMAN_MONTH = rf"(?<![^\W\d_])(?:{_GERMAN_MONTH_RE})(?![^\W\d_])"
_TEXT_MONTH_GERMAN = re.compile(
    rf"(?<![^\W_])(?P<day1>\d{{1,2}}){_SEP_RE}*(?P<month1>{_GERMAN_MONTH})"
    rf"{_SEP_RE}*(?P<year1>{_YEAR_RE})(?!\d)|"
    rf"(?P<month3>{_GERMAN_MONTH}){_SEP_RE}+(?P<year3>{_YEAR_RE})(?!\d)"
)
_TEXT_MONTH_GERMAN_WITHOUT_YEAR = re.compile(
    rf"(?<![^\W_])(?P<day1>\d{{1,2}}){_SEP_RE}*(?P<month1>{_GERMAN_MONTH})"
    r"(?:\d{2}(?!\d))?"
)
# A day and month in German notation, "16.08.", with the year left out
_DAY_MONTH_DOTTED = re.compile(
    r"(?<![\d.])(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?![\d.])"
)
# A day and month with a slash, "16/08" or "08/16", with the year left out;
# which of them is a date is up to _is_day_month
_DAY_MONTH_SLASHED = re.compile(
    r"(?<![\w./])(?P<first>\d{1,2})/(?P<second>\d{1,2})(?![\w/]|\.\d)"
)
# A runway is named by its two directions, which are 180 degrees apart:
# 08/26, 16/34. 26/08 is August 26th as well, so such a pair only counts as
# a runway in a name that says it speaks of one.
_RUNWAY_DIFFERENCE = 18
_RUNWAY_WORD = re.compile(r"(?i:\b(?:rwys?|rw|runways?|piste|(?:lande)?bahn)\b)")
# A month and a year without the day: "03/2026", "3/2026", "03.2026" and
# "2026/03" (2026-03 is one of the numeric shapes above). With a dot only
# month first and of two digits: 2026.3 is a version number and 3.2026 a
# decimal. A decimal such as 12.2026 goes as well, which a name rarely has.
_MONTH_YEAR = re.compile(
    r"(?<![\w./])(?:(?:0?[1-9]|1[0-2])/|(?:0[1-9]|1[0-2])\.)(?:19|20)\d{2}"
    r"(?![\w/]|\.\d)|"
    r"(?<![\w./])(?:19|20)\d{2}/(?:0?[1-9]|1[0-2])(?![\w/]|\.\d)"
)
_TIME_OF_DAY = re.compile(
    r"(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?"
    r"(?:\s*(?:Z|UTC|[AaPp]\.?[Mm]\.?)(?![A-Za-z]))?(?![\d:])"
)
# A time of day without a colon: "1430Z", "1430 UTC", and the "T1430" an
# ISO basic timestamp (20260816T1430) leaves once its date is out. Four
# digits alone are an altitude or a squawk as often, so only these forms.
_HHMM = r"(?:[01]\d|2[0-3])[0-5]\d(?:[0-5]\d)?"
_COMPACT_TIME = re.compile(
    rf"(?<![A-Za-z\d])(?:T{_HHMM}(?:Z|UTC)?|{_HHMM}\s*(?:Z|UTC))(?![A-Za-z\d])"
)
# The time of day right after a date is one in any form: the "T14:30:00Z"
# of an ISO timestamp, whose T would be left behind otherwise, and the
# "1430" of 20260816-1430 or 2026-08-16_1430, with fractions of a second and
# a UTC offset
_TIME_AFTER_DATE = re.compile(
    rf"(?:[-_\s]|T)(?:{_HHMM}|(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)"
    r"(?:\.\d+)?h?(?:\s*(?:Z|UTC)|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?"
    r"(?![A-Za-z\d:])"
)
# What is left around a removed date: separators at either end, a separator
# that now stands next to another one, and empty brackets
_EDGE_SEPARATORS = re.compile(r"^[\s\-_,.:;/|]+|[\s\-_,.:;/|]+$")
_DOUBLE_SEPARATORS = re.compile(r"\s*([-_,;/|])(?:\s*[-_,;/|])+\s*")
_EMPTY_BRACKETS = re.compile(r"\(\s*\)|\[\s*\]")
_SPACES = re.compile(r"\s+")


def month_number(name: str) -> int | None:
    """The number of an English month name, long or short, in any case."""
    return _MONTH_NUMBERS.get(name.lower())


def near_jan_first(month: int, day: int) -> bool:
    """Whether a date is one of the days a flight moved to January 1st spans."""
    return month == 1 and 1 <= day <= 1 + MAX_DAYS_AFTER_JAN_1


def _is_day_month(first: str, second: str, runways: bool) -> bool:
    """Whether two numbers around a slash are a day and a month.

    Either order, since "08/16" is August 16th in the US. Two numbers of
    one digit are more often a fraction ("1/2"), and in a name that speaks
    of runways (``runways``) a pair of runway directions is a runway (see
    ``_RUNWAY_DIFFERENCE``).
    """
    if len(first) == len(second) == 1:
        return False
    a, b = int(first), int(second)
    if runways and abs(a - b) == _RUNWAY_DIFFERENCE:
        return False
    return (1 <= a <= 31 and 1 <= b <= 12) or (1 <= a <= 12 and 1 <= b <= 31)


def _day_month_slashed_spans(text: str) -> list[tuple[int, int]]:
    runways = _RUNWAY_WORD.search(text) is not None
    return [
        match.span()
        for match in _DAY_MONTH_SLASHED.finditer(text)
        if _is_day_month(match["first"], match["second"], runways)
    ]


def _with_time_after(text: str, spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """The spans of dates, each with the time of day that follows it."""
    extended = []
    for start, end in spans:
        time = _TIME_AFTER_DATE.match(text, end)
        extended.append((start, time.end() if time else end))
    return extended


def _day_number(day_text: str | None) -> int:
    # A month with a year but no day gives the month away as well
    return int(re.sub(r"[a-z]+$", "", day_text)) if day_text else 1


def _german_month_number(name: str) -> int | None:
    return _GERMAN_MONTH_NUMBERS.get(name.lower())


def _text_month_spans(
    pattern: re.Pattern[str],
    text: str,
    skip_near_jan_first: bool,
    months: Callable[[str], int | None] = month_number,
) -> list[tuple[int, int]]:
    """The dates with a month name that ``pattern`` finds in a text.

    ``months`` gives the number of a month name, None for a word that is no
    month name.
    """
    spans = []
    for match in pattern.finditer(text):
        groups = match.groupdict()
        month_name = (
            groups.get("month1") or groups.get("month2") or groups.get("month3")
        )
        month = months(month_name or "")
        if month is None:
            continue
        day = _day_number(groups.get("day1") or groups.get("day2"))
        if skip_near_jan_first and near_jan_first(month, day):
            continue
        spans.append(match.span())
    return spans


def find_date_tokens(text: str, *, skip_near_jan_first: bool = False) -> list[str]:
    """The date-like tokens of a text, in the order of the patterns.

    With ``skip_near_jan_first`` the dates within ``MAX_DAYS_AFTER_JAN_1``
    days after January 1st are left out: those of an obfuscated file.
    """
    numeric = _NUMERIC_STRAY if skip_near_jan_first else _NUMERIC_ALL
    found = [match.group(0) for pattern in numeric for match in pattern.finditer(text)]
    found.extend(
        text[start:end]
        for start, end in _text_month_spans(_TEXT_MONTH, text, skip_near_jan_first)
        + _text_month_spans(
            _TEXT_MONTH_GERMAN, text, skip_near_jan_first, _german_month_number
        )
    )
    return found


def strip_dates(text: str | None) -> str | None:
    """A name without its dates and times of day, None when nothing is left.

    Every date shape of ``find_date_tokens`` is taken out, and so are a day
    and month without a year and a time of day. The separators the date
    stood between go with it ("EDDS to EDDP - 16 Aug 2026" is "EDDS to
    EDDP"). A name without a single letter left says nothing and is None.

    Runway designators (RWY 08/26, 07L/25R), frequencies (118.500),
    altitudes and squawks (7000, FL100) are no dates and stay.
    """
    if not text:
        return None
    spans = [
        match.span() for pattern in _NUMERIC_ALL for match in pattern.finditer(text)
    ]
    spans.extend(_text_month_spans(_TEXT_MONTH, text, skip_near_jan_first=False))
    spans.extend(
        _text_month_spans(_TEXT_MONTH_GERMAN, text, False, _german_month_number)
    )
    # The common case, and the one that keeps a name exactly as it was
    if (
        not spans
        and not _TEXT_MONTH_WITHOUT_YEAR.search(text)
        and not _TEXT_MONTH_GERMAN_WITHOUT_YEAR.search(text)
        and not _DAY_MONTH_DOTTED.search(text)
        and not _day_month_slashed_spans(text)
        and not _MONTH_YEAR.search(text)
        and not _TIME_OF_DAY.search(text)
        and not _COMPACT_TIME.search(text)
    ):
        return text if any(c.isalpha() for c in text) else None

    stripped = _blank(text, _with_time_after(text, spans))
    stripped = _blank(
        stripped,
        _with_time_after(
            stripped,
            _text_month_spans(_TEXT_MONTH_WITHOUT_YEAR, stripped, False)
            + _text_month_spans(
                _TEXT_MONTH_GERMAN_WITHOUT_YEAR, stripped, False, _german_month_number
            )
            + [match.span() for match in _DAY_MONTH_DOTTED.finditer(stripped)]
            + _day_month_slashed_spans(stripped)
            + [match.span() for match in _MONTH_YEAR.finditer(stripped)],
        )
        + [match.span() for match in _TIME_OF_DAY.finditer(stripped)]
        + [match.span() for match in _COMPACT_TIME.finditer(stripped)],
    )
    stripped = _EMPTY_BRACKETS.sub(" ", stripped)
    stripped = _DOUBLE_SEPARATORS.sub(lambda m: f" {m.group(1)} ", stripped)
    stripped = _SPACES.sub(" ", stripped)
    stripped = _EDGE_SEPARATORS.sub("", stripped)
    return stripped if any(c.isalpha() for c in stripped) else None


def _blank(text: str, spans: list[tuple[int, int]]) -> str:
    """``text`` with every span replaced by a space."""
    if not spans:
        return text
    covered = bytearray(len(text))
    for start, end in spans:
        covered[start:end] = b"\x01" * (end - start)
    return "".join(" " if covered[i] else char for i, char in enumerate(text))
