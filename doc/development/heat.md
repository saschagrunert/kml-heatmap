# Heat

How the heat is drawn: the flat heatmap and the heat lines it hands over to, the
heat sources the year worker writes for them, the legend and the scale it reads,
the heat cloud of the 3D view, the heat the replay of all flights builds up with
the cloud, and the readout of the cloud under the pointer. What the user sees of
it is described under [Heatmap](../features.md#heatmap) in the map features; the
relief and the ribbons the cloud stands on are in [Rendering](rendering.md).

## The flat heatmap

`ui/heatmapPaint.ts` holds the paint of the heatmap and of the heat lines it
hands over to. A point reaches 18 px out to map zoom 9 and narrows to 13 px at
10 (`HEATMAP_RADIUS_PX`): at the reach of before, the routes of a region, a few
kilometres apart, merged into one blue fog from 8 to 10 and the home field's
circuits into one blot. Out to 9 it reached 22 px, the reference reach, and a
route flown once was a band of even blue as wide as a busy corridor; at 18 px,
with the faintest colours fainter (see
[The low end of the ramp](#the-low-end-of-the-ramp)), a single route is a
slimmer, softer line and the corridors stand out. It keeps its reach while the
clusters are drawn (`HEATMAP_CLUSTER`, up to 9): scaled up towards the next
level they lie up to 12 px apart, and narrowing from 7 on turned a lone track
into a string of beads from 8.5 to 9. The ridge of a track is as high as its
kernel is wide, so the intensity grows as the reach narrows (`intensityAt`, a
stop per half level of the zoom, which follows the narrowing to within 4 %). The
exposure keeps its cells and intensity of the reach of 22 px
(`EXPOSURE_INTENSITY`), so the narrower reach changes no exposure; it is worked
out by the year worker, in `calculations/heatExposure.ts` with that reference
reach (see
[The heat sources and the year worker](#the-heat-sources-and-the-year-worker)
below).

Further in the fixes of a track draw apart on the screen, 20 px at 12, and the
reach widens again, to 16 px at 11 and 24 at 12, so a track stays a line (under
half the reach of 10 on the ground). The heat lines take over from there
(`HEAT_LINES`: they fade in from map zoom 11 to 11.75, `z` 12 to 12.75, and the
heatmap fades out from there to map zoom 12.75, `z` 13.75), and the wide glow of
its last level lies round them as a halo. They took over a level earlier before,
from map zoom 10 to 11.5, which left a map of the towns around a field in thin
lines where its heat was still wanted. The glow of the lines is widest and
strongest where they take over (10 px at 0.3 at 12, settling to 0.18 by 16), so
the map does not drop from the heatmap's halo to hairlines. Their heat is scaled
by the heatmap's exposure and rolled off as its heat is (`heatLineTone`), so the
hand-over keeps the colours.

Kept on that long, the heatmap made the hand-over the dearest stretch of the
map, and zooming in through it stuttered. Nothing is worked out anew on a zoom;
MapLibre draws every point into the heatmap's texture every frame, and at the
home field hundreds of circuits and the apron put thousands of fixes on top of
one another. On a phone's screen (390 by 844 at 3x, timed per layer with
`EXT_disjoint_timer_query_webgl2` on a Radeon RX 9070 XT) a frame took 1.5 ms of
the GPU at `z` 11.5 and 1.8 to 2.1 ms at 12 against 0.6 and 1.1 ms before, the
heatmap's texture alone 0.7 to 0.8 ms and the lines' glow, 10 px from 11 on, 0.4
to 0.65 ms. So the year worker merges the fixes of one pixel at the heatmap's
last zoom into one point of their heat (`mergedPoints` in
`services/heatSource.ts`): at `z` 12 the home field is drawn from 26,000 points
instead of 43,000 and the texture takes 0.3 ms. The weight of such a point (`n`
fixes) keeps the floors of its fixes, and since MapLibre's cut of a kernel now
takes its share once instead of `n` times, the point weighs that much less for
every fix beyond the first (`heatmapWeight`), so the apron keeps most of its
white. Merged or not, the flights of the current year differ in 0.1 % of the
pixels of a screenshot on a desktop and 0.3 % on a phone, those of all years in
0.2 and 0.8 %, around the apron. What is left is the spot where aircraft stood,
at `z` 10 to 11 with all years: hundreds of light fixes, each cut down to a
small hard-edged kernel, piled up into a white spot there that one merged point,
drawn with a whole soft kernel, leaves light cyan; a smaller cut brings the
white back but lights up everything around it. The heat layers end at
`fullZoom`, so their sources are not cut into tiles from 12.75 on, and the glow
grows with the map from 5 px at 11 to 10 px at 12, where it takes over, instead
of lying 10 px wide under a heatmap still drawn whole. With both, a frame on the
phone takes 0.8 ms at 11.5 and 1.2 to 1.5 ms at 12.

### Roll-off

The heat of flights adds up and the ramp ends in white, so a home field flown
for years, hundreds of times the heat of its busiest routes, burned out into a
flat white racetrack with a hard edge from `z` 9 to 11, its downwind, base,
final and runway one shape. Before its colours the heat is rolled off
(`calculations/heatTone.ts`): up to the knee (`HEAT_KNEE`, 10 flights' worth as
drawn, where the exposure puts the busiest routes) as it is, beyond it a
logarithm, a knee's worth of colour for every factor of e. MapLibre's heatmap
adds up its densities and colours them by a ramp of 256 texels, so the roll-off
cannot come between the two: `exposedHeat` rolls off the weights of the points
instead, by the heat of the cell of the exposure each is in (its mean density in
flights' worth), every point of a cell alike, so a place keeps its share of its
cell's heat. In the heat of all years of `data/` a thousandth of the cells held
more than 100 flights' worth, the busiest circuits 360 to 900 and the apron
4,700, all past white (a density of 1, 67 flights' worth); rolled off they are
drawn as 33, 46 to 55 and 72 flights' worth, and only the apron reaches white.
The clusters add up the rolled-off weights of their fixes, so out to map zoom 9
the roll-off holds at every zoom. Closer in the fixes are drawn as they are, and
a point contributes no less than `HEATMAP_LEAST_POINT_CONTRIBUTION` (see
`heatmapWeight`), under which MapLibre drops it: the points of the busiest
cells, rolled off to a fiftieth, are lifted to that, and in `data/` the heat of
the cells rolled off to under a fifth comes out 2.8 times as rolled off at 9,
1.7 at 9.5, 1.3 at 10 and 1.1 from 10.5 in, on to where the heat lines take
over.

### The low end of the ramp

The low end of the ramp (`HEATMAP_GRADIENT`) has the most steps of lightness,
since most of the map is a route flown once to a few times: a stop of its own at
two flights, and over the dark base map a quarter of a flight, one, two and four
each about half as light again as the one before, four well over twice as light
as one where it was not quite twice. The two faintest stops are at 0.22 and 0.5:
at 0.4 and 0.58 a route flown once was drawn in nearly the blue of a busy one, a
band of even colour with crisp edges, and the corridors did not stand out from
it. The heat lines take the colours of the stops and not their opacity, so they
keep theirs. A quarter of a flight is the ramp's first texel (a density of
0.004), below which MapLibre's ramp has no colours of its own.

### Labels over the heat

The base map's labels, above the heat, broke it up where they lay over it, the
names of the regions most of all. `withDataLayers` gives the symbol layers of
the base style an opacity of 0.78 and a halo of the base map's colour 1.6 px
wide at 0.9 (`labelOverHeat`, only where the style gives the halo as a single
value) while the global state `heatShown` (`HEAT_SHOWN_STATE`) is set, which
`followLayerVisibility` sets while the heat is drawn at full strength (the
Heatmap switch on, the flat heatmap or the cloud, no replay, and no colour
layer, aviation chart or selection's lines over it, `dimsHeatmap`), and again on
every `style.load`: a style built anew (a base style whose difference failed, or
after a lost WebGL context) starts from a state of its own. With the heat off or
stepping back, the labels are as the base style has them. Faded to half on their
thin halo the names read as smudged over the glow; the darker halo keeps them
legible and cuts only a thin outline out of the heat. The wide grey band CARTO
draws along a country's border (`boundary_country_outline`, 8 px at 0.5) read as
one more flight track, over the heat and without it, and is drawn at 0.2; the
thin line of the border itself is left alone.

## The heat sources and the year worker

A change of the year, the aircraft or an isolated selection gives the heatmap
new points, one per fix the filter keeps (`heatmapPoints` in
`ui/dataManager.ts`): 135,000 for all years of `data/`. Handed to its GeoJSON
source as a feature each, they held up the main thread of Chrome for 155 to 160
ms in one task on a desktop (Ryzen 7 9800X3D), among it 20 ms for the points,
their exposure and roll-off, and 120 ms to hand them over: 70 ms for MapLibre's
own copy of the objects and 45 ms for the structured clone to its worker. With
the CPU slowed down four times, as for a phone, it was 550 to 570 ms, and zoomed
in to where the heat lines are worked out 310 to 330 ms and 1.1 to 1.2 s.

Now the page works out the points and the heat of each alone and hands them to
the year worker as one column (`heatColumns`, a copy of about a millisecond).
The worker works out the exposure and the roll-off
(`calculations/heatExposure.ts`) and writes the GeoJSON as text into a Blob
(`drawHeat` in `services/heatSource.ts`): the text `JSON.stringify` writes for
the same features, with the coordinates of the points to 5 decimals (about 1.1
m, drawn up to zoom 12.75), those of the heat lines to 7 (about 1 cm, drawn up
to the map's last zoom) and the heat of the points to 4 significant digits. The
source is given a Blob URL of it (`DataManager.writeSource`), which MapLibre's
worker fetches and parses itself. That takes two fixes of `scripts/vendor.js`:
MapLibre fetches a URL of a scheme other than http(s) and file through the main
thread for its worker, and sends the GeoJSON of a URL back to the main thread
whole, and for a `blob:` URL it now does neither. A source keeps its URL until
it has taken the next one, which is revoked then, and the page's CSP allows
`blob:` in `connect-src` for a browser that holds MapLibre's worker to it
(Chrome does not) and for the e2e tests, which read the sources' URLs.

The heat lines take the same way: the page works them out with the code of the
worker's bundle (`heatLinesAlong`, along the curves the colour lines keep),
which leaves them out of the first visit, and the worker writes their text. A
heat is drawn once (`Heat.drawn`), so a selection and isolation reuse it, and a
source is not sent what it holds (`heatWritten`).

The legend takes the new exposure as the worker answers, with the heat it stands
for; until then both stay as they were, and so does the heatmap an isolated
selection is drawn from (`isolatedWritten`), and a heat let go of before its
answer is not written. The map is idle while the worker works, so Wrapped's map
and the e2e tests wait for its answers as well (`heatRequests`, see
`revealMapWhenPainted` in `ui/wrappedManager.ts` and `waitForMapIdle` in
`tests/e2e/map.ts`). Where the worker cannot be used, the decoder does its part
on the main thread from the same bundle, which still spares it the objects.

The first visit went from 157.30 KB to 156.44 KB raw and from 54.26 KB to 53.78
KB gzipped, the worker's bundle from 4.78 KB to 9.11 KB raw and from 2.28 KB to
4.14 KB gzipped. `heatTone` and `appendCurve` with the helpers of `toLngLat` are
in both. The worker's build takes `utils/constants.ts` for a module without side
effects (`pureConstantsPlugin` in `build.js`): it uses none of it, and esbuild
kept 0.85 KB of it that it cannot tell are free of them.

On the built site (Chrome 154, a switch between years already loaded, the median
of three, the main thread traced until the map is idle), the longest task of a
switch to all years went from 161 to 21 ms and of an aircraft from 63 to 12 ms;
with the CPU slowed down four times from 572 to 63 and 195 to 35 ms. Zoomed in
to map zoom 9.5, where the page then still worked out the heat lines (70 to 90
ms), from 326 to 105 and 312 to 84 ms, slowed down from 1,174 to 313 and 1,082
to 310 ms. All of the main thread's work for a switch to all years went from 216
to 82 ms, 679 to 221 ms slowed down. The heat sources, the isolated selection's,
the heat lines and the exposure came out byte for byte the same in ten switches
of year, aircraft, weighing (By distance, since removed) and isolation.

## The heat legend and the heat scale

The heat legend (`#heat-legend` in the template, `ui/heatLegend.ts`, in the
first visit's bundle) says what the colours of the flat heatmap, its heat lines
and the cloud stand for, in one short row: "Time spent", "Less", a slim bar and
"More". Four labels under the bar, "≈1 pass, 4, 16, 64", were hard to read (a
pass of what, and which way the time grew) and took a box of 228 by 80 px of a
phone's map; the row takes about 275 by 40. The numbers are in the bar's
accessible name and the tooltip of the bar's row (`heatLegendText`): about how
many flights' worth of heat the two ends stand for, the heat one flight leaves
over a place as a lone cruise at 100 kt does, the time spent there, a flight's
worth being one pass of any flight. It is a `.color-legend`, so it stands where
the altitude and groundspeed legends do and follows their rules beside the rail,
the replay panel, the profile strip, the phone's bar and Wrapped.
`followLayerVisibility` shows it while the heat is the colour the map shows (the
Heatmap switch on, no colour layer, which brings its own legend, and no replay)
and fades its bar with the heat when that steps back for the aviation chart or a
selection. In the 3D view a `<details>` in it (`#heat-cloud-about`) says what
the glow, the shadow (under lifted flights) and the direction flown mean: by the
pulses while the map is in use or the chevrons at rest, and by the chevrons
alone under reduced motion, where the pulses rest (the stylesheet swaps the two
wordings); `followHeatLegend` shows it while `heatCloud` is set, and
`features.css`, which arrives with the cloud, styles it.

### The heat scale

What a colour stands for is read through one function, `heatScale(app)` in
`ui/heatScale.ts`: the density on the heat ramp (`HEATMAP_GRADIENT`, 0 to 1)
that one flight's worth is drawn at right now. The heat of flights that overlap
adds up, so n flights' worth is drawn at n times it.

- The flat heatmap weighs its points by their heat and puts the ridge of a lone
  cruise at about the ramp's third colour, 0.015 (`HEAT_FLIGHT_DENSITY`, which
  `HEATMAP_REFERENCE_INTENSITY` is chosen for; a test holds the two together),
  at every zoom and reach, times its adaptive exposure (`heatExposure`), rolled
  off past the knee. `DataManager.setHeatmapPoints` writes that exposure of the
  heat drawn, an isolated selection's while there is one, to the store
  (`heatmapExposure`).
- The heat lines colour the seconds around a fix, scaled by the same exposure: a
  lone pass leaves the time between two fixes, about 5 s, which they round to 4
  s. Their stops (`HEAT_LINE_SECONDS`) are the gradient's densities at 4 s per
  flight's worth, so n passes get the heatmap's colour of n flights under any
  exposure and the hand-over to them changes nothing; past the knee both roll
  their heat off alike.
- The cloud fills its colours so that a lone cruise glows like that density
  (`CLOUD_COLOUR`), and hands the store the factor it draws a flight's worth
  with where the map came to rest (`heatCloudScale`: the gain of `CLOUD_STOPS`
  at that zoom times `cloudExposure` of its busiest cells), which `heatScale`
  reads in place of the flat exposure while `heatCloud` is set. The height band
  leaves that exposure alone.

The heatmap and the cloud count the heat whatever the pace of the fixes. The
lines add it up in 40 m cells, which a lone pass logged every few seconds leaves
the time between two fixes in, so a log of a fix a second reads there as about a
quarter of a flight. The legend says "about" for that and for the latitude,
which widens or narrows a kernel of fixed pixels on the ground.

`followHeatLegend` draws the bar and words its ends anew as the store keys that
change the scale do: `heatCloud`, `heatCloudScale` and `heatmapExposure`.

### The bar

The bar spans four steps of four, the step of the ramp's colours: the first is
the power of two nearest the flights' worth of the ramp's colour of one flight,
at least one, so the flat heatmap unscaled and its lines span about 1 to 64
passes, a logbook drawn at a quarter 4 to 256 and the cloud closer in, drawn at
half, 2 to 128. Each count has the middle of its quarter of the bar, and the bar
is drawn on a scale of those steps from the ramp's own colours (`heatLegend`),
shifted so that the colour there is the one its count is drawn in: the counts
stay round numbers and the ramp moves under them. Past the knee a colour stands
for the heat rolled off to it (`heatUntone`): unscaled, the light cyan of a
density of 0.25 is about 20 passes, a little right of the 16, the bar ends at
128 short of the pale cyan of about 200, and white is thousands, off the bar.
The words of the bar call the colour of 64 light cyan: it lies halfway between
the two, at a density of about 0.43, lighter than the light cyan of 0.25 and not
yet the nearly white pale cyan of 0.6, which stands for about 200.

## The heat cloud of the 3D view

While the 3D view is on, the heat is drawn as a cloud in the air instead of the
flat heatmap: `ui/heatCloud.ts` (with the feature bundle, started with the
relief's code by `LayerManager.syncTerrain`) puts a MapLibre custom layer
(`ui/heatCloudLayer.ts`, id `heat-cloud`) on the map while the 3D view is on,
and sets `heatCloud` in the store, for which `followLayerVisibility` hides the
flat heatmap and its heat lines; the Heatmap switch, its button, the sheet row,
the saved state and the link are the heatmap's as before. It draws what the
heatmap would: the flights the year and aircraft filters keep, the selected ones
alone while isolated, nothing while the switch is off, at the heatmap's dimmed
opacity under the aviation chart or a selection's lines (`dimsHeatCloud`; not
under a colour layer as the flat heatmap, since the ribbons are drawn in front
of the cloud, which dimmed for them was a faint halo round the flights), and at
a quarter (`CLOUD_REPLAY_OPACITY`) and without its pulses while the replay of
one flight runs (the replay of all flights builds it up at full strength, see
[The replay of all flights](#the-replay-of-all-flights)), where the flat heatmap
is hidden; the Heatmap button stays pressed then (`heatCloud` and
`heatmapVisible`), and disabled as for every replay. Points the cloud does not
draw (cut ahead, left while the switch is off, or the other cloud's) go after
`CLOUD_IDLE_MS` (15 s). No style layer draws a glow at a height: `heatmap` lies
on the ground, `circle` has no depth, and deck.gl or three.js would be several
hundred kilobytes for one layer.

### The cloud in Wrapped's intro

Wrapped's intro forces the cloud on (`forcedHeatCloud`) with a style of its own:
the flights of the year and aircraft filters on flat ground (it is on the
globe), at full strength, whatever the switch, Isolate, a colour layer or a
selection say, and the switches are not touched. Its button cuts those points
ahead of time, in idle callbacks rather than in the pointer's event, for the
whole zoom level of the overview and the one below (closer in than the last
relief level the cloud is cut for the zoom's own level, see
[Cutting the points](#cutting-the-points)), of all the map, with that key and
with the flights smoothed aside rather than in `groundedFlights`, whose curves
the ribbons stand on, and kept apart from the 3D view's (shared where both stand
on flat ground with nothing isolated and the other's cut is of the same zoom
level and reaches as far as the view; each cloud keeps its own exposures), and
the intro fits the overview in one update with the cloud and the globe, so the
end of that zoom finds them rather than cutting the cloud and the ribbons for
the relief the globe leaves out.

Its moves are tagged, so the cloud stays cut for the overview all through the
intro, and the camera comes down only two zoom levels closer than that (`HOME`
in `ui/wrappedIntro.ts`): five levels closer, the few stretches the circuits and
the taxiing at the home field are merged into at the overview's level were each
a hundred pixels long and glowed far past white, a hard-edged polygon round the
field.

As the settle sets off, the intro hands the map back to the flat heatmap and the
projection the user had (`flat` in `ui/wrappedIntro.ts`, which a skip goes
through as well), so the camera settles on the overview a skip shows, and the
flights to a destination hovered on the cards and back fly over a heatmap
MapLibre draws anew at every zoom. The cloud, cut only where the map comes to
rest, drew the year's coarse stretches over the field flown in to and the
destination's view alone all the way back out.

It fades out over the heatmap in `CLOUD_HANDOVER_MS` (1 s), drawn as it was: the
heatmap shows at once and cuts its tiles under it, where taken off at once the
cloud left the map without heat for the frames those took. A close takes it off
at once, as the page's map shows the user's own heat. The fade scales its heat
(`fade` of `HeatCloudStyle`, on `u_gain`) rather than its `opacity`, which moves
what it glows over towards that much of white and turned the heatmap under it
red as it went to 0.

Side by side the map has the whole dialog while the intro plays and keeps that
size while it draws back into its panel beside the cards (a `clip-path`
transition in `wrapped.css`), with its view padded by the width of the cards on
its way to the overview (`overviewIn`), which moves the middle of MapLibre's
perspective into the panel's part; it is measured and fitted in its panel once
there, where it shows the same. A fit padded for the panel alone saw the globe
from off to the side and jumped as the map took its panel, and resizing the map
on every frame would draw its canvas anew in each.

### Cutting the points

`calculations/heatCloud.ts` makes the data, once per dataset, filter, isolated
selection, zoom level and relief on or off, and from `CULL_FROM_ZOOM` in (`z` 9)
for the part of the map around the view, as the ribbons are (`viewBox`) but a
whole view to each side of it rather than a quarter (`CLOUD_VIEW_SPARE`: a pan
of a view, or a zoom out of one and a half levels, shows no edge of it before
the map comes to rest; the GPU time is the same, as the stretches out of the
view are dropped before a pixel is drawn), and again once the map comes to rest
with the view out of it, in a task after the frame the move ends in, unless the
map moves on by then in a move whose rest it follows: a scripted one
(`REPLAY_CAMERA_MOVE`) is not, so the cut still runs under it: skipped there, it
left every stop of the hotspot tour, which turns over each place as it arrives,
after the first without heat (the points of the last four zoom levels are kept,
so a zoom back into one takes no work; during a replay, whose camera moves on
its own, they are the relief level's of all the map, and those of Wrapped's
intro, whose camera does as well, are of all the map at every zoom: cut around a
view the camera left at once, its glow ended in a straight edge across the map),
along the curves the ribbons are cut from: every flight smoothed through its
fixes on its ground at the relief level (`groundedFlights` in
`calculations/groundProfile.ts`, which keeps the last for both; the layer
manager lets go of it when no colour layer draws in 3D and the cloud does not
show either, and with the 3D view).

A flight's curve and its smoothed altitudes are the same on every ground and at
every level, so the curves of a dataset are smoothed once and a level only lays
its ground along them and lifts the heights, to the bit what smoothing on that
ground gave; the metres, the seconds and the clock times of each curve's pieces
are worked out once as well (`chainPieces` in `calculations/flightClock.ts`,
shared with replay all).

The points of a curve are merged where they are closer than `CLOUD_STEP_PX` (6
px in the middle of the zoom level) unless the height changed by a pixel. The
zoom level is the relief level, and closer in than the last one (`z` 12) the
zoom's own up to `LIFT_MAX_ZOOM`, on the ground and at the exaggeration of the
last relief level: cut for its pixels, the cloud crossed the corners of a
circuit and the taxiways in chords of about 110 m, 270 px long at `z` 18, where
the heat lines follow them. These steps are merged again along straight runs
into stretches of up to `CLOUD_MERGE_MAX_PX` (64 px) that pass every step on the
way within `CLOUD_MERGE_PX` (1 px) across, in height and on the ground, and
within `CLOUD_MERGE_TIME_PX` (3 px) of where its time puts the pulses, and whose
steps carry a heat per metre within `CLOUD_MERGE_HEAT` (1.5) times of each
other: a quad reaches three blurs past both ends of its stretch, and those of
the steps lay 35 to 55 deep on every pixel the cloud lights at `z` 8 to 10, 100
million pixels of glow a frame on a phone's screen. Merged, there are a third of
the stretches and 2.5 times fewer pixels of glow out to `z` 10; closer in, where
the steps follow the turns of the taxiing, about as many as before, and a fifth
more than the chords had.

The points are kept as x and y in Mercator units from an origin in the middle of
them (so 32-bit floats hold them to a fraction of a pixel), the ground under the
point and the height above it in feet, and the seconds spent on the stretch to
the next point: those of each segment as the heatmap and its lines count them
(`heatWeight` in `calculations/heatLines.ts`: the time spent; steps of no heat
are neither merged nor written; counting fixes, as the heatmap once did, left a
cruise logged at an uneven pace in beads), spread over the stretches of the
curve along it by their length (`chainPieces`, kept per curve, clock and
weighing), and the time into its flight the point was flown at (the clock replay
all plays by, from 0 at the flight's first fix, on across a gap in its log,
whatever the weighing), and how strongly the stretch from it may draw the marks
of the way flown (see [Marks of the way flown](#marks-of-the-way-flown);
`CLOUD_POINT_FLOATS`, 7). A stretch is kept where either end is around the view,
or where it crosses it with neither (a fix logged a kilometre or more after the
last does, close in).

On the way the heat of each step of the relief level (whatever zoom level the
points are cut for) over its length is added up in cells of `CLOUD_CELL_PX` (16
px of the relief level), those of every flight the heatmap shows whether they
are around the view or not, and `busiest` is the 99th percentile of the cells
with any, so the exposure is the same wherever the view is and at every zoom
level beyond the last relief level. It is kept by relief level with the points,
and a cut that has it goes through the flights that reach the view alone: a cut
after a move around the home field takes 25 to 35 ms on a desktop and 100 to 130
ms at a quarter of its speed, where one that added up the cells again took 35 to
60 and 145 to 215 ms, and came after twice as many moves.

The heights are the ribbons': the smoothed altitude above the ground of the
flight at the relief level, never below it, on the relief standing on that
ground, and exaggerated by the relief's own exaggeration (`map.getTerrain()`),
or by the level's without a relief. A custom layer cannot read the relief
MapLibre draws, so where the ribbons stand on the elevation tiles of the level
drawn under them (see
[The ground of each level](rendering.md#the-ground-of-each-level)), the cloud
stands on the ground the build sampled, smoothed for the level: within about a
pixel of them, and a flight whose ground is not known stands on the line between
its fields. All years at `z` 12 are about 45,000 points (1.3 MB; 104,000 before
the steps were merged), at `z` 6 about 2,300, and around the view of the home
field tilted by 60 degrees 51,000 to 56,000 from `z` 14 to 17.

### Drawing the glow

The layer draws every stretch between two points as one instance of a quad on
the screen, reaching three blurs around it (`CLOUD_STOPS`: 7 CSS px in the
middle of the map out to map zoom 9.5, `z` 10.5, narrowing to 4.5 px at 10.5 and
2.5 px from 13 in, and wider in front and narrower behind in a tilted view, held
between 0.8 device pixels and one and a half times the middle's
(`CLOUD_SIGMA_MOST`; at three times, the nearest tracks of `z` 14 tilted by 70
degrees grew into wide saturated smears across the bottom of the screen); a far
flight narrower than that is drawn as much fainter, so it fades rather than
sharpening into a flickering line).

The glow fades with its distance from the camera as well, by the distance of the
middle over its own to the power of 1.5 behind the middle (`CLOUD_HAZE`, a haze:
tilted by 70 degrees at `z` 8.5 the far tracks piled up into one bright band
towards the horizon, which flattened the depth) and of 0.6 in front of it
(`CLOUD_NEAR_FADE`), where the nearest tracks outshone the middle the view is
of. Close in its gain goes down with it, to half at 13: at the full width and
gain the glow of every track around a busy field covered twice the map the flat
heatmap does at `z` 12 and 25 times as much at `z` 14, over the roads and place
names, where the flat heatmap has handed over to thin heat lines. Now it covers
about as much as the flat heatmap at `z` 12 (7 % of the map lifted by the glow
against 8.5 %, place names at a contrast of 7.0 against 7.2), and at `z` 14 a
crisp glow along each circuit (8 % against the heat lines' 1 %, contrast 4.3
against 4.5).

A pixel gets the Gaussian of its distance across the stretch, integrated along
it (with `erf`) from the join with the stretch before to the join with the one
after, the bisectors of the bends, so the stretches of a flight add up to the
blur of the whole line without gaps or beads, and one shorter than its blur is a
soft point; the heat is the seconds over the pixels of the stretch, so a lone
track flown at 100 kt is 1 at any zoom and depth, as the heatmap's intensity
keeps a lone track alike by zoom.

Each channel is `1 - exp(-heat * k)` of full, blended as a screen
(`ONE, ONE_MINUS_SRC_COLOR`), which adds up the same over every glow on a pixel
whatever the order: blue fills first, then green, then red (`CLOUD_COLOUR`), a
lone cruise faint azure, four cyan, and some sixty white, the stops of the
heatmap's gradient. A dimmed cloud has the strength it is drawn with as its
source factor (`CONSTANT_COLOR` and `blendColor`, which is `ONE` at full
strength): each glow moves a pixel by `glow * (strength - pixel)`, so however
many glows there are, it fills towards that much of white and no further. A
quarter of the heat, which it was before, still filled the home field to white.
The cost is the map under the brightest of it, which goes towards the same grey:
over dark ground a haze, but over satellite imagery a flat grey where the
circuits of the home field are. The opacity of a layer proper,
`map + strength * (screen - map)`, cannot be blended a glow at a time (it needs
the screen of all of them first, in a texture of its own); a quarter of each
glow's colour instead screens up to white again under enough of them.

The vertex shader projects with the code MapLibre hands a custom layer
(`shaderData.vertexShaderPrelude`, `projectTileFor3D`), so the same shaders work
on the globe, which gets its own matrix and the flat map's (`fallbackMatrix`,
scaled to heights in metres) for the way into and out of it; a program is
compiled per variant.

### The shadow

Where the flights are lifted and the cloud is not dimmed, the same buffers are
drawn a second time first, on the ground (no lift), in a muted grey blue that
fills to 24 % at most (`CLOUD_SHADOW_COLOUR`, `CLOUD_SHADOW_CEILING`, 18 %
before the heights over a region were exaggerated more): a shadow that shows how
high the glow above it is. The brightest shadow on a pixel is kept
(`blendEquation(MAX)`, put back to `FUNC_ADD` for the glow) rather than
screened: the screen of a busy field's hundreds of circuits filled to white,
most of the white of the cloud there. A stretch on the ground (the taxiing, the
take-off run) casts none, one 30 to 100 ft up fades in (`CLOUD_SHADOW_LIFT_FT`),
and the shadow is a Gaussian of the distance to its stretch reaching 2 blurs
(`CLOUD_SHADOW_REACH`), with a stretch shorter than its blur as bright as the
glow's `erf` makes it in its middle: on a Radeon RX 9070 XT it took 0.22 to 0.40
ms a frame against 0.27 to 0.90 ms as a copy of the glow. MapLibre puts the
blend equation back to `FUNC_ADD` after every custom layer (`setBaseState`) and
sets its blend function again, so neither leaks into its own layers or the
replay of all flights.

The maximum has a cost: it is taken against what the pixel already has, the map
under the cloud, not against the other shadows alone. The shadow is a light haze
of at most 24 % grey blue, so over ground brighter than that it is gone: roads
and the light parts of the base map, and most satellite imagery. At EDAQ (`z`
13, pitch 60) the shadow alone lifts 36 % of the pixels over the dark map and 7
% over the imagery, where the old screen lifted 49 % of both (and filled the
circuits to white). Keeping the brightest shadow and then screening it onto the
map takes a texture of its own, the size of the canvas: the shadows drawn into
it with `MAX`, then one pass that screens it over the map, a framebuffer to
resize with the canvas and to make again after a lost context. The alpha of the
canvas cannot stand in for it, as the page is composed with it, and the stencil
keeps the first shadow on a pixel, not the brightest. The shadow is also left
out while the cloud is dimmed for what is drawn over it (`dimsHeatCloud`), where
it cost as much as the glow for a haze no one could see.

### Exposure and roll-off

The exposure (`cloudExposure`) scales the heat so the busiest cells, at the gain
of the zoom, glow no hotter than `CLOUD_WHITE_HEAT` (white), down to a quarter
and never above 1, eased over a fraction of a second as the level or the zoom
changes; the two years of the sample data never reach it. Past the exposure, the
heat of each stretch is rolled off as the flat heatmap's is (`heatTone`, see
[Roll-off](#roll-off)) by the heat of the cells of `CLOUD_CELL_PX` of the level
cut for that it passes, which `markStretches` adds up for the marks anyway:
`cloudPoints` asks `ui/heatCloud.ts` for the scale a flight's worth is drawn at
for its busiest heat (the gain of the middle of the level cut for times
`cloudExposure`), and a second in a cell is that many flights' worth over the
cell's width at the reference cruise. The busiest heat is taken before the
roll-off, so the exposure and the scale the legend reads stay as they were. The
home field of `data/` burned out into a white blob from `z` 9 to 10.5; rolled
off, its circuits keep a few steps of colour.

### Pulses

The pulses of the flow brighten and dim the glow by the time of each pixel's
stretch, a comet brightest at its head moving the way the flights went, about 90
px of a cruise apart at any zoom (two spacings a power of two apart, blended by
the zoom so they do not jump: the longer of one octave is the shorter of the
next, at the same phase) and a mean of 1, so the heat as a whole stays as it
was. A pulse is a raised cosine skewed forward (`cloudPulse`,
`1 - cos(2 pi phase^2)`, scaled by `1 / (1 - C(2) / 2)` with the Fresnel
integral `C`): it rises along its tail to its head at 0.71 of the period and
falls ahead of it a little quicker, with no step and no kink where one pulse
hands over to the next. The comet before fell from its head to nothing in the
last 15 % of the period, which read as a jerk as each head passed. Along a
stretch where they come closer than 8 blurs on the screen
(`CLOUD_FLOW_CLOSEST`), slow taxiing close in or any track near the horizon,
they fade out, gone at 4: there they ran together into a comb. They fade in
while the map is used (`move` of its camera, `touchstart`; not the pointer
moving over it, which kept the map drawing every frame while it rested on it)
and out 8 s after, and the layer asks for another frame only while they run or
fade or the exposure moves, every frame the screen shows, so an idle map draws
nothing. Frames held to 30 a second (25 ms after the last) moved them visibly in
steps. A frame slower than 100 ms moves them on by 100 ms: they slow for it
rather than jump. They are off under reduced motion, read in every frame, and
during a replay, and hold still in the frame `withMapStill` takes for an export
(`isMapStill`), whose resizes do not wake them either.

### Marks of the way flown

The marks of the way flown take over whenever the pulses do not run: under
reduced motion, on a map at rest, in an exported image and in the faint cloud of
a replay. The glow pass draws them with `u_marks.x` from `markStrength`, one
less the strength the pulses are drawn with in the same frame, so the two
cross-fade as the pulses fade in and out and the cloud always shows one of them;
the shadow pass draws none. In the frame `withMapStill` takes the layer draws
the marks and no pulse, without touching its fade. The band of heights fades the
marks as it fades the glow under them. They fade in from map zoom 7.5 to 9
(`CLOUD_MARK_ZOOMS`), further out the routes of a region run together: from 6.5
to 8 they scattered over a region's routes as noise.

A mark is a chevron pointing ahead along a track where it crosses a line of a
lattice on the ground, in Mercator units from the origin of the points. The
vertex shader finds the lattice of a stretch once for all its pixels
(`markLattice`, handed on as `v_lattice`): its lines cross the axis nearest the
stretch's direction, of 16 at every 22.5 degrees.

It is one axis and not a blend of the two either side, as it first was: their
lines cross a track at places of their own, and the blend drew two rows of marks
at half their strength along a track about halfway between two axes, nearly a
third of all headings; a track that turns across that halfway fades its marks
out towards the turn from both sides, where the lattices of both stretches drew
a mark each, a pair of them close together (the snapshot of the cloud showed
one). The lines are a power of two of Mercator units apart, the one nearest
`CLOUD_MARK_SPACING_PX` (96 CSS px, 64 before crowded a busy field) along the
stretch on the screen, and every second one, blended as that goes from one power
to the next, so the marks keep their spacing on the screen at every zoom and
depth and do not jump.

Every flight along a track finds the same lines, so where a route is flown over
and over the marks add up to one row: marks timed by each flight, as the pulses
are, added up to a haze of them wherever flights overlapped. That is one row
where the flights are within a stroke of each other: flights a little apart,
side by side or at heights that a tilted map close to the camera sets apart on
the screen, glow as one track and still draw a row of marks each.

The stroke adds a part of the stretch's heat (`CLOUD_MARK_ADD`), a band as wide
around it takes a part of the glow away (`CLOUD_MARK_CUT`, 0.4: at 0.8 the dark
outlines cut the glow into pieces), so a mark shows on a faint track as a
brighter chevron and on a white one as a darker outline; a mark whose arms would
be under 2 to 4 CSS px (`CLOUD_MARK_LEAST`, the far distance of a tilted map)
fades out, and a pixel further across the track than the arms reach keeps its
glow without working a mark out.

Only a stretch whose time runs forward draws them. A stretch that reaches behind
the camera's near plane is cut there, and the ends of the part left have its
time, height, marks, heat and place on the ground, the ground its glow is pulled
to among them, so its pulses, its band of heights, its pull and its marks stay
where it was flown and meet those of the next.

Where flights overlap in both directions, a runway or a circuit used both ways,
a route flown out and back, marks both ways at the same places would be noise,
so `markStretches` (`calculations/cloudCells.ts`) adds up the directions of the
stretches written in cells of `CLOUD_CELL_PX` (16 px of the level the points are
cut for) weighed by their heat (their sum S and the sum T of their outer
products), each at two places a cell along it, so a stretch merged along a
straight run counts in every cell it passes and not only where it starts; a
stretch draws its marks by its agreement with the cells it passes, (d . S) / (d
. T d), from none at 0.3 to in full at 0.8 (`MARK_AGREEMENT_RANGE`): the heat
along its axis its way less that the other way, over all of it, where flights
across it count for neither. Steps of no heat are not written, so they take no
marks away. The home field of the sample data flies its circuit both ways and
shows almost none; the routes in and out show them. It runs on the points of
each cut, those around the view, and takes about 15 ms for 100,000 stretches on
a desktop.

How strongly a stretch may draw them is a float of its own, the seventh of each
point, which the vertex shader reads at either end of the stretch; the last
point of a run of stretches has the marks of the stretch before it. The shaders
keep the marks in blocks of their own (`MARKS_VERTEX`, `MARKS_FRAGMENT`), with
their own uniform (`u_marks`: the strength, the spacing in device pixels, the
device pixels of a CSS pixel).

The flat heat lines of the 2D map get no marks: they are drawn on the first
visit, whose budget has no room for an arrow symbol and its placement, and a
symbol placed along lines would show the direction of whichever flight's line
won the collision, both ways on a runway.

### Layer order, depth and lost contexts

It is a 3D layer, right below the first ribbon layer: above every layer of the
app that lies on the ground, the flat lines of the selection, the flights and
the replay's route and trail among them, and below the ribbons and the labels.
On the relief MapLibre draws the layers on the ground into a texture of each
relief tile and the relief with it (`drawTerrain`, with `depthRangeFor3D`) once
for every run of them another layer breaks, so they are all one run below the
ribbons (`mapLayers.ts` puts the flat trail of the replay below the ribbons
too): between the heatmaps and the heat lines, where it first was, the cloud had
the relief drawn three times a frame instead of once, and a frame of the relief
in software WebGL in Safari's engine (the Playwright image, 800x500) took about
90 ms instead of 30.

The cloud tests against the relief's depth without writing to it, so a ridge in
front of a flight hides its glow and no glow hides another. Each glow is pulled
towards the camera by its reach for the test, so a fix on the ground glows round
rather than cut by the ground in front of it. Near the ground (within its reach)
a corner of a quad is pulled further, to where its ray meets the plane of the
ground under its end, 30 ft higher (`CLOUD_GROUND_SLACK_FT`, where the relief
MapLibre draws can lie over the cloud's ground), and 12 blurs at most
(`CLOUD_GROUND_PULL`), never nearer than its near plane: the steeper the ground
rises into a flat view, the more of a glow it cut, in a straight line along a
runway. The pull only moves the glow in front of ground up to 30 ft over its
own, so a ridge higher than that still hides the glow behind it, and flights
higher up keep their reach. The plane is the ground's through three points 100
px apart (`u_ground`); where the view runs along it (no meeting) or its ray
meets it behind the camera, the corner keeps its reach. On the globe the plane
is a chord of the curved ground, off by a few hundredths of a blur at most
(about 1 km at `z` 5, where a blur is some 30 km across, and metres at `z` 8).

Its GL objects are made in its first frame, where MapLibre takes up the state of
its context anew after a custom layer. Given no points, it lets go of the ones
it drew in its next frame (`LayerGl.empty`: the buffer left empty, not deleted),
which it held on to for as long as it stayed on the map. Taken off the map it
deletes its buffers and keeps its compiled programs for its return in the same
context (`ui/glLayer.ts`, shared with replay all), which a context lost
meanwhile has invalidated (`isProgram`); a lost context drops them
(`webglcontextlost`), and the style MapLibre gets back has no custom layers, so
`ui/heatCloud.ts` adds the layer again on `style.load`, and on `styledata` after
a new base style. Shaders that do not compile turn it off with one logged error,
and the flat heatmap stays, until the context is restored, where they are tried
again (the replay of all flights alike, which closes its panel with an error
toast in the run that failed). A program that did not compile is not kept for
the layer's return (`release`): a context lost and restored while the layer was
off the map, which it does not hear of, is the same object, and the kept failure
was handed out there again without a word, the cloud drawing nothing while the
heatmap stood aside for it. What fails while the context is lost
(`isContextLost`: every GL object is null and no shader compiles) is no failure
(`LayerGl`).

It only draws: a custom layer has no features for `queryRenderedFeatures`, and
the ribbons stay what is hovered and clicked (the readout below works out what
the cloud under the pointer is made of from the segments instead). An exported
image has it, without its pulses, since the canvas is read in the frame that
drew it (`withMapStill`). It is drawn in the world copy of the flights only,
where the flat map shows several.

### The band of heights

The band of heights (`heightBand` in the store, `h` in the link, the text
`500-3000` or `1000-` of `calculations/heightBand.ts`, empty for every height)
leaves out the heat below and above two heights above ground. It needs no other
points: the fourth float of a point is its height above the ground in feet, the
one the cloud is lifted by, and the shaders get the band as one uniform
(`u_band`, from `heightBandEdgesFt`): where it fades in, where it is whole,
where it starts to fade out and where it is gone, 15 % of each edge's height
past it and at least 50 ft. A stretch with both ends outside the band on one
side is dropped in the vertex shader, and the others are faded per pixel by the
height along them (`smoothstep`), in the glow and in the shadow alike; the
exposure is still that of all the points, so a band is as bright as in the whole
cloud. The band is above ground rather than above the sea because the ground
under every point is known, the relief sampled by the build or without it the
line between the fields, and a circuit is then at the same height over any
field.

The control (`ui/heightBand.ts`, in the feature bundle and started with the
cloud) is two range inputs over one track, each with a label and its height as
`aria-valuetext`, at the stops of `HEIGHT_BAND_STOPS_FT` (the top past the last
is no top); it is a row of the Map group under the 3D switch, a group of its own
over the top of the map in the phone layout (`PHONE_LAYOUT_QUERY`, before the
floating compass in the page, so the keyboard reaches the two in turn), and
shown while the 3D view draws the cloud with the Heatmap switch on, but not over
the statistics (`features.css`). The first visit carries only the check of the
link (`isHeightBand` in `state/urlState.ts`, with the text's pattern and the
stops, which the saved state checks as well), the store key and Reset view. A
text that is not two stops, the lower first, as a link edited by hand may have,
is every height: it is dropped as the link or the saved state is read, where the
store held it before, wrote it back into the link and kept Reset view available
until the control was first shown. Wrapped always draws every height
(`wrappedVisible`), its intro included.

### Performance

The numbers below were measured before the shadow, which draws the cloud a
second time where the flights are lifted, and the pulses, which redraw the map
every frame while they run. On a desktop GPU (Radeon RX 9070 XT, 1440x900) the
cloud's draw took 0.35 ms of a frame for all years at `z` 6, 0.6 ms for 2025 at
`z` 8 and 1.4 ms for all years at `z` 12, and the camera turned at 60 frames a
second with and without it. Working out the points took 13 ms for 2026 and 31 ms
for all years at `z` 12 with the altitude layer on, which smooths the flights
for its ribbons anyway, and 72 and 131 ms with the heatmap alone, which smooths
them for the cloud; holding the smoothed flights then is 4 MB of the page's heap
for 2026 and 12 MB for all years. A level kept takes none of that. The upload
took under a millisecond. In software WebGL (SwiftShader) it took 28 ms of a
frame of 170 to 250 ms. The e2e test (`orientation.spec.ts`, "on the relief")
checks that the layer is on the map and drew stretches (`drawn`, which the layer
counts per frame), not what the pixels look like.

## The replay of all flights

The replay of all flights builds its heat up with the cloud: while it is open
the cloud is drawn at full strength up to the replay's clock
(`HeatCloudStyle.until`, `u_until` in the vertex shader, which leaves out a
stretch not begun and cuts the one under way where the clock is), on the flat
map as well, in place of the flat heatmap, and under the replay's trails. With
the Heatmap switch off it draws none. The trails are drawn at their height there
too, and the heat with them: flat on the map, the replay drew lines on the
ground under Wrapped's intro, whose camera flies and tilts over them through the
lifted cloud, and a tilted map showed no height either. Both are lifted as the
cloud is (`heatCloudLevel`: the 3D view's relief level, and outside it the level
of the zoom the map last came to rest at), so the heads fly in the heat, and the
cloud's shadow marks the ground. With the heat left flat under lifted trails,
each trail lay beside its heat by its height (some 100 px at `z` 10 tilted by 60
degrees) and read as the track of another flight. A map tilted by less than 20
degrees (`TILT_MIN_PITCH`) is tilted to the 3D view's 50 (`TILT_PITCH`) as the
replay opens, and laid back as it closes, unless the user tilted it meanwhile
(by more than 5 degrees (`TILT_BY_HAND_DEG`) in one gesture: a right drag that
turns the map tilts it as the pointer strays up or down) or turned the 3D view
on. Meanwhile the link and the saved state keep the tilt from before
(`ReplayState.pitchBefore`), and until the map is laid back, what opens then and
keeps the user's view (Wrapped, the hotspot tour, the replay of all flights
again) takes the tilt it goes back to rather than the one half way there
(`restingPitch`, `ReplayState.layingBack`, forgotten as that move ends).

The camera is fitted to the flights on the tilted map, not to their bounds: a
fit of the bounds with the tilt (`fitBounds` with `pitch`) fits the corners of
the bounds, which the tilt spreads, and left the flights small in the middle of
the map with its far third empty. `fitTilted` in `calculations/replayAll.ts`
starts from the flat fit of the bounds and measures the points of the flights
four times on the screen of the camera, as MapLibre draws the flat map in
Mercator (the camera at the distance of the field of view from the middle,
turned down by the tilt), moving their middle to the middle of the room and
zooming by the room left; the room is the map clear of the panels along its
edges (`mapChromePadding`) and of the replay's panel. At 1440x900 that is about
a zoom level closer than the fit of the bounds, at 390x844 about a quarter. The
curves are thinned as for the zoom of the flat fit, that many whole levels
further out than the map (`ReplayAllPlayer.thinOut`), which the tilt shows them
about as large as: thinned for the closer zoom they were twice the points, each
of which the vertex shader takes up twice a frame (the trails, then the heads),
and in software WebGL (SwiftShader in CI) a frame of the replay took a third
longer than before the fit, 224 against 165 ms of its CPU at 1280x720, and the
steps of the e2e test ran out of time; now it takes 175 ms. The flights are cut
for the level the cloud takes as a zoom ends, so the cloud's listener is added
as it is followed, ahead of the player's, and like the cloud and the ribbons
they are handed to the flat lines at `LIFT_MAX_ZOOM` as the zoom ends.

The panel offers 100 to 1000 times (`REPLAY_ALL_SPEEDS`). A trail fades over 3 s
on the screen (`TRAIL_FADE_S`), but over no more than 25 minutes of flight
(`TRAIL_MOST_S`): at a thousand times a trail of 3 s was 50 minutes of flight,
most of a flight behind every head, where the heat built up behind them shows
the way flown already. The clock is a slider (`#replay-all-time`): a drag holds
the replay where the thumb is and lets it play on as the pointer lets go, a
click jumps, and the arrow keys step a minute (`SLIDER_STEP_S`), Home and End to
either end.

Scrubbing back shrinks the heat, since the layer draws from the clock alone. The
flat heatmap cannot be cut by time: its points carry no time, its clusters merge
fixes of different flights and times, and a filter or a weight by time is worked
out again in MapLibre's worker for every tile, far too slow for every frame. A
heatmap of its own drawn into a texture and coloured by the ramp would have
matched the heatmap to the pixel, but it needed some 4 KB more of the feature
bundle than there was room for. The cloud's glow uses the heatmap's colours and
reach, and the end of the replay shows it a little lighter and narrower than the
heatmap the page goes back to. For all years (103 files) on the Radeon RX 9070
XT at 1280x800, `z` 6 on the flat map, MapLibre's `_render` took 1.36 ms a frame
on average (95th percentile 3.3 ms) with the heat and 0.66 ms (1.0 ms) without,
and the frames came every 16.7 ms either way; with the CPU slowed down four
times 2.1 ms against 2.6 ms, and in the 3D view 4.0 ms against 0.8 ms with the
cloud's shadow at full strength. Opening the replay took about 45 ms more for
cutting the cloud's points. With the flights and the heat lifted on the flat map
(tilted to 50 degrees, the cloud and its shadow), the same view took 1.37 ms a
frame (95th percentile 2.9 ms) against 0.97 ms (1.6 ms) flat, the median of
three runs each on a machine busy with other work, and the frames still came
every 16.7 ms.

## The readout of the heat cloud

Pointing at the cloud (a resting mouse, or a tap) shows a box beside the pointer
with the time spent around the place, the flights that were there and the 400 ft
band of height above the ground most of it was in. `ui/cloudReadout.ts` (feature
bundle, started by `followHeatCloud`) listens to the map's pointer events only
while the 3D view draws the cloud (`threeDVisible` and `heatCloud`, the Heatmap
switch on, no replay, not in Wrapped or its intro's `forcedHeatCloud`, nor while
the hotspot tour holds the map, `tourView` in the store) and looks once per
frame at most (`frameCoalescer`); with the 3D view off it holds nothing but its
store subscription, and lets go of what it kept. `calculations/cloudReadout.ts`
is the maths:

- Under the pointer means along the line of sight through it. The cloud adds up
  every glow on a pixel, so the pixel shows every flight the line passes near,
  at any height; the ground under the pointer alone would miss the glow pointed
  at in a tilted view, where a flight stands up the screen from its ground.
  `sightLine` samples the line from the ground up to the highest flight (15,000
  ft above the ground at most), a point at a height standing on the ground
  `liftOffsetPx` further down the screen, the approximation `PathHover` takes a
  ribbon down by, at most every radius on the screen and 48 times at most. A
  segment is measured against the place of its own height, interpolated between
  the samples. Looking straight down, or with the flights flat from `z` 18 in,
  it is one place. The relief is not asked whether it hides a flight from the
  pointer.
- A sample is on the ground only where `project` takes the place `unproject`
  gave back to within half a radius of the sample: MapLibre answers the sky of a
  tilted map with ground behind the camera, and the space beside the globe with
  its rim. Neither is a longitude past 180, in a world copy the cloud is not
  drawn in. The pointer on no ground has no readout, and the line ends at the
  first sample on none. It ends too where two samples are more than 8 radii
  apart (`SIGHT_MAX_GAP_RADII`), towards the horizon of a steeply tilted map,
  and has no readout if that is the first pair: a radius spans a few pixels
  there, and the reach of the search below grows with the gap. Without the
  checks a pointer just above the horizon searched 2,000 km for 3.7 s per frame
  (130,000 synthetic segments, Node).
- The radius is a round one (`READOUT_RADII_M`, 100 m to 50 km) nearest to the
  reach of a stretch's glow in the middle of the map (`cloudReachPx`: 21 CSS px
  out to map zoom 9.5, `z` 10.5, narrowing with `CLOUD_STOPS` to 7.5 px from map
  zoom 13 in), so the box can say "within 1 km".
- The time is the cloud's: the heat of each segment in seconds as `heatWeight`
  weighs it (at most 120 s, a track without times at a cruise,
  `CRUISE_SPEED_MS`), times the part of it within the circle (`insideFraction`),
  times the part of it the band of heights draws (`heightBandEdgesFt`, the fade
  of the cloud's shaders, at the height of the segment). A segment of no heat
  counts for nothing, as the cloud draws nothing of it, and a place with none
  has no readout. The flights are the path ids with any heat within, of those
  the cloud draws (filters, Isolate, band of heights). The heights are above the
  ground the cloud stands on (`groundProfilesFt` at the relief level: the
  sampled ground on the relief, the line between the fields on the globe), added
  up in 100 ft bins; the box names the run of four with the most of it, "mostly"
  from half of it on. The exposure never enters it: the box speaks of time, not
  of heat. A change of the switches tells a resting pointer anew.
- The segments near a place come from a grid made per dataset for each radius
  (`segmentGrid`, a `WeakMap` on `path_segments`, let go with the 3D view), its
  cells twice the radius. A segment goes into the cells of points along it at
  most half a cell apart, so a query looks in the cells within its reach and one
  more, and visits each segment once (a stamp per segment). The grids of the
  three radii asked for last are kept: the finer the grid, the more cells a
  segment is in, and for 130,000 segments the one of 100 m took 13 MB and the
  one of 1 km 2.3 MB. The seconds and the heights are kept alike, the seconds
  per weighing (`heatWeight`, or one a test asks for), the heights per relief
  level. On 100,000 synthetic segments around one field, the grid took 12 to 16
  ms to make and a readout 0.5 ms at 500 m and 1.6 ms at 5 km (Node, desktop
  CPU); the 49 `unproject` calls of a line of sight took 0.3 ms over the relief
  in Chrome.

### Keeping the pointer cheap

The pointer's frames do little: a move of up to 3 px from where the readout was
last worked out keeps it and moves the box along (`READOUT_SLACK_PX`), and
nothing is worked out while the map moves (`isMoving`), which tells a resting
pointer anew where it comes to rest. What a readout at a zoom is worked out from
(the seconds, the heights and the grid of its radius, `readoutKept`) is made
ahead of the pointer, once the page has a moment (`requestIdleCallback`, a
timeout where Safari lacks it) after the map comes to rest and as the readout
comes on; a hover that finds it missing hides the box and waits for it, and a
click or a tap, which wants its answer, makes it. A zoom across a step of the
radius used to make the grid in the next hover's frame or in the tap. With the
two years of `data/` (135,000 segments) in the unit tests' jsdom on a desktop
CPU, the frames of the first hover in the 3D view took 70 ms before and 14 to 19
ms after (the rest, 53 to 59 ms, in an idle task), those after a rest at the
next two zoom levels 19 to 29 ms before and 1.5 to 7 ms after (13 to 27 ms
idle), and twenty moves of a pixel 25 ms and 20 readouts before, 2.3 ms and none
after. A readout in the 3D view takes up to 49 `unproject` and `project` pairs.

### Beside the values of a flight

With a colour layer on, the 3D view draws the flights as ribbons, and around a
busy field the ribbons are within `PathHover`'s few pixels of nearly every
point: at `z` 10.5 around the home field its tooltip showed at 39 of 77 points
of a grid 40 px apart, and a readout that stepped aside for it showed at 5. So
the two show together, and the box goes where it leaves the values of a flight
in sight (`place`): below and to the right of the pointer, then the other
corners, then beside the tooltip or the tapped popup (a `.segment-tooltip` or
`.segment-popup` in the map's container; a `MutationObserver` places the box
again as one opens or closes later, after a look on idle), and clear of the
panels over the map (the control columns, the selection chip, the flight
profile, the phone's bar and the floating band of heights) where it can, within
the map. With it the readout showed at 44 of the 77 points, at each of the 39
with the tooltip too, and never over it. It hides over a marker (the event's
target is not the canvas), while a button is held or the map moves, and after
Escape until the pointer moves 8 px; a change of what it is worked out from
(filters, Isolate, the band, the relief) tells a resting pointer anew.

### Clicks and taps

A click or a tap on the map, handled after the app's own click handler, shows
the box there, on a flight as well: a tap on the ribbons of a busy field nearly
always hits one, which selects it and opens its values, and a readout that left
those taps alone never showed on a phone around the home field. It is read out
once (`announceStatus`) unless the click changed the selection (counted from the
`mousedown` or `touchstart` before it), which the app reads out itself in the
same status region, where the last word is the one heard; the box itself is
`aria-hidden`, so a hover says nothing. A tap is a click less than a second
after a `touchstart` on the map (the browser's mouse events for it are left
alone), and puts the box above the finger; the flight profile that a selection
opens moves the map, and the box of a tap follows the place tapped. The box
takes no pointer events. It is an element of its own in the map's container,
styled like the popups in `features.css`, not a MapLibre popup, so no spec that
counts the popups finds it.

### No readout on the flat map

The flat heatmap has no readout. The code comes with the feature bundle, which a
visit that never turns on the 3D view, a replay, the satellite imagery, the
cross-section, the hotspot tour or a single selection does not fetch: in 2D it
would be fetched on every first visit, or add about 3 KB gzipped to a first
visit that has no room left. The flat map's heat lines already show where the
time was spent from `z` 12 in. The feature bundle grew by 8.2 KB raw and 3.3 KB
gzipped; the first visit by a few bytes: the readout imports only what the
shared chunk exports already (each new import from it adds to its export list).
`cloud-readout.spec.ts` turns the altitude colours on and enters the 3D view by
its button near the home field (the button leaves the heatmap alone, which it
draws as the cloud), and rests the pointer on a place a flight passed low over,
with the ribbons and the markers on; it checks the shape of the words, not the
numbers, which the unit tests check, and that the box covers neither the pointer
nor a tooltip. It waits for the map to stand tilted, not for `map.loaded()`, and
points at the place anew until the box shows, since the relief may land later; a
look into the page took up to 26 s in software WebGL on CI, so every check after
the 3D view comes on has the relief's minute.
