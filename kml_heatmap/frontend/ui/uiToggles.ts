/**
 * UI Toggles - Handles UI toggle functions (heatmap, altitude, airspeed, airports, aviation, buttons visibility, export)
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";

export class UIToggles {
  private app: MapApp;
  private buttonsHidden: boolean;

  constructor(app: MapApp) {
    this.app = app;
    this.buttonsHidden = false;
  }

  toggleHeatmap(): void {
    if (!this.app.map) return;

    if (this.app.heatmapVisible) {
      if (this.app.heatmapLayer) {
        this.app.map.removeLayer(this.app.heatmapLayer);
      }
      this.app.heatmapVisible = false;
      const btn = document.getElementById("heatmap-btn");
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
      const btn = document.getElementById("heatmap-btn");
      if (btn) btn.style.opacity = "1.0";
    }
    this.app.stateManager!.saveMapState();
  }

  toggleAltitude(): void {
    if (!this.app.map) return;

    if (this.app.altitudeVisible) {
      // Don't allow hiding altitude during replay if airspeed is also hidden
      if (this.app.replayManager!.replayActive && !this.app.airspeedVisible) {
        return;
      }
      this.app.map.removeLayer(this.app.altitudeLayer);
      this.app.altitudeVisible = false;
      const btn = document.getElementById("altitude-btn");
      if (btn) btn.style.opacity = "0.5";
      const legend = document.getElementById("altitude-legend");
      if (legend) legend.style.display = "none";
    } else {
      // Hide airspeed if it's visible
      if (this.app.airspeedVisible) {
        if (!this.app.replayManager!.replayActive) {
          this.app.map.removeLayer(this.app.airspeedLayer);
        }
        this.app.airspeedVisible = false;
        const airspeedBtn = document.getElementById("airspeed-btn");
        if (airspeedBtn) airspeedBtn.style.opacity = "0.5";
        const airspeedLegend = document.getElementById("airspeed-legend");
        if (airspeedLegend) airspeedLegend.style.display = "none";
      }

      // During replay, don't add layer to map - just update state and legend
      if (!this.app.replayManager!.replayActive) {
        this.app.map.addLayer(this.app.altitudeLayer);
        this.app.layerManager!.redrawAltitudePaths(); // Draw altitude paths when enabled
      } else {
        // During replay: redraw the replay path with new altitude colors
        const savedTime = this.app.replayManager!.replayCurrentTime;
        const savedIndex = this.app.replayManager!.replayLastDrawnIndex;
        if (this.app.replayManager!.replayLayer) {
          this.app.replayManager!.replayLayer.clearLayers();
        }
        this.app.replayManager!.replayLastDrawnIndex = -1;

        // Redraw all segments up to current position with altitude colors
        for (
          let i = 0;
          i <= savedIndex && i < this.app.replayManager!.replaySegments.length;
          i++
        ) {
          const seg = this.app.replayManager!.replaySegments[i];
          if (seg && (seg.time || 0) <= savedTime) {
            const segmentColor = (window as any).KMLHeatmap.getColorForAltitude(
              seg.altitude_ft,
              this.app.replayManager!.replayColorMinAlt,
              this.app.replayManager!.replayColorMaxAlt
            );

            L.polyline(seg.coords || [], {
              color: segmentColor,
              weight: 3,
              opacity: 0.8,
            }).addTo(this.app.replayManager!.replayLayer!);

            this.app.replayManager!.replayLastDrawnIndex = i;
          }
        }
      }

      this.app.altitudeVisible = true;
      const btn = document.getElementById("altitude-btn");
      if (btn) btn.style.opacity = "1.0";
      const legend = document.getElementById("altitude-legend");
      if (legend) legend.style.display = "block";
    }

    // Update airplane popup if it's open during replay
    if (
      this.app.replayManager!.replayActive &&
      this.app.replayManager!.replayAirplaneMarker &&
      this.app.replayManager!.replayAirplaneMarker.isPopupOpen()
    ) {
      this.app.replayManager!.updateReplayAirplanePopup();
    }

    this.app.stateManager!.saveMapState();
  }

  toggleAirspeed(): void {
    if (!this.app.map) return;

    if (this.app.airspeedVisible) {
      // Don't allow hiding airspeed during replay if altitude is also hidden
      if (this.app.replayManager!.replayActive && !this.app.altitudeVisible) {
        return;
      }
      this.app.map.removeLayer(this.app.airspeedLayer);
      this.app.airspeedVisible = false;
      const btn = document.getElementById("airspeed-btn");
      if (btn) btn.style.opacity = "0.5";
      const legend = document.getElementById("airspeed-legend");
      if (legend) legend.style.display = "none";
    } else {
      // Hide altitude if it's visible
      if (this.app.altitudeVisible) {
        if (!this.app.replayManager!.replayActive) {
          this.app.map.removeLayer(this.app.altitudeLayer);
        }
        this.app.altitudeVisible = false;
        const altBtn = document.getElementById("altitude-btn");
        if (altBtn) altBtn.style.opacity = "0.5";
        const altLegend = document.getElementById("altitude-legend");
        if (altLegend) altLegend.style.display = "none";
      }

      // During replay, don't add layer to map - just update state and legend
      if (!this.app.replayManager!.replayActive) {
        this.app.map.addLayer(this.app.airspeedLayer);
        this.app.layerManager!.redrawAirspeedPaths(); // Draw airspeed paths when enabled
      } else {
        // During replay: redraw the replay path with new airspeed colors
        const savedTime = this.app.replayManager!.replayCurrentTime;
        const savedIndex = this.app.replayManager!.replayLastDrawnIndex;
        if (this.app.replayManager!.replayLayer) {
          this.app.replayManager!.replayLayer.clearLayers();
        }
        this.app.replayManager!.replayLastDrawnIndex = -1;

        // Redraw all segments up to current position with airspeed colors
        for (
          let i = 0;
          i <= savedIndex && i < this.app.replayManager!.replaySegments.length;
          i++
        ) {
          const seg = this.app.replayManager!.replaySegments[i];
          if (
            seg &&
            (seg.time || 0) <= savedTime &&
            (seg.groundspeed_knots || 0) > 0
          ) {
            const segmentColor = (window as any).KMLHeatmap.getColorForAltitude(
              seg.groundspeed_knots,
              this.app.replayManager!.replayColorMinSpeed,
              this.app.replayManager!.replayColorMaxSpeed
            );

            L.polyline(seg.coords || [], {
              color: segmentColor,
              weight: 3,
              opacity: 0.8,
            }).addTo(this.app.replayManager!.replayLayer!);

            this.app.replayManager!.replayLastDrawnIndex = i;
          }
        }
      }

      this.app.airspeedVisible = true;
      const btn = document.getElementById("airspeed-btn");
      if (btn) btn.style.opacity = "1.0";
      const legend = document.getElementById("airspeed-legend");
      if (legend) legend.style.display = "block";
    }

    // Update airplane popup if it's open during replay
    if (
      this.app.replayManager!.replayActive &&
      this.app.replayManager!.replayAirplaneMarker &&
      this.app.replayManager!.replayAirplaneMarker.isPopupOpen()
    ) {
      this.app.replayManager!.updateReplayAirplanePopup();
    }

    this.app.stateManager!.saveMapState();
  }

  toggleAirports(): void {
    if (!this.app.map) return;

    if (this.app.airportsVisible) {
      this.app.map.removeLayer(this.app.airportLayer);
      this.app.airportsVisible = false;
      const btn = document.getElementById("airports-btn");
      if (btn) btn.style.opacity = "0.5";
    } else {
      this.app.map.addLayer(this.app.airportLayer);
      this.app.airportsVisible = true;
      const btn = document.getElementById("airports-btn");
      if (btn) btn.style.opacity = "1.0";
    }
    this.app.stateManager!.saveMapState();
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
        const btn = document.getElementById("aviation-btn");
        if (btn) btn.style.opacity = "0.5";
      } else {
        this.app.map.addLayer(this.app.openaipLayers["Aviation Data"]);
        this.app.aviationVisible = true;
        const btn = document.getElementById("aviation-btn");
        if (btn) btn.style.opacity = "1.0";
      }
      this.app.stateManager!.saveMapState();
    }
  }

  toggleButtonsVisibility(): void {
    const toggleableButtons = document.querySelectorAll(".toggleable-btn");
    const hideButton = document.getElementById("hide-buttons-btn");

    if (this.buttonsHidden) {
      // Show buttons
      toggleableButtons.forEach((btn) => {
        btn.classList.remove("buttons-hidden");
      });
      if (hideButton) hideButton.textContent = "🔼";
      this.buttonsHidden = false;
    } else {
      // Hide buttons
      toggleableButtons.forEach((btn) => {
        btn.classList.add("buttons-hidden");
      });
      if (hideButton) hideButton.textContent = "🔽";
      this.buttonsHidden = true;
    }
  }

  exportMap(): void {
    const btn = document.getElementById(
      "export-btn"
    ) as HTMLButtonElement | null;
    if (!btn) return;

    btn.disabled = true;
    btn.textContent = "⏳ Exporting...";

    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;

    const controls = [
      document.querySelector(".leaflet-control-zoom"),
      document.getElementById("stats-btn"),
      document.getElementById("export-btn"),
      document.getElementById("wrapped-btn"),
      document.getElementById("replay-btn"),
      document.getElementById("year-filter"),
      document.getElementById("aircraft-filter"),
      document.getElementById("heatmap-btn"),
      document.getElementById("altitude-btn"),
      document.getElementById("airspeed-btn"),
      document.getElementById("airports-btn"),
      document.getElementById("aviation-btn"),
      document.getElementById("stats-panel"),
      document.getElementById("altitude-legend"),
      document.getElementById("airspeed-legend"),
      document.getElementById("loading"),
    ];

    const displayStates = controls.map((el) =>
      el ? (el as HTMLElement).style.display : null
    );
    controls.forEach((el) => {
      if (el) (el as HTMLElement).style.display = "none";
    });

    setTimeout(() => {
      (window as any).domtoimage
        .toJpeg(mapContainer, {
          width: mapContainer.offsetWidth * 2,
          height: mapContainer.offsetHeight * 2,
          bgcolor: "#1a1a1a",
          quality: 0.95,
          style: {
            transform: "scale(2)",
            transformOrigin: "top left",
          },
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
