# Privacy

What the generated site holds and what it leaves out, what the page and the
build ask other servers for, and how to scrub the KML files themselves.

## What the site carries

**The generated site carries no flight date finer than the year.** Flight paths
keep only relative seconds since the start of each flight, which is enough for
the replay and the speed colours; a flight keeps its year, and nothing else.
That holds whatever the input files contain, so nothing has to be done to them
before generating a site. The site shows where you have been and how much you
have flown, but not when.

The one full date it does carry is when it was built: `map_config.js` holds the
build date (the day in UTC, without the time) and the short hash of the commit
it was built from, and the statistics panel shows both. A site built right after
a flight therefore hints at the day of that flight, but not at its time. Set
`SOURCE_DATE_EPOCH` to stamp a different day. The commit is `KML_HEATMAP_COMMIT`
(with its remote in `KML_HEATMAP_REPOSITORY`, which `make build` sets from your
checkout), else `GITHUB_SHA` on GitHub Actions (in the repository
`GITHUB_REPOSITORY` names, on the server `GITHUB_SERVER_URL` names, which is
`https://github.com` unless the workflow runs on GitHub Enterprise, so the link
is right on a fork as well), else `HEAD` of the checkout the tool runs from. The
hash links to the commit only when the repository is known.

That is the site. A repository the KML files are committed to keeps its own
dates: a public one dates every committed flight to the day of its commit, in
the commit itself, in the Actions run it started and in the Pages deployment
that followed, however well the files are obfuscated. Whoever publishes their
flights in a public repository should therefore commit them in batches, some
time after the last of them, or with coarse commit dates (`GIT_AUTHOR_DATE` and
`GIT_COMMITTER_DATE` set to the first of the month, say), so that no commit
dates a flight. The pre-push hook (`make hooks`) warns when a push adds a single
flight.

## Your input files

**Your input files are read and left alone** unless you pass
`--obfuscate-inputs`, which cannot be undone.

## Requests to other servers

**The build asks AWS for the elevation tiles of the area you flew over** (see
[Elevation data](output.md#elevation-data)): tiles of about 25 km across at 50
degrees north, fetched once and cached, with nothing else in the request. Pass
`--no-terrain` to build without them.

**The build downloads the OurAirports database** (see
[Airport database](output.md#airport-database)): the airports and runways CSV
files from GitHub Pages (`davidmegginson.github.io`), on the first run and again
once the cached copy is 30 days old, with nothing about your flights in the
request.

**The page asks AWS for the elevation tiles of the area in view** while the 3D
view is on, at every zoom, to draw or shade the relief: AWS sees the visitor's
address and which tiles, so roughly where on the map they look, as CARTO does
for the base map. Nothing is fetched from AWS otherwise.

**The page asks EOX for the satellite imagery of the area in view** while the
Satellite switch is on (see [Satellite imagery](output.md#satellite-imagery)):
EOX sees the visitor's address and which tiles, as AWS and CARTO do. Nothing is
fetched from EOX while it is off, and it is off unless the visitor, their saved
state or the link they followed turns it on.

**The page asks open flightmaps for the aviation charts of the area in view**
while the Aviation switch is on and the map is zoomed in far enough to draw them
(see [Aviation](features.md#aviation)): its tile server
(`nwy-tiles-api.prod.newaydata.com`) sees the visitor's address and which tiles,
as EOX does. Nothing is fetched from it while the switch is off, which it is
unless the visitor, their saved state or the link they followed turns it on.

## Obfuscating the KML files themselves

That is a separate need: this repository commits the files in `data/`, and they
must not carry real dates. `--obfuscate-inputs`, or
`python -m kml_heatmap.obfuscate <dir>` on its own, rewrites them in place
(atomically, after validation). The timestamps of a flight are shifted by one
offset of whole seconds so that it starts at 00:00:00 UTC on January 1st of its
year: the intervals between its points, the gaps between its tracks and so its
durations, speeds, landings and flight time stay exactly as they were, while
neither its date nor its time of day is left. A flight across midnight stays in
one piece and in the year it started in. A file holding flights on several dates
moves each of them to midnight on January 1st of its own year. Date-bearing
names, descriptions (a Charterware description keeps `12:00AM` as its time),
Charterware file names and the creator field are replaced. Read-only files and
symlinks are reported instead of rewritten. Obfuscated KML files still contain:

- The year of each flight
- The durations between points, counted from midnight
- Full precision coordinates and altitudes
- The order of the flights (from the file numbering)

`python -m kml_heatmap.obfuscate <dir> --check` verifies a directory: the first
timestamp of every flight must be 00:00:00 on January 1st (a fraction of a
second may follow), and no other date may appear anywhere in a file or its name
(numeric, or with an English or German month name such as `16 Aug 2026` or
`16. Mai 2026`), except the two days after January 1st that a flight past
midnight runs into. Nor may a weekday named in full (`Saturday`, `Samstag`,
`sonntags`): the timestamps no longer fall on it. The name of a file carries no
time of day either (`1513h`, `1513H`, `15h13`, `0930Z`, `0930z`, `0930UTC`,
`15:13`, `3pm`, `1430 GMT`, `1430 Zulu`, `14:30 EST`, `1430 local`,
`0930 hours`, `14.30Z`, `0930Z-1045Z`, `14:30 +02:00`, `1430+0200`), except for
the sequence number in the time slot of an obfuscated Charterware name, and
neither do its names and descriptions, nor a Unix time of a past day in the text
of an element (see
[Troubleshooting](usage.md#make-check-obfuscation-or-the-commit-hook-fails)). A
comment or processing instruction inside a text hides nothing from the check
(`16<!-- -->.08.2026`). The timestamps of one track (a gx:Track, the tracks of a
gx:MultiTrack, or a Placemark without either that is no point marker) count as
one flight and are never split, and so do tracks no more than 12 hours apart in
one year; the TimeStamp of a point marker joins the flight before it within two
hours, across New Year too. A track that starts after New Year keeps its year,
as the site does, even right after a flight that ended the night before, unless
it overlaps that flight in time or its Placemark has a TimeSpan that begins
before New Year: then it moves into the year that flight or that TimeSpan starts
in. A recording that runs longer than those days fails the check rather than
being cut in two. When a date cannot be removed (in a file name, say, or an
element the tool does not rewrite), the rewrite lists it and stops rather than
leaving a file half scrubbed.

## What reaches the site

Kept in the site:

- Coordinates, altitudes, distances, groundspeeds
- Airport visit counts
- Per flight, the number of full-stop landings, touch-and-goes and go-arounds,
  and the field and runway of each touchdown, without a time
- Flight time per year and per aircraft
- Airport names: a placemark name that holds an ICAO code (`EDDS`,
  `EDAQ Halle-Oppin`), and both sides of a route name as written, with or
  without a code (`Home strip - Aunt farm`). A route name between two people
  (`Anna Mueller - Bob Smith`) therefore publishes their names as airports,
  unless a field with a code is next to them. The build warns with every name it
  publishes whose code is not in the airport database, so a name that only looks
  like one (`ANNA Mueller`) is named too, and `--list` names them below its
  table
- The aircraft registration and type of a file name (`1_DEHYL_DA40.kml`); the
  type only when it is a type designator with a digit (`DA40`, `C172`,
  `PA-28-181`) or one of the ICAO designators without one (`GLID`), in capitals.
  Any other text there is dropped with a warning, a type of letters alone too
  (see [the rule](usage.md#kml-file-naming-convention))
- The order of the flights: each year lists them in input order, which is the
  order of their dates for numbered and Charterware file names. Together with
  the speeds, tracks and runways of each flight, that order narrows down when
  each one was flown, for someone who compares them with weather archives or the
  flights of others
- The same again in the link preview pages of each year and flight (their year,
  airports and aircraft), and images of the tracks

Removed from the site:

- Individual flight dates and times
- Any other placemark name: free text such as `Flight with Anna` or
  `Untitled Path` is no airport name, and the start of such a flight gets no
  airport marker at all
- Dates and times of day in placemark and file names (`16 Aug 2026`,
  `the 16th of August 2026`, `16/Aug/2026`, `16/08`, `16-08`, `16_08`, `26.08`,
  `16.8`, `16 08 2026`, `16AUG26`, `16-AUG-26`, `260816`, `03/2026`,
  `2026/8/16`, `KW33 2026`, `KW33`, `Week 33`, `2026W33`, `14:30`, `1430Z`,
  `0930z`, `1430 UTC`, `1430L`, `1513h`, `1513H`, `1430hrs`, `14h30`, `15.13h`,
  `14.30 Uhr`, `3pm`, `0930Z-1045Z`, `2026-08-16_1430`, `2026-08-16-14-30`,
  `202608161430`), with the zone, the fraction of a second or the offset that
  follows a time (`1430 GMT`, `1430 Zulu`, `09:30 EDT`, `14:30 AEST`,
  `1430 local`, `0930 hours`, `14:30:00.5Z`, `14:30 +02:00`, `1430+0200`; the
  common zones, not every one there is), also with German month names written
  day first (`16. Mai 2026`, `16. März`, `16MAI26`, `Mai 2026`); a month name
  alone (`Flugplatz Juli`) stays, and so do runway designators in a name that
  speaks of a runway (`RWY 08/26`, `07L/25R`) and a version after a word that
  says so (`firmware 12.10`), while a bare `26/08` is August 26th and
  `EDDS 07/25` July 25th (or July 2025): where a name could hold a date, the
  date goes. A registration that looks like a time keeps it (`N1513H`,
  `RA-1430L`), and `W33` alone is the code of an airport in the US as often. A
  time written with a dot and nothing else (`Aunt farm 14.30`) stays, since it
  cannot be told from a decimal (`Fuel 14.30`); with a zone, the local time, the
  hours or `Uhr` it goes (`14.30Z`, `14.30 UTC`, `14.30L`, `14.30 hrs`,
  `15.13h`, `14.30 Uhr`). Four digits before `hours` go even where they count
  the hours of an engine (`Engine 1500 hours`)
- Weekdays in placemark and file names: named in full in English or German
  wherever they stand (`Saturday`, `Sundays`, `Samstag`, `sonntags`,
  `Sonntagsflug`, `Samstagnachmittag`), and abbreviated only right next to a
  date or a time (`Sat 16 Aug 2026`, `Sa., 16.08.2026`, `16.08.2026 (Sa)`). An
  abbreviation on its own stays, since it is as often something else: `Sun` and
  `Sat` are words, `SAT` and `THU` airport codes, `Do 27` a Dornier, and a
  letter or a hyphen before it makes it a part of a registration (`D-EFRI`,
  `OE-SAT`). Aircraft types (`C172`, `PA28`, `DA20`, `SR22`) and ICAO codes
  (`EDMO`) are never touched. The places named after a weekday keep it
  (`Friday Harbor`, `Thursday Island`, `Sunday Creek`); a family name such as
  `Freitag` does not
- A registration that holds a date, a time of day or a weekday
  (`1_16AUG26_DA40.kml`, `1_MONDAY_DA40.kml`), with a warning

The CARTO key is a public client-side tile key. It is embedded in the generated
`map_config.js` and published with the site by design, because the browser needs
it to load the base map. The generated site is not committed; the key lives in
the repository secrets and in the deployed site only.
