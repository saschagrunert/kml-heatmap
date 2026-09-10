/**
 * MobileBar: mounting rules, the five tabs and the sheets they open.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MapApp } from "../../../../kml_heatmap/frontend/mapApp";
import { AppStore } from "../../../../kml_heatmap/frontend/state/store";
import {
  MobileBar,
  MOBILE_BAR_BREAKPOINT_PX,
} from "../../../../kml_heatmap/frontend/ui/mobileBar";

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1200;

/** Button groups the bar replaces */
const LEGACY_IDS = ["left-buttons", "right-buttons"];

let mqlListeners: Set<(e: MediaQueryListEvent) => void>;
let mqlMatches: boolean;

function setupMatchMedia(): void {
  mqlListeners = new Set();
  mqlMatches = false;
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn((_query: string) => ({
      get matches() {
        return mqlMatches;
      },
      addEventListener(_type: string, cb: (e: MediaQueryListEvent) => void) {
        mqlListeners.add(cb);
      },
      removeEventListener(_type: string, cb: (e: MediaQueryListEvent) => void) {
        mqlListeners.delete(cb);
      },
    })),
    configurable: true,
    writable: true,
  });
}

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
  const matches = width < MOBILE_BAR_BREAKPOINT_PX;
  if (matches !== mqlMatches) {
    mqlMatches = matches;
    for (const cb of mqlListeners) {
      cb({ matches } as MediaQueryListEvent);
    }
  }
}

function createMockApp() {
  const store = new AppStore();
  return {
    store,
    config: { openaipApiKey: undefined as string | undefined },
    uiToggles: {
      toggleHeatmap: vi.fn(),
      toggleAirports: vi.fn(),
      toggleAltitude: vi.fn(),
      toggleAirspeed: vi.fn(),
      toggleAviation: vi.fn(),
      exportMap: vi.fn(),
      shareLink: vi.fn(() => Promise.resolve()),
    },
    statsManager: { toggleStats: vi.fn() },
    wrappedManager: { showWrapped: vi.fn() },
    pathSelection: { toggleIsolateSelection: vi.fn() },
    replayManager: { canReplay: vi.fn(() => true), toggleReplay: vi.fn() },
    get heatmapVisible() {
      return store.get("heatmapVisible");
    },
    get altitudeVisible() {
      return store.get("altitudeVisible");
    },
    get airspeedVisible() {
      return store.get("airspeedVisible");
    },
    get airportsVisible() {
      return store.get("airportsVisible");
    },
    get aviationVisible() {
      return store.get("aviationVisible");
    },
    get isolateSelection() {
      return store.get("isolateSelection");
    },
    get selectedPathIds() {
      return store.get("selectedPathIds");
    },
  };
}

type BarMockApp = ReturnType<typeof createMockApp>;

function mountPageChrome(): void {
  for (const id of LEGACY_IDS) {
    const group = document.createElement("div");
    group.id = id;
    document.body.append(group);
  }

  const airspeed = document.createElement("button");
  airspeed.id = "airspeed-btn";
  document.body.append(airspeed);

  // Shaped like the template plus what the app appends at load: the
  // unfiltered option names the filter, and no label carries an emoji
  for (const [id, all, rest] of [
    ["year-select", "All years", ["2024", "2025"]],
    ["aircraft-select", "All aircraft", ["D-EABC (C172)"]],
  ] as [string, string, string[]][]) {
    const select = document.createElement("select");
    select.id = id;
    for (const [value, label] of [["all", all], ...rest.map((r) => [r, r])]) {
      const option = document.createElement("option");
      option.value = value!;
      option.textContent = label!;
      select.append(option);
    }
    document.body.append(select);
  }
}

function tab(id: string): HTMLButtonElement {
  const element = document.getElementById("mobile-tab-" + id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Missing tab ${id}`);
  }
  return element;
}

function sheetRows(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".mobile-sheet .sheet-row"),
  ).map((row) => row.dataset["row"] ?? "");
}

function sheetTitle(): string {
  return document.querySelector(".sheet-title")?.textContent ?? "";
}

/** Dismiss the open sheet the way the user does */
function dismissSheet(): void {
  document.querySelector<HTMLButtonElement>(".sheet-close")!.click();
}

describe("MobileBar", () => {
  let app: BarMockApp;
  let bar: MobileBar | null;

  const create = (): MobileBar => {
    const created = MobileBar.mountFor(app as unknown as MapApp);
    if (!created) throw new Error("MobileBar was not created");
    bar = created;
    return created;
  };

  beforeEach(() => {
    setupMatchMedia();
    mqlMatches = true;
    Object.defineProperty(window, "innerWidth", {
      value: PHONE_WIDTH,
      configurable: true,
      writable: true,
    });
    mountPageChrome();
    app = createMockApp();
    bar = null;
  });

  afterEach(() => {
    bar?.destroy();
    document.body.replaceChildren();
    document.body.className = "";
    setWidth(1024);
    vi.restoreAllMocks();
  });

  describe("mounting", () => {
    it("mounts below the breakpoint", () => {
      create();

      expect(document.querySelector(".mobile-bar")).not.toBeNull();
    });

    it("stays out of the document above the breakpoint", () => {
      mqlMatches = false;
      Object.defineProperty(window, "innerWidth", {
        value: MOBILE_BAR_BREAKPOINT_PX,
        configurable: true,
        writable: true,
      });

      const created = create();

      expect(created.isMounted()).toBe(false);
      expect(document.querySelector(".mobile-bar")).toBeNull();
    });

    it("takes the floating button groups out of reach", () => {
      const created = create();
      for (const id of LEGACY_IDS) {
        // The stylesheet turns the attribute into `display: none`; nothing
        // inline is written, so hideControls() keeps sole ownership of that
        expect(document.getElementById(id)!.hidden).toBe(true);
      }

      created.destroy();

      for (const id of LEGACY_IDS) {
        expect(document.getElementById(id)!.hidden).toBe(false);
      }
    });

    it("keeps the groups out of reach while replay owns the bottom edge", () => {
      const created = create();

      created.setReplayActive(true);

      // The bar leaves the document, so a `body:has(.mobile-bar)` rule would
      // stop matching here; the attribute the stylesheet keys off must stay
      expect(document.contains(created.root)).toBe(false);
      for (const id of LEGACY_IDS) {
        expect(document.getElementById(id)!.hidden).toBe(true);
      }
    });

    it("never writes the inline display of the groups", () => {
      // hideControls()/restoreControls() own it while Wrapped is open or an
      // export is in flight; the stylesheet hides the groups on its own
      const groups = LEGACY_IDS.map((id) => document.getElementById(id)!);
      for (const group of groups) group.style.display = "block";

      const created = create();
      for (const group of groups) expect(group.style.display).toBe("block");

      created.destroy();
      for (const group of groups) expect(group.style.display).toBe("block");
    });

    it("survives a rotation taken while Wrapped hid the controls", () => {
      const groups = LEGACY_IDS.map((id) => document.getElementById(id)!);
      setWidth(DESKTOP_WIDTH);
      const created = create();

      // Wrapped opens: hideControls() saves the current display and blanks it
      const saved = groups.map((group) => group.style.display);
      for (const group of groups) group.style.display = "none";
      // The phone is rotated into portrait while Wrapped is still open
      setWidth(PHONE_WIDTH);
      // Escape dismisses Wrapped: restoreControls() puts back what it saved
      groups.forEach((group, index) => {
        group.style.display = saved[index] ?? "";
      });
      // ...and the phone goes back to landscape
      setWidth(DESKTOP_WIDTH);

      // A snapshot taken at mount would have captured Wrapped's "none" and
      // restored it here, stranding every desktop control until a reload
      expect(created.isMounted()).toBe(false);
      for (const group of groups) {
        expect(group.hidden).toBe(false);
        expect(group.style.display).toBe("");
      }
    });

    it("follows the viewport across the breakpoint", () => {
      setWidth(DESKTOP_WIDTH);
      const created = create();

      setWidth(PHONE_WIDTH);
      expect(created.isMounted()).toBe(true);

      setWidth(DESKTOP_WIDTH);
      expect(created.isMounted()).toBe(false);
      expect(document.querySelector(".mobile-sheet")).toBeNull();
    });

    it("stops listening after destroy", () => {
      const created = create();
      created.destroy();

      setWidth(PHONE_WIDTH);

      expect(created.isMounted()).toBe(false);
    });
  });

  describe("tabs", () => {
    beforeEach(() => {
      create();
    });

    it("shows five labelled tabs with 24px icons", () => {
      const tabs = document.querySelectorAll<HTMLElement>(".mobile-tab");

      expect(
        Array.from(tabs).map(
          (element) =>
            element.querySelector(".mobile-tab-label")?.textContent ?? "",
        ),
      ).toEqual(["Layers", "Filter", "Stats", "Wrapped", "More"]);
      expect(
        tabs[0]!.querySelector(":scope > svg.icon")!.getAttribute("width"),
      ).toBe("24");
    });

    it("marks sheet tabs as dialog openers", () => {
      expect(tab("layers").getAttribute("aria-haspopup")).toBe("dialog");
      expect(tab("layers").getAttribute("aria-controls")).toBe("mobile-sheet");
      // The open sheet covers the bar, so the tab is not an operable
      // disclosure and must not claim to be one
      expect(tab("layers").getAttribute("aria-expanded")).toBeNull();
      expect(tab("stats").getAttribute("aria-pressed")).toBe("false");
    });

    it("opens the layers sheet and marks the tab active", () => {
      tab("layers").click();

      expect(sheetTitle()).toBe("Layers");
      expect(sheetRows()).toEqual(["heatmap", "airports", "altitude", "speed"]);
      expect(tab("layers").classList.contains("active")).toBe(true);
      expect(tab("layers").getAttribute("aria-expanded")).toBeNull();
    });

    it("toggles the stats panel instead of opening a sheet", () => {
      tab("stats").click();

      expect(app.statsManager.toggleStats).toHaveBeenCalledTimes(1);
      expect(document.querySelector<HTMLElement>(".mobile-sheet")!.hidden).toBe(
        true,
      );
    });

    it("follows the stats panel state", () => {
      app.store.set("statsPanelVisible", true);

      expect(tab("stats").classList.contains("active")).toBe(true);
      expect(tab("stats").getAttribute("aria-pressed")).toBe("true");
    });

    it("opens the wrapped card and follows its state", () => {
      tab("wrapped").click();
      expect(app.wrappedManager.showWrapped).toHaveBeenCalledTimes(1);

      app.store.set("wrappedVisible", true);
      expect(tab("wrapped").classList.contains("active")).toBe(true);
    });

    it("collects the remaining controls under More", () => {
      tab("more").click();

      expect(sheetTitle()).toBe("More");
      expect(sheetRows()).toEqual([
        "replay",
        "isolate",
        "export",
        "share",
        "github",
        "attribution",
      ]);
    });
  });

  describe("filter rows", () => {
    it("offers a row for each dropdown", () => {
      create();
      tab("filter").click();

      expect(sheetTitle()).toBe("Filter");
      expect(sheetRows()).toEqual(["year", "aircraft"]);
    });

    it("mirrors the page dropdowns and writes a choice back", () => {
      create();
      tab("filter").click();
      const year = document.querySelector<HTMLSelectElement>(
        '[data-row="year"] select',
      )!;
      expect(Array.from(year.options).map((o) => o.value)).toEqual([
        "all",
        "2024",
        "2025",
      ]);
      // The unfiltered option is relabelled: the row already says "Year"
      expect(year.options[0]!.textContent).toBe("All");

      year.value = "2025";
      year.dispatchEvent(new Event("change", { bubbles: true }));

      expect(
        document.querySelector<HTMLSelectElement>("#year-select")!.value,
      ).toBe("2025");
    });

    it("names each dropdown by its row label", () => {
      create();
      tab("filter").click();

      for (const rowId of ["year", "aircraft"]) {
        const select = document.querySelector<HTMLSelectElement>(
          `[data-row="${rowId}"] select`,
        )!;
        const id = select.getAttribute("aria-labelledby");
        expect(id, `${rowId} select is unnamed`).toBeTruthy();
        expect(document.getElementById(id!)?.textContent).toBeTruthy();
      }
    });
  });

  describe("layer rows", () => {
    it("drives the layer toggles", () => {
      create();
      tab("layers").click();

      document.querySelector<HTMLElement>('[data-row="heatmap"]')!.click();

      expect(app.uiToggles.toggleHeatmap).toHaveBeenCalledTimes(1);
    });

    it("wires every row to its own toggle and no other", () => {
      // Each row's own switch: a row wired to the wrong toggle used to pass
      // here and was caught only by the mobile end-to-end project
      const wiring: [string, keyof typeof app.uiToggles][] = [
        ["heatmap", "toggleHeatmap"],
        ["airports", "toggleAirports"],
        ["altitude", "toggleAltitude"],
        ["speed", "toggleAirspeed"],
        ["aviation", "toggleAviation"],
      ];
      app.config.openaipApiKey = "key";
      create();
      tab("layers").click();

      for (const [rowId, method] of wiring) {
        const row = document.querySelector<HTMLElement>(
          `[data-row="${rowId}"]`,
        );
        expect(row, `missing row ${rowId}`).not.toBeNull();
        row!.click();

        for (const [, other] of wiring) {
          const calls = vi.mocked(app.uiToggles[other]).mock.calls.length;
          expect(calls, `${rowId} called ${String(other)}`).toBe(
            other === method ? 1 : 0,
          );
        }
        vi.mocked(app.uiToggles[method]).mockClear();
      }
    });

    it("leaves the aviation row out without an OpenAIP key", () => {
      app.config.openaipApiKey = "";
      create();
      tab("layers").click();

      expect(sheetRows()).toEqual(["heatmap", "airports", "altitude", "speed"]);
    });

    it("reflects a layer change made elsewhere", () => {
      create();
      tab("layers").click();
      const row = document.querySelector<HTMLElement>('[data-row="altitude"]')!;
      expect(row.getAttribute("aria-checked")).toBe("false");

      app.store.set("altitudeVisible", true);

      expect(row.getAttribute("aria-checked")).toBe("true");
    });

    it("disables the speed row while the speed button is disabled", () => {
      (document.getElementById("airspeed-btn") as HTMLButtonElement).disabled =
        true;
      create();
      tab("layers").click();

      expect(
        document.querySelector<HTMLButtonElement>('[data-row="speed"]')!
          .disabled,
      ).toBe(true);
    });

    it("offers the aviation layer only with an API key", () => {
      app.config.openaipApiKey = "key";
      create();
      tab("layers").click();

      expect(sheetRows()).toContain("aviation");
    });
  });

  describe("more rows", () => {
    beforeEach(() => {
      create();
      tab("more").click();
    });

    it("explains why replay is unavailable", () => {
      app.replayManager.canReplay.mockReturnValue(false);
      dismissSheet();
      tab("more").click();

      const hint = document.querySelector<HTMLElement>(
        '[data-row="replay"] .sheet-row-hint',
      )!;
      expect(hint.hidden).toBe(false);
      expect(hint.textContent).toBe("Select one flight with timing data");
    });

    it("starts replay from the sheet", () => {
      document.querySelector<HTMLElement>('[data-row="replay"]')!.click();

      expect(app.replayManager.toggleReplay).toHaveBeenCalledTimes(1);
    });

    it("keeps isolate disabled without a selection", () => {
      expect(
        document.querySelector<HTMLButtonElement>('[data-row="isolate"]')!
          .disabled,
      ).toBe(true);
    });

    it("exports and shares", () => {
      document.querySelector<HTMLElement>('[data-row="export"]')!.click();
      tab("more").click();
      document.querySelector<HTMLElement>('[data-row="share"]')!.click();

      expect(app.uiToggles.exportMap).toHaveBeenCalledTimes(1);
      expect(app.uiToggles.shareLink).toHaveBeenCalledTimes(1);
    });
  });

  describe("replay handover", () => {
    it("takes the bar out of the document and closes the sheet", () => {
      const created = create();
      tab("layers").click();

      created.setReplayActive(true);

      // Merely hiding it would still reserve its height for the stylesheet
      expect(document.contains(created.root)).toBe(false);
      expect(created.isVisible()).toBe(false);
      expect(document.querySelector<HTMLElement>(".mobile-sheet")!.hidden).toBe(
        true,
      );
      expect(created.currentTab()).toBeNull();
    });

    it("brings the bar back when replay closes", () => {
      const created = create();

      created.setReplayActive(true);
      created.setReplayActive(false);

      expect(document.contains(created.root)).toBe(true);
      expect(created.isVisible()).toBe(true);
    });

    it("stays out of the document when the bar mounts during replay", () => {
      setWidth(DESKTOP_WIDTH);
      const created = create();
      created.setReplayActive(true);

      setWidth(PHONE_WIDTH);

      expect(created.isMounted()).toBe(true);
      expect(document.contains(created.root)).toBe(false);
    });
  });
});
