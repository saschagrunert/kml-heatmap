"""Dates written into free text: finding them and taking them out.

The obfuscator's check looks for dates that give a flight away
(``find_date_tokens`` with ``skip_near_jan_first``), and the export takes
every date out of the names it publishes (``strip_dates``): placemark names
and file names are free text, and "Sunday flight 16 Aug 2026" would publish
the day of the flight.

Numeric dates: 2024-03-14, 2024.03.14, 14.03.2024, 14/03/2024, 14-03-2024,
3/14/2024, 14.03.24, the compact 20240314, the year and month 2024-03, the
ISO week 2024-W11 and the ordinal date 2024-074. With a month name:
"14 Mar 2024", "14th March 2024", "14-MAR-2024", "March 14, 2024",
"Mar14_2024" and "March 2024".
"""

import re

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
_TEXT_MONTH_WITHOUT_YEAR = re.compile(
    rf"(?<![A-Za-z\d])(?P<day1>{_DAY_RE}){_SEP_RE}*(?P<month1>{_MONTH_NAME_RE})"
    r"(?![A-Za-z])|"
    rf"(?<![A-Za-z])(?P<month2>{_MONTH_NAME_RE}){_SEP_RE}*(?P<day2>{_DAY_RE})"
    r"(?![A-Za-z\d])"
)
# A day and month in German notation, "16.08.", with the year left out
_DAY_MONTH_DOTTED = re.compile(
    r"(?<![\d.])(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?![\d.])"
)
_TIME_OF_DAY = re.compile(
    r"(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?"
    r"(?:\s*(?:Z|UTC|[AaPp]\.?[Mm]\.?)(?![A-Za-z]))?(?![\d:])"
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


def _day_number(day_text: str | None) -> int:
    # A month with a year but no day gives the month away as well
    return int(re.sub(r"[a-z]+$", "", day_text)) if day_text else 1


def _text_month_spans(
    pattern: re.Pattern[str], text: str, skip_near_jan_first: bool
) -> list[tuple[int, int]]:
    spans = []
    for match in pattern.finditer(text):
        groups = match.groupdict()
        month_name = groups["month1"] or groups["month2"] or groups.get("month3")
        month = month_number(month_name or "")
        if month is None:
            continue
        day = _day_number(groups["day1"] or groups["day2"])
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
    )
    return found


def strip_dates(text: str | None) -> str | None:
    """A name without its dates and times of day, None when nothing is left.

    Every date shape of ``find_date_tokens`` is taken out, and so are a day
    and month without a year and a time of day. The separators the date
    stood between go with it ("EDDS to EDDP - 16 Aug 2026" is "EDDS to
    EDDP"). A name without a single letter left says nothing and is None.
    """
    if not text:
        return None
    spans = [
        match.span() for pattern in _NUMERIC_ALL for match in pattern.finditer(text)
    ]
    spans.extend(_text_month_spans(_TEXT_MONTH, text, skip_near_jan_first=False))
    # The common case, and the one that keeps a name exactly as it was
    if (
        not spans
        and not _TEXT_MONTH_WITHOUT_YEAR.search(text)
        and not _DAY_MONTH_DOTTED.search(text)
        and not _TIME_OF_DAY.search(text)
    ):
        return text if any(c.isalpha() for c in text) else None

    stripped = _blank(text, spans)
    stripped = _blank(
        stripped,
        _text_month_spans(_TEXT_MONTH_WITHOUT_YEAR, stripped, False)
        + [match.span() for match in _TIME_OF_DAY.finditer(stripped)]
        + [match.span() for match in _DAY_MONTH_DOTTED.finditer(stripped)],
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
