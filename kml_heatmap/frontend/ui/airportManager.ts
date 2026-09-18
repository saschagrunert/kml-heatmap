/**
 * Airport Manager - Handles airport markers and popups
 */
import type { MapApp } from "../mapApp";
import {
  calculateAirportFlightCounts,
  calculateVisibleAirports,
  createAirportIcon,
  findHomeBase,
} from "../features/airports";
import type { AirportCounts } from "../features/airports";
import { datasetIndex } from "../calculations/datasetIndex";
import type { PathInfo } from "../types";
import { ddToDms } from "../utils/geometry";
import { generateAirportPopupHtml } from "../utils/htmlGenerators";

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
  ".leaflet-control-attribution",
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
  /** Home-base icon state per airport marker (icons are recreated on change) */
  private homeIconState: Map<string, boolean> = new Map();

  constructor(app: MapApp) {
    this.app = app;

    // The markers follow the data, the filters and the selection; nothing
    // has to remember to refresh them. A year switch changes four of these
    // keys at once, and both refreshes touch every marker, so each runs once
    // per update rather than once per key.
    app.store.subscribeKeys(POPUP_KEYS, () => this.updateAirportPopups());
    app.store.subscribeKeys(VISIBILITY_KEYS, () => this.updateAirportOpacity());

    // Adding the layer back rebuilds every marker icon from its HTML, which
    // drops the crowded class; the labels would overlap until the next zoom
    app.store.subscribe("airportsVisible", (visible) => {
      if (visible) this.declutterLabels();
    });
  }

  // Calculate airport flight counts based on current filters
  calculateAirportFlightCounts(): AirportCounts {
    return calculateAirportFlightCounts(
      this.app.fullPathInfo ?? [],
      this.app.selectedYear,
      this.app.selectedAircraft,
    );
  }

  /**
   * The same counts, kept with the dataset for as long as the filter stays.
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
   * Update popup content and home-base marker class with the counts of the
   * current year/aircraft filter
   */
  updateAirportPopups(): void {
    if (!this.app.allAirportsData || !this.app.airportMarkers) return;

    let iconsRecreated = false;
    const airportCounts = this.airportFlightCounts();

    // Home base: airport with most flights in the current filter
    const homeBaseName = findHomeBase(airportCounts);

    for (const airport of this.app.allAirportsData) {
      const marker = this.app.airportMarkers[airport.name];
      if (!marker) continue;

      const flightCount = airportCounts[airport.name] || 0;
      const isHomeBase = airport.name === homeBaseName;

      const popup = generateAirportPopupHtml({
        name: airport.name,
        lat: airport.lat,
        lon: airport.lon,
        latDms: ddToDms(airport.lat, true),
        lonDms: ddToDms(airport.lon, false),
        flightCount,
        isHomeBase,
      });

      // The markers are created without a popup so that the very first
      // content already carries the counts of the active filter
      if (marker.getPopup()) {
        marker.setPopupContent(popup);
      } else {
        marker.bindPopup(popup, { autoPanPadding: [50, 50] });
      }

      if ((this.homeIconState.get(airport.name) ?? false) !== isHomeBase) {
        marker.setIcon(createAirportIcon(airport.name, isHomeBase));
        this.homeIconState.set(airport.name, isHomeBase);
        iconsRecreated = true;
      }
    }

    // A new icon is a new element, so whatever declutterLabels() decided
    // about the old one went with it
    if (iconsRecreated) this.declutterLabels();
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

      if (visibleAirports === null || visibleAirports.has(airportName)) {
        marker.setOpacity(1.0);
        if (!this.app.airportLayer.hasLayer(marker)) {
          marker.addTo(this.app.airportLayer);
        }
      } else if (this.app.airportLayer.hasLayer(marker)) {
        this.app.airportLayer.removeLayer(marker);
      }
    }

    // Markers that just left the map free up room for the labels that stay
    this.declutterLabels();
  }

  updateAirportMarkerSizes(): void {
    if (!this.app.map) return;

    const zoom = this.app.map.getZoom();
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;

    let sizeClass = "";
    if (zoom >= 14) sizeClass = "xlarge";
    else if (zoom >= 12) sizeClass = "large";
    else if (zoom >= 10) sizeClass = "medium";
    else if (zoom >= 8) sizeClass = "medium-small";
    else if (zoom >= 6) sizeClass = "small";

    mapContainer.dataset["zoomSize"] = sizeClass;
    mapContainer.classList.toggle("zoom-hide-labels", zoom < 5);

    this.declutterLabels();
  }

  /**
   * Hide the ICAO labels that would be drawn on top of one another.
   *
   * Leaflet places every marker independently, so at the zoom levels that fit
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

    const labels = Object.entries(this.app.airportMarkers)
      .map(([name, marker]) => ({
        name,
        label: marker
          .getElement()
          ?.querySelector<HTMLElement>(".airport-label"),
      }))
      .filter((entry): entry is { name: string; label: HTMLElement } =>
        Boolean(entry.label),
      )
      .sort((a, b) => (counts[b.name] ?? 0) - (counts[a.name] ?? 0));

    // Clear last run's verdict first: a crowded label is only invisible, it
    // still takes its place in layout, so this is a state reset rather than
    // something the measurement needs. Doing every write before every read
    // is what keeps this to one reflow instead of one per label.
    for (const { label } of labels) {
      label.classList.remove("airport-label-crowded");
    }
    const boxes = labels.map(({ label }) => label.getBoundingClientRect());
    placed.push(...chromeBoxes());

    labels.forEach(({ label }, index) => {
      const box = boxes[index]!;
      // A marker that is not on the map has no layout at all
      if (box.width === 0) return;

      const overlaps = placed.some(
        (other) =>
          box.left < other.right + LABEL_GAP_PX &&
          box.right > other.left - LABEL_GAP_PX &&
          box.top < other.bottom + LABEL_GAP_PX &&
          box.bottom > other.top - LABEL_GAP_PX,
      );

      if (overlaps) {
        label.classList.add("airport-label-crowded");
      } else {
        placed.push(box);
      }
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
