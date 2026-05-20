/**
 * UI Toggles - Handles UI toggle functions (heatmap, altitude, airspeed, airports, aviation, buttons visibility, export)
 */
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";
import { showToast } from "../utils/toast";

type ColorLayerMode = "altitude" | "airspeed";

export class UIToggles {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;

    // Pre-cache frequently accessed DOM elements
    domCache.cacheElements([
      "isolate-btn",
      "heatmap-btn",
      "altitude-btn",
      "airspeed-btn",
      "airports-btn",
      "aviation-btn",
      "altitude-legend",
      "airspeed-legend",
      "export-btn",
      "hide-buttons-btn",
      "map",
      "stats-btn",
      "wrapped-btn",
      "replay-btn",
      "year-filter",
      "aircraft-filter",
      "stats-panel",
      "loading",
    ]);
  }

  toggleHeatmap(): void {
    if (!this.app.map) return;

    if (this.app.heatmapVisible) {
      if (this.app.heatmapLayer) {
        this.app.map.removeLayer(this.app.heatmapLayer);
      }
      this.app.heatmapVisible = false;
      const btn = domCache.get("heatmap-btn");
      if (btn) btn.style.opacity = "0.5";
    } else {
      if (this.app.heatmapLayer) {
        this.app.map.addLayer(this.app.heatmapLayer);
        // Ensure heatmap is non-interactive after adding to map
        if (this.app.heatmapLayer._canvas) {
          this.app.heatmapLayer._canvas.style.pointerEvents = "none";
        }
      }
      this.app.heatmapVisible = true;
      const btn = domCache.get("heatmap-btn");
      if (btn) btn.style.opacity = "1.0";
    }
  }

  toggleAltitude(): void {
    this.toggleColorLayer("altitude");
  }

  toggleAirspeed(): void {
    this.toggleColorLayer("airspeed");
  }

  private toggleColorLayer(mode: ColorLayerMode): void {
    if (!this.app.map) return;

    const other: ColorLayerMode = mode === "altitude" ? "airspeed" : "altitude";
    const isVisible =
      mode === "altitude" ? this.app.altitudeVisible : this.app.airspeedVisible;
    const otherVisible =
      mode === "altitude" ? this.app.airspeedVisible : this.app.altitudeVisible;
    const layer =
      mode === "altitude" ? this.app.altitudeLayer : this.app.airspeedLayer;
    const otherLayer =
      mode === "altitude" ? this.app.airspeedLayer : this.app.altitudeLayer;
    const btnId = mode === "altitude" ? "altitude-btn" : "airspeed-btn";
    const otherBtnId = mode === "altitude" ? "airspeed-btn" : "altitude-btn";
    const legendId =
      mode === "altitude" ? "altitude-legend" : "airspeed-legend";
    const otherLegendId =
      mode === "altitude" ? "airspeed-legend" : "altitude-legend";
    const redraw =
      mode === "altitude"
        ? () => this.app.layerManager.redrawAltitudePaths()
        : () => this.app.layerManager.redrawAirspeedPaths();

    const setVisible = (value: boolean) => {
      if (mode === "altitude") this.app.altitudeVisible = value;
      else this.app.airspeedVisible = value;
    };
    const setOtherVisible = (value: boolean) => {
      if (other === "altitude") this.app.altitudeVisible = value;
      else this.app.airspeedVisible = value;
    };

    if (isVisible) {
      if (this.app.replayManager.state.active && !otherVisible) return;
      this.app.map.removeLayer(layer);
      setVisible(false);
      const btn = domCache.get(btnId);
      if (btn) btn.style.opacity = "0.5";
      const legend = domCache.get(legendId);
      if (legend) legend.style.display = "none";
    } else {
      if (otherVisible) {
        if (!this.app.replayManager.state.active) {
          this.app.map.removeLayer(otherLayer);
        }
        setOtherVisible(false);
        const otherBtn = domCache.get(otherBtnId);
        if (otherBtn) otherBtn.style.opacity = "0.5";
        const otherLegend = domCache.get(otherLegendId);
        if (otherLegend) otherLegend.style.display = "none";
      }

      if (!this.app.replayManager.state.active) {
        this.app.map.addLayer(layer);
        redraw();
      } else {
        this.app.replayManager.redrawReplayPath(mode);
      }

      setVisible(true);
      const btn = domCache.get(btnId);
      if (btn) btn.style.opacity = "1.0";
      const legend = domCache.get(legendId);
      if (legend) legend.style.display = "block";
    }

    if (
      this.app.replayManager.state.active &&
      this.app.replayManager.state.airplaneMarker &&
      this.app.replayManager.state.airplaneMarker.isPopupOpen()
    ) {
      this.app.replayManager.updateReplayAirplanePopup();
    }
  }

  toggleAirports(): void {
    if (!this.app.map) return;

    if (this.app.airportsVisible) {
      this.app.map.removeLayer(this.app.airportLayer);
      this.app.airportsVisible = false;
      const btn = domCache.get("airports-btn");
      if (btn) btn.style.opacity = "0.5";
    } else {
      this.app.map.addLayer(this.app.airportLayer);
      this.app.airportsVisible = true;
      const btn = domCache.get("airports-btn");
      if (btn) btn.style.opacity = "1.0";
    }
  }

  toggleAviation(): void {
    if (!this.app.map) return;

    if (
      this.app.config.openaipApiKey &&
      this.app.openaipLayers["Aviation Data"]
    ) {
      if (this.app.aviationVisible) {
        this.app.map.removeLayer(this.app.openaipLayers["Aviation Data"]);
        this.app.aviationVisible = false;
        const btn = domCache.get("aviation-btn");
        if (btn) btn.style.opacity = "0.5";
      } else {
        this.app.map.addLayer(this.app.openaipLayers["Aviation Data"]);
        this.app.aviationVisible = true;
        const btn = domCache.get("aviation-btn");
        if (btn) btn.style.opacity = "1.0";
      }
    }
  }

  toggleButtonsVisibility(): void {
    const toggleableButtons = document.querySelectorAll(".toggleable-btn");
    const hideButton = domCache.get("hide-buttons-btn");

    if (this.app.buttonsHidden) {
      // Show buttons
      toggleableButtons.forEach((btn) => {
        btn.classList.remove("buttons-hidden");
      });
      if (hideButton) hideButton.textContent = "🔼";
      this.app.buttonsHidden = false;
    } else {
      // Hide buttons
      toggleableButtons.forEach((btn) => {
        btn.classList.add("buttons-hidden");
      });
      if (hideButton) hideButton.textContent = "🔽";
      this.app.buttonsHidden = true;
    }

    // Redraw paths to apply hide/dim behavior based on button state
    if (this.app.altitudeVisible) {
      this.app.layerManager.redrawAltitudePaths();
    }
    if (this.app.airspeedVisible) {
      this.app.layerManager.redrawAirspeedPaths();
    }
  }

  exportMap(): void {
    const btn = domCache.get("export-btn") as HTMLButtonElement | null;
    if (!btn) return;

    btn.disabled = true;
    btn.textContent = "⏳ Exporting...";

    const mapContainer = domCache.get("map");
    if (!mapContainer) return;

    const controls = [
      document.querySelector(".leaflet-control-zoom"),
      domCache.get("stats-btn"),
      domCache.get("export-btn"),
      domCache.get("wrapped-btn"),
      domCache.get("replay-btn"),
      domCache.get("year-filter"),
      domCache.get("aircraft-filter"),
      domCache.get("heatmap-btn"),
      domCache.get("altitude-btn"),
      domCache.get("airspeed-btn"),
      domCache.get("airports-btn"),
      domCache.get("aviation-btn"),
      domCache.get("stats-panel"),
      domCache.get("altitude-legend"),
      domCache.get("airspeed-legend"),
      domCache.get("loading"),
    ];

    const displayStates = controls.map((el) =>
      el ? (el as HTMLElement).style.display : null
    );
    controls.forEach((el) => {
      if (el) (el as HTMLElement).style.display = "none";
    });

    setTimeout(() => {
      window.domtoimage
        ?.toJpeg(mapContainer, {
          width: mapContainer.offsetWidth * 2,
          height: mapContainer.offsetHeight * 2,
          bgcolor: "#1a1a1a",
          quality: 0.95,
        })
        .then((dataUrl: string) => {
          controls.forEach((el, i) => {
            if (el) (el as HTMLElement).style.display = displayStates[i] || "";
          });
          btn.disabled = false;
          btn.textContent = "📷 Export";

          const link = document.createElement("a");
          link.download =
            "heatmap_" +
            new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-") +
            ".jpg";
          link.href = dataUrl;
          link.click();
        })
        .catch((error: Error) => {
          controls.forEach((el, i) => {
            if (el) (el as HTMLElement).style.display = displayStates[i] || "";
          });
          showToast("Export failed: " + error.message, "error");
          btn.disabled = false;
          btn.textContent = "📷 Export";
        });
    }, 200);
  }
}
