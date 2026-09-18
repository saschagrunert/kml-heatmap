/**
 * The lazily loaded feature bundle.
 *
 * Replay and Wrapped are a quarter of the frontend and most visits open
 * neither, so they are fetched on first use. A failure has to leave the rest
 * of the map working, and two callers arriving at once must not fetch twice.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
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
vi.mock("../../../../kml_heatmap/frontend/services/dataLoader", () => ({
  loadScript,
}));

const features = { ReplayManager: vi.fn(), WrappedManager: vi.fn() };

describe("loadFeatures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFeatureLoader();
    delete window.KMLFeatures;
  });

  it("fetches the bundle next to the page and returns its exports", async () => {
    loadScript.mockImplementation(() => {
      window.KMLFeatures = features;
      return Promise.resolve();
    });

    await expect(loadFeatures()).resolves.toBe(features);
    expect(loadScript).toHaveBeenCalledWith(FEATURES_URL, expect.any(Number));
    // A relative URL, so the page works from file:// too
    expect(FEATURES_URL.startsWith("./")).toBe(true);
  });

  it("does not fetch again once the bundle is there", async () => {
    window.KMLFeatures = features;

    await expect(loadFeatures()).resolves.toBe(features);

    expect(loadScript).not.toHaveBeenCalled();
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

    loadScript.mockImplementation(() => {
      window.KMLFeatures = features;
      return Promise.resolve();
    });

    await expect(loadFeatures()).resolves.toBe(features);
    expect(loadScript).toHaveBeenCalledTimes(2);
  });
});
