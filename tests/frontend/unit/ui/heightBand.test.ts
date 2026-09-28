/**
 * The control of the heat cloud's band of heights: where it is, when it
 * shows, what it reads out, and the band it writes to the store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { followHeightBand } from "../../../../kml_heatmap/frontend/ui/heightBand";
import {
  HEIGHT_BAND_STOPS_FT,
  OPEN_TOP,
} from "../../../../kml_heatmap/frontend/calculations/heightBand";
import { icon } from "../../../../kml_heatmap/frontend/utils/icons";
import { asMapApp, createMockApp, type MockApp } from "../../testHelpers";

/** The stop of `feet` */
const stop = (feet: number): number => HEIGHT_BAND_STOPS_FT.indexOf(feet);

let phone: boolean;
let changes: Set<() => void>;

/** A window whose width says whether the page has the phone layout */
function setupMatchMedia(): void {
  phone = false;
  changes = new Set();
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => ({
      get matches() {
        return phone;
      },
      addEventListener: (_type: string, listener: () => void) => {
        changes.add(listener);
      },
    })),
    configurable: true,
    writable: true,
  });
}

/** Switch to the phone layout, or back */
function setPhone(on: boolean): void {
  phone = on;
  for (const listener of changes) listener();
}

describe("the control of the heat cloud's band of heights", () => {
  let app: MockApp;
  let lifetime: AbortController;
  let root: HTMLElement;

  const thumbs = (): [HTMLInputElement, HTMLInputElement] => [
    root.querySelector<HTMLInputElement>("#height-band-low")!,
    root.querySelector<HTMLInputElement>("#height-band-high")!,
  ];
  const readout = (): string =>
    root.querySelector(".height-band-value")!.textContent ?? "";
  /** Move the thumb `thumb` to the stop `to`, as a drag or a key does */
  const move = (thumb: HTMLInputElement, to: number): void => {
    thumb.value = String(to);
    thumb.dispatchEvent(new Event("input", { bubbles: true }));
  };

  beforeEach(() => {
    setupMatchMedia();
    document.body.innerHTML = `
      <div id="right-buttons" class="control-column">
        <div class="control-group">
          <div class="control-row"><button id="globe-btn"></button></div>
          <div class="control-row"><button id="three-d-btn"></button></div>
          <div class="control-row"><button id="satellite-btn"></button></div>
        </div>
      </div>
      <button id="compass-float-btn" hidden></button>
      <div id="map"></div>`;
    lifetime = new AbortController();
    app = createMockApp({ signal: lifetime.signal, heatmapVisible: true });
    root = followHeightBand(asMapApp(app));
  });

  afterEach(() => {
    lifetime.abort();
    Reflect.deleteProperty(window, "matchMedia");
    document.body.innerHTML = "";
  });

  it("shows while the 3D view draws the heat cloud, and not while the heatmap is off", () => {
    expect(root.hidden).toBe(true);
    app.threeDVisible = true;
    expect(root.hidden).toBe(true);
    app.heatCloud = true;
    expect(root.hidden).toBe(false);
    app.heatmapVisible = false;
    expect(root.hidden).toBe(true);
    app.heatmapVisible = true;
    // Wrapped's intro draws the cloud with the 3D view off
    app.threeDVisible = false;
    expect(root.hidden).toBe(true);
  });

  it("is a group of two sliders named for what they set", () => {
    expect(root.getAttribute("role")).toBe("group");
    const title = document.getElementById(
      root.getAttribute("aria-labelledby")!,
    );
    expect(title?.textContent).toBe("Height AGL");
    // Not the ruler of the cross-section: an arrow up from the ground
    const climb = document.createElement("span");
    climb.innerHTML = icon("climb", 16);
    expect(title?.querySelector("svg")?.outerHTML).toBe(
      climb.firstElementChild!.outerHTML,
    );
    const [low, high] = thumbs();
    for (const thumb of [low, high]) {
      expect(thumb.type).toBe("range");
      expect(thumb.min).toBe("0");
      expect(thumb.max).toBe(String(OPEN_TOP));
      expect(thumb.step).toBe("1");
    }
    expect(low.getAttribute("aria-label")).toBe("Lowest height above ground");
    expect(high.getAttribute("aria-label")).toBe("Highest height above ground");
  });

  it("sits under the 3D switch in the control column, and over the map in the phone layout", () => {
    const threeD = document.getElementById("three-d-btn")!.parentElement!;
    expect(threeD.nextElementSibling).toBe(root);
    expect(root.classList.contains("control-group")).toBe(false);

    setPhone(true);
    expect(root.parentElement).toBe(document.body);
    expect(root.classList.contains("control-group")).toBe(true);
    // Beside the floating compass, and next to it for the keyboard
    expect(root.nextElementSibling?.id).toBe("compass-float-btn");

    setPhone(false);
    expect(threeD.nextElementSibling).toBe(root);
    expect(root.classList.contains("control-group")).toBe(false);
  });

  it("shows every height at first", () => {
    const [low, high] = thumbs();
    expect(low.value).toBe("0");
    expect(high.value).toBe(String(OPEN_TOP));
    expect(low.getAttribute("aria-valuetext")).toBe("0 ft");
    expect(high.getAttribute("aria-valuetext")).toBe("No limit");
    expect(readout()).toBe("All heights");
    expect(app.heightBand).toBe("");
  });

  it("shows the band of the store on the thumbs, their heights and the track", () => {
    app.heightBand = "500-3000";
    const [low, high] = thumbs();
    expect(low.value).toBe(String(stop(500)));
    expect(high.value).toBe(String(stop(3000)));
    expect(low.getAttribute("aria-valuetext")).toBe("500 ft");
    expect(high.getAttribute("aria-valuetext")).toBe("3,000 ft");
    expect(readout()).toBe("500 to 3,000 ft");
    expect(Number(root.style.getPropertyValue("--band-low"))).toBeCloseTo(
      stop(500) / OPEN_TOP,
    );
    expect(Number(root.style.getPropertyValue("--band-high"))).toBeCloseTo(
      stop(3000) / OPEN_TOP,
    );
  });

  it("sets the band as a thumb moves", () => {
    const [low, high] = thumbs();
    move(high, stop(1500));
    expect(app.heightBand).toBe("0-1500");
    expect(readout()).toBe("Up to 1,500 ft");
    move(low, stop(500));
    expect(app.heightBand).toBe("500-1500");
    move(high, OPEN_TOP);
    expect(app.heightBand).toBe("500-");
    expect(readout()).toBe("Above 500 ft");
    // Every height again: nothing for a link to carry
    move(low, 0);
    expect(app.heightBand).toBe("");
  });

  it("keeps a thumb a stop from the other", () => {
    app.heightBand = "500-3000";
    const [low, high] = thumbs();
    move(low, OPEN_TOP);
    expect(app.heightBand).toBe("2500-3000");
    expect(low.value).toBe(String(stop(2500)));
    move(high, 0);
    expect(app.heightBand).toBe("2500-3000");
    expect(high.value).toBe(String(stop(3000)));
  });

  it("lays the bottom thumb over the top one once it is in the right half", () => {
    const [low] = thumbs();
    app.heightBand = "500-";
    expect(low.classList.contains("is-above")).toBe(false);
    app.heightBand = "5000-";
    expect(low.classList.contains("is-above")).toBe(true);
  });

  it("puts a band it has no stops for back to every height", () => {
    app.heightBand = "450-3000";
    expect(app.heightBand).toBe("");
    expect(readout()).toBe("All heights");
    app.heightBand = "0-";
    expect(app.heightBand).toBe("");
  });

  it("goes with the app", () => {
    lifetime.abort();
    expect(root.isConnected).toBe(false);
    app.heightBand = "500-3000";
    expect(readout()).toBe("All heights");
  });
});
