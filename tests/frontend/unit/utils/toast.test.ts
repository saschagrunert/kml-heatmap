import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { showToast } from "../../../../kml_heatmap/frontend/utils/toast";

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
    document
      .querySelectorAll(".toast-notification")
      .forEach((el) => el.remove());
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

  it("sets role=alert for accessibility", () => {
    showToast("Accessible message");

    const toast = document.querySelector(".toast-notification");
    expect(toast!.getAttribute("role")).toBe("alert");
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
});
