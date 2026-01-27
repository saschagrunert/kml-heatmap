/**
 * Wrapped Manager - Handles year-in-review/wrapped feature
 */
import DOMPurify from "dompurify";
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";
import {
  generateStatsHtml,
  generateFunFactsHtml,
  generateAircraftFleetHtml,
  generateHomeBaseHtml,
  generateDestinationsHtml,
} from "../utils/htmlGenerators";

export class WrappedManager {
  private app: MapApp;
  private originalMapParent: HTMLElement | null;
  private originalMapIndex: number | null;

  constructor(app: MapApp) {
    this.app = app;
    this.originalMapParent = null;
    this.originalMapIndex = null;

    // Pre-cache wrapped modal elements
    domCache.cacheElements([
      "wrapped-title",
      "wrapped-year",
      "wrapped-stats",
      "wrapped-fun-facts",
      "wrapped-aircraft-fleet",
      "wrapped-top-airports",
      "wrapped-airports-grid",
      "map",
      "wrapped-map-container",
      "wrapped-modal",
      "stats-btn",
      "export-btn",
      "wrapped-btn",
      "heatmap-btn",
      "airports-btn",
      "altitude-btn",
      "airspeed-btn",
      "aviation-btn",
      "year-filter",
      "aircraft-filter",
      "stats-panel",
      "altitude-legend",
      "airspeed-legend",
      "loading",
    ]);
  }

  showWrapped(): void {
    if (!this.app.map) return;

    // Use the currently selected year (including 'all')
    const year = this.app.selectedYear;

    // Calculate stats for selected year
    const yearStats = window.KMLHeatmap.calculateYearStats(
      this.app.fullPathInfo || [],
      this.app.fullPathSegments || [],
      year,
      this.app.fullStats
    );

    // Update title and year display based on selection
    const titleEl = domCache.get("wrapped-title");
    const yearEl = domCache.get("wrapped-year");

    if (year === "all") {
      if (titleEl) titleEl.textContent = "✨ Your Flight History";
      if (yearEl) yearEl.textContent = "All Years";
    } else {
      if (titleEl) titleEl.textContent = "✨ Your Year in Flight";
      if (yearEl) yearEl.textContent = year;
    }

    // Check if we have timing data (flight time and groundspeed)
    const hasTimingData =
      this.app.fullStats !== null &&
      this.app.fullStats.max_groundspeed_knots !== undefined &&
      this.app.fullStats.max_groundspeed_knots > 0;

    // Build stats grid (conditionally include flight time and max groundspeed)
    const statsHtml = generateStatsHtml(
      yearStats,
      this.app.fullStats ?? null,
      hasTimingData
    );

    const statsEl = domCache.get("wrapped-stats");
    if (statsEl) statsEl.innerHTML = DOMPurify.sanitize(statsHtml);

    // Build fun facts section with dynamic, varied facts
    const funFacts = window.KMLHeatmap.generateFunFacts(
      yearStats,
      this.app.fullStats
    );

    const funFactsHtml = generateFunFactsHtml(funFacts);

    const funFactsEl = domCache.get("wrapped-fun-facts");
    if (funFactsEl) funFactsEl.innerHTML = DOMPurify.sanitize(funFactsHtml);

    // Build aircraft fleet section using year-filtered data
    if (yearStats.aircraft_list && yearStats.aircraft_list.length > 0) {
      const fleetHtml = generateAircraftFleetHtml(yearStats);
      const fleetEl = domCache.get("wrapped-aircraft-fleet");
      if (fleetEl) fleetEl.innerHTML = DOMPurify.sanitize(fleetHtml);
    }

    // Build home base section using year-filtered airport data
    if (yearStats.airport_names && yearStats.airport_names.length > 0) {
      // Filter path info by selected year to count airport visits
      let filteredPathInfo;
      if (year === "all") {
        filteredPathInfo = this.app.fullPathInfo || [];
      } else {
        const yearStr = year.toString();
        filteredPathInfo = (this.app.fullPathInfo || []).filter((pathInfo) => {
          return pathInfo.year && pathInfo.year.toString() === yearStr;
        });
      }

      // Filter airports to only those in this year and count flights
      const yearAirportCounts: { [name: string]: number } = {};

      // Count how many times each airport appears in filtered paths
      filteredPathInfo.forEach((pathInfo) => {
        if (pathInfo.start_airport) {
          yearAirportCounts[pathInfo.start_airport] =
            (yearAirportCounts[pathInfo.start_airport] || 0) + 1;
        }
        if (pathInfo.end_airport) {
          yearAirportCounts[pathInfo.end_airport] =
            (yearAirportCounts[pathInfo.end_airport] || 0) + 1;
        }
      });

      // Create airport objects with year-specific counts
      const yearAirports = yearStats.airport_names.map((name: string) => {
        return {
          name: name,
          flight_count: yearAirportCounts[name] || 0,
        };
      });

      // Sort by flight count to find home base
      yearAirports.sort((a, b) => b.flight_count - a.flight_count);
      const homeBase = yearAirports[0];

      if (homeBase) {
        const homeBaseHtml = generateHomeBaseHtml(homeBase);
        const topAirportsEl = domCache.get("wrapped-top-airports");
        if (topAirportsEl)
          topAirportsEl.innerHTML = DOMPurify.sanitize(homeBaseHtml);

        // Build all destinations badge grid (excluding home base)
        const destinations = yearStats.airport_names.filter(
          (name) => name !== homeBase.name
        );

        const destinationsHtml = generateDestinationsHtml(destinations);
        const gridEl = domCache.get("wrapped-airports-grid");
        if (gridEl) gridEl.innerHTML = DOMPurify.sanitize(destinationsHtml);
      }
    }

    // Move the map into the wrapped container
    const mapContainer = domCache.get("map");
    const wrappedMapContainer = domCache.get("wrapped-map-container");

    if (!mapContainer || !wrappedMapContainer) return;

    // Store original position if not already stored
    if (!this.originalMapParent) {
      this.originalMapParent = mapContainer.parentNode as HTMLElement;
      this.originalMapIndex = Array.from(
        this.originalMapParent.children
      ).indexOf(mapContainer);
    }

    // Zoom to fit all data with extra padding
    this.app.map.fitBounds(this.app.config.bounds, { padding: [80, 80] });

    // Hide controls in wrapped view FIRST
    const controls = [
      document.querySelector(".leaflet-control-zoom"),
      domCache.get("stats-btn"),
      domCache.get("export-btn"),
      domCache.get("wrapped-btn"),
      domCache.get("heatmap-btn"),
      domCache.get("airports-btn"),
      domCache.get("altitude-btn"),
      domCache.get("airspeed-btn"),
      domCache.get("aviation-btn"),
      domCache.get("year-filter"),
      domCache.get("aircraft-filter"),
      domCache.get("stats-panel"),
      domCache.get("altitude-legend"),
      domCache.get("airspeed-legend"),
      domCache.get("loading"),
    ];
    controls.forEach((el) => {
      if (el) (el as HTMLElement).style.display = "none";
    });

    // Show modal first to ensure wrapped-map-container has dimensions
    const modal = domCache.get("wrapped-modal");
    if (modal) modal.style.display = "flex";

    // Wait for modal to render and have dimensions
    setTimeout(() => {
      // Now move map into wrapped container (which now has dimensions)
      wrappedMapContainer.appendChild(mapContainer);

      // Make sure the map container fills the wrapped container
      mapContainer.style.width = "100%";
      mapContainer.style.height = "100%";
      mapContainer.style.borderRadius = "12px";
      mapContainer.style.overflow = "hidden";

      // Force a layout recalculation
      wrappedMapContainer.offsetHeight;

      // Now that container has dimensions, invalidate map size
      setTimeout(() => {
        this.app.map!.invalidateSize();
        this.app.map!.fitBounds(this.app.config.bounds, { padding: [80, 80] });

        // Save state after wrapped panel is shown
        if (this.app.stateManager) {
          this.app.stateManager.saveMapState();
        }
      }, 100);
    }, 50);
  }

  closeWrapped(event?: MouseEvent): void {
    if (!event || (event.target as HTMLElement).id === "wrapped-modal") {
      // Move map back to original position
      const mapContainer = domCache.get("map");
      if (!mapContainer) return;

      if (this.originalMapParent && this.originalMapIndex !== null) {
        const children = Array.from(this.originalMapParent.children);
        if (this.originalMapIndex >= children.length) {
          this.originalMapParent.appendChild(mapContainer);
        } else {
          const refChild = children[this.originalMapIndex];
          if (refChild) {
            this.originalMapParent.insertBefore(mapContainer, refChild);
          }
        }

        // Restore map styling
        mapContainer.style.width = "";
        mapContainer.style.height = "";
        mapContainer.style.borderRadius = "";
        mapContainer.style.overflow = "";

        // Show controls again
        const controls = [
          document.querySelector(".leaflet-control-zoom"),
          domCache.get("stats-btn"),
          domCache.get("export-btn"),
          domCache.get("wrapped-btn"),
          domCache.get("heatmap-btn"),
          domCache.get("airports-btn"),
          domCache.get("altitude-btn"),
          domCache.get("airspeed-btn"),
          domCache.get("year-filter"),
          domCache.get("aircraft-filter"),
          domCache.get("stats-panel"),
          domCache.get("altitude-legend"),
          domCache.get("airspeed-legend"),
          domCache.get("loading"),
        ];
        controls.forEach((el) => {
          if (el) (el as HTMLElement).style.display = "";
        });

        // Only show aviation button if API key is available
        if (this.app.config.openaipApiKey) {
          const aviationBtn = domCache.get("aviation-btn");
          if (aviationBtn) aviationBtn.style.display = "";
        }

        // Force map to recalculate size
        setTimeout(() => {
          if (this.app.map) this.app.map.invalidateSize();

          // Save state after wrapped panel is closed
          if (this.app.stateManager) {
            this.app.stateManager.saveMapState();
          }
        }, 100);
      }

      const modal = domCache.get("wrapped-modal");
      if (modal) modal.style.display = "none";
    }
  }
}
