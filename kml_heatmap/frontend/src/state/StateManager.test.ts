import { describe, it, expect, beforeEach, vi } from "vitest";
import { StateManager } from "./StateManager";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
});

// Mock Leaflet Map
const mockMap = {
  getCenter: () => ({ lat: 52.52, lng: 13.405 }),
  getZoom: () => 10,
} as any;

describe("StateManager", () => {
  let stateManager: StateManager;

  beforeEach(() => {
    localStorageMock.clear();
    stateManager = new StateManager();
  });

  describe("layer visibility", () => {
    it("should have correct default visibility", () => {
      const visibility = stateManager.getLayerVisibility();
      expect(visibility.heatmap).toBe(true);
      expect(visibility.altitude).toBe(false);
      expect(visibility.airspeed).toBe(false);
      expect(visibility.airports).toBe(true);
      expect(visibility.aviation).toBe(false);
    });

    it("should update layer visibility", () => {
      stateManager.setLayerVisibility("altitude", true);
      const visibility = stateManager.getLayerVisibility();
      expect(visibility.altitude).toBe(true);
    });

    it("should toggle layer visibility", () => {
      stateManager.setLayerVisibility("heatmap", false);
      const visibility = stateManager.getLayerVisibility();
      expect(visibility.heatmap).toBe(false);
    });
  });

  describe("filter state", () => {
    it("should have correct default filters", () => {
      expect(stateManager.getSelectedYear()).toBe("all");
      expect(stateManager.getSelectedAircraft()).toBe("all");
    });

    it("should update selected year", () => {
      stateManager.setSelectedYear("2024");
      expect(stateManager.getSelectedYear()).toBe("2024");
    });

    it("should update selected aircraft", () => {
      stateManager.setSelectedAircraft("N12345");
      expect(stateManager.getSelectedAircraft()).toBe("N12345");
    });
  });

  describe("path selection", () => {
    it("should start with empty selection", () => {
      const selected = stateManager.getSelectedPathIds();
      expect(selected.size).toBe(0);
    });

    it("should add path to selection", () => {
      const isSelected = stateManager.togglePathSelection("path1");
      expect(isSelected).toBe(true);
      expect(stateManager.getSelectedPathIds().has("path1")).toBe(true);
    });

    it("should remove path from selection on second toggle", () => {
      stateManager.togglePathSelection("path1");
      const isSelected = stateManager.togglePathSelection("path1");
      expect(isSelected).toBe(false);
      expect(stateManager.getSelectedPathIds().has("path1")).toBe(false);
    });

    it("should clear all selections", () => {
      stateManager.togglePathSelection("path1");
      stateManager.togglePathSelection("path2");
      stateManager.clearPathSelection();
      expect(stateManager.getSelectedPathIds().size).toBe(0);
    });

    it("should add multiple paths to selection", () => {
      stateManager.addPathsToSelection(["path1", "path2", "path3"]);
      const selected = stateManager.getSelectedPathIds();
      expect(selected.size).toBe(3);
      expect(selected.has("path1")).toBe(true);
      expect(selected.has("path2")).toBe(true);
      expect(selected.has("path3")).toBe(true);
    });
  });

  describe("state persistence", () => {
    it("should save state to localStorage", () => {
      stateManager.setLayerVisibility("altitude", true);
      stateManager.setSelectedYear("2024");
      stateManager.saveState(mockMap);

      const saved = localStorage.getItem("kml-heatmap-state");
      expect(saved).not.toBeNull();

      const parsed = JSON.parse(saved!);
      expect(parsed.altitudeVisible).toBe(true);
      expect(parsed.selectedYear).toBe("2024");
      expect(parsed.zoom).toBe(10);
    });

    it("should load state from localStorage", () => {
      const testState = {
        center: { lat: 50, lng: 10 },
        zoom: 12,
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        selectedYear: "2023",
        selectedAircraft: "N12345",
        selectedPathIds: ["path1"],
        statsPanelVisible: false,
        replayActive: false,
        replayPlaying: false,
        replayCurrentTime: 0,
        replaySpeed: 50,
        replayAutoZoom: false,
      };

      localStorage.setItem("kml-heatmap-state", JSON.stringify(testState));

      const loaded = stateManager.loadState();
      expect(loaded).not.toBeNull();
      expect(loaded?.selectedYear).toBe("2023");
      expect(loaded?.altitudeVisible).toBe(true);
    });

    it("should restore state from loaded data", () => {
      const testState = {
        center: { lat: 50, lng: 10 },
        zoom: 12,
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        selectedYear: "2023",
        selectedAircraft: "N12345",
        selectedPathIds: ["path1", "path2"],
        statsPanelVisible: false,
        replayActive: false,
        replayPlaying: false,
        replayCurrentTime: 0,
        replaySpeed: 50,
        replayAutoZoom: false,
      };

      stateManager.restoreState(testState);

      expect(stateManager.getSelectedYear()).toBe("2023");
      expect(stateManager.getSelectedAircraft()).toBe("N12345");
      expect(stateManager.getLayerVisibility().altitude).toBe(true);
      expect(stateManager.getSelectedPathIds().size).toBe(2);
    });
  });
});
