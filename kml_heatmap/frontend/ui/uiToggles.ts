/**
 * UI Toggles - Handles UI toggle functions (heatmap, altitude, airspeed, airports, aviation, export, share)
 */
import type * as L from "leaflet";
import type { MapApp } from "../mapApp";
import { setControlLabel } from "../utils/buttonState";
import { domCache } from "../utils/domCache";
import { showToast } from "../utils/toast";

type ColorLayerMode = "altitude" | "airspeed";

/**
 * html-to-image is only needed for export, so it is loaded on first use.
 * It is served from the site next to the page (see scripts/vendor.js), so
 * there is no integrity hash to pin: same-origin and already covered by the
 * page's own CSP.
 */
export const HTML_TO_IMAGE_URL = "./vendor/html-to-image.js";

import { MOBILE_BREAKPOINT_PX } from "../utils/constants";
/** Largest canvas iOS Safari will draw into (16.7 million pixels) */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** Phones get their pixel density up to this factor */
const MAX_PHONE_EXPORT_SCALE = 3;
const EXPORT_BUTTON_LABEL = "Export image";
const EXPORT_BUTTON_BUSY_LABEL = "Exporting…";

let htmlToImagePromise: Promise<HtmlToImage | null> | null = null;

/**
 * Load html-to-image on demand. Resolves with null when the script cannot be
 * loaded (a site published without the vendor directory, blocked by CSP).
 */
export function loadHtmlToImage(): Promise<HtmlToImage | null> {
  if (window.htmlToImage) return Promise.resolve(window.htmlToImage);
  if (htmlToImagePromise) return htmlToImagePromise;

  htmlToImagePromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = HTML_TO_IMAGE_URL;
    script.onload = () => resolve(window.htmlToImage ?? null);
    script.onerror = () => {
      script.remove();
      htmlToImagePromise = null;
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return htmlToImagePromise;
}

/** Reset the cached loader (used by tests) */
export function resetHtmlToImageLoader(): void {
  htmlToImagePromise = null;
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
    const map = this.app.map;
    if (!map) return;

    const other: ColorLayerMode = mode === "altitude" ? "airspeed" : "altitude";
    const replay = this.app.replayState.active;
    const layers = this.app.layerManager;

    // The buttons and the legends follow the store keys written below
    if (this.app[`${mode}Visible`]) {
      if (replay) {
        // The layer is off the map for the replay already. The trail keeps
        // its altitude colours without a colour layer, so only a speed
        // trail changes (see ReplayManager.updateTrailLegend for the scale)
        if (mode === "airspeed") {
          this.app.replayManager?.redrawReplayPath("altitude");
        }
      } else {
        map.removeLayer(this.app[`${mode}Layer`]);
      }
      this.app[`${mode}Visible`] = false;
      // A hidden layer is rebuilt when it is shown again; kept, its
      // polylines and their segment lists held tens of MB for nothing
      layers.clearLayer(mode);
    } else {
      if (this.app[`${other}Visible`]) {
        if (!replay) map.removeLayer(this.app[`${other}Layer`]);
        this.app[`${other}Visible`] = false;
        layers.clearLayer(other);
      }

      if (!replay) {
        if (mode === "altitude") layers.redrawAltitudePaths();
        else layers.redrawAirspeedPaths();
        map.addLayer(this.app[`${mode}Layer`]);
      } else {
        this.app.replayManager?.redrawReplayPath(mode);
      }

      this.app[`${mode}Visible`] = true;
    }

    if (replay && this.app.replayState.airplaneMarker?.isPopupOpen()) {
      this.app.replayManager?.updateReplayAirplanePopup();
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
    const htmlToImage = await loadHtmlToImage();
    if (!htmlToImage) {
      showToast("Export unavailable", "error");
      return;
    }

    const scale = exportScale(
      mapContainer.offsetWidth,
      mapContainer.offsetHeight,
    );
    const dataUrl = await htmlToImage.toJpeg(mapContainer, {
      // The canvas is the map's CSS size times this; the clone keeps the
      // map's own layout
      pixelRatio: scale,
      // The page has no web fonts to inline. Looking for them reads every
      // stylesheet, which a file:// page is not allowed to.
      skipFonts: true,
      backgroundColor:
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
