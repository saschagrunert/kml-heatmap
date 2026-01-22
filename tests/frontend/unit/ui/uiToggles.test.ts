import { describe, it, expect, beforeEach, vi } from "vitest";
import { UIToggles } from "../../../../kml_heatmap/frontend/ui/uiToggles";

describe("UIToggles", () => {
  let uiToggles: UIToggles;
  let mockApp: any;

  beforeEach(() => {
    // Set up DOM elements
    document.body.innerHTML = `
      <button id="hide-buttons-btn">🔼</button>
      <button class="toggleable-btn">Button 1</button>
      <button class="toggleable-btn">Button 2</button>
    `;

    // Create mock app with all required properties
    mockApp = {
      buttonsHidden: false,
      altitudeVisible: false,
      airspeedVisible: false,
      layerManager: {
        redrawAltitudePaths: vi.fn(),
        redrawAirspeedPaths: vi.fn(),
      },
      stateManager: {
        saveMapState: vi.fn(),
      },
    };

    uiToggles = new UIToggles(mockApp);
  });

  describe("toggleButtonsVisibility", () => {
    it("hides buttons when currently visible", () => {
      mockApp.buttonsHidden = false;

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.buttonsHidden).toBe(true);
      const hideButton = document.getElementById("hide-buttons-btn");
      expect(hideButton?.textContent).toBe("🔽");

      const toggleableButtons = document.querySelectorAll(".toggleable-btn");
      toggleableButtons.forEach((btn) => {
        expect(btn.classList.contains("buttons-hidden")).toBe(true);
      });
    });

    it("shows buttons when currently hidden", () => {
      mockApp.buttonsHidden = true;

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.buttonsHidden).toBe(false);
      const hideButton = document.getElementById("hide-buttons-btn");
      expect(hideButton?.textContent).toBe("🔼");

      const toggleableButtons = document.querySelectorAll(".toggleable-btn");
      toggleableButtons.forEach((btn) => {
        expect(btn.classList.contains("buttons-hidden")).toBe(false);
      });
    });

    it("redraws altitude paths when altitude visible", () => {
      mockApp.altitudeVisible = true;

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalled();
    });

    it("redraws airspeed paths when airspeed visible", () => {
      mockApp.airspeedVisible = true;

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.layerManager.redrawAirspeedPaths).toHaveBeenCalled();
    });

    it("does not redraw paths when layers not visible", () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(mockApp.layerManager.redrawAirspeedPaths).not.toHaveBeenCalled();
    });

    it("redraws both layers when both visible", () => {
      mockApp.altitudeVisible = true;
      mockApp.airspeedVisible = true;

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalled();
      expect(mockApp.layerManager.redrawAirspeedPaths).toHaveBeenCalled();
    });
  });
});
