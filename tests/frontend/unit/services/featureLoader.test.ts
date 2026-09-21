/**
 * The lazily loaded feature bundle and the stylesheet that goes with it.
 *
 * Replay and Wrapped are a quarter of the frontend and most visits open
 * neither, so they are fetched on first use. A failure has to leave the rest
 * of the map working, and two callers arriving at once must not fetch twice.
 * Both files have to arrive: a panel drawn without its stylesheet is worse
 * than the toast a failed load produces.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FEATURES_CSS_URL,
  FEATURES_URL,
  loadFeatures,
  resetFeatureLoader,
} from "../../../../kml_heatmap/frontend/services/featureLoader";
import { logError } from "../../../../kml_heatmap/frontend/utils/logger";

vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

const loadScript = vi.hoisted(() => vi.fn());
const loadStylesheet = vi.hoisted(() => vi.fn());
vi.mock("../../../../kml_heatmap/frontend/services/dataLoader", () => ({
  loadScript,
  loadStylesheet,
}));

const features = {
  ReplayManager: vi.fn(),
  WrappedManager: vi.fn(),
  listFlights: vi.fn(),
};

/** A script load that publishes the bundle's exports, as the real one does */
function bundleArrives(): void {
  loadScript.mockImplementation(() => {
    window.KMLFeatures = features;
    return Promise.resolve();
  });
}

describe("loadFeatures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFeatureLoader();
    delete window.KMLFeatures;
    loadStylesheet.mockResolvedValue(undefined);
  });

  it("fetches the bundle next to the page and returns its exports", async () => {
    bundleArrives();

    await expect(loadFeatures()).resolves.toBe(features);
    expect(loadScript).toHaveBeenCalledWith(FEATURES_URL, expect.any(Number));
    // Relative URLs, so the page works from file:// too
    expect(FEATURES_URL.startsWith("./")).toBe(true);
    expect(FEATURES_CSS_URL.startsWith("./")).toBe(true);
  });

  it("fetches the stylesheet alongside the bundle", async () => {
    bundleArrives();

    await loadFeatures();

    expect(loadStylesheet).toHaveBeenCalledWith(
      FEATURES_CSS_URL,
      expect.any(Number),
    );
  });

  it("does not fetch again once both have arrived", async () => {
    bundleArrives();
    await loadFeatures();
    vi.clearAllMocks();

    await expect(loadFeatures()).resolves.toBe(features);

    expect(loadScript).not.toHaveBeenCalled();
    expect(loadStylesheet).not.toHaveBeenCalled();
  });

  it("resolves with null and reports when the stylesheet cannot be loaded", async () => {
    bundleArrives();
    loadStylesheet.mockRejectedValue(new Error("offline"));

    await expect(loadFeatures()).resolves.toBeNull();

    expect(logError).toHaveBeenCalled();
  });

  it("fetches both again when only the stylesheet failed", async () => {
    // The script ran, so window.KMLFeatures is set even though the load as a
    // whole failed; the next attempt must not take that for a finished load
    bundleArrives();
    loadStylesheet.mockRejectedValueOnce(new Error("offline"));
    await expect(loadFeatures()).resolves.toBeNull();
    expect(window.KMLFeatures).toBe(features);

    await expect(loadFeatures()).resolves.toBe(features);

    expect(loadScript).toHaveBeenCalledTimes(2);
    expect(loadStylesheet).toHaveBeenCalledTimes(2);
  });

  it("shares one request between callers that arrive together", async () => {
    let settle: () => void = () => {};
    loadScript.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = () => {
            window.KMLFeatures = features;
            resolve();
          };
        }),
    );

    const both = Promise.all([loadFeatures(), loadFeatures()]);
    settle();

    expect(await both).toEqual([features, features]);
    expect(loadScript).toHaveBeenCalledTimes(1);
  });

  it("resolves with null and reports when the bundle cannot be loaded", async () => {
    loadScript.mockRejectedValue(new Error("offline"));

    await expect(loadFeatures()).resolves.toBeNull();

    expect(logError).toHaveBeenCalled();
  });

  it("resolves with null when the bundle defines no exports", async () => {
    loadScript.mockResolvedValue(undefined);

    await expect(loadFeatures()).resolves.toBeNull();
  });

  it("tries again after a failure instead of caching it", async () => {
    loadScript.mockRejectedValueOnce(new Error("offline"));
    await expect(loadFeatures()).resolves.toBeNull();

    bundleArrives();

    await expect(loadFeatures()).resolves.toBe(features);
    expect(loadScript).toHaveBeenCalledTimes(2);
  });
});
