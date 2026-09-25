/**
 * The lazily loaded bundles and the stylesheets that go with them.
 *
 * Replay and Wrapped are a quarter of the frontend and most visits open
 * neither, so each is fetched on first use, from a bundle of its own. A
 * failure has to leave the rest of the map working, and two callers arriving
 * at once must not fetch twice. Both files have to arrive: a panel drawn
 * without its stylesheet is worse than the toast a failed load produces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  FEATURES_CSS_URL,
  WRAPPED_CSS_URL,
  loadFeatures,
  loadWrapped,
  resetFeatureLoader,
  resetWrappedLoader,
} from "../../../../kml_heatmap/frontend/services/featureLoader";
import type { FeatureModule } from "../../../../kml_heatmap/frontend/features";
import type { WrappedModule } from "../../../../kml_heatmap/frontend/wrapped";
import { logError } from "../../../../kml_heatmap/frontend/utils/logger";

vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

const loadStylesheet = vi.hoisted(() => vi.fn());
vi.mock("../../../../kml_heatmap/frontend/services/stylesheet", () => ({
  loadStylesheet,
}));

const features = {
  ReplayManager: vi.fn(),
  listFlights: vi.fn(),
  followTerrain: vi.fn(),
  followHeatCloud: vi.fn(),
} as unknown as FeatureModule;

const wrapped = {
  WrappedManager: vi.fn(),
} as unknown as WrappedModule;

/** Stands in for `import("../features")` */
const importFeatures =
  vi.fn<(failedImports: number) => Promise<FeatureModule>>();

/** Stands in for `import("../wrapped")` */
const importWrapped =
  vi.fn<(failedImports: number) => Promise<WrappedModule>>();

describe("loadFeatures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFeatureLoader(importFeatures);
    importFeatures.mockResolvedValue(features);
    loadStylesheet.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("imports the bundle and returns its exports", async () => {
    await expect(loadFeatures()).resolves.toBe(features);
    expect(importFeatures).toHaveBeenCalledTimes(1);
  });

  it("fetches the stylesheet alongside the bundle", async () => {
    await loadFeatures();

    expect(loadStylesheet).toHaveBeenCalledWith(
      FEATURES_CSS_URL,
      expect.any(Number),
    );
    // Relative to the page, which is not at the root of its host
    expect(FEATURES_CSS_URL.startsWith("./")).toBe(true);
  });

  it("does not fetch again once both have arrived", async () => {
    await loadFeatures();
    vi.clearAllMocks();

    await expect(loadFeatures()).resolves.toBe(features);

    expect(importFeatures).not.toHaveBeenCalled();
    expect(loadStylesheet).not.toHaveBeenCalled();
  });

  it("resolves with null and reports when the stylesheet cannot be loaded", async () => {
    loadStylesheet.mockRejectedValue(new Error("offline"));

    await expect(loadFeatures()).resolves.toBeNull();

    expect(logError).toHaveBeenCalled();
  });

  it("fetches both again when only the stylesheet failed", async () => {
    // The import succeeded even though the load as a whole failed; the next
    // attempt must not take that for a finished load
    loadStylesheet.mockRejectedValueOnce(new Error("offline"));
    await expect(loadFeatures()).resolves.toBeNull();

    await expect(loadFeatures()).resolves.toBe(features);

    expect(importFeatures).toHaveBeenCalledTimes(2);
    expect(loadStylesheet).toHaveBeenCalledTimes(2);
  });

  it("shares one request between callers that arrive together", async () => {
    let settle: () => void = () => {};
    importFeatures.mockImplementation(
      () =>
        new Promise<FeatureModule>((resolve) => {
          settle = () => resolve(features);
        }),
    );

    const both = Promise.all([loadFeatures(), loadFeatures()]);
    settle();

    expect(await both).toEqual([features, features]);
    expect(importFeatures).toHaveBeenCalledTimes(1);
  });

  it("resolves with null and reports when the bundle cannot be loaded", async () => {
    importFeatures.mockRejectedValue(new Error("offline"));

    await expect(loadFeatures()).resolves.toBeNull();

    expect(logError).toHaveBeenCalled();
  });

  it("gives up on an import that never settles", async () => {
    vi.useFakeTimers();
    importFeatures.mockImplementation(() => new Promise(() => {}));

    const result = loadFeatures();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toBeNull();
    expect(logError).toHaveBeenCalled();
  });

  it("tries again after a failure, under a URL the browser has not failed on", async () => {
    // A browser may answer a second import() of a URL that failed with the
    // same failure, so every retry has to say how many went wrong before
    importFeatures.mockRejectedValueOnce(new Error("offline"));
    importFeatures.mockRejectedValueOnce(new Error("still offline"));
    await expect(loadFeatures()).resolves.toBeNull();
    await expect(loadFeatures()).resolves.toBeNull();

    await expect(loadFeatures()).resolves.toBe(features);

    expect(importFeatures.mock.calls).toEqual([[0], [1], [2]]);
  });

  it("asks for the same URL again after a timeout, which may yet finish", async () => {
    vi.useFakeTimers();
    importFeatures.mockImplementationOnce(() => new Promise(() => {}));
    const first = loadFeatures();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toBeNull();

    await expect(loadFeatures()).resolves.toBe(features);

    expect(importFeatures.mock.calls).toEqual([[0], [0]]);
  });

  it("does not count a failed stylesheet as a failed import", async () => {
    loadStylesheet.mockRejectedValueOnce(new Error("offline"));
    await expect(loadFeatures()).resolves.toBeNull();

    await loadFeatures();

    expect(importFeatures.mock.calls).toEqual([[0], [0]]);
  });
});

describe("loadWrapped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFeatureLoader(importFeatures);
    resetWrappedLoader(importWrapped);
    importFeatures.mockResolvedValue(features);
    importWrapped.mockResolvedValue(wrapped);
    loadStylesheet.mockResolvedValue(undefined);
  });

  it("imports its own bundle and stylesheet, not the feature bundle's", async () => {
    await expect(loadWrapped()).resolves.toBe(wrapped);

    expect(importWrapped).toHaveBeenCalledTimes(1);
    expect(loadStylesheet).toHaveBeenCalledTimes(1);
    expect(loadStylesheet).toHaveBeenCalledWith(
      WRAPPED_CSS_URL,
      expect.any(Number),
    );
    expect(WRAPPED_CSS_URL.startsWith("./")).toBe(true);
    // Opening Wrapped says nothing about replay
    expect(importFeatures).not.toHaveBeenCalled();
  });

  it("is loaded apart from the feature bundle", async () => {
    await loadFeatures();
    vi.clearAllMocks();

    // The feature bundle having arrived does not make Wrapped loaded ...
    await expect(loadWrapped()).resolves.toBe(wrapped);
    expect(importWrapped).toHaveBeenCalledTimes(1);

    // ... and Wrapped having arrived does not fetch the features again
    await loadFeatures();
    expect(importFeatures).not.toHaveBeenCalled();
  });

  it("does not fetch again once both have arrived", async () => {
    await loadWrapped();
    vi.clearAllMocks();

    await expect(loadWrapped()).resolves.toBe(wrapped);

    expect(importWrapped).not.toHaveBeenCalled();
    expect(loadStylesheet).not.toHaveBeenCalled();
  });

  it("shares one request between callers that arrive together", async () => {
    let settle: () => void = () => {};
    importWrapped.mockImplementation(
      () =>
        new Promise<WrappedModule>((resolve) => {
          settle = () => resolve(wrapped);
        }),
    );

    const both = Promise.all([loadWrapped(), loadWrapped()]);
    settle();

    expect(await both).toEqual([wrapped, wrapped]);
    expect(importWrapped).toHaveBeenCalledTimes(1);
  });

  it("resolves with null and reports when the stylesheet cannot be loaded", async () => {
    loadStylesheet.mockRejectedValueOnce(new Error("offline"));

    await expect(loadWrapped()).resolves.toBeNull();

    expect(logError).toHaveBeenCalled();
    // The next attempt fetches both again, under the same bundle URL
    await expect(loadWrapped()).resolves.toBe(wrapped);
    expect(importWrapped.mock.calls).toEqual([[0], [0]]);
  });

  it("tries again after a failure, under a URL the browser has not failed on", async () => {
    importWrapped.mockRejectedValueOnce(new Error("offline"));
    importWrapped.mockRejectedValueOnce(new Error("still offline"));
    await expect(loadWrapped()).resolves.toBeNull();
    await expect(loadWrapped()).resolves.toBeNull();

    await expect(loadWrapped()).resolves.toBe(wrapped);

    expect(importWrapped.mock.calls).toEqual([[0], [1], [2]]);
    // A failed Wrapped counts nothing against the feature bundle
    await loadFeatures();
    expect(importFeatures.mock.calls).toEqual([[0]]);
  });
});
