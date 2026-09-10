/**
 * Wrapped Manager - Handles year-in-review/wrapped feature
 */
import type { MapApp } from "../mapApp";
import { domCache, hideControls, restoreControls } from "../utils/domCache";
import {
  calculateAirportFlightCounts,
  countryDisplayName,
  countryFlag,
  findHomeBase,
  groupByCountry,
} from "../features/airports";
import {
  calculateYearStats,
  findFurthestAirport,
  generateFunFacts,
} from "../features/wrapped";
import type { Coordinate } from "../utils/geometry";
import {
  calculateFilteredStatistics,
  filterPaths,
  filterSegmentsByPaths,
} from "../calculations/statistics";
import {
  generateStatsHtml,
  generateFunFactsHtml,
  generateAircraftFleetHtml,
  generateHomeBaseHtml,
  generateDestinationsHtml,
} from "../utils/htmlGenerators";

/** Elements that stay interactive while the dialog is open */
const NON_INERT_IDS = new Set(["map"]);

/**
 * Write the heading as a sparkle plus its words.
 *
 * The heading paints its text with a gradient through `background-clip`, and
 * an emoji inside that ignores the clip and keeps its own colours, so the two
 * halves of one line ended up looking unrelated. The sparkle gets its own
 * element that the gradient rule does not apply to.
 */
function setWrappedTitle(titleEl: HTMLElement, text: string): void {
  titleEl.replaceChildren();

  const spark = document.createElement("span");
  spark.className = "wrapped-title-spark";
  spark.setAttribute("aria-hidden", "true");
  // The space is part of the text rather than a margin, so the heading reads
  // and copies as one line and the gap is an ordinary word space
  spark.textContent = "✨ ";

  titleEl.append(spark, text);
}

/** Airport coordinates exported by the backend, keyed by airport name */
function airportCoordinates(): Map<string, Coordinate> {
  const coordinates = new Map<string, Coordinate>();
  for (const airport of window.KML_AIRPORTS?.airports ?? []) {
    if (typeof airport.lat === "number" && typeof airport.lon === "number") {
      coordinates.set(airport.name, [airport.lat, airport.lon]);
    }
  }
  return coordinates;
}

export class WrappedManager {
  private app: MapApp;
  private originalMapParent: HTMLElement | null;
  private originalMapIndex: number | null;
  private savedControlDisplays: Map<HTMLElement, string> = new Map();
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private previouslyFocused: HTMLElement | null = null;
  private inertElements: Element[] = [];
  private inertObserver: MutationObserver | null = null;
  private mapMoveTimer: ReturnType<typeof setTimeout> | null = null;
  private mapResizeTimer: ReturnType<typeof setTimeout> | null = null;
  private cardsScrollCleanup: (() => void) | null = null;

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
      "wrapped-cards-column",
      "map",
      "wrapped-map-container",
      "wrapped-modal",
      "stats-btn",
      "export-btn",
      "share-btn",
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

  private setWrappedVisible(visible: boolean): void {
    this.app.store.set("wrappedVisible", visible);
  }

  /**
   * Put the cards column back to the top for this opening and keep the
   * bottom fade in step with its scroll position: the fade says "there is
   * more below", so it has to go once there is not. Only the desktop layout
   * scrolls the column; the stacked one scrolls the dialog and drops the
   * mask in CSS.
   */
  private prepareCardsScroll(column: HTMLElement): void {
    // The column keeps its scroll position between openings, so without this
    // reopening Wrapped lands mid-card instead of on the title
    column.scrollTop = 0;

    const update = (): void => {
      const atEnd =
        column.scrollTop + column.clientHeight >= column.scrollHeight - 1;
      column.classList.toggle("is-at-end", atEnd);
    };
    column.addEventListener("scroll", update, { passive: true });
    // A resize can make everything fit, and then the fade would sit over
    // nothing until the next scroll that can no longer happen
    window.addEventListener("resize", update, { passive: true });
    this.cardsScrollCleanup = () => {
      column.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
    update();
  }

  showWrapped(): void {
    if (!this.app.map || this.savedControlDisplays.size > 0) return;

    // Use the currently selected year (including 'all')
    const year = this.app.selectedYear;

    const aircraft = this.app.selectedAircraft;

    const allPathInfo = this.app.fullPathInfo || [];
    const allSegments = this.app.fullPathSegments || [];

    // Filter once and share between both stat calculations
    const filteredPaths = filterPaths(allPathInfo, year, aircraft);
    const filteredSegments = filterSegmentsByPaths(allSegments, filteredPaths);
    const preFiltered = { paths: filteredPaths, segments: filteredSegments };

    const filteredStats = calculateFilteredStatistics({
      pathInfo: allPathInfo,
      segments: allSegments,
      year: year,
      aircraft: aircraft,
      preFiltered,
    });

    const yearStats = calculateYearStats(
      allPathInfo,
      allSegments,
      year,
      this.app.fullStats,
      aircraft,
      preFiltered,
    );

    // Update title and year display based on selection
    const titleEl = domCache.get("wrapped-title");
    const yearEl = domCache.get("wrapped-year");

    if (year === "all") {
      if (titleEl) setWrappedTitle(titleEl, "Your Flight History");
      if (yearEl) yearEl.textContent = "All Years";
    } else {
      if (titleEl) setWrappedTitle(titleEl, "Your Year in Flight");
      if (yearEl) yearEl.textContent = year;
    }

    // Check if we have timing data (flight time and groundspeed)
    const hasTimingData =
      filteredStats.max_groundspeed_knots !== undefined &&
      filteredStats.max_groundspeed_knots > 0;

    // Build stats grid (conditionally include flight time and max groundspeed)
    const statsHtml = generateStatsHtml(
      yearStats,
      filteredStats,
      hasTimingData,
    );

    const statsEl = domCache.get("wrapped-stats");
    if (statsEl) statsEl.innerHTML = statsHtml;

    // Build fun facts section with dynamic, varied facts
    const funFacts = generateFunFacts(yearStats, filteredStats);

    const funFactsHtml = generateFunFactsHtml(funFacts);

    const funFactsEl = domCache.get("wrapped-fun-facts");
    if (funFactsEl) funFactsEl.innerHTML = funFactsHtml;

    // The sections below are conditional, so clear them first: a year
    // without aircraft or airports must not show the previous year's content
    const fleetEl = domCache.get("wrapped-aircraft-fleet");
    const topAirportsEl = domCache.get("wrapped-top-airports");
    const gridEl = domCache.get("wrapped-airports-grid");
    if (fleetEl) fleetEl.innerHTML = "";
    if (topAirportsEl) topAirportsEl.innerHTML = "";
    if (gridEl) gridEl.innerHTML = "";

    // Build aircraft fleet section using year-filtered data
    if (yearStats.aircraft_list && yearStats.aircraft_list.length > 0) {
      const fleetHtml = generateAircraftFleetHtml(yearStats);
      if (fleetEl) fleetEl.innerHTML = fleetHtml;
    }

    // Build home base section using year-filtered airport data
    if (yearStats.airport_names && yearStats.airport_names.length > 0) {
      const airportCounts = calculateAirportFlightCounts(
        filteredPaths,
        "all",
        "all",
      );
      const homeBase = findHomeBase(airportCounts);
      const homeBaseCount = homeBase ? (airportCounts[homeBase] ?? 0) : 0;

      if (homeBase) {
        const homeBaseHtml = generateHomeBaseHtml({
          name: homeBase,
          flight_count: homeBaseCount,
        });
        if (topAirportsEl) topAirportsEl.innerHTML = homeBaseHtml;

        // Every airport is listed, the home base included, so the country
        // groups are complete; home base and furthest airport are accented
        const grouped = groupByCountry(yearStats.airport_names);
        const furthest = findFurthestAirport(
          homeBase,
          yearStats.airport_names,
          airportCoordinates(),
        );

        const destinationsHtml = generateDestinationsHtml(grouped, {
          countryName: countryDisplayName,
          flag: countryFlag,
          homeBase,
          furthest,
        });
        if (gridEl) gridEl.innerHTML = destinationsHtml;
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
        this.originalMapParent.children,
      ).indexOf(mapContainer);
    }

    // Zoom to fit all data with extra padding
    this.app.map.fitBounds(this.app.config.bounds, { padding: [80, 80] });

    // Hide controls in wrapped view FIRST
    this.savedControlDisplays = hideControls();

    // Show modal first to ensure wrapped-map-container has dimensions
    const modal = domCache.get("wrapped-modal");
    if (modal) {
      modal.style.display = "flex";
      this.trapFocus(modal);
    }
    this.setWrappedVisible(true);

    const cardsColumn = domCache.get("wrapped-cards-column");
    if (cardsColumn) this.prepareCardsScroll(cardsColumn);

    // Add Escape key handler to close modal
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.closeWrapped();
      }
    };
    document.addEventListener("keydown", this.escapeHandler);

    // Wait for modal to render and have dimensions. The handles are cleared
    // on close so that a quick close cannot move the map into a hidden dialog.
    this.mapMoveTimer = setTimeout(() => {
      this.mapMoveTimer = null;
      if (!this.app.store.get("wrappedVisible")) return;
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
      this.mapResizeTimer = setTimeout(() => {
        this.mapResizeTimer = null;
        if (!this.app.map || !this.app.store.get("wrappedVisible")) return;
        this.app.map.invalidateSize();
        this.app.map.fitBounds(this.app.config.bounds, { padding: [80, 80] });

        // Save state after wrapped panel is shown
        if (this.app.stateManager) {
          this.app.stateManager.saveMapState();
        }
      }, 100);
    }, 50);
  }

  /**
   * Keep keyboard and screen reader focus inside the dialog: remember the
   * opener, make everything outside the dialog inert and focus the close
   * button. The map is excluded because it is moved into the dialog.
   *
   * A snapshot of the children is not enough. Crossing the breakpoint while
   * the dialog is open mounts the mobile bar onto the body, and without the
   * observer its five tabs joined the dialog's tab cycle and stayed operable,
   * so a keyboard user could open a sheet behind the modal.
   */
  private trapFocus(modal: HTMLElement): void {
    const active = document.activeElement;
    this.previouslyFocused = active instanceof HTMLElement ? active : null;

    const makeInert = (el: Element): void => {
      if (
        el === modal ||
        NON_INERT_IDS.has(el.id) ||
        el.hasAttribute("inert")
      ) {
        return;
      }
      el.setAttribute("inert", "");
      this.inertElements.push(el);
    };

    this.inertElements = [];
    Array.from(document.body.children).forEach(makeInert);

    this.inertObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) makeInert(node);
        }
      }
    });
    this.inertObserver.observe(document.body, { childList: true });

    const closeBtn = modal.querySelector<HTMLElement>(".close-btn");
    if (closeBtn) closeBtn.focus();
  }

  private releaseFocus(): void {
    this.inertObserver?.disconnect();
    this.inertObserver = null;
    this.inertElements.forEach((el) => el.removeAttribute("inert"));
    this.inertElements = [];

    const opener = this.previouslyFocused;
    this.previouslyFocused = null;
    if (opener && document.contains(opener)) {
      // A hidden opener (for example while the controls are collapsed) stays
      // in the document but cannot take focus
      opener.focus();
      if (document.activeElement === opener) return;
    }

    // No opener to return to: do not leave focus inside the hidden dialog
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("#wrapped-modal")) {
      active.blur();
    }
  }

  /** Cancel the deferred map move and resize scheduled by showWrapped */
  private cancelPendingMapTimers(): void {
    if (this.mapMoveTimer !== null) {
      clearTimeout(this.mapMoveTimer);
      this.mapMoveTimer = null;
    }
    if (this.mapResizeTimer !== null) {
      clearTimeout(this.mapResizeTimer);
      this.mapResizeTimer = null;
    }
  }

  closeWrapped(event?: MouseEvent): void {
    if (!event || (event.target as HTMLElement).id === "wrapped-modal") {
      this.cancelPendingMapTimers();
      this.cardsScrollCleanup?.();
      this.cardsScrollCleanup = null;
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

        // Restore controls to their pre-wrapped display states
        restoreControls(this.savedControlDisplays);
        this.savedControlDisplays.clear();

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
      this.setWrappedVisible(false);

      // Remove Escape key handler
      if (this.escapeHandler) {
        document.removeEventListener("keydown", this.escapeHandler);
        this.escapeHandler = null;
      }

      this.releaseFocus();
    }
  }
}
