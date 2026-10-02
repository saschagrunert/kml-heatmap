/**
 * The questions the app asks about the device: the phone layout, a finger
 * for a pointer, and a pointer that cannot hover.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  PHONE_LAYOUT_QUERY,
  isPhoneLayout,
  isSmallDevice,
  isTouchDevice,
  matchesMedia,
} from "../../../../kml_heatmap/frontend/utils/device";
import { MOBILE_BREAKPOINT_PX } from "../../../../kml_heatmap/frontend/utils/constants";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Answer the media queries of `matching` as matched, every other not */
function stubMedia(...matching: string[]): ReturnType<typeof vi.fn> {
  const matchMedia = vi.fn((query: string) => ({
    matches: matching.includes(query),
  }));
  Object.defineProperty(window, "matchMedia", {
    value: matchMedia,
    configurable: true,
    writable: true,
  });
  return matchMedia;
}

function setInnerWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

describe("device", () => {
  const innerWidth = window.innerWidth;

  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
    Reflect.deleteProperty(window, "ontouchstart");
    setInnerWidth(innerWidth);
  });

  describe("the phone layout", () => {
    it("is the stylesheet's breakpoint, just under it", () => {
      expect(PHONE_LAYOUT_QUERY).toBe(
        "(max-width: 767.98px), (max-height: 480px)",
      );
    });

    it("is the one the stylesheets give the phone, and leave the columns", () => {
      // A phone held sideways (844 by 390) is wide enough for the columns
      // but too short for them: every width rule says so too
      for (const name of ["styles", "features", "wrapped"]) {
        const css = readFileSync(
          resolve(__dirname, `../../../../kml_heatmap/static/${name}.css`),
          "utf8",
        );
        for (const [, query] of css.matchAll(/@media ([^{]*width[^{]*)\{/g)) {
          const min = /\(min-width: (\d+)px\)/.exec(query!);
          const max = /^\(max-width: (\d+)\.98px\)/.exec(query!.trim());
          if (min && Number(min[1]) >= MOBILE_BREAKPOINT_PX) {
            expect(query, name).toContain("and (min-height: 480.02px)");
          } else if (max && Number(max[1]) >= MOBILE_BREAKPOINT_PX - 1) {
            expect(query, name).toContain(", (max-height: 480px)");
          }
        }
      }
    });

    it("is a short window's too, without media queries", () => {
      Reflect.deleteProperty(window, "matchMedia");
      setInnerWidth(844);
      const height = window.innerHeight;
      Object.defineProperty(window, "innerHeight", {
        value: 390,
        configurable: true,
      });

      expect(isPhoneLayout()).toBe(true);
      Object.defineProperty(window, "innerHeight", {
        value: height,
        configurable: true,
      });
      expect(isPhoneLayout()).toBe(false);
    });

    it("follows the media query where there is one", () => {
      setInnerWidth(1280);
      const matchMedia = stubMedia(PHONE_LAYOUT_QUERY);

      expect(isPhoneLayout()).toBe(true);
      expect(matchMedia).toHaveBeenCalledWith(PHONE_LAYOUT_QUERY);

      stubMedia();
      setInnerWidth(390);
      expect(isPhoneLayout()).toBe(false);
    });

    it("goes by the width of the window without media queries", () => {
      setInnerWidth(MOBILE_BREAKPOINT_PX - 1);
      expect(isPhoneLayout()).toBe(true);
      setInnerWidth(MOBILE_BREAKPOINT_PX);
      expect(isPhoneLayout()).toBe(false);
    });
  });

  describe("isSmallDevice", () => {
    it("is true in the phone layout", () => {
      stubMedia(PHONE_LAYOUT_QUERY);
      expect(isSmallDevice()).toBe(true);
    });

    it("is true for coarse pointers on wide viewports", () => {
      stubMedia("(pointer: coarse)");
      expect(isSmallDevice()).toBe(true);
    });

    it("is false for wide viewports with a fine pointer", () => {
      stubMedia();
      expect(isSmallDevice()).toBe(false);
    });
  });

  describe("isTouchDevice", () => {
    it("returns false when no touch support", () => {
      expect(isTouchDevice()).toBe(false);
    });

    it("asks the hover media query when the browser has one", () => {
      // A laptop with a touchscreen is driven by its mouse most of the
      // time; touch support alone lost it the hover tooltips
      (window as { ontouchstart?: unknown }).ontouchstart = null;
      stubMedia();
      expect(isTouchDevice()).toBe(false);
      stubMedia("(hover: none)");
      expect(isTouchDevice()).toBe(true);
    });

    it("returns true when ontouchstart exists", () => {
      (window as { ontouchstart?: unknown }).ontouchstart = null;
      expect(isTouchDevice()).toBe(true);
    });

    it("returns true when maxTouchPoints > 0", () => {
      const original = navigator.maxTouchPoints;
      Object.defineProperty(navigator, "maxTouchPoints", {
        value: 1,
        configurable: true,
      });
      try {
        expect(isTouchDevice()).toBe(true);
      } finally {
        Object.defineProperty(navigator, "maxTouchPoints", {
          value: original,
          configurable: true,
        });
      }
    });
  });

  describe("matchesMedia", () => {
    it("is false without media queries", () => {
      expect(matchesMedia("(prefers-contrast: more)")).toBe(false);
    });

    it("asks the browser where it can", () => {
      stubMedia("(prefers-contrast: more)");
      expect(matchesMedia("(prefers-contrast: more)")).toBe(true);
      expect(matchesMedia("(hover: none)")).toBe(false);
    });
  });
});
