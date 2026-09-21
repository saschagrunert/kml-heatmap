/**
 * Wrapped Manager - Handles year-in-review/wrapped feature
 */
import type { FitBoundsOptions, LngLatBoundsLike } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { Airport, MapCenter } from "../types";
import { domCache, hideControls, restoreControls } from "../utils/domCache";
import { toBounds, toLngLat } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import {
  TOAST_ALERT_ID,
  TOAST_STACK_ID,
  TOAST_STATUS_ID,
} from "../utils/toast";
import {
  countryDisplayName,
  countryFlagSrc,
  findHomeBase,
  groupByCountry,
} from "../features/airports";
import {
  calculateYearStats,
  findFurthestAirport,
  generateFunFacts,
  segmentBounds,
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
} from "../utils/wrappedHtml";
import { watchScrollEnd, type ScrollEndWatcher } from "../utils/scrollFade";

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

/**
 * Longest the map panel holds its placeholder waiting for tiles. The map
 * says when they have landed; this covers the case where it never does:
 * offline, or in a tab that is hidden and renders no frames.
 */
const MAP_REVEAL_TIMEOUT_MS = 1200;

/** Padding in pixels around the data when the dialog fits the map to it */
const FIT_PADDING = 80;

/** The user's map view: app-shaped center, zoom in the map's own unit */
export interface UserMapView {
  center: MapCenter;
  zoom: number;
}

/**
 * Write the heading.
 *
 * It used to open with a sparkle, an emoji that ignored the gradient the
 * heading is painted with and came out differently on every platform, and
 * then with the same star drawn from the icon set, which at 24px beside
 * 36px type sat low and read as a stray mark. The card is titled by its
 * words alone.
 */
function setWrappedTitle(titleEl: HTMLElement, text: string): void {
  titleEl.textContent = text;
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
  private mapRevealTimer: ReturnType<typeof setTimeout> | null = null;
  /** Drops the map panel's placeholder; held so a close can run it early */
  private revealMap: (() => void) | null = null;
  private cardsScroll: ScrollEndWatcher | null = null;
  /**
   * The map view from before the dialog fitted it to the data. Kept until
   * the close has put it back, so a reopening in between does not take the
   * fitted view for the user's.
   */
  private savedView: UserMapView | null = null;
  private unsubscribeData: () => void;

  /**
   * The user's own map view while the dialog holds the map fitted to all
   * the data, null otherwise. The state manager saves this one: with the
   * fitted view in the URL and in storage, a reload or a shared link landed
   * on the overview once the dialog was closed. The zoom is the map's own;
   * the state manager converts it like any other.
   */
  userMapView(): UserMapView | null {
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
    this.cardsScroll = watchScrollEnd(column);
  }

  /**
   * Hold the placeholder until the map has something to show.
   *
   * Moving the map in takes two frames; its tiles take as long as the
   * network does, and the panel showed a black rectangle for all of it.
   */
  private revealMapWhenPainted(container: HTMLElement): void {
    const map = this.app.map;
    const reveal = (): void => {
      if (this.mapRevealTimer !== null) {
        clearTimeout(this.mapRevealTimer);
        this.mapRevealTimer = null;
      }
      map?.off("idle", reveal);
      this.revealMap = null;
      container.classList.remove("is-awaiting-map");
    };

    // Nothing in flight and nothing moving: no `idle` is coming, because the
    // map only fires it at the end of a frame and has no reason to draw one
    if (!map || (map.loaded() && !map.isMoving())) {
      reveal();
      return;
    }

    // `idle` lands when the fit has come to rest and the last tile of the
    // fitted view is drawn, which is the first moment the panel has anything
    // to show. It is the one to wait for rather than `load`, which fires once
    // in the life of the map, or `moveend`, which does not wait for tiles.
    this.revealMap = reveal;
    // `reveal` takes itself off, whichever of the three ways it is reached
    map.on("idle", reveal);
    this.mapRevealTimer = setTimeout(reveal, MAP_REVEAL_TIMEOUT_MS);
  }

  /**
   * What the dialog fits the map to: the flights it describes. The exported
   * bounds cover the whole dataset, so a single year or aircraft used to be
   * shown as a speck in the middle of every flight ever made.
   */
  private fitTarget(): LngLatBoundsLike {
    const { selectedYear, selectedAircraft, currentData } = this.app;
    if (
      (selectedYear === "all" && selectedAircraft === "all") ||
      !currentData
    ) {
      return toBounds(this.app.config.bounds);
    }
    const view = datasetIndex(currentData).filter(
      selectedYear,
      selectedAircraft,
    );
    return toBounds(segmentBounds(view.segments()) ?? this.app.config.bounds);
  }

  /**
   * Fit options for the overview, without the animation for reduced motion.
   * No duration: the map's default carries the fit, as it always has.
   */
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
    if (!this.savedView) {
      const center = this.app.map.getCenter();
      this.savedView = {
        center: { lat: center.lat, lng: center.lng },
        zoom: this.app.map.getZoom(),
      };
    }
    const fitTarget = this.fitTarget();
    this.app.map.fitBounds(fitTarget, this.fitOptions());

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

    // The map is moved in two frames from now, and its tiles land after
    // that. Until then the panel would be an empty rectangle taking up most
    // of the dialog, so it holds a placeholder of its own surface and the
    // map fades in over it.
    wrappedMapContainer.classList.add("is-awaiting-map");

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

      // Now that container has dimensions, have the map measure it
      this.mapResizeTimer = setTimeout(() => {
        this.mapResizeTimer = null;
        if (!this.app.map || !this.app.store.get("wrappedVisible")) return;
        this.app.map.resize();
        this.app.map.fitBounds(fitTarget, this.fitOptions());
        this.revealMapWhenPainted(wrappedMapContainer);
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
    const funFacts = generateFunFacts(yearStats, filteredStats, year);

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
          flagSrc: countryFlagSrc,
          homeBase,
          furthest,
        });
        if (gridEl) {
          gridEl.innerHTML = destinationsHtml;
          // The groups fade in one after another. Set here rather than in
          // the markup: the CSP allows no style attributes.
          gridEl
            .querySelectorAll<HTMLElement>(".country-group")
            .forEach((group, index) => {
              group.style.animationDelay = index / 10 + "s";
            });
        }
      }
    }

    // The cards were just rewritten, which is neither a scroll nor a
    // resize: without this the fade at the bottom of the column keeps
    // whatever verdict the previous set of cards left behind
    this.cardsScroll?.update();
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
   *
   * The map comes along, and with it the canvas and the airport markers,
   * which are tabbable. The overview map is not meant to be worked in, so
   * they are taken out of the tab cycle until the dialog closes. MapLibre
   * puts the markers inside the canvas container, so making that one inert
   * covers them; popups are children of the map itself and are closed, and
   * whatever is left of them (the segment tooltip) is made inert as well.
   */
  private trapFocus(modal: HTMLElement): void {
    const active = document.activeElement;
    // Opened from a link or a restored state, focus is on the body
    this.previouslyFocused =
      active instanceof HTMLElement && active !== document.body ? active : null;

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
    for (const marker of Object.values(this.app.airportMarkers)) {
      if (marker.isPopupOpen()) marker.closePopup();
    }
    document
      .querySelectorAll(
        "#map .maplibregl-canvas-container, #map .maplibregl-popup",
      )
      .forEach(makeInert);

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

    // No opener to return to: the control that opens the dialog is where
    // it would have been opened from, on either layout
    for (const id of ["wrapped-btn", "mobile-tab-wrapped"]) {
      const control = document.getElementById(id);
      control?.focus();
      if (control && document.activeElement === control) return;
    }

    // Not even that: do not leave focus inside the hidden dialog
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
    // Takes the placeholder down and drops the idle listener with it
    this.revealMap?.();
  }

  /** Drop every pending timer and listener; the dialog stays as it is */
  destroy(): void {
    this.unsubscribeData();
    this.cancelPendingMapTimers();
    this.cardsScroll?.stop();
    this.cardsScroll = null;
    if (this.escapeHandler) {
      document.removeEventListener("keydown", this.escapeHandler);
      this.escapeHandler = null;
    }
    this.inertObserver?.disconnect();
    this.inertObserver = null;
  }

  closeWrapped(): void {
    this.cancelPendingMapTimers();
    this.cardsScroll?.stop();
    this.cardsScroll = null;
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
        this.app.map.resize();
        if (view) {
          this.app.map.jumpTo({
            center: toLngLat([view.center.lat, view.center.lng]),
            zoom: view.zoom,
          });
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
