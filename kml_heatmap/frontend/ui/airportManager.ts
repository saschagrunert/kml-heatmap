/**
 * Airport Manager - Handles airport markers and popups
 */
import { Popup } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { calculateVisibleAirports, findHomeBase } from "../features/airports";
import type { AirportCounts } from "../features/airports";
import { datasetIndex } from "../calculations/datasetIndex";
import type { PathInfo } from "../types";
import {
  AIRPORT_HIDE_LABELS_BELOW_ZOOM,
  AIRPORT_SIZE_ZOOMS,
} from "../utils/constants";
import { ddToDms } from "../utils/geometry";
import { generateAirportPopupHtml } from "../utils/htmlGenerators";
import {
  closeWhenBehindGlobe,
  isBehindGlobe,
  panPopupIntoView,
} from "../utils/mapHelpers";
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

/** Padding added around a label box before two are called overlapping */
const LABEL_GAP_PX = 2;

/**
 * Chrome that sits over the map. A label underneath one of these is not
 * hidden by it, it is half hidden by it: the panels are translucent in
 * places and the label slides under an edge. They are fed to the declutter
 * pass as space that is already taken.
 */
const CHROME_SELECTORS = [
  "#left-buttons",
  "#right-buttons",
  "#stats-rail",
  "#mobile-bar",
  "#replay-controls",
  "#selection-chip",
  "#mobile-sheet",
  "#github-footer",
  ".color-legend",
  ".maplibregl-ctrl-attrib",
] as const;

/** Store keys that change the popup counts and the home base */
const POPUP_KEYS = ["currentData", "selectedYear", "selectedAircraft"] as const;

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

  constructor(app: MapApp) {
    this.app = app;

    // The markers follow the data, the filters and the selection; nothing
    // has to remember to refresh them. A year switch changes four of these
    // keys at once, and both refreshes touch every marker, so each runs once
    // per update rather than once per key.
    app.store.subscribeKeys(POPUP_KEYS, () => this.updateAirportPopups());
    app.store.subscribeKeys(VISIBILITY_KEYS, () => this.updateAirportOpacity());

    // A hidden layer has no label boxes to measure, so whatever the map did
    // in the meantime went past the declutter pass. A popup would be left
    // pointing at nothing.
    app.store.subscribe("airportsVisible", (visible) => {
      if (visible) this.declutterLabels();
      else this.closePopup();
    });

    this.popup.on("close", () => this.onPopupClosed());
    if (app.map) closeWhenBehindGlobe(app.map, this.popup);
  }

  /**
   * Flights per airport under the current filter, kept with the dataset for
   * as long as the filter stays.
   *
   * declutterLabels() needs them to decide which label wins, and it runs on
   * every zoom, where nothing about the counts can have changed.
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

    for (const [airportName, marker] of Object.entries(
      this.app.airportMarkers,
    )) {
      if (!marker) continue;

      const visible =
        visibleAirports === null || visibleAirports.has(airportName);
      marker.setVisible(visible);
      // A popup does not outlive the marker it points at
      if (!visible) this.closePopup(airportName);
    }

    // Markers that just left the map free up room for the labels that stay
    this.declutterLabels();
  }

  updateAirportMarkerSizes(): void {
    if (!this.app.map) return;

    const zoom = this.app.map.getZoom();
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;

    const sizeClass =
      AIRPORT_SIZE_ZOOMS.find((size) => zoom >= size.minZoom)?.sizeClass ?? "";

    mapContainer.dataset["zoomSize"] = sizeClass;
    mapContainer.classList.toggle(
      "zoom-hide-labels",
      zoom < AIRPORT_HIDE_LABELS_BELOW_ZOOM,
    );

    this.declutterLabels();
  }

  /**
   * Hide the ICAO labels that would be drawn on top of one another.
   *
   * Every marker is placed independently, so at the zoom levels that fit
   * a whole country the codes of neighbouring airports overlap and neither is
   * readable. Busier airports are placed first, so the ones a reader is most
   * likely looking for keep their label; the marker dot itself always stays.
   *
   * The page's own panels count as taken space for the same reason, so a
   * label pans behind the control column instead of sliding half under it.
   */
  declutterLabels(): void {
    const counts = this.airportFlightCounts();
    const placed: DOMRect[] = [];

    // A marker behind the globe is hidden, not gone: its label keeps a box,
    // at the point the far side projects to, right among the visible ones.
    // Asked of the map and not of the class MapLibre hides it by, which it
    // sets a frame after the move this may run at the end of.
    const map = this.app.map;
    const labels = Object.entries(this.app.airportMarkers)
      .filter(([, marker]) => !map || !isBehindGlobe(map, marker.getLatLng()))
      .map(([name, marker]) => ({
        name,
        label: marker.getElement().querySelector<HTMLElement>(".airport-label"),
      }))
      .filter((entry): entry is { name: string; label: HTMLElement } =>
        Boolean(entry.label),
      )
      .sort((a, b) => (counts[b.name] ?? 0) - (counts[a.name] ?? 0));

    // A crowded label is only invisible, it keeps its place in layout, so
    // last run's verdict can stay while this one is measured. Every read
    // comes before every write, which keeps this to one reflow instead of
    // one per label.
    const boxes = labels.map(({ label }) => label.getBoundingClientRect());
    placed.push(...chromeBoxes());

    const crowded = labels.map((_, index) => {
      const box = boxes[index]!;
      // A marker that is not on the map has no layout at all
      if (box.width === 0) return false;

      const overlaps = placed.some(
        (other) =>
          box.left < other.right + LABEL_GAP_PX &&
          box.right > other.left - LABEL_GAP_PX &&
          box.top < other.bottom + LABEL_GAP_PX &&
          box.bottom > other.top - LABEL_GAP_PX,
      );
      if (!overlaps) placed.push(box);
      return overlaps;
    });

    // Only a label whose verdict changed is touched: the stylesheet fades
    // it, and a class taken off and put back would restart that fade on
    // every label at every run
    labels.forEach(({ label }, index) => {
      label.classList.toggle("airport-label-crowded", crowded[index]);
    });
  }
}

/** Boxes of the chrome currently drawn over the map */
function chromeBoxes(): DOMRect[] {
  const boxes: DOMRect[] = [];
  for (const selector of CHROME_SELECTORS) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      // `display: none` already measures as an empty box; `visibility` does
      // not, and replay hides the legends, the GitHub link and the
      // statistics sheet that way rather than relayouting around them
      if (getComputedStyle(element).visibility === "hidden") continue;
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) boxes.push(box);
    }
  }
  return boxes;
}
