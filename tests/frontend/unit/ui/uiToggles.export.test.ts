/**
 * UIToggles: image export, the dom-to-image loader and link sharing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DOM_TO_IMAGE_URL,
  MAX_CANVAS_PIXELS,
  UIToggles,
  dataUrlToBlob,
  exportScale,
  isSmallDevice,
  loadDomToImage,
  resetDomToImageLoader,
} from "../../../../kml_heatmap/frontend/ui/uiToggles";
import {
  asMapApp,
  createMockApp,
  el,
  mountElements,
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

function setDevicePixelRatio(ratio: number): void {
  Object.defineProperty(window, "devicePixelRatio", {
    value: ratio,
    configurable: true,
  });
}

function defineNavigatorProperty(name: string, value: unknown): void {
  Object.defineProperty(navigator, name, { value, configurable: true });
}

function deleteNavigatorProperty(name: string): void {
  Reflect.deleteProperty(navigator, name);
}

/**
 * A stand-in for document.head.appendChild that hands the appended script to
 * the test instead of the DOM; the return type of the real method is generic,
 * which the lint rules cannot follow through a mock
 */
function appendChildStub(
  onAppend: (script: HTMLScriptElement) => void,
): typeof document.head.appendChild {
  return ((node: Node) => {
    onAppend(node as HTMLScriptElement);
    return node;
  }) as typeof document.head.appendChild;
}

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
    uiToggles = new UIToggles(asMapApp(app));
  });

  afterEach(() => {
    unmount();
    document.querySelectorAll(".toast-notification").forEach((e) => e.remove());
    delete window.domtoimage;
    resetDomToImageLoader();
    setInnerWidth(1024);
    Reflect.deleteProperty(window, "devicePixelRatio");
    deleteNavigatorProperty("share");
    deleteNavigatorProperty("canShare");
    deleteNavigatorProperty("clipboard");
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("loadDomToImage", () => {
    it("resolves immediately when dom-to-image is already loaded", async () => {
      const lib = { toJpeg: vi.fn() } as unknown as DomToImage;
      window.domtoimage = lib;
      const appendSpy = vi.spyOn(document.head, "appendChild");

      await expect(loadDomToImage()).resolves.toBe(lib);
      expect(appendSpy).not.toHaveBeenCalled();
    });

    it("injects the vendored script and resolves once it loads", async () => {
      const lib = { toJpeg: vi.fn() } as unknown as DomToImage;
      let script: HTMLScriptElement | null = null;
      vi.spyOn(document.head, "appendChild").mockImplementation(
        appendChildStub((node) => {
          script = node;
          window.domtoimage = lib;
          queueMicrotask(() => {
            script?.onload?.(new Event("load"));
          });
        }),
      );

      await expect(loadDomToImage()).resolves.toBe(lib);
      // A relative src, so the element resolves it against the page
      expect(script!.getAttribute("src")).toBe(DOM_TO_IMAGE_URL);
      expect(new URL(script!.src).origin).toBe(window.location.origin);
      // Same-origin now, so neither attribute is set any more
      expect(script!.hasAttribute("integrity")).toBe(false);
      expect(script!.hasAttribute("crossorigin")).toBe(false);
    });

    it("shares one in-flight load between callers", async () => {
      let script: HTMLScriptElement | null = null;
      const appendSpy = vi
        .spyOn(document.head, "appendChild")
        .mockImplementation((node) => {
          script = node as HTMLScriptElement;
          return node;
        });

      const first = loadDomToImage();
      const second = loadDomToImage();
      expect(first).toBe(second);
      expect(appendSpy).toHaveBeenCalledTimes(1);

      script!.onerror?.(new Event("error"));
      await expect(first).resolves.toBeNull();
    });

    it("resolves null and allows a retry when the script fails", async () => {
      const appendSpy = vi
        .spyOn(document.head, "appendChild")
        .mockImplementation(
          appendChildStub((node) => {
            queueMicrotask(() => {
              node.onerror?.(new Event("error"));
            });
          }),
        );

      await expect(loadDomToImage()).resolves.toBeNull();
      await expect(loadDomToImage()).resolves.toBeNull();
      expect(appendSpy).toHaveBeenCalledTimes(2);
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

    function installDomToImage(
      toJpeg: AnyMock = vi
        .fn()
        .mockResolvedValue("data:image/jpeg;base64,aGVsbG8="),
    ): AnyMock {
      window.domtoimage = { toJpeg } as unknown as DomToImage;
      return toJpeg;
    }

    function clickedLink(): HTMLAnchorElement {
      const link = clickSpy.mock.contexts[0] as HTMLAnchorElement | undefined;
      if (!link) throw new Error("No download link was clicked");
      return link;
    }

    it("does nothing if the export button is missing", async () => {
      el("export-btn").remove();
      const toJpeg = installDomToImage();

      uiToggles.exportMap();
      await finishExport();

      expect(toJpeg).not.toHaveBeenCalled();
    });

    it("does nothing if the map container is missing", async () => {
      el("map").remove();
      const toJpeg = installDomToImage();
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(btn.disabled).toBe(false);
      expect(toJpeg).not.toHaveBeenCalled();
    });

    it("disables the button while exporting and leaves the other controls alone", () => {
      installDomToImage();
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();

      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe("Exporting…");
      // Only #map is captured and the controls are its siblings, so hiding
      // them would only make the page flicker
      expect(el("replay-btn").style.display).toBe("");
      expect(el("share-btn").style.display).toBe("");
      expect(el("stats-btn").style.display).toBe("");
    });

    it("captures the map right away instead of waiting for a repaint", async () => {
      const toJpeg = installDomToImage();

      uiToggles.exportMap();
      await vi.advanceTimersByTimeAsync(0);

      expect(toJpeg).toHaveBeenCalledTimes(1);
    });

    it("changes only the label so the button keeps its icon", async () => {
      installDomToImage();
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
      const toJpeg = installDomToImage();

      uiToggles.exportMap();
      uiToggles.exportMap();
      await finishExport();

      expect(toJpeg).toHaveBeenCalledTimes(1);
    });

    it("exports at 2x on desktop, downloads a blob and shows a success toast", async () => {
      const toJpeg = installDomToImage();
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(toJpeg).toHaveBeenCalledWith(
        el("map"),
        expect.objectContaining({ width: 1600, height: 1200, quality: 0.95 }),
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
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe("Export image");
    });

    it("exports at the pixel density of a phone", async () => {
      setInnerWidth(500);
      setDevicePixelRatio(3);
      const toJpeg = installDomToImage();

      uiToggles.exportMap();
      await finishExport();

      // A fixed 1x left a 3x phone with an image a third of its resolution
      const scaledStyle: unknown = expect.objectContaining({
        transform: "scale(3)",
      });
      expect(toJpeg).toHaveBeenCalledWith(
        el("map"),
        expect.objectContaining({
          width: 2400,
          height: 1800,
          style: scaledStyle,
        }),
      );
    });

    it("falls back to the data URL when object URLs are unavailable", async () => {
      Object.defineProperty(URL, "createObjectURL", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      installDomToImage();

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
      installDomToImage();

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
      installDomToImage();

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
      installDomToImage();

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
      installDomToImage();

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
      installDomToImage();
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(clickSpy).not.toHaveBeenCalled();
      expect(toast()).toBeNull();
      expect(btn.disabled).toBe(false);
    });

    it("shows an error toast and re-enables the button when dom-to-image is unavailable", async () => {
      vi.spyOn(document.head, "appendChild").mockImplementation(
        appendChildStub((node) => {
          queueMicrotask(() => {
            node.onerror?.(new Event("error"));
          });
        }),
      );
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(toast()?.textContent).toBe("Export unavailable");
      expect(toast()?.classList.contains("toast-error")).toBe(true);
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe("Export image");
      expect(clickSpy).not.toHaveBeenCalled();
    });

    it("re-enables the button and shows a toast on dom-to-image failure", async () => {
      installDomToImage(vi.fn().mockRejectedValue(new Error("Export failed")));
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(toast()?.textContent).toBe("Export failed: Export failed");
      expect(toast()?.classList.contains("toast-error")).toBe(true);
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe("Export image");
    });
  });

  describe("shareLink", () => {
    it("flushes the pending state so the URL is current, then uses the share sheet", async () => {
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
      defineNavigatorProperty("share", vi.fn().mockRejectedValue(abort));
      const writeText = vi.fn().mockResolvedValue(undefined);
      defineNavigatorProperty("clipboard", { writeText });

      await uiToggles.shareLink();

      expect(writeText).not.toHaveBeenCalled();
      expect(toast()).toBeNull();
    });

    it("falls back to the clipboard when sharing fails", async () => {
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
