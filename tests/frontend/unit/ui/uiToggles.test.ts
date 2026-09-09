import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DOM_TO_IMAGE_INTEGRITY,
  DOM_TO_IMAGE_URL,
  UIToggles,
  dataUrlToBlob,
  isSmallDevice,
  loadDomToImage,
  resetDomToImageLoader,
} from "../../../../kml_heatmap/frontend/ui/uiToggles";
import type { MapApp } from "../../../../kml_heatmap/frontend/mapApp";

type AnyMock = ReturnType<typeof vi.fn>;

interface ToggleMockApp {
  map: { addLayer: AnyMock; removeLayer: AnyMock } | null;
  heatmapLayer: { _canvas: HTMLCanvasElement | null };
  heatmapVisible: boolean;
  altitudeLayer: object;
  airspeedLayer: object;
  airportLayer: object;
  altitudeVisible: boolean;
  airspeedVisible: boolean;
  airportsVisible: boolean;
  aviationVisible: boolean;
  buttonsHidden: boolean;
  stateManager: { saveMapState: AnyMock };
  replayManager: {
    state: {
      active: boolean;
      airplaneMarker: { isPopupOpen: AnyMock } | null;
    };
    redrawReplayPath: AnyMock;
    updateReplayAirplanePopup: AnyMock;
  };
  layerManager: { redrawAltitudePaths: AnyMock; redrawAirspeedPaths: AnyMock };
  config: { openaipApiKey: string };
  openaipLayers: Record<string, object>;
}

const DOM: Record<string, string> = {
  "heatmap-btn": "button",
  "altitude-btn": "button",
  "airspeed-btn": "button",
  "airports-btn": "button",
  "aviation-btn": "button",
  "altitude-legend": "div",
  "airspeed-legend": "div",
  "hide-buttons-btn": "button",
  "export-btn": "button",
  "share-btn": "button",
  "replay-btn": "button",
  "stats-btn": "button",
  map: "div",
};

function el(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing test element #${id}`);
  return element;
}

function toast(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".toast-notification");
}

/** Let the export settle: the 200 ms repaint delay plus promise chains,
 * without running the toast removal timer */
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

describe("UIToggles", () => {
  let uiToggles: UIToggles;
  let mockApp: ToggleMockApp;

  beforeEach(() => {
    for (const [id, tag] of Object.entries(DOM)) {
      const element = document.createElement(tag);
      element.id = id;
      document.body.appendChild(element);
    }
    Object.defineProperty(el("map"), "offsetWidth", {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(el("map"), "offsetHeight", {
      value: 600,
      configurable: true,
    });

    mockApp = {
      map: { addLayer: vi.fn(), removeLayer: vi.fn() },
      heatmapLayer: { _canvas: null },
      heatmapVisible: true,
      altitudeLayer: {},
      airspeedLayer: {},
      airportLayer: {},
      altitudeVisible: false,
      airspeedVisible: false,
      airportsVisible: true,
      aviationVisible: false,
      buttonsHidden: false,
      stateManager: { saveMapState: vi.fn() },
      replayManager: {
        state: { active: false, airplaneMarker: null },
        redrawReplayPath: vi.fn(),
        updateReplayAirplanePopup: vi.fn(),
      },
      layerManager: {
        redrawAltitudePaths: vi.fn(),
        redrawAirspeedPaths: vi.fn(),
      },
      config: { openaipApiKey: "" },
      openaipLayers: {},
    };

    uiToggles = new UIToggles(mockApp as unknown as MapApp);
  });

  afterEach(() => {
    for (const id of Object.keys(DOM)) document.getElementById(id)?.remove();
    document.querySelectorAll(".toggleable-btn").forEach((e) => e.remove());
    document.querySelectorAll(".toast-notification").forEach((e) => e.remove());
    delete window.domtoimage;
    resetDomToImageLoader();
    setInnerWidth(1024);
    deleteNavigatorProperty("share");
    deleteNavigatorProperty("canShare");
    deleteNavigatorProperty("clipboard");
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("toggleHeatmap", () => {
    it("hides heatmap when visible", () => {
      mockApp.heatmapVisible = true;

      uiToggles.toggleHeatmap();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.heatmapLayer,
      );
      expect(mockApp.heatmapVisible).toBe(false);
      expect(el("heatmap-btn").style.opacity).toBe("0.5");
      expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("shows heatmap when hidden", () => {
      mockApp.heatmapVisible = false;

      uiToggles.toggleHeatmap();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.heatmapLayer);
      expect(mockApp.heatmapVisible).toBe(true);
      expect(el("heatmap-btn").style.opacity).toBe("1");
      expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("true");
    });

    it("sets pointer-events to none on canvas when showing heatmap", () => {
      mockApp.heatmapVisible = false;
      const canvas = document.createElement("canvas");
      mockApp.heatmapLayer._canvas = canvas;

      uiToggles.toggleHeatmap();

      expect(canvas.style.pointerEvents).toBe("none");
    });

    it("does nothing without a map", () => {
      mockApp.map = null;

      uiToggles.toggleHeatmap();

      expect(mockApp.heatmapVisible).toBe(true);
    });
  });

  describe("toggleAltitude", () => {
    it("shows altitude and hides airspeed when airspeed is visible", () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = true;

      uiToggles.toggleAltitude();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.airspeedLayer,
      );
      expect(mockApp.airspeedVisible).toBe(false);
      expect(el("airspeed-btn").style.opacity).toBe("0.5");
      expect(el("airspeed-btn").getAttribute("aria-pressed")).toBe("false");
      expect(el("airspeed-legend").style.display).toBe("none");

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.altitudeLayer);
      expect(mockApp.altitudeVisible).toBe(true);
      expect(el("altitude-btn").style.opacity).toBe("1");
      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("true");
      expect(el("altitude-legend").style.display).toBe("block");
      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalled();
    });

    it("hides altitude when visible", () => {
      mockApp.altitudeVisible = true;

      uiToggles.toggleAltitude();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.altitudeLayer,
      );
      expect(mockApp.altitudeVisible).toBe(false);
      expect(el("altitude-btn").style.opacity).toBe("0.5");
      expect(el("altitude-legend").style.display).toBe("none");
    });

    it("shows altitude without airspeed conflict", () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      uiToggles.toggleAltitude();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.altitudeLayer);
      expect(mockApp.altitudeVisible).toBe(true);
      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalled();
    });

    it("does nothing without a map", () => {
      mockApp.map = null;

      uiToggles.toggleAltitude();

      expect(mockApp.altitudeVisible).toBe(false);
    });

    it("prevents hiding altitude during replay if airspeed is also hidden", () => {
      mockApp.altitudeVisible = true;
      mockApp.airspeedVisible = false;
      mockApp.replayManager.state.active = true;

      uiToggles.toggleAltitude();

      expect(mockApp.altitudeVisible).toBe(true);
      expect(mockApp.map!.removeLayer).not.toHaveBeenCalled();
    });

    it("during replay does not add layer but updates state", () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;
      mockApp.replayManager.state.active = true;

      uiToggles.toggleAltitude();

      expect(mockApp.map!.addLayer).not.toHaveBeenCalled();
      expect(mockApp.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(mockApp.altitudeVisible).toBe(true);
      expect(el("altitude-legend").style.display).toBe("block");
    });

    it("during replay hides airspeed without removing layer", () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = true;
      mockApp.replayManager.state.active = true;

      uiToggles.toggleAltitude();

      expect(mockApp.map!.removeLayer).not.toHaveBeenCalled();
      expect(mockApp.airspeedVisible).toBe(false);
      expect(mockApp.altitudeVisible).toBe(true);
    });

    it("during replay updates airplane popup if open", () => {
      mockApp.altitudeVisible = false;
      mockApp.replayManager.state.active = true;
      mockApp.replayManager.state.airplaneMarker = {
        isPopupOpen: vi.fn(() => true),
      };

      uiToggles.toggleAltitude();

      expect(
        mockApp.replayManager.updateReplayAirplanePopup,
      ).toHaveBeenCalled();
    });

    it("during replay delegates redraw to replayManager", () => {
      mockApp.altitudeVisible = false;
      mockApp.replayManager.state.active = true;

      uiToggles.toggleAltitude();

      expect(mockApp.replayManager.redrawReplayPath).toHaveBeenCalledWith(
        "altitude",
      );
      expect(mockApp.map!.addLayer).not.toHaveBeenCalled();
    });
  });

  describe("toggleAirspeed", () => {
    it("shows airspeed and hides altitude when altitude is visible", () => {
      mockApp.airspeedVisible = false;
      mockApp.altitudeVisible = true;

      uiToggles.toggleAirspeed();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.altitudeLayer,
      );
      expect(mockApp.altitudeVisible).toBe(false);
      expect(el("altitude-btn").style.opacity).toBe("0.5");
      expect(el("altitude-legend").style.display).toBe("none");

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.airspeedLayer);
      expect(mockApp.airspeedVisible).toBe(true);
      expect(el("airspeed-btn").style.opacity).toBe("1");
      expect(el("airspeed-legend").style.display).toBe("block");
      expect(mockApp.layerManager.redrawAirspeedPaths).toHaveBeenCalled();
    });

    it("hides airspeed when visible", () => {
      mockApp.airspeedVisible = true;

      uiToggles.toggleAirspeed();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.airspeedLayer,
      );
      expect(mockApp.airspeedVisible).toBe(false);
      expect(el("airspeed-btn").style.opacity).toBe("0.5");
      expect(el("airspeed-legend").style.display).toBe("none");
    });

    it("shows airspeed without altitude conflict", () => {
      uiToggles.toggleAirspeed();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.airspeedLayer);
      expect(mockApp.airspeedVisible).toBe(true);
      expect(mockApp.layerManager.redrawAirspeedPaths).toHaveBeenCalled();
    });

    it("does nothing without a map", () => {
      mockApp.map = null;

      uiToggles.toggleAirspeed();

      expect(mockApp.airspeedVisible).toBe(false);
    });

    it("prevents hiding airspeed during replay if altitude is also hidden", () => {
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;
      mockApp.replayManager.state.active = true;

      uiToggles.toggleAirspeed();

      expect(mockApp.airspeedVisible).toBe(true);
      expect(mockApp.map!.removeLayer).not.toHaveBeenCalled();
    });

    it("during replay does not add layer but updates state", () => {
      mockApp.replayManager.state.active = true;

      uiToggles.toggleAirspeed();

      expect(mockApp.map!.addLayer).not.toHaveBeenCalled();
      expect(mockApp.layerManager.redrawAirspeedPaths).not.toHaveBeenCalled();
      expect(mockApp.airspeedVisible).toBe(true);
      expect(el("airspeed-legend").style.display).toBe("block");
    });

    it("during replay updates airplane popup if open", () => {
      mockApp.replayManager.state.active = true;
      mockApp.replayManager.state.airplaneMarker = {
        isPopupOpen: vi.fn(() => true),
      };

      uiToggles.toggleAirspeed();

      expect(
        mockApp.replayManager.updateReplayAirplanePopup,
      ).toHaveBeenCalled();
    });

    it("during replay delegates redraw to replayManager", () => {
      mockApp.replayManager.state.active = true;

      uiToggles.toggleAirspeed();

      expect(mockApp.replayManager.redrawReplayPath).toHaveBeenCalledWith(
        "airspeed",
      );
      expect(mockApp.map!.addLayer).not.toHaveBeenCalled();
    });
  });

  describe("toggleAirports", () => {
    it("hides airports when visible", () => {
      mockApp.airportsVisible = true;

      uiToggles.toggleAirports();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.airportLayer,
      );
      expect(mockApp.airportsVisible).toBe(false);
      expect(el("airports-btn").style.opacity).toBe("0.5");
      expect(el("airports-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("shows airports when hidden", () => {
      mockApp.airportsVisible = false;

      uiToggles.toggleAirports();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.airportLayer);
      expect(mockApp.airportsVisible).toBe(true);
      expect(el("airports-btn").style.opacity).toBe("1");
      expect(el("airports-btn").getAttribute("aria-pressed")).toBe("true");
    });

    it("does nothing without a map", () => {
      mockApp.map = null;

      uiToggles.toggleAirports();

      expect(mockApp.airportsVisible).toBe(true);
    });
  });

  describe("toggleAviation", () => {
    it("shows aviation layer when hidden and API key is set", () => {
      mockApp.config.openaipApiKey = "test-key";
      mockApp.openaipLayers["Aviation Data"] = {};
      mockApp.aviationVisible = false;

      uiToggles.toggleAviation();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(
        mockApp.openaipLayers["Aviation Data"],
      );
      expect(mockApp.aviationVisible).toBe(true);
      expect(el("aviation-btn").getAttribute("aria-pressed")).toBe("true");
    });

    it("hides aviation layer when visible", () => {
      mockApp.config.openaipApiKey = "test-key";
      mockApp.openaipLayers["Aviation Data"] = {};
      mockApp.aviationVisible = true;

      uiToggles.toggleAviation();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.openaipLayers["Aviation Data"],
      );
      expect(mockApp.aviationVisible).toBe(false);
      expect(el("aviation-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("does nothing when no API key is set", () => {
      mockApp.config.openaipApiKey = "";
      mockApp.aviationVisible = false;

      uiToggles.toggleAviation();

      expect(mockApp.map!.addLayer).not.toHaveBeenCalled();
      expect(mockApp.aviationVisible).toBe(false);
    });

    it("does nothing without a map", () => {
      mockApp.map = null;
      mockApp.config.openaipApiKey = "test-key";

      uiToggles.toggleAviation();

      expect(mockApp.aviationVisible).toBe(false);
    });
  });

  describe("toggleButtonsVisibility", () => {
    let toggleableButtons: HTMLElement[];

    beforeEach(() => {
      toggleableButtons = [];
      for (let i = 0; i < 3; i++) {
        const btn = document.createElement("button");
        btn.classList.add("toggleable-btn");
        document.body.appendChild(btn);
        toggleableButtons.push(btn);
      }
    });

    // The DOM is updated by the store subscriber that MapApp installs; see
    // "restores hidden buttons from the store" in mapApp.initialize.test.ts
    it("hides buttons when they are visible", () => {
      mockApp.buttonsHidden = false;

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.buttonsHidden).toBe(true);
    });

    it("shows buttons when they are hidden", () => {
      mockApp.buttonsHidden = true;
      toggleableButtons.forEach((btn) => btn.classList.add("buttons-hidden"));

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.buttonsHidden).toBe(false);
    });

    it("does not redraw paths (button visibility does not affect rendering)", () => {
      mockApp.altitudeVisible = true;
      mockApp.airspeedVisible = true;

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(mockApp.layerManager.redrawAirspeedPaths).not.toHaveBeenCalled();
    });

    it("works without the hide button element", () => {
      el("hide-buttons-btn").remove();

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.buttonsHidden).toBe(true);
    });
  });

  describe("loadDomToImage", () => {
    it("resolves immediately when dom-to-image is already loaded", async () => {
      const lib = { toJpeg: vi.fn() } as unknown as DomToImage;
      window.domtoimage = lib;
      const appendSpy = vi.spyOn(document.head, "appendChild");

      await expect(loadDomToImage()).resolves.toBe(lib);
      expect(appendSpy).not.toHaveBeenCalled();
    });

    it("injects the script with SRI and resolves once it loads", async () => {
      const lib = { toJpeg: vi.fn() } as unknown as DomToImage;
      let script: HTMLScriptElement | null = null;
      vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
        script = node as HTMLScriptElement;
        window.domtoimage = lib;
        queueMicrotask(() => script?.onload?.(new Event("load")));
        return node;
      });

      await expect(loadDomToImage()).resolves.toBe(lib);
      expect(script!.src).toBe(DOM_TO_IMAGE_URL);
      expect(script!.integrity).toBe(DOM_TO_IMAGE_INTEGRITY);
      expect(script!.crossOrigin).toBe("anonymous");
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
        .mockImplementation((node) => {
          queueMicrotask(() =>
            (node as HTMLScriptElement).onerror?.(new Event("error")),
          );
          return node;
        });

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

    it("disables the button and hides the replay and share buttons while exporting", () => {
      installDomToImage();
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();

      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe("⏳ Exporting...");
      expect(el("replay-btn").style.display).toBe("none");
      expect(el("share-btn").style.display).toBe("none");
      expect(el("stats-btn").style.display).toBe("none");
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
      expect(btn.textContent).toBe("📷 Export");
      expect(el("replay-btn").style.display).toBe("");
      expect(el("share-btn").style.display).toBe("");
    });

    it("caps the scale at 1 on small devices", async () => {
      setInnerWidth(500);
      const toJpeg = installDomToImage();

      uiToggles.exportMap();
      await finishExport();

      expect(toJpeg).toHaveBeenCalledWith(
        el("map"),
        expect.objectContaining({ width: 800, height: 600 }),
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

    it("shows an error toast and restores the buttons when dom-to-image is unavailable", async () => {
      vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
        queueMicrotask(() =>
          (node as HTMLScriptElement).onerror?.(new Event("error")),
        );
        return node;
      });
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(toast()?.textContent).toBe("Export unavailable");
      expect(toast()?.classList.contains("toast-error")).toBe(true);
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe("📷 Export");
      expect(el("replay-btn").style.display).toBe("");
      expect(el("share-btn").style.display).toBe("");
      expect(clickSpy).not.toHaveBeenCalled();
    });

    it("restores controls and shows a toast on dom-to-image failure", async () => {
      installDomToImage(vi.fn().mockRejectedValue(new Error("Export failed")));
      const btn = el("export-btn") as HTMLButtonElement;

      uiToggles.exportMap();
      await finishExport();

      expect(toast()?.textContent).toBe("Export failed: Export failed");
      expect(toast()?.classList.contains("toast-error")).toBe(true);
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe("📷 Export");
      expect(el("replay-btn").style.display).toBe("");
    });
  });

  describe("shareLink", () => {
    it("uses the native share sheet when available", async () => {
      const share = vi.fn().mockResolvedValue(undefined);
      defineNavigatorProperty("share", share);

      await uiToggles.shareLink();

      expect(mockApp.stateManager.saveMapState).toHaveBeenCalled();
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
      expect(toast()?.getAttribute("role")).toBe("status");
    });

    it("shows an error toast when the clipboard is unavailable", async () => {
      await uiToggles.shareLink();

      expect(toast()?.textContent).toBe("Could not copy link");
      expect(toast()?.classList.contains("toast-error")).toBe(true);
    });

    it("is triggered by the share button", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      defineNavigatorProperty("clipboard", { writeText });

      el("share-btn").click();
      await Promise.resolve();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledWith(window.location.href);
    });
  });
});
