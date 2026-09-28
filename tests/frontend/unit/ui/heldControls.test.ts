/**
 * The controls a replay, the replay of all flights or the hotspot tour
 * hold while it runs, and give back as each was
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { holdControls } from "../../../../kml_heatmap/frontend/ui/heldControls";

describe("holdControls", () => {
  let root: HTMLElement;
  const control = (id: string): HTMLButtonElement | HTMLSelectElement =>
    document.getElementById(id) as HTMLButtonElement | HTMLSelectElement;

  beforeEach(() => {
    root = document.createElement("div");
    root.innerHTML =
      '<button id="heatmap-btn"></button>' +
      '<button id="airspeed-btn" disabled></button>' +
      '<select id="year-select"></select>' +
      '<div id="stats-rail"></div>';
    document.body.append(root);
  });

  afterEach(() => {
    root.remove();
  });

  it("disables the buttons and selects it is given", () => {
    holdControls(["heatmap-btn", "airspeed-btn", "year-select", "stats-rail"]);

    expect(control("heatmap-btn").disabled).toBe(true);
    expect(control("airspeed-btn").disabled).toBe(true);
    expect(control("year-select").disabled).toBe(true);
    // Not a control that can be disabled, and missing ones are no error
    expect(
      document.getElementById("stats-rail")!.hasAttribute("disabled"),
    ).toBe(false);
    expect(() => holdControls(["no-such-btn"])).not.toThrow();
  });

  it("gives each back as it was, a disabled one disabled (regression)", () => {
    // The speed layer of a site without timing data came back on
    const release = holdControls([
      "heatmap-btn",
      "airspeed-btn",
      "year-select",
    ]);

    release();

    expect(control("heatmap-btn").disabled).toBe(false);
    expect(control("airspeed-btn").disabled).toBe(true);
    expect(control("year-select").disabled).toBe(false);
  });

  it("gives them back once", () => {
    const release = holdControls(["heatmap-btn"]);
    release();
    control("heatmap-btn").disabled = true;

    release();

    expect(control("heatmap-btn").disabled).toBe(true);
  });
});
