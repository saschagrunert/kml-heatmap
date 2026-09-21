/**
 * Map Orientation - the compass and the globe switch
 *
 * The map turns and tilts by gesture (right drag or ctrl drag, two fingers
 * on touch, shift with the arrow keys), and these two controls are the way
 * back and the way to the other projection. They are the app's own buttons
 * rather than MapLibre's NavigationControl and GlobeControl: those sit in a
 * corner of the map, where the control columns and the legends already are,
 * they are 29 px squares in a light theme where every control here is 36 px
 * (44 px on touch) on the dark surface, and on a phone they would float over
 * the map while everything else lives in the bar and its sheets. What they
 * do is one call each, which is all this module has to carry.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";

/**
 * The compass in the control column, and the one that floats over the map
 * on a phone, where the columns are hidden. The floating one only shows
 * while there is something to reset.
 */
const COMPASS_ID = "compass-btn";
const FLOATING_COMPASS_ID = "compass-float-btn";

export class MapOrientation {
  private readonly app: MapApp;
  /** Set once the style has loaded, before which no projection can be set */
  private styled: MapLibreMap | null = null;
  /** Bearing and pitch the airport labels were last sorted out at */
  private declutteredAt = "0/0";

  private readonly onTurn = (): void => this.syncCompass();

  /**
   * Sort the airport labels out again once the map has turned or tilted. A
   * pan of a flat map moves every marker by the same pixels, so there the
   * zoom alone decides which labels collide (see MapApp). A turn and a tilt
   * shift them against each other, and so does any move of a tilted map,
   * where what is further away is drawn closer together, and of a globe.
   */
  private readonly onMoveEnd = (): void => {
    const map = this.app.map;
    if (!map) return;
    const globe = this.app.globeVisible;
    const pitch = map.getPitch();
    const orientation = `${map.getBearing()}/${pitch}`;
    if (orientation === this.declutteredAt && pitch === 0 && !globe) return;
    this.declutteredAt = orientation;
    this.app.airportManager.declutterLabels();
    // A marker that went behind the globe while it had focus. Hidden like
    // the others it would drop the focus to <body>, and the arrow keys that
    // were turning the globe would stop doing anything half way; so the
    // stylesheet leaves it, faded, until the map has taken the focus. A
    // frame later: MapLibre marks the markers in the frame after a move.
    if (!globe) return;
    requestAnimationFrame(() => {
      if (document.activeElement?.closest(".maplibregl-marker-covered")) {
        map.getCanvas().focus();
      }
    });
  };

  constructor(app: MapApp) {
    this.app = app;
    const map = app.map;
    if (!map) return;

    // `rotate` and `pitch` fire for every frame of a gesture and of an
    // animation, the app's own included
    map.on("rotate", this.onTurn);
    map.on("pitch", this.onTurn);
    map.on("moveend", this.onMoveEnd);
    this.syncCompass();

    app.store.subscribe("globeVisible", () => this.applyProjection());
    // The projection is part of the style, so it waits for one. `mapReady`
    // resolves in the turn the data layers are added in, before the map
    // has drawn a frame with them: a link to a globe opens as one.
    app.mapReady
      .then((styled) => {
        this.styled = styled;
        this.applyProjection();
      })
      // The start-up reports a map that never got ready
      .catch(() => {});
  }

  destroy(): void {
    const map = this.app.map;
    if (!map) return;
    map.off("rotate", this.onTurn);
    map.off("pitch", this.onTurn);
    map.off("moveend", this.onMoveEnd);
  }

  /** Turn the map north up and lay it flat, the way every view starts */
  resetNorth(): void {
    // Shortened to nothing under reduced motion by the map itself
    this.app.map?.easeTo({ bearing: 0, pitch: 0 });
  }

  toggleGlobe(): void {
    this.app.globeVisible = !this.app.globeVisible;
  }

  private applyProjection(): void {
    const map = this.styled;
    if (!map) return;
    const type = this.app.globeVisible ? "globe" : "mercator";
    // A style names no projection until one is set, and means Mercator
    if ((map.getProjection()?.type ?? "mercator") === type) return;
    map.setProjection({ type });
    // No camera moved, so no `moveend` comes, yet every marker has a new
    // place once the map has drawn in the other projection
    void map.once("idle", () => this.app.airportManager.declutterLabels());
  }

  /**
   * Point the needle north. The angle goes on the button and the stylesheet
   * turns the icon by it: the icon itself is drawn again whenever the chrome
   * changes size, and would lose a transform of its own. The tilt is not
   * shown: laid back by up to 60 degrees, a 16 px needle is a smudge.
   */
  private syncCompass(): void {
    const map = this.app.map;
    if (!map) return;
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    const floating = domCache.get(FLOATING_COMPASS_ID);
    for (const button of [domCache.get(COMPASS_ID), floating]) {
      // At 0 the stylesheet draws the needle pointing up, so north is at
      // minus the bearing
      button?.style.setProperty("--compass-turn", `${-bearing}deg`);
    }
    if (!floating) return;
    const upright = bearing === 0 && pitch === 0;
    // The button hides once its own click has done its work. Focus would
    // fall back to <body> with it; the map is what it acted on.
    if (upright && document.activeElement === floating) map.getCanvas().focus();
    floating.hidden = upright;
  }
}
