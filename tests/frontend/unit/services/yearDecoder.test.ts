import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createYearDecoder } from "../../../../kml_heatmap/frontend/services/yearDecoder";
import { expandYearData } from "../../../../kml_heatmap/frontend/services/yearDecode";
import { logError } from "../../../../kml_heatmap/frontend/utils/logger";
import {
  dataset,
  FakeYearWorker,
  path,
  rawYear,
  yearBytes,
} from "../../yearFixtures";

vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

const year = rawYear(
  2025,
  { "1": path([50, 8], [[50.1, 8.1, 500, 100]]) },
  [{ id: 1 }],
  2,
);
const expanded = expandYearData(year);

describe("createYearDecoder", () => {
  let worker: FakeYearWorker;
  const createWorker = vi.fn(() => worker.asWorker());

  beforeEach(() => {
    worker = new FakeYearWorker();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts one worker, at once, and asks it for every year", async () => {
    const decoder = createYearDecoder({ createWorker });
    expect(createWorker).toHaveBeenCalledTimes(1);

    const [first, second] = await Promise.all([
      decoder.decode(yearBytes(year)),
      decoder.decode(yearBytes(year)),
    ]);

    expect(first).toEqual(expanded);
    expect(second).toEqual(expanded);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.requests.map((request) => request.id)).toEqual([0, 1]);
    expect(logError).not.toHaveBeenCalled();
  });

  it("keeps the bytes it sent, so that they can be decoded here after all", async () => {
    const decoder = createYearDecoder({ createWorker });
    const bytes = yearBytes(year);
    const postMessage = vi.spyOn(worker, "postMessage");

    await decoder.decode(bytes);

    // No transfer list: a transferred buffer would be empty on this side
    expect(postMessage).toHaveBeenCalledWith({ id: 0, bytes });
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("warns about the broken paths the worker reports", async () => {
    const broken = path([50, 8], [[50.1, 8.1, 500, 100]]);
    (broken.columns[0] as unknown[])[0] = "x";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const decoder = createYearDecoder({ createWorker });

    const data = await decoder.decode(
      yearBytes(rawYear(2025, { "1": broken })),
    );

    expect(data.path_segments).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Path 1: row 0 is not numeric, dropped the rest",
    );
    warn.mockRestore();
  });

  it("combines years like combineYearData", () => {
    const decoder = createYearDecoder({ createWorker });

    expect(decoder.combine([dataset(2), null]).path_segments).toHaveLength(2);
  });

  describe("fallback to the main thread", () => {
    it("decodes here where there are no workers", async () => {
      vi.stubGlobal("Worker", undefined);
      const decoder = createYearDecoder();

      await expect(decoder.decode(yearBytes(year))).resolves.toEqual(expanded);
      expect(logError).toHaveBeenCalledWith(
        "Year worker failed, decoding on the main thread:",
        expect.any(Error),
      );
    });

    it("starts the worker from the URL of its own module", () => {
      const WorkerStub = vi.fn(function () {
        return worker;
      });
      vi.stubGlobal("Worker", WorkerStub);

      createYearDecoder();

      expect(WorkerStub).toHaveBeenCalledWith(
        expect.stringMatching(/yearDecoder/),
        { type: "module" },
      );
    });

    it("decodes here once the worker reports an error, the years it still owed included", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const owed = decoder.decode(yearBytes(year));

      worker.emit("error", { message: "script did not load" });

      await expect(owed).resolves.toEqual(expanded);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(
        "Year worker failed, decoding on the main thread:",
        "script did not load",
      );
      // Not asked again for the rest of the visit
      await expect(decoder.decode(yearBytes(year))).resolves.toEqual(expanded);
      expect(worker.requests).toHaveLength(1);
      expect(createWorker).toHaveBeenCalledTimes(1);
    });

    it("gives up on the worker once, however many errors it reports", () => {
      const decoder = createYearDecoder({ createWorker });

      worker.emit("error", { message: "first" });
      worker.emit("messageerror", {});

      expect(logError).toHaveBeenCalledTimes(1);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      decoder.destroy();
    });

    it("decodes here when an answer cannot be read", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const owed = decoder.decode(yearBytes(year));

      worker.emit("messageerror", {});

      await expect(owed).resolves.toEqual(expanded);
    });

    it("decodes here when the request cannot be posted", async () => {
      vi.spyOn(worker, "postMessage").mockImplementation(() => {
        throw new Error("DataCloneError");
      });
      const decoder = createYearDecoder({ createWorker });

      await expect(decoder.decode(yearBytes(year))).resolves.toEqual(expanded);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it("decodes here when the worker does not answer in time", async () => {
      vi.useFakeTimers();
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker, timeoutMs: 1000 });
      const owed = decoder.decode(yearBytes(year));

      await vi.advanceTimersByTimeAsync(999);
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(owed).resolves.toEqual(expanded);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("waits half a minute for an answer by default", async () => {
      vi.useFakeTimers();
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const owed = decoder.decode(yearBytes(year));

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(owed).resolves.toEqual(expanded);
    });

    it("decodes a year the worker failed over again, and keeps the worker", async () => {
      const decoder = createYearDecoder({ createWorker });
      const bad = decoder.decode(yearBytes({ format: -1 }));

      // The error itself, not the text the worker sent
      await expect(bad).rejects.toThrow(/another release/);
      expect(logError).toHaveBeenCalledWith(
        "Year worker could not decode:",
        expect.stringContaining("another release"),
      );
      expect(worker.terminate).not.toHaveBeenCalled();
      await expect(decoder.decode(yearBytes(year))).resolves.toEqual(expanded);
      expect(worker.requests).toHaveLength(2);
    });

    it("decodes here when the worker failed over a file that is fine", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const owed = decoder.decode(yearBytes(year));

      worker.say({ id: 0, error: "out of memory" });

      await expect(owed).resolves.toEqual(expanded);
    });
  });

  describe("requests that are given up on", () => {
    it("clears the timer of a year that was answered", async () => {
      vi.useFakeTimers();
      const decoder = createYearDecoder({ createWorker });

      await decoder.decode(yearBytes(year));

      expect(vi.getTimerCount()).toBe(0);
    });

    it("ignores an answer nobody waits for", async () => {
      const decoder = createYearDecoder({ createWorker });
      await decoder.decode(yearBytes(year));

      expect(() => worker.answer(worker.requests[0]!)).not.toThrow();
      expect(() => worker.say({ id: 99, error: "stray" })).not.toThrow();
      expect(logError).not.toHaveBeenCalled();
    });

    it("ends the worker and every wait with the app", async () => {
      vi.useFakeTimers();
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const first = decoder.decode(yearBytes(year));
      const second = decoder.decode(yearBytes(year));

      decoder.destroy();

      await expect(first).rejects.toThrow("year decoder destroyed");
      await expect(second).rejects.toThrow("year decoder destroyed");
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      // Nothing left that holds on to the requests or their bytes
      expect(vi.getTimerCount()).toBe(0);
      // A late error of the worker starts no decoding on the main thread
      worker.emit("error", { message: "late" });
      expect(logError).not.toHaveBeenCalled();
    });

    it("decodes nothing after the app has ended", async () => {
      const decoder = createYearDecoder({ createWorker });

      decoder.destroy();

      await expect(decoder.decode(yearBytes(year))).rejects.toThrow(
        "year decoder destroyed",
      );
      expect(worker.requests).toEqual([]);
    });
  });
});
