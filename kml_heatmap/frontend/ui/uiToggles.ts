/**
 * UI Toggles - Handles UI toggle functions (heatmap, altitude, airspeed, airports, aviation, satellite, export, share)
 */
import type { MapApp } from "../mapApp";
import { setControlLabel } from "../utils/buttonState";
import { domCache } from "../utils/domCache";
import { logError } from "../utils/logger";
import { withMapStill } from "../utils/mapHelpers";
import { showToast } from "../utils/toast";
import { setColorLayer } from "./layerVisibility";

/**
 * html-to-image is only needed for export, so it is imported on first use.
 * It is no part of the bundles: the build points the import at the module
 * scripts/vendor.js puts next to the page, the way it does with MapLibre
 * (see build.js). Same-origin, so the page's CSP covers it as it is.
 */
export const HTML_TO_IMAGE_URL = "./vendor/html-to-image.mjs";

import { MOBILE_BREAKPOINT_PX } from "../utils/constants";
/** Largest canvas iOS Safari will draw into (16.7 million pixels) */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** Phones get their pixel density up to this factor */
const MAX_PHONE_EXPORT_SCALE = 3;
const EXPORT_BUTTON_LABEL = "Export image";
const EXPORT_BUTTON_BUSY_LABEL = "Exporting…";

/** What the export uses of html-to-image */
export type HtmlToImage = Pick<typeof import("html-to-image"), "toJpeg">;

/**
 * The import itself, replaceable by tests and exported for them. A retry
 * names the vendored module under a URL the page has not tried yet, because
 * a browser may answer a failed import() from memory (see
 * services/featureLoader.ts).
 */
export const importFromVendor = (
  failedImports: number,
): Promise<HtmlToImage> =>
  failedImports === 0
    ? import("html-to-image")
    : (import(
        new URL(`${HTML_TO_IMAGE_URL}?retry=${failedImports}`, import.meta.url)
          .href
      ) as Promise<HtmlToImage>);

let importHtmlToImage = importFromVendor;
let htmlToImagePromise: Promise<HtmlToImage | null> | null = null;
let failedImports = 0;

/**
 * Load html-to-image on demand. Resolves with null when the module cannot be
 * loaded (offline, a site published without the vendor directory); that is
 * not kept, so the next export asks the server again.
 */
export function loadHtmlToImage(): Promise<HtmlToImage | null> {
  htmlToImagePromise ??= importHtmlToImage(failedImports).catch(
    (error: unknown) => {
      logError("Could not load html-to-image:", error);
      failedImports++;
      htmlToImagePromise = null;
      return null;
    },
  );
  return htmlToImagePromise;
}

/** Forget the cached import, and replace it (used by tests) */
export function resetHtmlToImageLoader(
  importer: typeof importHtmlToImage = importFromVendor,
): void {
  htmlToImagePromise = null;
  failedImports = 0;
  importHtmlToImage = importer;
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

  // The toggles only write the store: what the map shows, the buttons and
  // the legends follow it (see ui/layerVisibility.ts)

  toggleHeatmap(): void {
    if (this.app.map) this.app.heatmapVisible = !this.app.heatmapVisible;
  }

  toggleAltitude(): void {
    this.toggleColorLayer("altitude");
  }

  toggleAirspeed(): void {
    this.toggleColorLayer("airspeed");
  }

  private toggleColorLayer(mode: "altitude" | "airspeed"): void {
    if (!this.app.map) return;
    if (setColorLayer(this.app, mode, !this.app[`${mode}Visible`])) {
      const label = mode === "altitude" ? "Speed" : "Altitude";
      showToast(`${label} layer disabled`, "info");
    }
  }

  toggleAirports(): void {
    if (this.app.map) this.app.airportsVisible = !this.app.airportsVisible;
  }

  toggleAviation(): void {
    if (this.app.map) this.app.aviationVisible = !this.app.aviationVisible;
  }

  toggleSatellite(): void {
    if (this.app.map) this.app.satelliteVisible = !this.app.satelliteVisible;
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
    if (btn.getAttribute("aria-disabled") === "true") return;

    // Unavailable while it runs, but not `disabled`: that takes the focus
    // off the button that was just pressed and drops it to <body>
    btn.setAttribute("aria-disabled", "true");
    // Only the label changes so the button keeps its icon
    setControlLabel(btn, EXPORT_BUTTON_BUSY_LABEL);

    const restore = () => {
      btn.setAttribute("aria-disabled", "false");
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
    const options = {
      // The canvas is the map's CSS size times this; the clone keeps the
      // map's own layout
      pixelRatio: scale,
      // The page has no web fonts to inline, so there is no point in
      // reading every stylesheet to look for them
      skipFonts: true,
      backgroundColor:
        getComputedStyle(document.documentElement)
          .getPropertyValue("--color-bg-primary")
          .trim() || "#1a1a1a",
      quality: 0.95,
    };
    // html-to-image copies DOM, and the map's WebGL canvas copies blank, so
    // the map stands still as an image of itself while it is captured,
    // drawn at the scale of the export so it is as sharp as the page on it
    const map = this.app.map;
    const capture = (): Promise<string> =>
      htmlToImage.toJpeg(mapContainer, options);
    const dataUrl = map
      ? await withMapStill(map, capture, scale)
      : await capture();

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
   * Share the current view: the native share sheet on a phone or a tablet,
   * as with an exported image, otherwise the link is copied to the
   * clipboard. The control says "Copy link", and desktop Safari and Chrome
   * have a share sheet too, which opened instead of copying.
   */
  async shareLink(): Promise<void> {
    // The URL is read right now, so the debounced save has to land first
    this.app.stateManager.flush();
    const url = window.location.href;

    if (isSmallDevice() && typeof navigator.share === "function") {
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
