# Adding flights

This is the workflow for this repository, whose flights live in `data/` and
whose site is published from it. With your own fork or a local directory the
steps are the same; only the last one (publishing) depends on GitHub Pages.

## 1. Export the flight

- **SkyDemon**: export the flight's track log as a KML file (the Google Earth
  format). SkyDemon writes the track as a `gx:Track` with a time for every
  point, so the speed layer, the flight time and the replay work.
- **Charterware**: download the flight's KML file and keep the name it comes
  with (`YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE.kml`). Charterware tracks carry no
  time per point, so the speed layer, the flight time and the replay are not
  available for them (see
  [KML file naming convention](usage.md#kml-file-naming-convention)).

Other apps work as long as the file holds the track as a `LineString` or a
`gx:Track` and a date somewhere the parser finds it (see
[Troubleshooting](usage.md#troubleshooting)).

## 2. Name the file and put it into `data/`

Rename a SkyDemon export to `N_REGISTRATION_TYPE.kml` and copy it into `data/`:

- `N` is the next free flight number: one more than the highest number already
  in `data/` (`ls data | sort -n | tail -n 1`). The numbers keep the flights in
  chronological order, and the files are processed in that order.
- `REGISTRATION` is the registration without its hyphen (`DEHYL` for `D-EHYL`).
- `TYPE` is the aircraft type designator (`DA40`, `C172`).

For example, the flight after `103_DESST_C172.kml` in D-EHYL is
`104_DEHYL_DA40.kml`. A Charterware file keeps its own name. The full rules are
in [KML file naming convention](usage.md#kml-file-naming-convention).

## 3. Add the aircraft if it is new

The registration in the file name decides which aircraft a flight belongs to.
For a registration that has not flown before, add it with its full model name to
`data/aircraft.json`, written with the hyphen:

```json
{
  "D-EHYL": "Diamond DA-40TDI Diamond Star",
  "D-EXYZ": "Piper PA-28-181 Archer III"
}
```

Without an entry the flight still counts for the aircraft, which then shows the
type from the file name instead of a model name (see
[Aircraft model data](usage.md#aircraft-model-data)).

## 4. Obfuscate the new files

```bash
make obfuscate          # python -m kml_heatmap.obfuscate data
make check-obfuscation  # every file in data/ passes
```

The published site never carries a date finer than the year, whatever the KML
files hold. The files in `data/` are committed to a public repository, though,
so they must not carry real dates or times either. `make obfuscate` rewrites
them in place, irreversibly: every flight moves to start at midnight (UTC) on
January 1st of its year (the intervals between its points stay, its time of day
does not), dates in placemark names and descriptions and the creator field are
replaced, and a Charterware file is renamed to `YYYY-01-01_NNNNh_...` with a
sequence number in place of the time. Files that are already obfuscated are left
as they are; files obfuscated by an earlier version, which kept the time of day,
fail the check until `make obfuscate` has moved them to midnight. Keep a copy of
the original export if you want the real dates. It runs locally and needs the
Python environment from [CONTRIBUTING.md](../CONTRIBUTING.md);
`--obfuscate-inputs` does the same as part of a build. See [Privacy](privacy.md)
for what is kept.

## 5. Build and preview the site

```bash
make build        # builds the container image and generates docs/ from data/
make serve        # http://127.0.0.1:8000/
```

Without podman or docker, build from the checkout instead:

```bash
npm ci && npm run build
python -m kml_heatmap data --output-dir docs
python -m http.server 8000 --bind 127.0.0.1 -d docs
```

A local build has no tile API key unless you pass one (see
[With an API key](usage.md#with-an-api-key-optional)). The base map loads
without one today, and the flights do not depend on it.

## 6. Check the result

`python -m kml_heatmap --list data` is the quick way to see that a flight is in:
it prints a line for every flight with its year, aircraft and airports, and says
why the site would leave any of them out, without building anything.

In the build output (on a terminal; where the output goes to a file or a pipe,
as with `make build` and in CI, `✓` is written `[ok]` and `⚠` is written `[!]`):

- `✓ Loaded N points from <file>` (or `[ok] Loaded N points from <file>`) for
  the new file, and no warning about it (see
  [Troubleshooting](usage.md#troubleshooting) for the warnings that matter)
- A `✓` (`[ok]`) line with the registration and its model in the aircraft list;
  a `⚠` (`[!]`) line there means `aircraft.json` has no model for it

On the map:

- The year of the flight is in the year filter, and with that year selected the
  flight count in the statistics went up by one
- The track is drawn where you flew, and with Altitude or Groundspeed on,
  clicking it selects it
- The departure and arrival airports have markers with their ICAO codes
- The aircraft appears in the aircraft filter with its model name
- For a SkyDemon flight: the speed layer colours the track and Replay plays it
  with the flight selected

## 7. Commit and publish

```bash
git add data/
git commit -s -m "chore: add flight 104"
```

`git add data/` picks up renamed Charterware files and `aircraft.json` as well.
Install the hooks once: with the pre-commit hooks (see
[CONTRIBUTING.md](../CONTRIBUTING.md)) the commit fails while a file in `data/`
is not obfuscated, and the pre-push hook (`make hooks`, which needs only Python)
refuses to push a commit that carries one. The `obfuscation` CI job catches the
same mistake only after the push, when the real dates are already public.

Open a pull request or push to `main`. On `main`, the `test` workflow runs every
test job against the new data, including the obfuscation check; once they pass,
its `site` job builds the site from `data/` with the tile API key from the
repository secrets and its `deploy` job publishes it to GitHub Pages. Nothing
generated is committed: the local `docs/` stays out of git. A pull request runs
the same tests but publishes nothing. To publish the site anywhere else, see
[Hosting](hosting.md).
