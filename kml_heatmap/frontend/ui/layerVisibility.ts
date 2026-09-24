/**
 * Layer visibility - What each layer shows follows from the store alone
 */
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
import {
  applyLegendVisibility,
  applyToggleButtonState,
} from "../utils/buttonState";
import { domCache } from "../utils/domCache";

/** The keys the layers follow */
const LAYER_KEYS: readonly (keyof StoreState)[] = [
  "heatmapVisible",
  "altitudeVisible",
  "airspeedVisible",
  "airportsVisible",
  "aviationVisible",
  "replayActive",
];

/**
 * Show every layer the store asks for. The layer flags keep what the user
 * chose, and a running replay hides the heatmap and the colour layers on
 * top of them, so closing it brings back exactly that choice. Nothing else
 * sets the visibility of these layers, the heatmap's toggle or the altitude
 * scale: a toggle, a restored link and the start and end of a replay only
 * write store keys.
 */
export function followLayerVisibility(app: MapApp): void {
  const apply = (): void => {
    const replay = app.replayActive;
    const heatmap = app.heatmapVisible && !replay;
    if (heatmap !== app.heatmapLayer.isVisible()) {
      if (heatmap) app.dataManager.showHeatmap();
      else app.heatmapLayer.setVisible(false);
    }
    // Which of heatmap and colour layer reads first follows the flags too
    app.dataManager.applyHeatmapEmphasis();
    app.layerManager.syncModes();
    app.airportLayer.setVisible(app.airportsVisible);
    app.aviationLayer.setVisible(app.aviationVisible);

    // The heatmap is hidden for a replay, so its toggle must not report it
    // as on. The replay trail is coloured by altitude unless the speed
    // layer is on, so it needs the altitude scale with neither layer on.
    const button = domCache.get("heatmap-btn");
    if (button) applyToggleButtonState(button, heatmap);
    const legend = domCache.get("altitude-legend");
    if (legend) {
      applyLegendVisibility(
        legend,
        app.altitudeVisible || (replay && !app.airspeedVisible),
      );
    }
  };
  app.store.subscribeKeys(LAYER_KEYS, apply);
  apply();
}

/**
 * Switch a colour layer on or off. Altitude and speed colour the same
 * paths, so one on switches the other off, in the same update: nobody sees
 * both on for a moment. Returns whether it did.
 */
export function setColorLayer(
  app: MapApp,
  mode: "altitude" | "airspeed",
  visible: boolean,
): boolean {
  const other = mode === "altitude" ? "airspeedVisible" : "altitudeVisible";
  const replaced = visible && app[other];
  app.store.batch(() => {
    app[`${mode}Visible`] = visible;
    if (visible) app[other] = false;
  });
  return replaced;
}
