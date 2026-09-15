/**
 * UI Toggles - Handles UI toggle functions (heatmap, altitude, airspeed, airports, aviation, export, share)
 */
import type * as L from "leaflet";
import type { MapApp } from "../mapApp";
import { setControlLabel } from "../utils/buttonState";
import { domCache } from "../utils/domCache";
import { showToast } from "../utils/toast";

type ColorLayerMode = "altitude" | "airspeed";

/** dom-to-image is only needed for export, so it is loaded on first use */
export const DOM_TO_IMAGE_URL =
  "https://cdn.jsdelivr.net/npm/dom-to-image@2.6.0/dist/dom-to-image.min.js";
export const DOM_TO_IMAGE_INTEGRITY =
  "sha384-zESinL+vR3OR5XGFqKjneclbVKOL8SfP+fKKO3K9BHAaPtboci56Vu3g5flevHk9";

const MOBILE_BREAKPOINT_PX = 768;
/** Largest canvas iOS Safari will draw into (16.7 million pixels) */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** Phones get their pixel density up to this factor */
const MAX_PHONE_EXPORT_SCALE = 3;
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

/**
 * Scale of the exported image relative to the map's CSS size. Desktops get
 * 2x. A phone gets its own pixel density, since 1x left a 390x844 image on
 * a 3x screen. Either way the canvas stays within what iOS will allocate,
 * past which the export comes out blank.
 */
export function exportScale(width: number, height: number): number {
  const preferred =
    window.innerWidth < MOBILE_BREAKPOINT_PX
      ? Math.min(
          Math.max(window.devicePixelRatio || 1, 1),
          MAX_PHONE_EXPORT_SCALE,
        )
      : 2;
  const area = width * height;
  if (area <= 0) return preferred;
  return Math.min(preferred, Math.sqrt(MAX_CANVAS_PIXELS / area));
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
  }

  /**
   * Add or remove a layer and record the result in the store. The buttons
   * and legends follow the store, so nothing here touches them.
   */
  private toggleSimpleLayer(
    layer: L.Layer | null | undefined,
    visible: boolean,
    setVisible: (v: boolean) => void,
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
  }

  toggleHeatmap(): void {
    this.toggleSimpleLayer(
      this.app.heatmapLayer,
      this.app.heatmapVisible,
      (v) => {
        this.app.heatmapVisible = v;
      },
      // Feeds the layer the points of the filter changes it missed while off
      () => this.app.dataManager.showHeatmap(),
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

    // The buttons and the legends follow the store keys written below
    if (isVisible) {
      if (this.app.replayManager.state.active) {
        // The layer is off the map for the replay already. The trail keeps
        // its altitude colours without a colour layer, so only a speed
        // trail changes (see ReplayManager.updateTrailLegend for the scale)
        if (mode === "airspeed") {
          this.app.replayManager.redrawReplayPath("altitude");
        }
      } else {
        this.app.map.removeLayer(layer);
      }
      setVisible(false);
    } else {
      if (otherVisible) {
        if (!this.app.replayManager.state.active) {
          this.app.map.removeLayer(otherLayer);
        }
        setOtherVisible(false);
      }

      if (!this.app.replayManager.state.active) {
        redraw();
        this.app.map.addLayer(layer);
      } else {
        this.app.replayManager.redrawReplayPath(mode);
      }

      setVisible(true);
    }

    // The heatmap underneath steps back so the colour scale reads
    this.app.dataManager.applyHeatmapEmphasis();

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
    );
  }

  /**
   * Capture the map as an image. Only the `#map` element is rendered, and
   * the controls are its siblings, so they never appear in the image and
   * nothing has to be hidden for it.
   */
  exportMap(): void {
    const btn = domCache.get("export-btn", HTMLButtonElement);
    const mapContainer = domCache.get("map");
    if (!btn || !mapContainer) return;
    // An export is already running
    if (btn.disabled) return;

    btn.disabled = true;
    // Only the label changes so the button keeps its icon
    setControlLabel(btn, EXPORT_BUTTON_BUSY_LABEL);

    const restore = () => {
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

    const scale = exportScale(
      mapContainer.offsetWidth,
      mapContainer.offsetHeight,
    );
    const dataUrl = await domtoimage.toJpeg(mapContainer, {
      width: Math.round(mapContainer.offsetWidth * scale),
      height: Math.round(mapContainer.offsetHeight * scale),
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
    // The URL is read right now, so the debounced save has to land first
    this.app.stateManager.flush();
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
