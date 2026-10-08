/**
 * UI Toggles - Handles UI toggle functions (heatmap, altitude, airspeed, airports, aviation, satellite, export, share)
 */
import type { MapApp } from "../mapApp";
import { setControlLabel } from "../utils/buttonState";
import { canShareLink, isPhoneLayout, isSmallDevice } from "../utils/device";
import { domCache } from "../utils/domCache";
import { TRY_AGAIN, importWithRetry } from "../services/lazyImport";
import { logError } from "../utils/logger";
import {
  MAP_COMPLETE_TIMEOUT_MS,
  whenMapComplete,
  withMapStill,
} from "../utils/mapHelpers";
import { MAP_SOURCES } from "../utils/constants";
import { showToast } from "../utils/toast";
import { SHARE_INTRO_PARAM } from "../state/urlState";
import { NO_TIMING_MESSAGE, STILL_LOADING_MESSAGE } from "./actions";
import { altitudeColours, setColorLayer } from "./layerVisibility";

/**
 * html-to-image is only needed for export, so it is imported on first use.
 * It is no part of the bundles: the build points the import at the module
 * scripts/vendor.js puts next to the page, the way it does with MapLibre
 * (see build.js). Same-origin, so the page's CSP covers it as it is.
 */
export const HTML_TO_IMAGE_URL = "./vendor/html-to-image.mjs";

/** Largest canvas iOS Safari will draw into (16.7 million pixels) */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** Phones get their pixel density up to this factor */
const MAX_PHONE_EXPORT_SCALE = 3;
const EXPORT_BUTTON_LABEL = "Export image";
const EXPORT_BUTTON_BUSY_LABEL = "Exporting…";

/** What the export uses of html-to-image */
export type HtmlToImage = Pick<typeof import("html-to-image"), "toJpeg">;

/**
 * The import itself, replaceable by tests and exported for them (see
 * services/lazyImport.ts)
 */
export const importFromVendor = (failedImports: number): Promise<HtmlToImage> =>
  importWithRetry(
    () => import("html-to-image"),
    HTML_TO_IMAGE_URL,
    failedImports,
  );

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

/**
 * Scale of the exported image relative to the map's CSS size. Desktops get
 * 2x. A phone gets its own pixel density, since 1x left a 390x844 image on
 * a 3x screen. Either way the canvas stays within what iOS will allocate,
 * past which the export comes out blank.
 */
export function exportScale(width: number, height: number): number {
  const preferred = isPhoneLayout()
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

/**
 * Said when an export fails. What failed goes to the console: html-to-image
 * rejects with an Event as often as with an Error, which read as
 * "[object Event]".
 */
export const EXPORT_FAILED_MESSAGE = "Could not export the image. Try again.";

/** Said when html-to-image cannot be fetched (see loadHtmlToImage) */
export const EXPORT_UNAVAILABLE_MESSAGE =
  "Export is unavailable: its code could not be loaded" + TRY_AGAIN;

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
 * How long an export that goes to the share sheet waits in all, from the
 * tap on Export, before the image is taken (ms): for the library and for
 * the map to be complete. `navigator.share` needs the tap to be recent,
 * and the full MAP_COMPLETE_TIMEOUT_MS outlasted that on a slow phone, as
 * did two seconds for the map after the library: the share failed with
 * NotAllowedError and the image was downloaded instead.
 */
export const EXPORT_SHARE_WAIT_MS = 1000;

/**
 * Of EXPORT_SHARE_WAIT_MS, what the wait for the map leaves to the frame
 * of the still (ms): a map that draws at all draws within a frame or two,
 * and one heavy frame of a slow phone fits as well. The frame itself is
 * waited for as long as ever (MAP_STILL_TIMEOUT_MS): one that comes late
 * still makes the image, which is downloaded where the share sheet no
 * longer opens, where giving up on it failed the export.
 */
export const EXPORT_SHARE_FRAME_MS = 400;

/** Whether the export goes to the share sheet of a phone (see deliverImage) */
function sharesFiles(): boolean {
  return (
    isSmallDevice() &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function"
  );
}

/**
 * Hand the exported image to the user: the native share sheet on mobile
 * devices that support file sharing, a download otherwise.
 */
async function deliverImage(
  dataUrl: string,
  filename: string,
): Promise<DeliveryOutcome> {
  const blob = dataUrlToBlob(dataUrl);

  if (sharesFiles()) {
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
    // Unavailable without timing data, and until the metadata says whether
    // there is any (aria-disabled, see appInitializer): a click says why
    // rather than turning on a layer with no speeds to draw
    if (!this.app.hasTimingData) {
      showToast(
        this.app.isInitializing ? STILL_LOADING_MESSAGE : NO_TIMING_MESSAGE,
      );
      return;
    }
    this.toggleColorLayer("airspeed");
  }

  private toggleColorLayer(mode: "altitude" | "airspeed"): void {
    if (!this.app.map) return;
    // A replay trail is always coloured by one of the two, altitude when
    // neither layer is on (see altitudeColours): the pair works as a choice
    // then, and switching the one on screen off switches to the other. A
    // plain flip of the altitude flag changed nothing on screen.
    if (this.app.replayActive && mode === "altitude") {
      if (altitudeColours(this.app)) {
        this.switchColorLayer("airspeed", true);
      } else {
        this.switchColorLayer("altitude", true);
      }
      return;
    }
    this.switchColorLayer(mode, !this.app[`${mode}Visible`]);
  }

  private switchColorLayer(
    mode: "altitude" | "airspeed",
    visible: boolean,
  ): void {
    if (setColorLayer(this.app, mode, visible)) {
      // "Disabled" is what the page says of a control that cannot be used
      const [off, on] =
        mode === "altitude"
          ? ["Groundspeed", "altitude"]
          : ["Altitude", "groundspeed"];
      showToast(`${off} off, colouring by ${on}`, "info");
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
        logError("Export failed:", error);
        showToast(EXPORT_FAILED_MESSAGE, "error");
      })
      .finally(restore);
  }

  private async runExport(mapContainer: HTMLElement): Promise<void> {
    // The share sheet's deadline, which counts from the tap
    const shareBy = sharesFiles() ? Date.now() + EXPORT_SHARE_WAIT_MS : null;
    const htmlToImage = await loadHtmlToImage();
    if (!htmlToImage) {
      showToast(EXPORT_UNAVAILABLE_MESSAGE, "error");
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
    // Not before the map is complete: an export taken while its tiles or
    // the heat of a year that has just come in were on their way had gaps
    // in the map, or the heat of before.
    // html-to-image copies DOM, and the map's WebGL canvas copies blank, so
    // the map stands still as an image of itself while it is captured,
    // drawn at the scale of the export so it is as sharp as the page on it.
    // Not as long on the way to the share sheet, which needs the tap on
    // Export to be recent: the waits keep within one deadline (see
    // EXPORT_SHARE_WAIT_MS), where a download follows that is not.
    const map = this.app.map;
    if (map) {
      await whenMapComplete(
        map,
        () => !this.app.dataManager.heatRequests,
        [MAP_SOURCES.heat, MAP_SOURCES.heatIsolated, MAP_SOURCES.heatLines],
        shareBy === null
          ? MAP_COMPLETE_TIMEOUT_MS
          : shareBy - EXPORT_SHARE_FRAME_MS - Date.now(),
      );
    }
    const capture = (): Promise<string> =>
      htmlToImage.toJpeg(mapContainer, options);
    const dataUrl = map
      ? await withMapStill(map, capture, scale)
      : await capture();

    // Named after the year shown, not the time of the export: an image
    // posted right after a flight would give its time of day away
    const filename = "heatmap_" + this.app.store.get("selectedYear") + ".jpg";

    const outcome = await deliverImage(dataUrl, filename);
    if (outcome === "shared") {
      showToast("Map shared", "info");
    } else if (outcome === "downloaded") {
      showToast("Map exported", "info");
    }
  }

  /**
   * Share the current view: the native share sheet in the phone layout,
   * whose row says "Share link" then (see MobileBar), otherwise the link
   * is copied to the clipboard. The column's control says "Copy link", and
   * desktop Safari and Chrome have a share sheet too, as have tablets and
   * touch laptops, which opened it instead of copying.
   */
  async shareLink(): Promise<void> {
    // The URL is read right now, so the debounced save has to land first
    this.app.stateManager.flush();
    // A link to shared flights draws them in as it opens, once (see
    // takeShareIntro). The save has just written the link anew, with a
    // query, as share mode has flights, and without a fragment.
    const url =
      window.location.href +
      (this.app.isolateSelection ? `&${SHARE_INTRO_PARAM}=1` : "");

    if (canShareLink()) {
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
