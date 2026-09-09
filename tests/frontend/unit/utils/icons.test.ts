import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  icon,
  iconSizeOf,
  isIconName,
  setControlIcon,
  DEFAULT_ICON_SIZE,
} from "../../../../kml_heatmap/frontend/utils/icons";
import { logError } from "../../../../kml_heatmap/frontend/utils/logger";

vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

describe("icons", () => {
  describe("icon", () => {
    it("draws at the requested size with the matching stroke weight", () => {
      expect(icon("stats", 24)).toContain('width="24"');
      expect(icon("stats", 24)).toContain('stroke-width="1.7"');
      expect(icon("stats", 20)).toContain('stroke-width="1.8"');
      expect(icon("stats", 16)).toContain('stroke-width="1.9"');
    });

    it("hides the icon from assistive tech when it has no title", () => {
      const svg = icon("heatmap");

      expect(svg).toContain('width="20"');
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).toContain('focusable="false"');
      expect(svg).not.toContain("aria-label");
    });

    it("names the icon when a title is given", () => {
      const svg = icon("close", 16, "Close");

      expect(svg).toContain('role="img"');
      expect(svg).toContain('aria-label="Close"');
      expect(svg).not.toContain("aria-hidden");
    });

    it("escapes a title so it cannot break out of the attribute", () => {
      const svg = icon("close", 16, '<b>A & "B"</b>');

      expect(svg).toContain(
        'aria-label="&lt;b&gt;A &amp; &quot;B&quot;&lt;/b&gt;"',
      );
      expect(svg).not.toContain("<b>");
    });
  });

  describe("isIconName", () => {
    it("accepts a known name and rejects anything else", () => {
      expect(isIconName("stats")).toBe(true);
      expect(isIconName("definitely-not-an-icon")).toBe(false);
      expect(isIconName("")).toBe(false);
      expect(isIconName(undefined)).toBe(false);
      // Inherited object members are not icons
      expect(isIconName("toString")).toBe(false);
    });
  });

  describe("iconSizeOf", () => {
    let el: HTMLElement;

    beforeEach(() => {
      el = document.createElement("button");
    });

    it("reads the size the element was last drawn at", () => {
      el.dataset["iconSize"] = "20";

      expect(iconSizeOf(el)).toBe(20);
    });

    it("falls back to the dense row size when unset or off the scale", () => {
      expect(iconSizeOf(el)).toBe(DEFAULT_ICON_SIZE);

      el.dataset["iconSize"] = "17";
      expect(iconSizeOf(el)).toBe(DEFAULT_ICON_SIZE);
    });
  });

  describe("setControlIcon", () => {
    let button: HTMLElement;

    beforeEach(() => {
      vi.mocked(logError).mockClear();
      button = document.createElement("button");
      document.body.appendChild(button);
    });

    afterEach(() => {
      button.remove();
    });

    it("replaces the icon and leaves the label alone", () => {
      button.innerHTML =
        '<svg class="icon" width="16"></svg><span class="control-label">Replay</span>';

      setControlIcon(button, "stop");

      expect(button.querySelectorAll("svg.icon")).toHaveLength(1);
      expect(button.querySelector(".control-label")!.textContent).toBe(
        "Replay",
      );
      expect(button.firstElementChild!.tagName.toLowerCase()).toBe("svg");
      expect(button.dataset["icon"]).toBe("stop");
    });

    it("keeps the size the control was rendered at", () => {
      button.dataset["iconSize"] = "20";

      setControlIcon(button, "play");

      expect(button.querySelector("svg.icon")!.getAttribute("width")).toBe(
        "20",
      );
    });

    it("records an explicit size so a later swap keeps it", () => {
      setControlIcon(button, "play", 24);
      expect(button.dataset["iconSize"]).toBe("24");

      setControlIcon(button, "pause");

      expect(button.querySelector("svg.icon")!.getAttribute("width")).toBe(
        "24",
      );
    });

    it("defaults to the dense row size for an unmarked control", () => {
      setControlIcon(button, "play");

      expect(button.querySelector("svg.icon")!.getAttribute("width")).toBe(
        String(DEFAULT_ICON_SIZE),
      );
    });

    it("logs and draws nothing for an unknown name", () => {
      setControlIcon(button, "not-an-icon" as never);

      expect(button.querySelector("svg.icon")).toBeNull();
      expect(button.dataset["icon"]).toBeUndefined();
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining("not-an-icon"),
      );
    });
  });
});
