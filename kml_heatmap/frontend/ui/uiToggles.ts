/**
 * UI Toggles - Handles UI toggle functions (heatmap, altitude, airspeed, airports, aviation, export, share)
 */
import type { MapApp } from "../mapApp";
import { setControlLabel } from "../utils/buttonState";
import { domCache, hideControls, restoreControls } from "../utils/domCache";
import { showToast } from "../utils/toast";

type ColorLayerMode = "altitude" | "airspeed";

/** dom-to-image is only needed for export, so it is loaded on first use */
export const DOM_TO_IMAGE_URL =
  "https://cdn.jsdelivr.net/npm/dom-to-image@2.6.0/dist/dom-to-image.min.js";
export const DOM_TO_IMAGE_INTEGRITY =
  "sha384-zESinL+vR3OR5XGFqKjneclbVKOL8SfP+fKKO3K9BHAaPtboci56Vu3g5flevHk9";

const MOBILE_BREAKPOINT_PX = 768;
const EXPORT_BUTTON_LABEL = "Export image";
const EXPORT_BUTTON_BUSY_LABEL = "Exporting…";

let domToImagePromise: Promise<DomToImage | null> | null = null;

/**
 * Load dom-to-image on demand. Resolves with null when the script cannot be
 * loaded (offline, blocked by CSP, integrity mismatch).
 */
export function loadDomToImage(): Promise<DomToImage | null> {
  if (window.domtoimage) return Promise.resolve(window.domtoimage);
  if (domToImagePromise) return domToImagePromise;

  domToImagePromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = DOM_TO_IMAGE_URL;
    script.integrity = DOM_TO_IMAGE_INTEGRITY;
    script.crossOrigin = "anonymous";
    script.onload = () => resolve(window.domtoimage ?? null);
    script.onerror = () => {
      script.remove();
      domToImagePromise = null;
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return domToImagePromise;
}

/** Reset the cached loader (used by tests) */
export function resetDomToImageLoader(): void {
  domToImagePromise = null;
}

/** Small viewport or touch device */
export function isSmallDevice(): boolean {
  if (window.innerWidth < MOBILE_BREAKPOINT_PX) return true;
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

/** Convert a data: URL into a Blob without going through fetch() */
export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIndex = dataUrl.indexOf(",");
  const header = commaIndex >= 0 ? dataUrl.slice(0, commaIndex) : "";
  const payload = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : "";
  const mimeMatch = /^data:([^;,]+)/.exec(header);
  const type = mimeMatch?.[1] ?? "application/octet-stream";

  if (!/;base64$/i.test(header)) {
    return new Blob([decodeURIComponent(payload)], { type });
  }

  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function downloadBlob(blob: Blob, fallbackHref: string, filename: string) {
  const hasObjectUrl = typeof URL.createObjectURL === "function";
  const href = hasObjectUrl ? URL.createObjectURL(blob) : fallbackHref;

  const link = document.createElement("a");
  link.download = filename;
  link.href = href;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();

  if (hasObjectUrl) {
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  }
}

type DeliveryOutcome = "shared" | "downloaded" | "cancelled";

/**
 * Hand the exported image to the user: the native share sheet on mobile
 * devices that support file sharing, a download otherwise.
 */
async function deliverImage(
  dataUrl: string,
  filename: string,
): Promise<DeliveryOutcome> {
  const blob = dataUrlToBlob(dataUrl);

  if (
    isSmallDevice() &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function"
  ) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: document.title });
        return "shared";
      } catch (error) {
        if (isAbortError(error)) return "cancelled";
        // Sharing failed for another reason: fall back to a download
      }
    }
  }

  downloadBlob(blob, dataUrl, filename);
  return "downloaded";
}

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
      "share-btn",
      "map",
      "stats-btn",
      "wrapped-btn",
      "replay-btn",
      "year-filter",
      "aircraft-filter",
      "left-buttons",
      "right-buttons",
      "stats-rail",
      "stats-panel",
      "loading",
    ]);

    // The share button is bound here because the data-action map in
    // mapApp.ts does not know this action yet.
    const shareBtn = domCache.get("share-btn");
    if (shareBtn) {
      shareBtn.addEventListener("click", () => {
        void this.shareLink();
      });
    }
  }

  private toggleSimpleLayer(
    layer: L.Layer | null | undefined,
    visible: boolean,
    setVisible: (v: boolean) => void,
    btnId: string,
    onAdd?: () => void,
  ): void {
    if (!this.app.map) return;

    if (visible) {
      if (layer) this.app.map.removeLayer(layer);
      setVisible(false);
    } else if (layer) {
      this.app.map.addLayer(layer);
      onAdd?.();
      setVisible(true);
    }

    const btn = domCache.get(btnId);
    if (btn) {
      btn.style.opacity = visible ? "0.5" : "1.0";
      btn.setAttribute("aria-pressed", visible ? "false" : "true");
    }
  }

  toggleHeatmap(): void {
    this.toggleSimpleLayer(
      this.app.heatmapLayer,
      this.app.heatmapVisible,
      (v) => {
        this.app.heatmapVisible = v;
      },
      "heatmap-btn",
      () => {
        if (this.app.heatmapLayer?._canvas) {
          this.app.heatmapLayer._canvas.style.pointerEvents = "none";
        }
      },
    );
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
      if (btn) {
        btn.style.opacity = "0.5";
        btn.setAttribute("aria-pressed", "false");
      }
      const legend = domCache.get(legendId);
      if (legend) legend.style.display = "none";
    } else {
      if (otherVisible) {
        if (!this.app.replayManager.state.active) {
          this.app.map.removeLayer(otherLayer);
        }
        setOtherVisible(false);
        const otherBtn = domCache.get(otherBtnId);
        if (otherBtn) {
          otherBtn.style.opacity = "0.5";
          otherBtn.setAttribute("aria-pressed", "false");
        }
        const otherLegend = domCache.get(otherLegendId);
        if (otherLegend) otherLegend.style.display = "none";
      }

      if (!this.app.replayManager.state.active) {
        redraw();
        this.app.map.addLayer(layer);
      } else {
        this.app.replayManager.redrawReplayPath(mode);
      }

      setVisible(true);
      const btn = domCache.get(btnId);
      if (btn) {
        btn.style.opacity = "1.0";
        btn.setAttribute("aria-pressed", "true");
      }
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
    this.toggleSimpleLayer(
      this.app.airportLayer,
      this.app.airportsVisible,
      (v) => {
        this.app.airportsVisible = v;
      },
      "airports-btn",
    );
  }

  toggleAviation(): void {
    if (
      !this.app.config.openaipApiKey ||
      !this.app.openaipLayers["Aviation Data"]
    )
      return;

    this.toggleSimpleLayer(
      this.app.openaipLayers["Aviation Data"],
      this.app.aviationVisible,
      (v) => {
        this.app.aviationVisible = v;
      },
      "aviation-btn",
    );
  }

  exportMap(): void {
    const btn = domCache.get("export-btn") as HTMLButtonElement | null;
    const mapContainer = domCache.get("map");
    if (!btn || !mapContainer) return;
    // An export is already running
    if (btn.disabled) return;

    btn.disabled = true;
    // Only the label changes so the button keeps its icon
    setControlLabel(btn, EXPORT_BUTTON_BUSY_LABEL);
    const savedDisplays = hideControls(["replay-btn", "share-btn"]);

    const restore = () => {
      restoreControls(savedDisplays);
      btn.disabled = false;
      setControlLabel(btn, EXPORT_BUTTON_LABEL);
    };

    void this.runExport(mapContainer)
      .catch((error: unknown) => {
        showToast("Export failed: " + errorMessage(error), "error");
      })
      .finally(restore);
  }

  private async runExport(mapContainer: HTMLElement): Promise<void> {
    const domtoimage = await loadDomToImage();
    if (!domtoimage) {
      showToast("Export unavailable", "error");
      return;
    }

    // Give the browser a moment to repaint without the hidden controls
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const scale = window.innerWidth < MOBILE_BREAKPOINT_PX ? 1 : 2;
    const dataUrl = await domtoimage.toJpeg(mapContainer, {
      width: mapContainer.offsetWidth * scale,
      height: mapContainer.offsetHeight * scale,
      // width/height only resize the canvas; the clone has to be scaled too
      style: {
        transform: "scale(" + scale + ")",
        transformOrigin: "top left",
      },
      bgcolor:
        getComputedStyle(document.documentElement)
          .getPropertyValue("--color-bg-primary")
          .trim() || "#1a1a1a",
      quality: 0.95,
    });

    const filename =
      "heatmap_" +
      new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-") +
      ".jpg";

    const outcome = await deliverImage(dataUrl, filename);
    if (outcome === "shared") {
      showToast("Map shared", "info");
    } else if (outcome === "downloaded") {
      showToast("Map exported", "info");
    }
  }

  /**
   * Share the current view: the native share sheet when available, otherwise
   * the link is copied to the clipboard.
   */
  async shareLink(): Promise<void> {
    // Flush any pending state so the URL reflects the current view
    this.app.stateManager.saveMapState();
    const url = window.location.href;

    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url, title: document.title });
        return;
      } catch (error) {
        if (isAbortError(error)) return;
        // Sharing failed: fall back to the clipboard
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copied", "info");
    } catch (_error) {
      showToast("Could not copy link", "error");
    }
  }
}
