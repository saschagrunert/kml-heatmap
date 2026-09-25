import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LIVE_REGION_DELAY_MS,
  TOAST_ALERT_ID,
  TOAST_STACK_ID,
  TOAST_STATUS_ID,
  announceInRegion,
  dismissToast,
  showToast,
} from "../../../../kml_heatmap/frontend/utils/toast";

describe("showToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const id of [TOAST_STACK_ID, TOAST_STATUS_ID, TOAST_ALERT_ID]) {
      document.getElementById(id)?.remove();
    }
  });

  it("creates a toast element in the DOM", () => {
    showToast("Test message");

    const toast = document.querySelector(".toast-notification");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toBe("Test message");
  });

  it("adds toast-visible class via requestAnimationFrame", () => {
    showToast("Test message");

    const toast = document.querySelector(".toast-notification");
    expect(toast!.classList.contains("toast-visible")).toBe(true);
  });

  it("applies info type by default", () => {
    showToast("Info message");

    const toast = document.querySelector(".toast-notification");
    expect(toast!.classList.contains("toast-info")).toBe(true);
  });

  it("applies error type when specified", () => {
    showToast("Error message", "error");

    const toast = document.querySelector(".toast-notification");
    expect(toast!.classList.contains("toast-error")).toBe(true);
  });

  it("stacks consecutive toasts in one container instead of on top of each other", () => {
    showToast("First");
    showToast("Second");

    const stack = document.getElementById(TOAST_STACK_ID)!;
    expect(
      Array.from(stack.children).map((toast) => toast.textContent),
    ).toEqual(["First", "Second"]);
    expect(document.querySelectorAll(`#${TOAST_STACK_ID}`)).toHaveLength(1);
  });

  it("speaks info toasts through the persistent status region", () => {
    showToast("Link copied");

    const region = document.getElementById(TOAST_STATUS_ID)!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    // The visible toast is only the picture of the message, so it is not
    // announced a second time
    expect(
      document
        .querySelector(".toast-notification")!
        .getAttribute("aria-hidden"),
    ).toBe("true");
    expect(
      document.querySelector(".toast-notification")!.getAttribute("role"),
    ).toBeNull();

    // Filled after a tick, so screen readers see a change to a region they
    // already track
    expect(region.textContent).toBe("");
    vi.advanceTimersByTime(LIVE_REGION_DELAY_MS);
    expect(region.textContent).toBe("Link copied");
  });

  it("speaks error toasts through the persistent alert region", () => {
    showToast("Export failed", "error");
    vi.advanceTimersByTime(LIVE_REGION_DELAY_MS);

    const region = document.getElementById(TOAST_ALERT_ID)!;
    expect(region.getAttribute("role")).toBe("alert");
    expect(region.textContent).toBe("Export failed");
    expect(document.getElementById(TOAST_STATUS_ID)).toBeNull();
  });

  it("uses the regions the page already carries", () => {
    const region = document.createElement("div");
    region.id = TOAST_STATUS_ID;
    document.body.appendChild(region);

    showToast("Map exported");
    vi.advanceTimersByTime(LIVE_REGION_DELAY_MS);

    expect(document.querySelectorAll(`#${TOAST_STATUS_ID}`)).toHaveLength(1);
    expect(region.textContent).toBe("Map exported");
  });

  it("removes toast-visible class after 4 seconds", () => {
    showToast("Temporary message");

    const toast = document.querySelector(".toast-notification");
    expect(toast!.classList.contains("toast-visible")).toBe(true);

    vi.advanceTimersByTime(4000);
    expect(toast!.classList.contains("toast-visible")).toBe(false);
  });

  it("removes toast from DOM after transition ends", () => {
    showToast("Will be removed");

    const toast = document.querySelector(".toast-notification")!;
    vi.advanceTimersByTime(4000);

    toast.dispatchEvent(new Event("transitionend"));
    expect(document.querySelector(".toast-notification")).toBeNull();
  });

  describe("an error", () => {
    const toast = (): HTMLElement =>
      document.querySelector<HTMLElement>(".toast-error")!;
    const buttons = (): HTMLButtonElement[] =>
      Array.from(toast().querySelectorAll("button"));

    it("stays until it is dismissed", () => {
      showToast("Export failed", "error");

      vi.advanceTimersByTime(60_000);
      expect(toast().classList.contains("toast-visible")).toBe(true);
      // Its buttons are in reach, so it is not hidden from assistive tech
      expect(toast().getAttribute("aria-hidden")).toBeNull();
      expect(
        document.getElementById(TOAST_STACK_ID)!.getAttribute("aria-hidden"),
      ).toBeNull();

      const [dismiss] = buttons();
      expect(dismiss!.getAttribute("aria-label")).toBe("Dismiss");
      dismiss!.click();
      vi.advanceTimersByTime(1000);
      expect(document.querySelector(".toast-error")).toBeNull();
    });

    it("keeps its message as its text", () => {
      showToast("Export failed", "error");

      expect(toast().textContent).toBe("Export failed");
    });

    it("carries the action that puts it right", () => {
      const run = vi.fn();
      showToast("Failed to load flight data for 2025", "error", {
        label: "Retry",
        run,
      });

      const [retry, dismiss] = buttons();
      expect(retry!.textContent).toBe("Retry");
      expect(dismiss!.getAttribute("aria-label")).toBe("Dismiss");
      retry!.click();

      expect(run).toHaveBeenCalledTimes(1);
      // A new failure says so with a toast of its own
      expect(toast().classList.contains("toast-visible")).toBe(false);
    });

    it("replaces the same error rather than stacking a copy", () => {
      showToast("Export failed", "error");
      showToast("Export failed", "error");
      vi.advanceTimersByTime(1000);

      expect(document.querySelectorAll(".toast-error")).toHaveLength(1);
    });

    it("goes when told, by its message or with every other", () => {
      showToast("Map rendering interrupted", "error");
      showToast("Export failed", "error");

      dismissToast("Map rendering interrupted");
      vi.advanceTimersByTime(1000);
      expect(
        Array.from(document.querySelectorAll(".toast-error")).map(
          (element) => element.textContent,
        ),
      ).toEqual(["Export failed"]);

      dismissToast();
      vi.advanceTimersByTime(1000);
      expect(document.querySelector(".toast-error")).toBeNull();
    });

    it("hands the focus of its button to the map as it goes", () => {
      // To the canvas, which takes the arrow keys, not the container
      const map = document.createElement("div");
      map.id = "map";
      map.tabIndex = -1;
      const canvas = document.createElement("canvas");
      canvas.tabIndex = 0;
      map.append(canvas);
      document.body.append(map);
      showToast("Export failed", "error");
      const [dismiss] = buttons();
      dismiss!.focus();

      dismiss!.click();

      expect(document.activeElement).toBe(canvas);
      map.remove();
    });
  });

  it("removes toast via fallback timeout when transitionend does not fire", () => {
    showToast("Fallback removal");

    const toast = document.querySelector(".toast-notification")!;
    vi.advanceTimersByTime(4000);
    expect(document.contains(toast)).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(document.contains(toast)).toBe(false);
  });
});

describe("announceInRegion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the region now and writes the message after a tick", () => {
    const region = document.createElement("div");
    region.textContent = "Replay playing";

    announceInRegion(region, "Replay playing");

    // The same message again is still a change the reader announces
    expect(region.textContent).toBe("");
    vi.advanceTimersByTime(LIVE_REGION_DELAY_MS);
    expect(region.textContent).toBe("Replay playing");
  });

  it("lets a newer message replace one that was not written yet", () => {
    const region = document.createElement("div");

    announceInRegion(region, "Replay paused at 1:05");
    announceInRegion(region, "Replay closed");
    vi.advanceTimersByTime(LIVE_REGION_DELAY_MS);

    expect(region.textContent).toBe("Replay closed");
  });
});
