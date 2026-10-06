# Rendering

How the map draws the flights beyond their heat: the camera of a replay and its
chase view, the relief of the 3D view with the ribbons that stand on it, the
ribbons of a selection, and the satellite imagery. The heat, with the cloud of
the 3D view, Wrapped's intro over it and the replay of all flights that builds
it up, is in [Heat](heat.md).

## Replay camera

What moves the map during a replay is in `ui/replayCamera.ts`, apart from the
renderer that draws the trail. By default the camera only pans once the airplane
nears the edge of the map, as a critically damped spring (`dampStep` in
`ui/chaseCamera.ts`) moved by one `jumpTo` a frame: an `easeTo` asked for on
every frame starts from rest on every frame and stutters. Auto-zoom zooms out
when the pan cannot keep up. MapLibre ends every `jumpTo` with `moveend` (and
`zoomend` when it zoomed), so the camera's jumps carry `REPLAY_CAMERA_MOVE`
(`utils/mapHelpers.ts`) as event data, and what the app does once the map comes
to rest (the airports towards the horizon, the markers on the relief, the saved
view, the cut of the ribbons for the zoom) skips them. The camera fires both
events itself, untagged, once a frame passes without a jump, every
`CAMERA_REST_MS` (1 s) while it keeps moving, as a chase does, and as a chase
gives the map back, before the view from before it eases in.

### Chase view

The chase view (`ui/chaseCamera.ts`) drives bearing, pitch, zoom and centre on
every frame instead, through the same kind of spring, at a tilt of `CHASE_PITCH`
(70 degrees) and a map zoom of `CHASE_ZOOM` (14.5, app zoom 15.5; the map's zoom
is the app's minus `ZOOM_OFFSET`). It looks at a point in the air, at the
airplane's height as the ribbons draw it (`elevation` in the camera options,
with `setCenterClampedToGround(false)` while it chases), so the zoom is the
camera's distance to the airplane and does not change over a valley or a ridge.
The airplane sits at `CHASE_SCREEN_Y` (0.6) of the height between the top of the
map and the replay panel; that height is measured again after a `resize` of the
map or a change of the panel's size (a `ResizeObserver`), not on every frame.
MapLibre's `project` knows no height but the ground's, so the airplane marker,
upright (`pitchAlignment: "viewport"`) while chasing, is placed by the camera's
own projection (`projectRelative`), which matches MapLibre's to a pixel.

The bearing follows the smoothed heading with a time constant of three seconds
of the flight, held between 0.2 and 1 s of the replay, led by the turn rate (at
most `CHASE_MAX_LEAD`, 45 degrees) so a fast replay does not swing behind a
turn. The tilt is held down to keep the camera and its line of sight 150 m above
the relief behind the airplane (`clearPitch`, from `queryTerrainElevation`), and
however far the spring lags, the camera never goes below the ground. On the
globe the zoom goes no lower than `GLOBE_FLAT_ZOOM` (map zoom 12, app zoom 13),
where MapLibre draws the globe flat and the chase's flat-map maths hold.

Any movement of the user's (`UserMapMovement`) holds the chase; the next frame
starts from their view and keeps their zoom and tilt within `CHASE_ZOOM_RANGE`
(map zoom 11 to 16) and `CHASE_PITCH_RANGE` (45 to 75 degrees). `release()`
hands the map back clamped to the ground without a jump. Switching it on slows a
replay faster than `CHASE_MAX_SPEED` (10x) down to it and switching it off
restores the speed from before; it also eases back to the zoom, bearing and
pitch from before over the airplane, closing the replay back to the whole view,
and a finished replay fits the flight at the bearing and pitch from before.
While it chases, the state manager saves the view from before
(`ReplayManager.userMapView`) to the session and the link, not a camera half way
along a flight. Under `prefers-reduced-motion` it does not start, and a toast
says why.

## The relief of the 3D view

At every zoom the 3D view draws the relief with `setTerrain`, from a
`raster-dem` source of the same Terrarium tiles the build samples
(`ui/terrain.ts`, which comes with the feature bundle and is fetched the first
time the 3D view is on). The `fill-extrusion` shader adds the relief times its
exaggeration to every ribbon, so a flight stays at its height only where the
ribbon's lift is exaggerated as much as the relief; the map takes one
exaggeration for the relief, and rebuilds it on every change (a few
milliseconds). Both therefore go by the relief level (`reliefLevel` in
`calculations/liftZoom.ts`, and in the store): the whole level the ribbons are
cut for, up to 11. `liftExaggeration` gives one number per level, 10 out to
level 7 (`z` 8 in the UI), then 7, 4, and 2 from level 10 in. The ramp down
began a level further out, at 7, 4 and 2 for levels 7 to 9, where over a region
(`z` 7 to 9 tilted by 45 to 60 degrees) the 1,000 to 3,000 ft of a light
aircraft were a few pixels next to the kilometres between its fields and the
cloud looked like the flat heatmap tilted. `LayerManager.syncTerrain` changes
the level only as a zoom ends, and `ui/terrain.ts` sets the relief's
exaggeration then; the flights are cut once for the new level, as wide as it
asks, over the cut of before. What the two share is `ui/reliefState.ts`: it
writes the store's relief switches in the order the map needs them, counts the
visits of a level, holds whether the ribbons show and lists their sources.
`calculations/liftZoom.ts` holds the zoom policy the app needs before the
feature bundle arrives (lifted zooms, relief level, ribbon width zoom), and
`calculations/lift.ts` the rest of the policy of levels and heights, which comes
with that bundle; the curve through the fixes, the ground of a flight, the
ribbons and their paint are `smoothing.ts`, `groundProfile.ts`, `ribbons.ts` and
`ribbonPaint.ts` beside it.

### The ground of each level

MapLibre raises a ribbon by the relief of the elevation tiles one level coarser
than the ribbon's own tile (`getSourceTile`, `deltaZoom` 1), so at level 5 the
ground under a flight is drawn from tiles of about 3 km pixels while the build
sampled 100 m ones. `groundProfileFt` smooths the sampled ground along each
flight for the level (`reliefPixelM`, `smoothAlong`: twice a moving average over
two pixels), which halved the difference to the relief MapLibre drew along a
flight over the Alps at every level from 4 to 9 (RMS 94 m at level 4, 31 m at 8,
4 m at 11). The rest is the relief beside the flight, which no smoothing along
it knows; times the exaggeration it is why the ramp stops at 10: with 51 times
at level 4 (the ramp before) a level cruise over the Alps sawed by 3 to 6 pixels
and the Alps stood as a wall, at 10 times it is under a pixel.

Not every tile is of the level the flights are cut for: while a zoom goes on the
tiles of the next level take over (in the middle of the map from about a tenth
of a level before the next), in the distance of a tilted view the tiles are a
level or two further out, and at a tilt of 75 degrees and more the nearest ones
one or two further in. So a ribbon carries the ground of the levels around its
own (`GROUND_LEVELS`: two out, one out and one in), as offsets `o-2`, `o-1` and
`o1` to the ground its height `h` is above, beside the level `l` it was cut for
(`ribbonProperties`). The ribbon layers are created without this paint, which
comes with the feature bundle: `paintRibbons` in `ui/terrain.ts` sets it once
the map is ready and again on a style that lost it. The paint (`ribbonHeights`)
is a `step` by zoom, which MapLibre works out for each tile at the tile's own
zoom, and takes the ground of the tile's level, the nearest carried beyond them
(the nearest tiles of a steep tilt stand on the ground of `o1`); the band of
height goes by the middle of the tile's level, as the width does, and on a level
further out than the one cut for by the next level in, as thin as the
interpolation by zoom before it had the distance of a tilted view. The offsets
are the smoothed ground of the other levels worked out in the browser
(`groundProfilesFt`, kept per level for the dataset), rounded to a quarter of a
pixel of the level (`groundOffsetStepFt`) and left out where that is zero, which
over flat land most of them are. Ground of every level from the build would have
cost 10 columns of the year files for what the browser smooths from one (the
ground column is about 200 KB of 2025's 1.6 MB, 36 KB gzipped).

### Exaggeration and settling

The exaggeration is one for the whole map, which a zoom expression would not
give (every tile has its own zoom), so the paint takes it from `l`. As a zoom
ends in a level of another exaggeration, the ribbons of the old cut get the new
one from a feature state in the same task as the relief (`exaggerateRibbons` in
`ui/terrain.ts`), which MapLibre applies to all of their tiles in the next
frame; a new paint would have them cut again tile by tile. A feature state needs
a feature id, which costs every tile a few bytes per feature (about 5 % of the
worker's heap with all years), so only the levels next to one of another
exaggeration have one (`k`, promoted to the id; `switchesExaggeration`: 7 to
10).

The id is a new one for every visit of a level (`ribbonId`,
`ReliefState.epoch`): MapLibre keeps an entry for every id it was given a state
for, even one taken away again, and works out the paint of every feature of such
an id anew, on the main thread, in each tile it loads, which for the cut of the
map's level took seconds per zoom in software WebGL. So only a cut that has to
switch gets a state, and never the one for the level of the map.

The flights stay in sight and on the relief through a zoom and its end.
`ui/terrain.ts` hides them only as the relief comes or goes, and as a zoom ends
in another exaggeration while the map may still draw a cut without an id (every
cut since all the ribbons last landed, `followsLevel`), until the map has drawn
their new tiles and the elevation tiles, for `SETTLE_MAX_MS` (3 s) at most,
since a frame of the relief takes seconds in software WebGL. The layer manager
lets go of such a cut first, as it does of the ribbons of a mode out of sight at
every change of the level, which would otherwise show the cut of before when the
mode shows again.

A `hillshade` layer from the same source shades the relief while it is drawn,
directly above the base map's ground and the satellite imagery on it
(`aboveGround` in `ui/satellite.ts`, see
[Satellite imagery](#satellite-imagery)), so below its runways, roads, buildings
and labels and every layer of the app, in the colours of the `--terrain-*`
tokens of `styles.css`; a second source would fetch about twice the tiles (89
instead of 41 for a session into the 3D view and two levels in and out, see
`shade` in `ui/terrain.ts`), for a sharper shading nobody sees under the dark
style (MapLibre warns about the shared source once). `withDataLayers` carries
the source and the relief across a base style swap and `ui/terrain.ts` puts the
shading back into the new style. The globe gets the shading alone
(`reliefShaded` in the store, set by `syncTerrain` for the 3D view, globe or
not) and no relief, since MapLibre 6.10 breaks the ribbons up on the relief of
the globe: `terrainActive`, and with it the ground the ribbons are cut on, stays
off there.

### Ribbons cut for the pixels

The colour layers' ribbons are cut for the pixels of their level, not for the
data (`screenCut` and `keptPoints` in `calculations/ribbons.ts`): a flight's
curve keeps a point where its height or its ground has changed by a step since
the last one kept, where it has turned by 10 degrees after 1.5 px, and every 16
px, and its pieces are `LIFT_STEP_FT` apart doubled as long as a step stays
within a pixel, merged where their heights span a step. The relief under a quad
is the one of its middle (MapLibre lifts each polygon by the elevation at its
centroid), so the ground criterion keeps a quad short over the relief and a
strip of quads cannot be one polygon. From level 8 (`z` 9) the layer manager
writes only the runs around the view (`viewBox`: a quarter of the view to each
side, and as far as the highest flight reaches into a tilted view), and again on
`moveend` once the view leaves that. For all years of 103 flights this took the
map's worker from 0.9 to 1.4 GB to 84 to 189 MB, and turning the 3D view on from
a 5.4 s task to 1.4 s on a phone (CPU 6x slower), most of that the smoothing of
every flight. Their sources keep a buffer of 32 px, which a quad never leaves (a
longer one is cut into quads of 24 px at most), instead of 128, and no
simplification: with it, far tiles of a tilted view dropped the ribbons whose
walls still showed. The replay's trail is cut as the data has it, into a source
as before; the chase camera looks at it from close up.

### Selection ribbons

The lines of a selection over the heatmap (`ui/selectionHighlight.ts`) lie flat
on the ground, and in the 3D view the cloud draws the same flights at their
height beside them. While the 3D view lifts the flights,
`ui/selectionRibbons.ts` (with the feature bundle) draws the selection as
ribbons instead, in the colour of the lines (`selection-highlight-3d`, among the
other ribbons above the cloud), cut for the pixels of the level as the colour
layers' are, and sets `selectionRibbons` in the store, for which the lines empty
their source. The source is one of `RIBBON_SOURCES`, so its ribbons take the
exaggeration of a new level by feature state with the others, and
`ui/terrain.ts` hides them with the trail while they settle on new ground. They
are cut again for a new selection, dataset, ground or relief level and at the
end of a zoom into another whole level, only while the lines show, and from
`CULL_FROM_ZOOM` on only around the view, again as the view leaves that
(`utils/viewBox.ts`, shared with the layer manager): at map zoom 16 a year's
flights, all selected, came to 83,000 pieces and 125 ms of every zoom's end,
around the view to 7,000 and 20 ms. A lost context has them written again as
they were; hidden by a colour layer or a replay they stay as long as they still
fit. Their curves are the ones `groundedFlights` holds for the level, or makes
where the selection is more than half of the segments (the flights of the home
field), and otherwise the selected flights smoothed alone (`smoothGrounded`),
each the same curve: smoothing every flight of 2026 again for a level whose
cloud points were kept took 35 ms of a zoom's end on a desktop. Like the lines
they are not hit tested.

### Elevation tiles in the page

The page fetches the tiles from `s3.amazonaws.com`, whose
`elevation-tiles-prod/` bucket alone the CSP names in `connect-src` (MapLibre
fetches raster-dem tiles; `img-src` needs no entry).
`tests/frontend/unit/csp.test.ts` fails when a URL the frontend fetches is not
allowed there. The e2e fixture (`tests/e2e/fixtures.ts`) answers them itself
with a flat tile 500 m up, or with a slope of ridges and valleys for a spec that
asks for one (the `terrain` option), so specs and screenshots stay deterministic
and a spec can tell the flights stand on the relief.

## Satellite imagery

The Satellite switch (`satelliteVisible` in the store, `s=1` in the link)
fetches `ui/satellite.ts` with the feature bundle the first time it is on
(`followSatelliteSwitch` in `ui/layerVisibility.ts`; a failed fetch turns the
switch back off with a toast, if it is still on). It adds a `raster` source of
EOX's Sentinel-2 cloudless 2024 tiles (`SATELLITE_TILE_MAX_ZOOM`, level 14 of
the 256 px tiles at most, `z` 14 in the UI, the last that adds detail over the
one below) with the credit on the source, so the map shows it only while the
layer is visible, and one `raster` layer directly above the last layer of the
base map's ground (the `landcover`, `landuse`, `park` and `water` source layers
of CARTO's OpenMapTiles schema, or the background of a style without them), so
below its roads and labels, the shading of the relief and every layer of the
app. CARTO draws its county and state borders among those fills; they are moved
above the imagery. Like the shading, the layer is none of the app's:
`withDataLayers` carries its source across a base style swap and
`ui/satellite.ts` puts the layer back on `styledata`. Its paint
(`raster-brightness-max`, `raster-saturation`, `raster-contrast`) comes from the
`--satellite-*` tokens of `styles.css`, darker and paler under
`prefers-contrast: more`. The page fetches the tiles from `tiles.maps.eox.at`,
named in `connect-src` like the other tile hosts; the e2e fixture answers them
with its transparent tile.
