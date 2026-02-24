/**
 * UI Toggles - Handles UI toggle functions (heatmap, altitude, airspeed, airports, aviation, buttons visibility, export)
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";

export class UIToggles {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;

    // Pre-cache frequently accessed DOM elements
    domCache.cacheElements([
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
    this.app.stateManager.saveMapState();
  }

  toggleAltitude(): void {
    if (!this.app.map) return;

    if (this.app.altitudeVisible) {
      // Don't allow hiding altitude during replay if airspeed is also hidden
      if (this.app.replayManager.replayActive && !this.app.airspeedVisible) {
        return;
      }
      this.app.map.removeLayer(this.app.altitudeLayer);
      this.app.altitudeVisible = false;
      const btn = domCache.get("altitude-btn");
      if (btn) btn.style.opacity = "0.5";
      const legend = domCache.get("altitude-legend");
      if (legend) legend.style.display = "none";
    } else {
      // Hide airspeed if it's visible
      if (this.app.airspeedVisible) {
        if (!this.app.replayManager.replayActive) {
          this.app.map.removeLayer(this.app.airspeedLayer);
        }
        this.app.airspeedVisible = false;
        const airspeedBtn = domCache.get("airspeed-btn");
        if (airspeedBtn) airspeedBtn.style.opacity = "0.5";
        const airspeedLegend = domCache.get("airspeed-legend");
        if (airspeedLegend) airspeedLegend.style.display = "none";
      }

      // During replay, don't add layer to map - just update state and legend
      if (!this.app.replayManager.replayActive) {
        this.app.map.addLayer(this.app.altitudeLayer);
        this.app.layerManager.redrawAltitudePaths(); // Draw altitude paths when enabled
      } else {
        // During replay: redraw the replay path with new altitude colors
        const savedTime = this.app.replayManager.replayCurrentTime;
        const savedIndex = this.app.replayManager.replayLastDrawnIndex;
        if (this.app.replayManager.replayLayer) {
          this.app.replayManager.replayLayer.clearLayers();
        }
        this.app.replayManager.replayLastDrawnIndex = -1;

        // Redraw all segments up to current position with altitude colors
        for (
          let i = 0;
          i <= savedIndex && i < this.app.replayManager.replaySegments.length;
          i++
        ) {
          const seg = this.app.replayManager.replaySegments[i];
          if (seg && (seg.time || 0) <= savedTime) {
            const segmentColor = window.KMLHeatmap.getColorForAltitude(
              seg.altitude_ft || 0,
              this.app.replayManager.replayColorMinAlt,
              this.app.replayManager.replayColorMaxAlt
            );

            L.polyline(seg.coords || [], {
              color: segmentColor,
              weight: 3,
              opacity: 0.8,
            }).addTo(this.app.replayManager.replayLayer!);

            this.app.replayManager.replayLastDrawnIndex = i;
          }
        }
      }

      this.app.altitudeVisible = true;
      const btn = domCache.get("altitude-btn");
      if (btn) btn.style.opacity = "1.0";
      const legend = domCache.get("altitude-legend");
      if (legend) legend.style.display = "block";
    }

    // Update airplane popup if it's open during replay
    if (
      this.app.replayManager.replayActive &&
      this.app.replayManager.replayAirplaneMarker &&
      this.app.replayManager.replayAirplaneMarker.isPopupOpen()
    ) {
      this.app.replayManager.updateReplayAirplanePopup();
    }

    this.app.stateManager.saveMapState();
  }

  toggleAirspeed(): void {
    if (!this.app.map) return;

    if (this.app.airspeedVisible) {
      // Don't allow hiding airspeed during replay if altitude is also hidden
      if (this.app.replayManager.replayActive && !this.app.altitudeVisible) {
        return;
      }
      this.app.map.removeLayer(this.app.airspeedLayer);
      this.app.airspeedVisible = false;
      const btn = domCache.get("airspeed-btn");
      if (btn) btn.style.opacity = "0.5";
      const legend = domCache.get("airspeed-legend");
      if (legend) legend.style.display = "none";
    } else {
      // Hide altitude if it's visible
      if (this.app.altitudeVisible) {
        if (!this.app.replayManager.replayActive) {
          this.app.map.removeLayer(this.app.altitudeLayer);
        }
        this.app.altitudeVisible = false;
        const altBtn = domCache.get("altitude-btn");
        if (altBtn) altBtn.style.opacity = "0.5";
        const altLegend = domCache.get("altitude-legend");
        if (altLegend) altLegend.style.display = "none";
      }

      // During replay, don't add layer to map - just update state and legend
      if (!this.app.replayManager.replayActive) {
        this.app.map.addLayer(this.app.airspeedLayer);
        this.app.layerManager.redrawAirspeedPaths(); // Draw airspeed paths when enabled
      } else {
        // During replay: redraw the replay path with new airspeed colors
        const savedTime = this.app.replayManager.replayCurrentTime;
        const savedIndex = this.app.replayManager.replayLastDrawnIndex;
        if (this.app.replayManager.replayLayer) {
          this.app.replayManager.replayLayer.clearLayers();
        }
        this.app.replayManager.replayLastDrawnIndex = -1;

        // Redraw all segments up to current position with airspeed colors
        for (
          let i = 0;
          i <= savedIndex && i < this.app.replayManager.replaySegments.length;
          i++
        ) {
          const seg = this.app.replayManager.replaySegments[i];
          if (
            seg &&
            (seg.time || 0) <= savedTime &&
            (seg.groundspeed_knots || 0) > 0
          ) {
            const segmentColor = window.KMLHeatmap.getColorForAltitude(
              seg.groundspeed_knots || 0,
              this.app.replayManager.replayColorMinSpeed,
              this.app.replayManager.replayColorMaxSpeed
            );

            L.polyline(seg.coords || [], {
              color: segmentColor,
              weight: 3,
              opacity: 0.8,
            }).addTo(this.app.replayManager.replayLayer!);

            this.app.replayManager.replayLastDrawnIndex = i;
          }
        }
      }

      this.app.airspeedVisible = true;
      const btn = domCache.get("airspeed-btn");
      if (btn) btn.style.opacity = "1.0";
      const legend = domCache.get("airspeed-legend");
      if (legend) legend.style.display = "block";
    }

    // Update airplane popup if it's open during replay
    if (
      this.app.replayManager.replayActive &&
      this.app.replayManager.replayAirplaneMarker &&
      this.app.replayManager.replayAirplaneMarker.isPopupOpen()
    ) {
      this.app.replayManager.updateReplayAirplanePopup();
    }

    this.app.stateManager.saveMapState();
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
    this.app.stateManager.saveMapState();
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
      this.app.stateManager.saveMapState();
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

    // Save state after toggling button visibility
    this.app.stateManager.saveMapState();
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
          alert("Export failed: " + error.message);
          btn.disabled = false;
          btn.textContent = "📷 Export";
        });
    }, 200);
  }
}
