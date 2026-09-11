/**
 * WrappedManager: opening and closing the dialog, focus, the inert page
 * behind it, the map hand-over and the timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WrappedManager } from "../../../../kml_heatmap/frontend/ui/wrappedManager";
import { showToast } from "../../../../kml_heatmap/frontend/utils/toast";
import { asMapApp, type MockApp } from "../../testHelpers";
import {
  createWrappedMockApp,
  el,
  installAirports,
  mountWrappedDom,
} from "./wrappedTestSetup";

describe("WrappedManager dialog", () => {
  let wrappedManager: WrappedManager;
  let mockApp: MockApp;

  beforeEach(() => {
    vi.useFakeTimers();
    installAirports();
    mountWrappedDom();
    mockApp = createWrappedMockApp();
    wrappedManager = new WrappedManager(asMapApp(mockApp));
  });

  afterEach(() => {
    wrappedManager.destroy();
    vi.useRealTimers();
    document.body.innerHTML = "";
    delete window.KML_AIRPORTS;
  });

  function openWrapped(): void {
    wrappedManager.showWrapped();
    vi.advanceTimersByTime(50);
  }

  describe("opening", () => {
    it("shows the modal and records it in the store", () => {
      wrappedManager.showWrapped();

      expect(el("wrapped-modal").style.display).toBe("flex");
      expect(mockApp.store.get("wrappedVisible")).toBe(true);
    });

    it("does not open twice while already open", () => {
      wrappedManager.showWrapped();
      el("wrapped-stats").innerHTML = "rendered once";

      wrappedManager.showWrapped();

      expect(el("wrapped-stats").innerHTML).toBe("rendered once");
    });

    it("hides the control elements behind the dialog", () => {
      wrappedManager.showWrapped();

      expect(el("stats-btn").style.display).toBe("none");
      expect(el("share-btn").style.display).toBe("none");
      expect(el("left-buttons").style.display).toBe("none");
      expect(el("right-buttons").style.display).toBe("none");
    });

    it("focuses the close button and makes the page behind inert", () => {
      el("wrapped-btn").focus();

      wrappedManager.showWrapped();

      expect(document.activeElement).toBe(
        el("wrapped-modal").querySelector(".close-btn"),
      );
      expect(el("left-buttons").hasAttribute("inert")).toBe(true);
      expect(el("right-buttons").hasAttribute("inert")).toBe(true);
      expect(el("github-footer").hasAttribute("inert")).toBe(true);
      expect(el("app-container").hasAttribute("inert")).toBe(true);
      expect(el("wrapped-modal").hasAttribute("inert")).toBe(false);
    });

    it("makes an element added to the page while it is open inert too", async () => {
      // Crossing the breakpoint with the dialog open mounts the mobile bar
      // onto the body. A one-time snapshot missed it, and its tabs joined the
      // dialog's tab cycle and stayed operable.
      wrappedManager.showWrapped();

      const bar = document.createElement("div");
      bar.className = "mobile-bar";
      bar.innerHTML = '<button id="mobile-tab-stats">Stats</button>';
      document.body.appendChild(bar);
      await Promise.resolve();

      expect(bar.hasAttribute("inert")).toBe(true);
    });

    it("keeps toasts live while the dialog is open", async () => {
      wrappedManager.showWrapped();

      showToast("Link copied", "info");
      await Promise.resolve();

      const toast = document.querySelector(".toast-notification")!;
      expect(toast.hasAttribute("inert")).toBe(false);
      expect(toast.getAttribute("role")).toBe("status");
      toast.remove();
    });

    it("keeps the map interactive because it moves into the dialog", () => {
      document.body.appendChild(el("map"));

      openWrapped();

      expect(el("map").hasAttribute("inert")).toBe(false);
    });

    it("moves the map into the dialog after the layout has settled", () => {
      const mapEl = el("map");
      const originalParent = mapEl.parentElement;

      wrappedManager.showWrapped();
      expect(el("wrapped-map-container").contains(mapEl)).toBe(false);

      vi.advanceTimersByTime(50);

      expect(el("wrapped-map-container").contains(mapEl)).toBe(true);
      expect(mapEl.style.width).toBe("100%");
      expect(mapEl.style.height).toBe("100%");
      expect(mapEl.style.borderRadius).toBe("12px");
      expect(mapEl.style.overflow).toBe("hidden");

      wrappedManager.closeWrapped();

      expect(originalParent?.contains(mapEl)).toBe(true);
    });

    it("remeasures the map and fits the bounds once it is inside", () => {
      wrappedManager.showWrapped();
      expect(mockApp.map!.fitBounds).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(150);

      expect(mockApp.map!.invalidateSize).toHaveBeenCalled();
      expect(mockApp.map!.fitBounds).toHaveBeenCalledTimes(2);
      expect(mockApp.map!.fitBounds).toHaveBeenCalledWith(
        mockApp.config.bounds,
        { padding: [80, 80] },
      );
    });

    it("leaves persistence to the store subscription", () => {
      wrappedManager.showWrapped();
      vi.advanceTimersByTime(150);
      wrappedManager.closeWrapped();
      vi.advanceTimersByTime(150);

      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
      expect(mockApp.stateManager.flush).not.toHaveBeenCalled();
    });

    it("skips the remeasure when the map disappears before the timeout", () => {
      wrappedManager.showWrapped();
      vi.advanceTimersByTime(50);
      mockApp.map = null;

      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    });

    it("returns early if the map container element is missing", () => {
      el("map").remove();

      wrappedManager.showWrapped();

      expect(el("wrapped-modal").style.display).toBe("");
      expect(el("stats-btn").style.display).toBe("");
    });

    it("returns early if the wrapped map container is missing", () => {
      el("wrapped-map-container").remove();

      wrappedManager.showWrapped();

      expect(el("wrapped-modal").style.display).toBe("");
      expect(mockApp.store.get("wrappedVisible")).toBeUndefined();
    });
  });

  describe("closing", () => {
    it("moves the map back and restores its styling", () => {
      const mapEl = el("map");
      const originalParent = mapEl.parentElement!;
      openWrapped();
      expect(mapEl.style.width).toBe("100%");

      wrappedManager.closeWrapped();

      expect(originalParent.contains(mapEl)).toBe(true);
      expect(mapEl.style.width).toBe("");
      expect(mapEl.style.height).toBe("");
      expect(mapEl.style.borderRadius).toBe("");
      expect(mapEl.style.overflow).toBe("");
    });

    it("restores the control elements to what they were", () => {
      mockApp.config.openaipApiKey = "test-api-key";
      el("aviation-btn").style.display = "block";
      openWrapped();
      expect(el("aviation-btn").style.display).toBe("none");

      wrappedManager.closeWrapped();

      expect(el("stats-btn").style.display).toBe("");
      expect(el("left-buttons").style.display).toBe("");
      expect(el("right-buttons").style.display).toBe("");
      expect(el("aviation-btn").style.display).toBe("block");
    });

    it("keeps a control hidden that was hidden before", () => {
      el("aviation-btn").style.display = "none";

      openWrapped();
      wrappedManager.closeWrapped();

      expect(el("aviation-btn").style.display).toBe("none");
    });

    it("hides the modal and records it in the store", () => {
      openWrapped();

      wrappedManager.closeWrapped();

      expect(el("wrapped-modal").style.display).toBe("none");
      expect(mockApp.store.get("wrappedVisible")).toBe(false);
    });

    it("releases inert siblings and restores focus to the opener", () => {
      el("wrapped-btn").focus();
      openWrapped();
      expect(el("left-buttons").hasAttribute("inert")).toBe(true);

      wrappedManager.closeWrapped();

      expect(el("left-buttons").hasAttribute("inert")).toBe(false);
      expect(el("right-buttons").hasAttribute("inert")).toBe(false);
      expect(el("github-footer").hasAttribute("inert")).toBe(false);
      expect(document.activeElement).toBe(el("wrapped-btn"));
    });

    it("releases an element that arrived while it was open", async () => {
      wrappedManager.showWrapped();
      const bar = document.createElement("div");
      bar.className = "mobile-bar";
      document.body.appendChild(bar);
      await Promise.resolve();
      expect(bar.hasAttribute("inert")).toBe(true);

      wrappedManager.closeWrapped();

      expect(bar.hasAttribute("inert")).toBe(false);
    });

    it("stops watching the page once it closes", async () => {
      wrappedManager.showWrapped();
      wrappedManager.closeWrapped();

      const late = document.createElement("div");
      document.body.appendChild(late);
      await Promise.resolve();

      expect(late.hasAttribute("inert")).toBe(false);
    });

    it("does not restore focus to an opener that left the document", () => {
      el("wrapped-btn").focus();
      openWrapped();
      el("wrapped-btn").remove();

      expect(() => wrappedManager.closeWrapped()).not.toThrow();
      expect(document.activeElement).toBe(document.body);
    });

    it("remeasures the map once it is back in the page", () => {
      openWrapped();
      mockApp.map!.invalidateSize.mockClear();

      wrappedManager.closeWrapped();
      vi.advanceTimersByTime(100);

      expect(mockApp.map!.invalidateSize).toHaveBeenCalled();
    });

    it("does nothing when the event target is not the backdrop", () => {
      openWrapped();
      const innerElement = document.createElement("div");
      innerElement.id = "some-inner-element";

      wrappedManager.closeWrapped({
        target: innerElement,
      } as unknown as MouseEvent);

      expect(el("wrapped-modal").style.display).toBe("flex");
      expect(el("wrapped-map-container").contains(el("map"))).toBe(true);
      expect(el("stats-btn").style.display).toBe("none");
    });

    it("closes when the event target is the backdrop", () => {
      openWrapped();

      wrappedManager.closeWrapped({
        target: el("wrapped-modal"),
      } as unknown as MouseEvent);

      expect(el("wrapped-modal").style.display).toBe("none");
    });

    it("leaves the dialog open when the map container is missing", () => {
      openWrapped();
      el("map").remove();

      wrappedManager.closeWrapped();

      expect(el("wrapped-modal").style.display).toBe("flex");
      expect(el("stats-btn").style.display).toBe("none");
      expect(el("left-buttons").hasAttribute("inert")).toBe(true);
    });

    it("appends the map when its original position is gone", () => {
      const mapEl = el("map");
      const originalParent = mapEl.parentElement!;
      openWrapped();
      while (originalParent.firstChild) {
        originalParent.removeChild(originalParent.firstChild);
      }

      wrappedManager.closeWrapped();

      expect(originalParent.contains(mapEl)).toBe(true);
      expect(originalParent.lastElementChild).toBe(mapEl);
    });

    it("does not remeasure a map that is gone by the time the timer fires", () => {
      openWrapped();
      vi.advanceTimersByTime(150);
      const invalidateSize = mockApp.map!.invalidateSize;
      invalidateSize.mockClear();

      wrappedManager.closeWrapped();
      mockApp.map = null;

      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
      expect(invalidateSize).not.toHaveBeenCalled();
    });

    it("drops the pending remeasure when the dialog reopens at once", () => {
      openWrapped();
      vi.advanceTimersByTime(150);
      mockApp.map!.invalidateSize.mockClear();

      wrappedManager.closeWrapped();
      wrappedManager.showWrapped();
      vi.advanceTimersByTime(100);

      // Only the reopening's own timers may run; the close timer would have
      // remeasured a map that is already inside the dialog again
      expect(mockApp.map!.invalidateSize).not.toHaveBeenCalled();
    });
  });

  describe("keyboard", () => {
    it("closes on Escape and ignores other keys", () => {
      openWrapped();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(el("wrapped-modal").style.display).toBe("flex");

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(el("wrapped-modal").style.display).toBe("none");
    });

    it("ignores Escape after the dialog was closed", () => {
      openWrapped();
      wrappedManager.closeWrapped();
      el("stats-btn").style.display = "block";

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      // A second close would have restored the controls again
      expect(el("stats-btn").style.display).toBe("block");
      expect(el("wrapped-modal").style.display).toBe("none");
    });
  });

  describe("destroy", () => {
    it("cancels the pending map hand-over", () => {
      wrappedManager.showWrapped();

      wrappedManager.destroy();
      vi.advanceTimersByTime(500);

      expect(el("wrapped-map-container").contains(el("map"))).toBe(false);
    });

    it("drops the Escape handler", () => {
      openWrapped();

      wrappedManager.destroy();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(el("wrapped-modal").style.display).toBe("flex");
    });
  });

  describe("cards column scroll", () => {
    it("starts a reopened dialog at the title", () => {
      const column = el("wrapped-cards-column");
      Object.defineProperty(column, "scrollHeight", {
        value: 2500,
        configurable: true,
      });
      Object.defineProperty(column, "clientHeight", {
        value: 600,
        configurable: true,
      });

      wrappedManager.showWrapped();
      column.scrollTop = 900;
      wrappedManager.closeWrapped();

      wrappedManager.showWrapped();

      // The column keeps its position across openings, so it has to be put
      // back or Wrapped reopens halfway down a card
      expect(column.scrollTop).toBe(0);
    });

    it("drops the bottom fade once the end is reached", () => {
      const column = el("wrapped-cards-column");
      Object.defineProperty(column, "scrollHeight", {
        value: 2500,
        configurable: true,
      });
      Object.defineProperty(column, "clientHeight", {
        value: 600,
        configurable: true,
      });

      wrappedManager.showWrapped();
      expect(column.classList.contains("is-at-end")).toBe(false);

      column.scrollTop = 1900;
      column.dispatchEvent(new Event("scroll"));

      expect(column.classList.contains("is-at-end")).toBe(true);
    });

    it("stops following the scroll once the dialog is closed", () => {
      const column = el("wrapped-cards-column");
      Object.defineProperty(column, "scrollHeight", {
        value: 2500,
        configurable: true,
      });
      Object.defineProperty(column, "clientHeight", {
        value: 600,
        configurable: true,
      });
      wrappedManager.showWrapped();
      wrappedManager.closeWrapped();

      column.scrollTop = 1900;
      column.dispatchEvent(new Event("scroll"));

      expect(column.classList.contains("is-at-end")).toBe(false);
    });
  });
});
