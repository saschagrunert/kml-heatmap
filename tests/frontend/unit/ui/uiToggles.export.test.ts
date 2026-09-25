/**
 * UIToggles: image export, the html-to-image loader and link sharing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MAX_CANVAS_PIXELS,
  UIToggles,
  dataUrlToBlob,
  exportScale,
  isSmallDevice,
  loadHtmlToImage,
  importFromVendor,
  resetHtmlToImageLoader,
  type HtmlToImage,
} from "../../../../kml_heatmap/frontend/ui/uiToggles";
import { logError } from "../../../../kml_heatmap/frontend/utils/logger";
import {
  asMapApp,
  createMockApp,
  el,
  mountElements,
  setDevicePixelRatio,
  type MockApp,
} from "../../testHelpers";

type AnyMock = ReturnType<typeof vi.fn>;

const DOM: Record<string, string> = {
  "export-btn": "button",
  "share-btn": "button",
  "replay-btn": "button",
  "stats-btn": "button",
  map: "div",
};

/** What the map's canvas reads as while it is captured */
const STILL_URL = "data:image/png;base64,c3RpbGw=";

function toast(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".toast-notification");
}

/** Let the export's promise chain settle without running the toast timer */
async function finishExport(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500);
}

function setInnerWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

function defineNavigatorProperty(name: string, value: unknown): void {
  Object.defineProperty(navigator, name, { value, configurable: true });
}

function deleteNavigatorProperty(name: string): void {
  Reflect.deleteProperty(navigator, name);
}

vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

describe("UIToggles export and share", () => {
  let uiToggles: UIToggles;
  let app: MockApp;
  let unmount: () => void;

  beforeEach(() => {
    unmount = mountElements(DOM);
    Object.defineProperty(el("map"), "offsetWidth", {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(el("map"), "offsetHeight", {
      value: 600,
      configurable: true,
    });
    app = createMockApp();
    // jsdom has neither a canvas to read nor images to decode, and the
    // capture takes a still of the map's canvas first (withMapStill)
    vi.spyOn(app.map!.getCanvas(), "toDataURL").mockReturnValue(STILL_URL);
    HTMLImageElement.prototype.decode = vi.fn(() => Promise.resolve());
    uiToggles = new UIToggles(asMapApp(app));
  });

  afterEach(() => {
    unmount();
    delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    document.querySelectorAll(".toast-notification").forEach((e) => e.remove());
    resetHtmlToImageLoader();
    setInnerWidth(1024);
    setDevicePixelRatio(1);
    deleteNavigatorProperty("share");
    deleteNavigatorProperty("canShare");
    deleteNavigatorProperty("clipboard");
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("loadHtmlToImage", () => {
    const lib: HtmlToImage = { toJpeg: vi.fn() };

    it("imports the library on the first call, and once for all callers", async () => {
      const importer = vi.fn(() => Promise.resolve(lib));
      resetHtmlToImageLoader(importer);
      expect(importer).not.toHaveBeenCalled();

      const first = loadHtmlToImage();
      const second = loadHtmlToImage();

      expect(first).toBe(second);
      await expect(first).resolves.toBe(lib);
      await expect(loadHtmlToImage()).resolves.toBe(lib);
      expect(importer.mock.calls).toEqual([[0]]);
    });

    it("resolves null when the import fails, and says why", async () => {
      const failure = new Error("offline");
      resetHtmlToImageLoader(() => Promise.reject(failure));

      await expect(loadHtmlToImage()).resolves.toBeNull();

      expect(logError).toHaveBeenCalledWith(
        "Could not load html-to-image:",
        failure,
      );
    });

    it("tries again after a failure, under a URL the browser has not failed on", async () => {
      const importer = vi
        .fn<(failedImports: number) => Promise<HtmlToImage>>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockRejectedValueOnce(new Error("still offline"))
        .mockResolvedValue(lib);
      resetHtmlToImageLoader(importer);

      await expect(loadHtmlToImage()).resolves.toBeNull();
      await expect(loadHtmlToImage()).resolves.toBeNull();
      await expect(loadHtmlToImage()).resolves.toBe(lib);

      expect(importer.mock.calls).toEqual([[0], [1], [2]]);
    });

    it("imports the package by default, which the build points at vendor/", async () => {
      resetHtmlToImageLoader();

      const library = await loadHtmlToImage();

      expect(library!.toJpeg).toBeTypeOf("function");
    });

    it("names the vendored module itself on a retry", async () => {
      // There is no vendor/ next to the sources, so this fails, and says
      // what it asked for; the e2e suite checks the retry against a site
      const failure = await importFromVendor(1).catch((e: unknown) => e);

      expect(String(failure)).toContain("/vendor/html-to-image.mjs");
    });
  });

  describe("dataUrlToBlob", () => {
    it("decodes base64 data URLs", async () => {
      const blob = dataUrlToBlob("data:image/jpeg;base64,aGVsbG8=");

      expect(blob.type).toBe("image/jpeg");
      expect(blob.size).toBe(5);
      expect(await blob.text()).toBe("hello");
    });

    it("decodes plain data URLs", async () => {
      const blob = dataUrlToBlob("data:text/plain,hello%20world");

      expect(blob.type).toBe("text/plain");
      expect(await blob.text()).toBe("hello world");
    });

    it("falls back to a generic type without a header", () => {
      const blob = dataUrlToBlob("no-comma");

      expect(blob.type).toBe("application/octet-stream");
    });
  });

  describe("exportScale", () => {
    it("uses 2x on desktop whatever the pixel density", () => {
      setInnerWidth(1280);
      setDevicePixelRatio(1);
      expect(exportScale(1280, 800)).toBe(2);
    });

    it("follows a phone's pixel density up to 3x", () => {
      setInnerWidth(390);
      setDevicePixelRatio(2.625);
      expect(exportScale(390, 844)).toBe(2.625);

      setDevicePixelRatio(4);
      expect(exportScale(390, 844)).toBe(3);

      setDevicePixelRatio(0);
      expect(exportScale(390, 844)).toBe(1);
    });

    it("keeps the canvas within the iOS pixel limit", () => {
      setInnerWidth(1280);
      const scale = exportScale(3000, 3000);

      expect(scale).toBeLessThan(2);
      expect(3000 * scale * (3000 * scale)).toBeCloseTo(MAX_CANVAS_PIXELS, 0);
    });

    it("tolerates a map that has no size yet", () => {
      setInnerWidth(1280);
      expect(exportScale(0, 0)).toBe(2);
    });
  });

  describe("isSmallDevice", () => {
    it("is true for narrow viewports", () => {
      setInnerWidth(500);
      expect(isSmallDevice()).toBe(true);
    });

    it("is true for coarse pointers on wide viewports", () => {
      setInnerWidth(1200);
      Object.defineProperty(window, "matchMedia", {
        value: vi.fn(() => ({ matches: true })),
        configurable: true,
        writable: true,
      });
      expect(isSmallDevice()).toBe(true);
    });

    it("is false for wide viewports with a fine pointer", () => {
      setInnerWidth(1200);
      Object.defineProperty(window, "matchMedia", {
        value: vi.fn(() => ({ matches: false })),
        configurable: true,
        writable: true,
      });
      expect(isSmallDevice()).toBe(false);
    });
  });

  describe("exportMap", () => {
    let clickSpy: AnyMock;
    let createObjectURL: AnyMock;
    let revokeObjectURL: AnyMock;

    beforeEach(() => {
      vi.useFakeTimers();
      clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => {});
      createObjectURL = vi.fn(() => "blob:mock-url");
      revokeObjectURL = vi.fn();
      Object.defineProperty(URL, "createObjectURL", {
        value: createObjectURL,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        value: revokeObjectURL,
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    });

    function installHtmlToImage(
      toJpeg: AnyMock = vi
        .fn()
        .mockResolvedValue("data:image/jpeg;base64,aGVsbG8="),
    ): AnyMock {
      resetHtmlToImageLoader(() =>
        Promise.resolve({ toJpeg } as unknown as HtmlToImage),
      );
      return toJpeg;
    }

    function clickedLink(): HTMLAnchorElement {
      const link = clickSpy.mock.contexts[0] as HTMLAnchorElement | undefined;
      if (!link) throw new Error("No download link was clicked");
      return link;
    }

    it("does nothing if the export button is missing", async () => {
      el("export-btn").remove();
      const toJpeg = installHtmlToImage();

      uiToggles.exportMap();
      await finishExport();

      expect(toJpeg).not.toHaveBeenCalled();
    });

    it("does nothing if the map container is missing", async () => {
      el("map").remove();
      const toJpeg = installHtmlToImage();
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(btn.getAttribute("aria-disabled")).not.toBe("true");
      expect(toJpeg).not.toHaveBeenCalled();
    });

    it("marks the button unavailable while exporting and leaves the other controls alone", () => {
      installHtmlToImage();
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();

      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.textContent).toBe("Exporting…");
      // Only #map is captured and the controls are its siblings, so hiding
      // them would only make the page flicker
      expect(el("replay-btn").style.display).toBe("");
      expect(el("share-btn").style.display).toBe("");
      expect(el("stats-btn").style.display).toBe("");
    });

    it("captures the map in the frame it asked for, without a timer", async () => {
      const toJpeg = installHtmlToImage();

      uiToggles.exportMap();
      await vi.advanceTimersByTimeAsync(0);

      expect(app.map!.triggerRepaint).toHaveBeenCalledTimes(1);
      expect(toJpeg).toHaveBeenCalledTimes(1);
    });

    it("captures a still of the map in place of its WebGL canvas", async () => {
      // html-to-image copies DOM, and a WebGL canvas copies blank
      const canvas = app.map!.getCanvas();
      const seen: { canvas: boolean; still: string | undefined }[] = [];
      const toJpeg = installHtmlToImage(
        vi.fn((node: HTMLElement) => {
          seen.push({
            canvas: node.contains(canvas),
            still: node.querySelector("img")?.src,
          });
          return Promise.resolve("data:image/jpeg;base64,aGVsbG8=");
        }),
      );

      uiToggles.exportMap();
      await finishExport();

      expect(toJpeg).toHaveBeenCalledTimes(1);
      expect(canvas.toDataURL).toHaveBeenCalledWith("image/png");
      expect(seen).toEqual([{ canvas: false, still: STILL_URL }]);
      // The canvas is back once the image is taken
      expect(el("map").contains(canvas)).toBe(true);
      expect(el("map").querySelector("img")).toBeNull();
    });

    it("puts the canvas back when the capture fails", async () => {
      const canvas = app.map!.getCanvas();
      installHtmlToImage(vi.fn().mockRejectedValue(new Error("tainted")));

      uiToggles.exportMap();
      await finishExport();

      expect(toast()?.textContent).toBe("Export failed: tainted");
      expect(el("map").contains(canvas)).toBe(true);
      expect(el("map").querySelector("img")).toBeNull();
    });

    it("draws the map at the scale of the export on a 1x screen, then gives the ratio back", async () => {
      setDevicePixelRatio(1);
      const map = app.map!;
      const ratios: number[] = [];
      installHtmlToImage(
        vi.fn(() => {
          ratios.push(map.getPixelRatio());
          return Promise.resolve("data:image/jpeg;base64,aGVsbG8=");
        }),
      );

      uiToggles.exportMap();
      await finishExport();

      expect(ratios).toEqual([2]);
      expect(map.getPixelRatio()).toBe(1);
    });

    it("draws the map no larger than the export is allowed to be", async () => {
      setDevicePixelRatio(1);
      Object.defineProperty(el("map"), "offsetWidth", { value: 4000 });
      Object.defineProperty(el("map"), "offsetHeight", { value: 3000 });
      installHtmlToImage();

      uiToggles.exportMap();
      await finishExport();

      const ratio = vi.mocked(app.map!.setPixelRatio).mock.calls[0]![0] ?? 0;
      expect(ratio).toBeGreaterThan(1);
      expect(4000 * ratio * (3000 * ratio)).toBeLessThanOrEqual(
        MAX_CANVAS_PIXELS + 1,
      );
    });

    it("gives the ratio back when the capture fails", async () => {
      setDevicePixelRatio(1);
      installHtmlToImage(vi.fn().mockRejectedValue(new Error("tainted")));
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(app.map!.getPixelRatio()).toBe(1);
      expect(toast()?.textContent).toBe("Export failed: tainted");
      expect(btn.getAttribute("aria-disabled")).not.toBe("true");
    });

    it("reports a canvas that cannot be read, and takes no picture", async () => {
      const toJpeg = installHtmlToImage();
      vi.mocked(app.map!.getCanvas().toDataURL).mockImplementation(() => {
        throw new Error("context lost");
      });

      uiToggles.exportMap();
      await finishExport();

      expect(toast()?.textContent).toBe("Export failed: context lost");
      expect(toJpeg).not.toHaveBeenCalled();
      expect(el("map").contains(app.map!.getCanvas())).toBe(true);
    });

    it("captures the page as it is when there is no map", async () => {
      app.map = null;
      const toJpeg = installHtmlToImage();

      uiToggles.exportMap();
      await finishExport();

      expect(toJpeg).toHaveBeenCalledWith(el("map"), expect.anything());
      expect(toast()?.textContent).toBe("Map exported");
    });

    it("changes only the label so the button keeps its icon", async () => {
      installHtmlToImage();
      const btn = el("export-btn") as HTMLButtonElement;
      btn.innerHTML =
        '<svg class="icon"></svg><span class="control-label">Export image</span>';

      uiToggles.exportMap();
      const label = btn.querySelector(".control-label");
      expect(label?.textContent).toBe("Exporting…");
      expect(btn.querySelector("svg.icon")).not.toBeNull();

      await finishExport();

      expect(label?.textContent).toBe("Export image");
      expect(btn.querySelector("svg.icon")).not.toBeNull();
    });

    it("ignores a second click while an export is running", async () => {
      const toJpeg = installHtmlToImage();

      uiToggles.exportMap();
      uiToggles.exportMap();
      await finishExport();

      expect(toJpeg).toHaveBeenCalledTimes(1);
    });

    it("exports at 2x on desktop, downloads a blob and shows a success toast", async () => {
      const toJpeg = installHtmlToImage();
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(toJpeg).toHaveBeenCalledWith(
        el("map"),
        expect.objectContaining({ pixelRatio: 2, quality: 0.95 }),
      );
      expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
      const link = clickedLink();
      expect(link.href).toBe("blob:mock-url");
      expect(link.download).toMatch(/^heatmap_\d{4}-\d{2}-\d{2}T.*\.jpg$/);
      expect(link.isConnected).toBe(false);
      expect(toast()?.textContent).toBe("Map exported");
      // The object URL is released after the download had time to start
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10000);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
      expect(btn.getAttribute("aria-disabled")).not.toBe("true");
      expect(btn.textContent).toBe("Export image");
    });

    it("exports at the pixel density of a phone", async () => {
      setInnerWidth(500);
      setDevicePixelRatio(3);
      const toJpeg = installHtmlToImage();

      uiToggles.exportMap();
      await finishExport();

      // A fixed 1x left a 3x phone with an image a third of its resolution
      expect(toJpeg).toHaveBeenCalledWith(
        el("map"),
        expect.objectContaining({ pixelRatio: 3 }),
      );
    });

    it("falls back to the data URL when object URLs are unavailable", async () => {
      Object.defineProperty(URL, "createObjectURL", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      installHtmlToImage();

      uiToggles.exportMap();
      await finishExport();

      expect(toast()?.textContent).toBe("Map exported");
      expect(clickedLink().href).toBe("data:image/jpeg;base64,aGVsbG8=");
    });

    it("shares the image on mobile when file sharing is supported", async () => {
      setInnerWidth(500);
      const share = vi.fn().mockResolvedValue(undefined);
      defineNavigatorProperty("share", share);
      defineNavigatorProperty(
        "canShare",
        vi.fn(() => true),
      );
      installHtmlToImage();

      uiToggles.exportMap();
      await finishExport();

      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({ files: [expect.any(File)] }),
      );
      const shared = (share.mock.calls[0]![0] as { files: File[] }).files[0]!;
      expect(shared.name).toMatch(/^heatmap_.*\.jpg$/);
      expect(shared.type).toBe("image/jpeg");
      expect(clickSpy).not.toHaveBeenCalled();
      expect(toast()?.textContent).toBe("Map shared");
    });

    it("downloads instead of sharing when the files cannot be shared", async () => {
      setInnerWidth(500);
      const share = vi.fn().mockResolvedValue(undefined);
      defineNavigatorProperty("share", share);
      defineNavigatorProperty(
        "canShare",
        vi.fn(() => false),
      );
      installHtmlToImage();

      uiToggles.exportMap();
      await finishExport();

      expect(share).not.toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it("does not share on desktop even when supported", async () => {
      setInnerWidth(1200);
      const share = vi.fn().mockResolvedValue(undefined);
      defineNavigatorProperty("share", share);
      defineNavigatorProperty(
        "canShare",
        vi.fn(() => true),
      );
      installHtmlToImage();

      uiToggles.exportMap();
      await finishExport();

      expect(share).not.toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it("falls back to a download when sharing fails", async () => {
      setInnerWidth(500);
      defineNavigatorProperty(
        "share",
        vi.fn().mockRejectedValue(new Error("boom")),
      );
      defineNavigatorProperty(
        "canShare",
        vi.fn(() => true),
      );
      installHtmlToImage();

      uiToggles.exportMap();
      await finishExport();

      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(toast()?.textContent).toBe("Map exported");
    });

    it("shows no toast when the user cancels sharing", async () => {
      setInnerWidth(500);
      const abort = new Error("cancelled");
      abort.name = "AbortError";
      defineNavigatorProperty("share", vi.fn().mockRejectedValue(abort));
      defineNavigatorProperty(
        "canShare",
        vi.fn(() => true),
      );
      installHtmlToImage();
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(clickSpy).not.toHaveBeenCalled();
      expect(toast()).toBeNull();
      expect(btn.getAttribute("aria-disabled")).not.toBe("true");
    });

    it("shows an error toast and re-enables the button when html-to-image is unavailable", async () => {
      resetHtmlToImageLoader(() => Promise.reject(new Error("offline")));
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(toast()?.textContent).toBe("Export unavailable");
      expect(toast()?.classList.contains("toast-error")).toBe(true);
      expect(btn.getAttribute("aria-disabled")).not.toBe("true");
      expect(btn.textContent).toBe("Export image");
      expect(clickSpy).not.toHaveBeenCalled();
    });

    it("re-enables the button and shows a toast on html-to-image failure", async () => {
      installHtmlToImage(vi.fn().mockRejectedValue(new Error("Export failed")));
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(toast()?.textContent).toBe("Export failed: Export failed");
      expect(toast()?.classList.contains("toast-error")).toBe(true);
      expect(btn.getAttribute("aria-disabled")).not.toBe("true");
      expect(btn.textContent).toBe("Export image");
    });
  });

  describe("shareLink", () => {
    it("flushes the pending state so the URL is current, then uses the share sheet", async () => {
      setInnerWidth(390);
      const share = vi.fn().mockResolvedValue(undefined);
      defineNavigatorProperty("share", share);

      await uiToggles.shareLink();

      expect(app.stateManager.flush).toHaveBeenCalledTimes(1);
      expect(share).toHaveBeenCalledWith({
        url: window.location.href,
        title: document.title,
      });
      expect(toast()).toBeNull();
    });

    it("stays silent when the user cancels the share sheet", async () => {
      const abort = new Error("cancelled");
      abort.name = "AbortError";
      setInnerWidth(390);
      defineNavigatorProperty("share", vi.fn().mockRejectedValue(abort));
      const writeText = vi.fn().mockResolvedValue(undefined);
      defineNavigatorProperty("clipboard", { writeText });

      await uiToggles.shareLink();

      expect(writeText).not.toHaveBeenCalled();
      expect(toast()).toBeNull();
    });

    it("copies the link on a desktop that has a share sheet too", async () => {
      // The control says "Copy link"; desktop Safari and Chrome opened their
      // share sheet instead
      setInnerWidth(1280);
      Object.defineProperty(window, "matchMedia", {
        value: vi.fn(() => ({ matches: false })),
        configurable: true,
        writable: true,
      });
      const share = vi.fn().mockResolvedValue(undefined);
      defineNavigatorProperty("share", share);
      const writeText = vi.fn().mockResolvedValue(undefined);
      defineNavigatorProperty("clipboard", { writeText });

      await uiToggles.shareLink();

      expect(share).not.toHaveBeenCalled();
      expect(writeText).toHaveBeenCalledWith(window.location.href);
      expect(toast()?.textContent).toBe("Link copied");
    });

    it("falls back to the clipboard when sharing fails", async () => {
      setInnerWidth(390);
      defineNavigatorProperty(
        "share",
        vi.fn().mockRejectedValue(new Error("boom")),
      );
      const writeText = vi.fn().mockResolvedValue(undefined);
      defineNavigatorProperty("clipboard", { writeText });

      await uiToggles.shareLink();

      expect(writeText).toHaveBeenCalledWith(window.location.href);
      expect(toast()?.textContent).toBe("Link copied");
    });

    it("copies the link to the clipboard without native sharing", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      defineNavigatorProperty("clipboard", { writeText });

      await uiToggles.shareLink();

      expect(writeText).toHaveBeenCalledWith(window.location.href);
      expect(toast()?.textContent).toBe("Link copied");
    });

    it("shows an error toast when the clipboard is unavailable", async () => {
      await uiToggles.shareLink();

      expect(toast()?.textContent).toBe("Could not copy link");
      expect(toast()?.classList.contains("toast-error")).toBe(true);
    });
  });
});
