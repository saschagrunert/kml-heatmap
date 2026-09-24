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
import { showToast } from "../utils/toast";

/**
 * The tilt the 3D view turns a flatter map to, and what counts as flat
 * enough to need it: straight from above, a height takes no room.
 */
const THREE_D_PITCH = 50;
const THREE_D_MIN_PITCH = 20;

/**
 * The compass in the control column, and the one that floats over the map
 * on a phone, where the columns are hidden. The floating one only shows
 * while there is something to reset.
 */
const COMPASS_ID = "compass-btn";
const FLOATING_COMPASS_ID = "compass-float-btn";

/** The furthest the needle lays back, in degrees (see syncCompass) */
const COMPASS_MAX_TILT = 60;

export class MapOrientation {
  private readonly app: MapApp;
  /** Set once the style has loaded, before which no projection can be set */
  private styled: MapLibreMap | null = null;
  private globeToastShown = false;

  private readonly onTurn = (): void => this.syncCompass();

  /**
   * A marker that went behind the globe while it had focus. Hidden like the
   * others it would drop the focus to <body>, and the arrow keys that were
   * turning the globe would stop doing anything half way; so the stylesheet
   * leaves it, faded, until the map has taken the focus. A frame later:
   * MapLibre marks the markers in the frame after a move.
   */
  private readonly onMoveEnd = (): void => {
    const map = this.app.map;
    if (!map || !this.app.globeVisible) return;
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
    const entering = !this.app.globeVisible;
    this.app.globeVisible = entering;
    if (entering && !this.globeToastShown) {
      this.globeToastShown = true;
      showToast("Drag to spin the globe");
    }
  }

  /**
   * Lift the flights to their altitude, or put them back on the ground.
   * Lifted, they only show on a tilted map, so a flat one is tilted; and
   * they are the colour layers lifted, so without one the altitude colours
   * come on.
   */
  toggleThreeD(): void {
    const entering = !this.app.threeDVisible;
    this.app.threeDVisible = entering;
    if (!entering) return;
    const map = this.app.map;
    if (!this.app.altitudeVisible && !this.app.airspeedVisible) {
      this.app.uiToggles.toggleAltitude();
    }
    if (map && map.getPitch() < THREE_D_MIN_PITCH) {
      map.easeTo({ pitch: THREE_D_PITCH });
    }
  }

  private applyProjection(): void {
    const map = this.styled;
    if (!map) return;
    const type = this.app.globeVisible ? "globe" : "mercator";
    // A style names no projection until one is set, and means Mercator
    if ((map.getProjection()?.type ?? "mercator") === type) return;
    map.setProjection({ type });
  }

  /**
   * Point the needle north and lay it back with the map. The angles go on
   * the button and the stylesheet turns the icon by them: the icon itself
   * is drawn again whenever the chrome changes size, and would lose a
   * transform of its own.
   *
   * Laid back by the full tilt, 60 degrees, a 16 px needle is half as
   * tall and a smudge. So it also grows by the square root of what the
   * tilt takes, as MapLibre's own compass does: the tilt still shows, and
   * the needle stays readable. The map tilts further (MAP_MAX_PITCH), where
   * the needle would lie flat and grow out of its button, so it stops at
   * COMPASS_MAX_TILT.
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
      // Only a tilted map gets the 3D transform: even `rotateX(0deg)` has
      // the flat needle drawn a few pixels differently
      if (pitch > 0) {
        const tilt = Math.min(pitch, COMPASS_MAX_TILT);
        button?.style.setProperty("--compass-tilt", `rotateX(${tilt}deg)`);
        button?.style.setProperty(
          "--compass-grow",
          String(1 / Math.sqrt(Math.cos((tilt * Math.PI) / 180))),
        );
      } else {
        button?.style.removeProperty("--compass-tilt");
        button?.style.removeProperty("--compass-grow");
      }
    }
    const upright = bearing === 0 && pitch === 0;
    // With nothing to reset the button in the column is shown unavailable,
    // like Isolate and Replay: still focusable, so a keyboard user who just
    // pressed it keeps their place
    const compass = domCache.get(COMPASS_ID);
    if (compass) {
      compass.setAttribute("aria-disabled", String(upright));
      compass.style.opacity = upright ? "0.5" : "1.0";
    }
    if (!floating) return;
    // The button hides once its own click has done its work. Focus would
    // fall back to <body> with it; the map is what it acted on.
    if (upright && document.activeElement === floating) map.getCanvas().focus();
    floating.hidden = upright;
  }
}
