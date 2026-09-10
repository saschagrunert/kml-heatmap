/**
 * Airport Manager - Handles airport markers and popups
 */
import type { MapApp } from "../mapApp";
import {
  calculateAirportFlightCounts,
  calculateVisibleAirports,
  findHomeBase,
} from "../features/airports";
import type { AirportCounts } from "../features/airports";
import type { PathInfo } from "../types";
import { ddToDms } from "../utils/geometry";
import { generateAirportPopupHtml } from "../utils/htmlGenerators";
import { createAirportIcon } from "../appInitializer";

/** Padding added around a label box before two are called overlapping */
const LABEL_GAP_PX = 2;

export class AirportManager {
  private app: MapApp;
  /** Home-base icon state per airport marker (icons are recreated on change) */
  private homeIconState: Map<string, boolean> = new Map();
  /** Flight counts and exactly what they were counted from */
  private countsCache: {
    pathInfo: PathInfo[];
    year: string;
    aircraft: string;
    counts: AirportCounts;
  } | null = null;

  constructor(app: MapApp) {
    this.app = app;
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
   * The same counts, remembered until the filter or the dataset changes.
   *
   * declutterLabels() needs them to decide which label wins, and it runs on
   * every zoom, where nothing about the counts can have changed.
   */
  private airportFlightCounts(): AirportCounts {
    const pathInfo = this.app.fullPathInfo ?? [];
    const year = this.app.selectedYear;
    const aircraft = this.app.selectedAircraft;

    // The path info is compared by identity: the loader hands out one array
    // per year, so a different dataset is a different array. Comparing its
    // length instead would have let two datasets of the same size share a
    // cache entry.
    const cache = this.countsCache;
    if (
      cache !== null &&
      cache.pathInfo === pathInfo &&
      cache.year === year &&
      cache.aircraft === aircraft
    ) {
      return cache.counts;
    }

    const counts = calculateAirportFlightCounts(pathInfo, year, aircraft);
    this.countsCache = { pathInfo, year, aircraft, counts };
    return counts;
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
    const visibleAirports = calculateVisibleAirports({
      pathInfo: this.app.fullPathInfo ?? [],
      selectedYear: this.app.selectedYear,
      selectedAircraft: this.app.selectedAircraft,
      selectedPathIds: this.app.selectedPathIds,
      isolateSelection: this.app.isolateSelection,
      pathInfoById: this.app.layerManager.getPathInfoMap(),
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
