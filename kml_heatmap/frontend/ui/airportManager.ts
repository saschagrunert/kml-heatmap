/**
 * Airport Manager - Handles airport markers and popups
 */
import {
  Popup,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type Point,
  type Subscription,
} from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { calculateVisibleAirports, findHomeBase } from "../features/airports";
import type { AirportCounts } from "../features/airports";
import { datasetIndex } from "../calculations/datasetIndex";
import type { PathInfo } from "../types";
import {
  AIRPORT_SIZE_ZOOMS,
  MAP_LAYERS,
  MAP_SOURCES,
} from "../utils/constants";
import { ddToDms } from "../utils/geometry";
import { generateAirportPopupHtml } from "../utils/htmlGenerators";
import {
  cameraDistanceRatio,
  closeWhenBehindGlobe,
  panPopupIntoView,
} from "../utils/mapHelpers";
import { isTouchDevice } from "./layerManager";
import { airportLabelFeatures, setAirportLabelHover } from "./airportLabels";

/**
 * How far from a click an airport label still counts as hit, in pixels: a
 * little for a pointer, more for a finger. Less than for a flight (see
 * layerManager), since a label sits over the flights it would take clicks
 * from.
 */
const LABEL_HIT_PADDING_PX = 3;
const LABEL_TOUCH_HIT_PADDING_PX = 6;

/** Class on a marker whose label is under the pointer */
const LABEL_HOVERED_CLASS = "is-label-hovered";
import { prefersReducedMotion } from "../utils/motion";
import { loadFeatures } from "../services/featureLoader";
import { logError } from "../utils/logger";

/** Room kept between an airport popup and the edge of the map, in pixels */
const POPUP_PAN_PADDING_PX = 50;

/**
 * Distance from the middle of a marker, where MapLibre anchors it, to the
 * edge of its pointer target, where the popup's tip belongs. Half of
 * `--marker-target` in the stylesheet.
 */
const POPUP_OFFSET_PX = 12;

/** Store keys that change the popup counts and the home base */
const POPUP_KEYS = ["currentData", "selectedYear", "selectedAircraft"] as const;

/**
 * How many times farther from the camera than the middle of the map an
 * airport may be and still be shown. Towards the horizon of a steeply tilted
 * map the airports of a whole country crowd into a strip of dots and labels
 * over one another; up to about 55 degrees of tilt the whole map is nearer
 * than this (see cameraDistanceRatio).
 */
const AIRPORT_MAX_DISTANCE_RATIO = 2;

/** Tilt in degrees up to which no airport in view is that far (see above) */
const AIRPORT_ALL_NEAR_PITCH = 50;

/** Store keys that change which markers are shown */
const VISIBILITY_KEYS = [
  ...POPUP_KEYS,
  "selectedPathIds",
  "isolateSelection",
] as const;

export class AirportManager {
  private app: MapApp;
  /**
   * The one popup every airport shares: only one is ever open, and its
   * content depends on the filter of the moment, so it is written when the
   * popup opens rather than kept per marker. It is opened from here and not
   * through `marker.setPopup`, whose own click and key handling would toggle
   * it a second time. MapLibre would focus the first control inside and
   * narrow it to 240px; the app decides about focus and the stylesheet about
   * the width. It would also close it on every click on the map, the click
   * on the marker that opens it included; MapApp's click dispatcher, which
   * can tell the two apart, closes it instead.
   */
  private readonly popup = new Popup({
    focusAfterOpen: false,
    maxWidth: "none",
    offset: POPUP_OFFSET_PX,
    closeOnClick: false,
  });
  /** The airport the popup is open for */
  private openAirport: string | null = null;
  /** The airports shown under the filter and selection, null for all */
  private visibleAirports: ReadonlySet<string> | null = null;
  /** The airports too far towards the horizon to be shown */
  private farAirports: ReadonlySet<string> = new Set();
  /** The airport whose label is under the pointer */
  private hoveredLabel: string | null = null;
  /** The map's handlers below, once it is ready */
  private subscriptions: Subscription[] = [];
  private destroyed = false;

  /**
   * Once the map comes to rest. Asked on every frame of a gesture it cost
   * a measurement of every airport, and a new label source mid-gesture.
   */
  private readonly handleMoveEnd = (): void => this.updateFarAirports();

  /**
   * A label opens a popup like its marker, and says so: the pointer, and
   * the hover of both the label and the marker's dot
   */
  private readonly handleLabelMove = (event: MapLayerMouseEvent): void => {
    const name: unknown = event.features?.[0]?.properties["name"];
    if (typeof name !== "string") return;
    event.target.getCanvas().style.cursor = "pointer";
    this.hoverLabel(name);
  };

  private readonly handleLabelLeave = (event: MapLayerMouseEvent): void => {
    event.target.getCanvas().style.cursor = "";
    this.hoverLabel(null);
  };

  constructor(app: MapApp) {
    this.app = app;

    // The markers follow the data, the filters and the selection; nothing
    // has to remember to refresh them. A year switch changes four of these
    // keys at once, and both refreshes touch every marker, so each runs once
    // per update rather than once per key.
    app.store.subscribeKeys(POPUP_KEYS, () => this.updateAirportPopups());
    app.store.subscribeKeys(VISIBILITY_KEYS, () => this.updateAirportOpacity());

    // A popup would be left pointing at nothing
    app.store.subscribe("airportsVisible", (visible) => {
      if (!visible) this.closePopup();
    });

    this.popup.on("close", () => this.onPopupClosed());
    if (app.map) closeWhenBehindGlobe(app.map, this.popup);

    // The labels are there once the map's layers are
    app.mapReady
      .then((map) => {
        if (this.destroyed) return;
        this.subscriptions = [
          map.on("moveend", this.handleMoveEnd),
          map.on("mousemove", MAP_LAYERS.airportLabels, this.handleLabelMove),
          map.on("mouseleave", MAP_LAYERS.airportLabels, this.handleLabelLeave),
        ];
      })
      // The start-up reports a map that never got ready
      .catch(() => {});
  }

  /** Stop following the map; the markers and labels stay as they are */
  destroy(): void {
    this.destroyed = true;
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions = [];
  }

  /**
   * Flights per airport under the current filter, kept with the dataset for
   * as long as the filter stays
   */
  private airportFlightCounts(): AirportCounts {
    const data = this.app.currentData;
    if (!data) return {};
    return datasetIndex(data)
      .filter(this.app.selectedYear, this.app.selectedAircraft)
      .airportCounts();
  }

  /**
   * Update the home-base marker and the open popup with the counts of the
   * current year/aircraft filter
   */
  updateAirportPopups(): void {
    if (!this.app.allAirportsData || !this.app.airportMarkers) return;

    // Home base: airport with most flights in the current filter
    const homeBaseName = findHomeBase(this.airportFlightCounts());

    for (const airport of this.app.allAirportsData) {
      this.app.airportMarkers[airport.name]?.setHome(
        airport.name === homeBaseName,
      );
    }

    if (this.openAirport !== null) this.writePopupContent(this.openAirport);
    this.updateLabels();
  }

  /**
   * What a click on an airport's marker or on its label does: open its
   * popup and select its flights, or close the popup it has open already.
   * No flights are selected during a replay, which shows the one flight.
   */
  activateAirport(name: string): void {
    if (this.isPopupOpen(name)) {
      this.closePopup(name);
      return;
    }
    if (!this.app.replayActive) {
      this.app.pathSelection.selectPathsByAirport(name);
    }
    this.openPopup(name);
  }

  /**
   * The airport whose label is drawn at a point of the map, if any. Only a
   * label the map has placed counts: one it left out for lack of room is
   * not there to be clicked. A click lands on whole pixels and a finger is
   * not precise, so a label within a few pixels counts as hit: the chip is
   * small, and a click on its edge would otherwise go to the map beneath.
   */
  airportLabelAt(point: Point): string | null {
    const map = this.app.map;
    if (!map?.getLayer(MAP_LAYERS.airportLabels)) return null;
    const pad = isTouchDevice()
      ? LABEL_TOUCH_HIT_PADDING_PX
      : LABEL_HIT_PADDING_PX;
    const [feature] = map.queryRenderedFeatures(
      [
        [point.x - pad, point.y - pad],
        [point.x + pad, point.y + pad],
      ],
      { layers: [MAP_LAYERS.airportLabels] },
    );
    const name: unknown = feature?.properties["name"];
    return typeof name === "string" ? name : null;
  }

  /**
   * Open the popup on an airport's marker.
   *
   * A popup opened from the keyboard takes focus, and closing it puts focus
   * back on the marker instead of dropping it on the page (see
   * onPopupClosed). A pointer leaves focus where it is.
   */
  openPopup(name: string): void {
    const map = this.app.map;
    const marker = this.app.airportMarkers[name];
    if (!map || !marker) return;

    // Moving the open popup is no close: the focus belongs to whatever
    // asked for the new one, not to the marker that is left behind
    if (this.openAirport !== null) this.setExpanded(this.openAirport, false);
    this.openAirport = name;
    this.setExpanded(name, true);
    this.popup.setLngLat(marker.getLatLng());
    this.writePopupContent(name);
    if (!this.popup.isOpen()) this.popup.addTo(map);

    if (marker.getElement().matches(":focus-visible")) {
      this.popup
        .getElement()
        ?.querySelector<HTMLElement>(".popup-container")
        ?.focus();
    }
  }

  /**
   * Close the popup.
   * @param name - Close it only when it is open for this airport
   */
  closePopup(name?: string): void {
    if (name !== undefined && name !== this.openAirport) return;
    this.popup.remove();
  }

  /**
   * Whether the popup is open.
   * @param name - Ask for this airport only
   */
  isPopupOpen(name?: string): boolean {
    if (!this.popup.isOpen()) return false;
    return name === undefined || name === this.openAirport;
  }

  /**
   * Write the popup for an airport, with the counts of the current filter
   * and the flights it lists.
   *
   * The list is what lets a keyboard pick a single flight, and with it
   * replay: otherwise only a click on a path does. It lives in the feature
   * bundle, which the first popup fetches, so it arrives after the content
   * and makes the popup taller. MapLibre neither tells when content changes
   * nor keeps a popup inside the map the way Leaflet did, so both are done
   * here: once everything is in, the popup is laid out again and the map
   * panned until it shows in full.
   */
  private writePopupContent(name: string): void {
    const airport = this.app.allAirportsData?.find((a) => a.name === name);
    if (!airport) return;

    const counts = this.airportFlightCounts();
    this.popup.setHTML(
      generateAirportPopupHtml({
        name: airport.name,
        lat: airport.lat,
        lon: airport.lon,
        latDms: ddToDms(airport.lat, true),
        lonDms: ddToDms(airport.lon, false),
        flightCount: counts[airport.name] || 0,
        isHomeBase: airport.name === findHomeBase(counts),
      }),
    );

    void loadFeatures()
      .then((features) => {
        const map = this.app.map;
        // The popup can have closed or moved on while the bundle loaded
        if (!map || this.openAirport !== name || !this.popup.isOpen()) return;
        features?.listFlights(this.app, this.popup, name);
        // The side the popup hangs on was chosen for the height it had
        // before the list; setting the same position chooses again
        this.popup.setLngLat(this.popup.getLngLat());
        panPopupIntoView(
          map,
          this.popup,
          POPUP_PAN_PADDING_PX,
          !prefersReducedMotion(),
        );
      })
      .catch((error) => {
        logError(error);
        if (this.popup.isOpen()) {
          this.popup
            .getElement()
            ?.querySelector(".kh-popup-flights-loading")
            ?.remove();
        }
      });
  }

  /**
   * MapLibre has taken the popup out of the document by now. Focus that was
   * inside it, on the close button or a listed flight, fell to the page
   * with it, and goes to the marker instead. A click on the map closes the
   * popup as well, and keeps the focus it gave to the map.
   */
  private onPopupClosed(): void {
    const name = this.openAirport;
    this.openAirport = null;
    if (name === null) return;
    this.setExpanded(name, false);

    const active = document.activeElement;
    if (active === null || active === document.body) {
      this.app.airportMarkers[name]?.getElement().focus();
    }
  }

  /** Tell assistive technology whether an airport's popup is open */
  private setExpanded(name: string, expanded: boolean): void {
    this.app.airportMarkers[name]
      ?.getElement()
      .setAttribute("aria-expanded", String(expanded));
  }

  updateAirportOpacity(): void {
    const data = this.app.currentData;
    const visibleAirports = calculateVisibleAirports({
      pathInfo: data?.path_info ?? [],
      selectedYear: this.app.selectedYear,
      selectedAircraft: this.app.selectedAircraft,
      selectedPathIds: this.app.selectedPathIds,
      isolateSelection: this.app.isolateSelection,
      pathInfoById: data
        ? datasetIndex(data).pathInfoById
        : new Map<number, PathInfo>(),
    });

    this.visibleAirports = visibleAirports;
    this.applyVisibility();
  }

  /**
   * Hide the airports that have gone too far towards the horizon, and show
   * the ones that have come back; nothing is touched while that stays
   */
  private updateFarAirports(): void {
    const map = this.app.map;
    if (!map || !this.app.allAirportsData) return;
    const far = new Set<string>();
    if (
      map.getPitch() > AIRPORT_ALL_NEAR_PITCH &&
      map.getProjection()?.type !== "globe"
    ) {
      for (const airport of this.app.allAirportsData) {
        const place = { lng: airport.lon, lat: airport.lat };
        // The one the keyboard is on stays, or focus would fall to the page
        const focused =
          this.app.airportMarkers[airport.name]?.getElement() ===
          document.activeElement;
        if (
          !focused &&
          cameraDistanceRatio(map, place) > AIRPORT_MAX_DISTANCE_RATIO
        ) {
          far.add(airport.name);
        }
      }
    }
    const previous = this.farAirports;
    if (far.size === previous.size && [...far].every((n) => previous.has(n))) {
      return;
    }
    this.farAirports = far;
    this.applyVisibility();
  }

  /** Show the markers and labels of the airports the filter and view allow */
  private applyVisibility(): void {
    const visibleAirports = this.visibleAirports;
    const far = this.farAirports;
    for (const [airportName, marker] of Object.entries(
      this.app.airportMarkers,
    )) {
      if (!marker) continue;

      const visible =
        (visibleAirports === null || visibleAirports.has(airportName)) &&
        !far.has(airportName);
      marker.setVisible(visible);
      // A popup does not outlive the marker it points at
      if (!visible) this.closePopup(airportName);
    }
    this.updateLabels();
  }

  /**
   * Hand the label layer the airports that are shown, with the counts that
   * decide which label wins and the home base, whose label is marked. The
   * map places, fades and hides them itself (see ui/airportLabels.ts).
   */
  updateLabels(): void {
    const source = this.app.map?.getSource<GeoJSONSource>(
      MAP_SOURCES.airportLabels,
    );
    if (!source || !this.app.allAirportsData) return;
    const counts = this.airportFlightCounts();
    void source.setData(
      airportLabelFeatures(
        this.app.allAirportsData,
        counts,
        findHomeBase(counts),
        this.shownAirports(),
      ),
    );
  }

  /** The airports whose labels are shown, null for all */
  private shownAirports(): ReadonlySet<string> | null {
    const far = this.farAirports;
    if (far.size === 0) return this.visibleAirports;
    const names = new Set(
      this.visibleAirports ??
        (this.app.allAirportsData ?? []).map((airport) => airport.name),
    );
    for (const name of far) names.delete(name);
    return names;
  }

  /**
   * The pointer is on an airport's label, or on none (null). The label
   * shows it, and so does the marker's dot, as if the pointer were on it.
   */
  private hoverLabel(name: string | null): void {
    const map = this.app.map;
    const previous = this.hoveredLabel;
    if (!map || name === previous) return;
    this.hoveredLabel = name;
    if (previous !== null) {
      setAirportLabelHover(map, previous, false);
      this.app.airportMarkers[previous]
        ?.getElement()
        .classList.remove(LABEL_HOVERED_CLASS);
    }
    if (name !== null) {
      setAirportLabelHover(map, name, true);
      this.app.airportMarkers[name]
        ?.getElement()
        .classList.add(LABEL_HOVERED_CLASS);
    }
  }

  updateAirportMarkerSizes(): void {
    if (!this.app.map) return;

    const zoom = this.app.map.getZoom();
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;

    const sizeClass =
      AIRPORT_SIZE_ZOOMS.find((size) => zoom >= size.minZoom)?.sizeClass ?? "";

    mapContainer.dataset["zoomSize"] = sizeClass;
  }
}
