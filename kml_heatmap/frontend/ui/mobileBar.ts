/**
 * Mobile bottom bar.
 *
 * Below the mobile breakpoint the eleven floating control buttons wrap over
 * four rows and take the top third of a 390 px phone. This replaces them
 * with five tabs pinned to the bottom edge: Layers, Filter, Stats, Wrapped
 * and More. Layers, Filter and More open a bottom sheet; Stats and Wrapped
 * drive their panels directly.
 *
 * The bar is built at runtime because the template is shared with the
 * desktop layout. Everything it needs already exists in the page, so it
 * wires straight to the managers and mirrors the existing dropdowns instead
 * of holding state of its own.
 *
 * When replay activates the bar steps aside entirely: the replay panel takes
 * the bottom edge, so the two never stack.
 */
import type { MapApp } from "../mapApp";
import type { SheetRow } from "./mobileSheet";
import { MobileSheet } from "./mobileSheet";
import { icon, type IconName } from "../utils/icons";

/** Bar and sheet exist only below this width (matches the CSS breakpoint) */
export const MOBILE_BAR_BREAKPOINT_PX = 768;

/** Control columns the bar replaces while it is mounted */
const LEGACY_CONTROL_IDS = ["left-buttons", "right-buttons"];

/** Store keys that change what the sheets show */
const SHEET_KEYS = [
  "heatmapVisible",
  "altitudeVisible",
  "airspeedVisible",
  "airportsVisible",
  "aviationVisible",
  "selectedPathIds",
  "isolateSelection",
  "selectedYear",
  "selectedAircraft",
] as const;

type TabId = "layers" | "filter" | "stats" | "wrapped" | "more";

interface TabSpec {
  id: TabId;
  icon: IconName;
  label: string;
  /** Sheet openers are dialog buttons; the rest are toggles */
  opensSheet: boolean;
}

const TABS: TabSpec[] = [
  { id: "layers", icon: "layers", label: "Layers", opensSheet: true },
  { id: "filter", icon: "filter", label: "Filter", opensSheet: true },
  { id: "stats", icon: "stats", label: "Stats", opensSheet: false },
  { id: "wrapped", icon: "wrapped", label: "Wrapped", opensSheet: false },
  { id: "more", icon: "more", label: "More", opensSheet: true },
];

export class MobileBar {
  readonly root: HTMLElement;
  readonly sheet: MobileSheet;

  private readonly app: MapApp;
  private readonly tabs = new Map<TabId, HTMLButtonElement>();
  private readonly unsubscribes: (() => void)[] = [];
  private readonly mql: MediaQueryList;
  private readonly onBreakpoint: (e: MediaQueryListEvent) => void;
  private mounted = false;
  private replayActive = false;
  private openTab: TabId | null = null;

  constructor(app: MapApp) {
    this.app = app;
    this.sheet = new MobileSheet("mobile-sheet");

    this.root = document.createElement("nav");
    this.root.className = "mobile-bar";
    this.root.id = "mobile-bar";
    this.root.setAttribute("aria-label", "Map controls");

    for (const spec of TABS) {
      const tab = this.createTab(spec);
      this.tabs.set(spec.id, tab);
      this.root.append(tab);
    }

    this.mql = window.matchMedia(`(max-width: 767.98px)`);
    this.onBreakpoint = (e) => this.syncBreakpoint(e.matches);
  }

  /**
   * Create the bar for an app and keep it in step with the viewport width.
   * Returns null when there is no document to mount into.
   */
  static mountFor(app: MapApp): MobileBar | null {
    if (typeof document === "undefined" || !document.body) return null;
    const bar = new MobileBar(app);
    bar.start();
    return bar;
  }

  /** Mount now if the viewport is small and follow it from then on */
  start(): void {
    this.syncBreakpoint(this.mql.matches);
    this.mql.addEventListener("change", this.onBreakpoint);
  }

  destroy(): void {
    this.mql.removeEventListener("change", this.onBreakpoint);
    this.unmount();
  }

  isMounted(): boolean {
    return this.mounted;
  }

  /**
   * Replay owns the bottom edge while it runs. The bar leaves the document
   * rather than hiding in place: the stylesheet lifts the attribution and
   * the replay panel off the bar with `body:has(.mobile-bar)`, so a bar
   * that is merely invisible would still reserve its height.
   */
  setReplayActive(active: boolean): void {
    this.replayActive = active;
    if (!this.mounted) return;
    if (active) {
      this.closeSheet();
      this.root.remove();
    } else if (!document.contains(this.root)) {
      document.body.append(this.root);
    }
  }

  /** Whether the bar is currently in the document */
  isVisible(): boolean {
    return this.mounted && document.contains(this.root);
  }

  /** Currently open sheet tab, or null */
  currentTab(): TabId | null {
    return this.openTab;
  }

  private syncBreakpoint(matches: boolean): void {
    if (matches === this.mounted) return;
    if (matches) this.mount();
    else this.unmount();
  }

  private mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    if (!this.replayActive) document.body.append(this.root);
    this.sheet.mount(document.body);

    // The floating button groups are what the bar replaces
    setLegacyControlsHidden(true);

    this.subscribe();
    this.syncTabs();
  }

  private unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;

    this.closeSheet();
    this.sheet.destroy();
    this.root.remove();

    setLegacyControlsHidden(false);

    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }

  private subscribe(): void {
    const store = this.app.store;
    this.unsubscribes.push(
      store.subscribe("statsPanelVisible", () => this.syncTabs()),
      store.subscribe("wrappedVisible", () => this.syncTabs()),
    );
    for (const key of SHEET_KEYS) {
      this.unsubscribes.push(
        store.subscribe(key, () => {
          if (this.sheet.isOpen()) this.sheet.refresh();
        }),
      );
    }
  }

  private createTab(spec: TabSpec): HTMLButtonElement {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "mobile-tab";
    tab.id = "mobile-tab-" + spec.id;
    tab.dataset["tab"] = spec.id;

    // The stylesheet sizes the icon through `.mobile-tab .icon`, so the
    // svg is a direct child rather than being wrapped
    tab.innerHTML = icon(spec.icon, 24);

    const label = document.createElement("span");
    label.className = "mobile-tab-label";
    label.textContent = spec.label;

    tab.append(label);

    if (spec.opensSheet) {
      // No aria-expanded: the sheet is modal and covers the whole bar, so
      // the tab is not an operable disclosure once it is open
      tab.setAttribute("aria-haspopup", "dialog");
      tab.setAttribute("aria-controls", this.sheet.root.id);
    } else {
      tab.setAttribute("aria-pressed", "false");
    }

    tab.addEventListener("click", () => this.selectTab(spec.id));
    return tab;
  }

  /**
   * Run a tab. The sheet sits behind the bar, so the tabs stay reachable
   * while it is open. Tapping the active sheet tab toggles it closed;
   * tapping a different sheet tab swaps the content.
   */
  private selectTab(id: TabId): void {
    if (this.openTab === id) {
      this.closeSheet();
      return;
    }
    switch (id) {
      case "layers":
        this.openSheet(id, "Layers", this.layerRows());
        break;
      case "filter":
        this.openSheet(id, "Filter", this.filterRows());
        break;
      case "more":
        this.openSheet(id, "More", this.moreRows());
        break;
      case "stats":
        this.app.statsManager.toggleStats();
        break;
      case "wrapped":
        this.app.wrappedManager.showWrapped();
        break;
    }
    this.syncTabs();
  }

  private openSheet(id: TabId, title: string, rows: SheetRow[]): void {
    this.sheet.clearCloseCallback();
    this.openTab = id;
    this.sheet.openWith(title, rows, () => {
      this.openTab = null;
      this.syncTabs();
    });
  }

  private closeSheet(): void {
    this.sheet.close();
    this.openTab = null;
    this.syncTabs();
  }

  /**
   * Reflect panel and sheet state on the tabs. The bar only reads app state
   * while it is mounted, so a wide viewport never touches the store.
   */
  private syncTabs(): void {
    if (!this.mounted) return;
    for (const spec of TABS) {
      const tab = this.tabs.get(spec.id);
      if (!tab) continue;
      const active = this.isTabActive(spec.id);
      tab.classList.toggle("active", active);
      if (!spec.opensSheet) tab.setAttribute("aria-pressed", String(active));
    }
  }

  private isTabActive(id: TabId): boolean {
    if (id === "stats") return this.app.store.get("statsPanelVisible");
    if (id === "wrapped") return this.app.store.get("wrappedVisible") === true;
    return this.openTab === id;
  }

  private layerRows(): SheetRow[] {
    const app = this.app;
    const rows: SheetRow[] = [
      {
        kind: "switch",
        id: "heatmap",
        icon: "heatmap",
        label: "Heatmap",
        isOn: () => app.heatmapVisible,
        onToggle: () => app.uiToggles.toggleHeatmap(),
      },
      {
        kind: "switch",
        id: "airports",
        icon: "airport",
        label: "Airports",
        isOn: () => app.airportsVisible,
        onToggle: () => app.uiToggles.toggleAirports(),
      },
      {
        kind: "switch",
        id: "altitude",
        icon: "altitude",
        label: "Altitude",
        chip: "altitude",
        isOn: () => app.altitudeVisible,
        onToggle: () => app.uiToggles.toggleAltitude(),
      },
      {
        kind: "switch",
        id: "speed",
        icon: "speed",
        label: "Speed",
        chip: "speed",
        isOn: () => app.airspeedVisible,
        isDisabled: () => isControlDisabled("airspeed-btn"),
        onToggle: () => app.uiToggles.toggleAirspeed(),
      },
    ];

    if (app.config.openaipApiKey) {
      rows.push({
        kind: "switch",
        id: "aviation",
        icon: "aviation",
        label: "Aviation data",
        isOn: () => app.aviationVisible,
        onToggle: () => app.uiToggles.toggleAviation(),
      });
    }

    return rows;
  }

  private filterRows(): SheetRow[] {
    return [
      {
        kind: "select",
        id: "year",
        icon: "calendar",
        label: "Year",
        sourceId: "year-select",
      },
      {
        kind: "select",
        id: "aircraft",
        icon: "aircraft",
        label: "Aircraft",
        sourceId: "aircraft-select",
      },
    ];
  }

  private moreRows(): SheetRow[] {
    const app = this.app;
    return [
      {
        kind: "action",
        id: "replay",
        icon: "play",
        label: "Replay flight",
        hint: () =>
          app.replayManager.canReplay()
            ? null
            : "Select one flight with timing data",
        onSelect: () => app.replayManager.toggleReplay(),
      },
      {
        kind: "switch",
        id: "isolate",
        icon: "isolate",
        label: "Isolate selection",
        isOn: () => app.isolateSelection,
        isDisabled: () => app.selectedPathIds.size === 0,
        onToggle: () => app.pathSelection.toggleIsolateSelection(),
      },
      {
        kind: "action",
        id: "export",
        icon: "export",
        label: "Export map",
        onSelect: () => app.uiToggles.exportMap(),
      },
      {
        kind: "action",
        id: "share",
        icon: "share",
        label: "Share link",
        onSelect: () => {
          void app.uiToggles.shareLink();
        },
      },
      {
        kind: "action",
        id: "github",
        icon: "github",
        label: "Source code",
        onSelect: () => {
          window.open(
            "https://github.com/saschagrunert/kml-heatmap",
            "_blank",
            "noopener",
          );
        },
      },
      {
        kind: "action",
        id: "attribution",
        icon: "info",
        label: "Map tiles",
        hint: () => "© OpenStreetMap, © CARTO",
        onSelect: () => {},
        closeOnSelect: false,
      },
    ];
  }
}

/**
 * Take the replaced control columns out of reach while the bar stands in for
 * them, and hand them back untouched afterwards.
 *
 * `hidden` takes them out of the tab order so the same controls are not
 * offered twice, and the stylesheet turns the same attribute into
 * `display: none`, which holds even while replay has taken the bar out of
 * the document.
 *
 * No inline style is written here. The inline `display` belongs to
 * hideControls() and restoreControls(), which own it while Wrapped is open
 * or an export is in flight. Snapshotting it here used to capture their
 * `none` and restore it forever, stranding every desktop control after a
 * rotation across the breakpoint.
 */
function setLegacyControlsHidden(hidden: boolean): void {
  for (const id of LEGACY_CONTROL_IDS) {
    const element = document.getElementById(id);
    if (!element) continue;
    element.hidden = hidden;
  }
}

/** Whether a control in the page is currently disabled */
function isControlDisabled(id: string): boolean {
  const element = document.getElementById(id);
  return element instanceof HTMLButtonElement ? element.disabled : false;
}
