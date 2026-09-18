/**
 * Wrapped Manager - Handles year-in-review/wrapped feature
 */
import type { FitBoundsOptions, LatLng } from "leaflet";
import type { MapApp } from "../mapApp";
import type { Airport } from "../types";
import { domCache, hideControls, restoreControls } from "../utils/domCache";
import { prefersReducedMotion } from "../utils/motion";
import {
  TOAST_ALERT_ID,
  TOAST_STACK_ID,
  TOAST_STATUS_ID,
} from "../utils/toast";
import {
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
import { calculateFilteredStatistics } from "../calculations/statistics";
import { datasetIndex } from "../calculations/datasetIndex";
import {
  generateStatsHtml,
  generateFunFactsHtml,
  generateAircraftFleetHtml,
  generateHomeBaseHtml,
  generateDestinationsHtml,
} from "../utils/htmlGenerators";

/**
 * Elements that stay out of the inert set while the dialog is open: the
 * map, which the dialog takes over, and the toasts, whose live regions
 * would otherwise fall silent for as long as Wrapped is open.
 */
const NON_INERT_IDS = new Set([
  "map",
  TOAST_STACK_ID,
  TOAST_STATUS_ID,
  TOAST_ALERT_ID,
]);

/** Delay before the map is remeasured after moving back out of the dialog */
const MAP_RESTORE_DELAY_MS = 100;

/** Padding around the data when the dialog fits the map to it */
const FIT_PADDING: [number, number] = [80, 80];

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

const coordinatesByAirports = new WeakMap<Airport[], Map<string, Coordinate>>();

/**
 * Airport coordinates exported by the backend, keyed by airport name. Kept
 * with the airports array, which is loaded once.
 */
function airportCoordinates(): Map<string, Coordinate> {
  const airports = window.KML_AIRPORTS?.airports;
  if (!airports) return new Map();
  let coordinates = coordinatesByAirports.get(airports);
  if (!coordinates) {
    coordinates = new Map();
    for (const airport of airports) {
      if (typeof airport.lat === "number" && typeof airport.lon === "number") {
        coordinates.set(airport.name, [airport.lat, airport.lon]);
      }
    }
    coordinatesByAirports.set(airports, coordinates);
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
  private mapRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private cardsScrollCleanup: (() => void) | null = null;
  /**
   * The map view from before the dialog fitted it to the data. Kept until
   * the close has put it back, so a reopening in between does not take the
   * fitted view for the user's.
   */
  private savedView: { center: LatLng; zoom: number } | null = null;
  private unsubscribeData: () => void;

  /**
   * The user's own map view while the dialog holds the map fitted to all
   * the data, null otherwise. The state manager saves this one: with the
   * fitted view in the URL and in storage, a reload or a shared link landed
   * on the overview once the dialog was closed.
   */
  userMapView(): { center: LatLng; zoom: number } | null {
    return this.savedView;
  }

  constructor(app: MapApp) {
    this.app = app;
    this.originalMapParent = null;
    this.originalMapIndex = null;

    // A year that finishes loading while the dialog is open replaces the
    // cards, which were computed from the data that was there before
    this.unsubscribeData = app.store.subscribe("currentData", () => {
      if (app.store.get("wrappedVisible") === true) this.renderContent();
    });
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

  /** Fit options for the overview, without the animation for reduced motion */
  private fitOptions(): FitBoundsOptions {
    return { padding: FIT_PADDING, animate: !prefersReducedMotion() };
  }

  showWrapped(): void {
    if (!this.app.map || this.savedControlDisplays.size > 0) return;
    // Replay owns the map while it runs; its control is disabled then, and
    // this covers every other way in (the mobile tab, a restored state)
    if (this.app.replayState.active) return;

    // A close that is still settling must not remeasure a map that is about
    // to move back into the dialog
    this.cancelPendingMapTimers();

    this.renderContent();

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

    // The dialog fits the map to all the data; closing it puts the user's
    // own view back. A view still waiting to be put back by a close that is
    // settling is the user's, the current one is the fitted one.
    this.savedView ??= {
      center: this.app.map.getCenter(),
      zoom: this.app.map.getZoom(),
    };
    this.app.map.fitBounds(this.app.config.bounds, this.fitOptions());

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
    // The stacked layout scrolls the content row instead of the column, and
    // it keeps its position between openings just the same
    const content = domCache.get("wrapped-content");
    if (content) content.scrollTop = 0;

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
        this.app.map.fitBounds(this.app.config.bounds, this.fitOptions());
      }, 100);
    }, 50);
  }

  /**
   * Fill the cards for the selected year and aircraft from the loaded data.
   * Runs on opening and again when other data finishes loading while the
   * dialog is open.
   */
  private renderContent(): void {
    // Use the currently selected year (including 'all')
    const year = this.app.selectedYear;

    const aircraft = this.app.selectedAircraft;

    // The filter view of the dataset is shared with the statistics panel,
    // so a filter it already computed is not walked again here
    const data = this.app.currentData;
    const view = data ? datasetIndex(data).filter(year, aircraft) : null;
    const preFiltered = {
      paths: view?.paths ?? [],
      segments: view?.segments() ?? [],
    };

    const filteredStats = view
      ? view.statistics()
      : calculateFilteredStatistics({ pathInfo: [], segments: [] });

    const yearStats = calculateYearStats(
      data?.path_info ?? [],
      data?.path_segments ?? [],
      year,
      this.app.aircraftModels,
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
      const airportCounts = view?.airportCounts() ?? {};
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

  /** Cancel the deferred map move, resize and restore timers */
  private cancelPendingMapTimers(): void {
    if (this.mapMoveTimer !== null) {
      clearTimeout(this.mapMoveTimer);
      this.mapMoveTimer = null;
    }
    if (this.mapResizeTimer !== null) {
      clearTimeout(this.mapResizeTimer);
      this.mapResizeTimer = null;
    }
    if (this.mapRestoreTimer !== null) {
      clearTimeout(this.mapRestoreTimer);
      this.mapRestoreTimer = null;
    }
  }

  /** Drop every pending timer and listener; the dialog stays as it is */
  destroy(): void {
    this.unsubscribeData();
    this.cancelPendingMapTimers();
    this.cardsScrollCleanup?.();
    this.cardsScrollCleanup = null;
    if (this.escapeHandler) {
      document.removeEventListener("keydown", this.escapeHandler);
      this.escapeHandler = null;
    }
    this.inertObserver?.disconnect();
    this.inertObserver = null;
  }

  closeWrapped(): void {
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

      // Force map to recalculate size once it is back in the page layout,
      // then put the user's view back. The move this fires is what saves
      // the view to the URL again.
      this.mapRestoreTimer = setTimeout(() => {
        this.mapRestoreTimer = null;
        const view = this.savedView;
        this.savedView = null;
        if (!this.app.map) return;
        this.app.map.invalidateSize();
        if (view) {
          this.app.map.setView(view.center, view.zoom, { animate: false });
        }
      }, MAP_RESTORE_DELAY_MS);
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
