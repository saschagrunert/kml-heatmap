import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createYearDecoder } from "../../../../kml_heatmap/frontend/services/yearDecoder";
import {
  DATA_FORMAT_VERSION,
  expandYearData,
} from "../../../../kml_heatmap/frontend/services/yearDecode";
import { logError } from "../../../../kml_heatmap/frontend/utils/logger";
import { drawHeat } from "../../../../kml_heatmap/frontend/services/heatSource";
import { heatColumns } from "../../../../kml_heatmap/frontend/calculations/heatExposure";
import { flatCurves } from "../../../../kml_heatmap/frontend/calculations/curves";
import {
  heatLineFeatures,
  heatWeight,
} from "../../../../kml_heatmap/frontend/calculations/heatLines";
import { createSegment } from "../../testHelpers";
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

    it("waits for a queue the worker works through, one answer at a time", async () => {
      vi.useFakeTimers();
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker, timeoutMs: 1000 });
      const first = decoder.decode(yearBytes(year));
      const second = decoder.decode(yearBytes(year));

      await vi.advanceTimersByTimeAsync(900);
      worker.answer(worker.requests[0]!);
      await vi.advanceTimersByTimeAsync(900);
      expect(worker.terminate).not.toHaveBeenCalled();
      worker.answer(worker.requests[1]!);

      await expect(first).resolves.toEqual(expanded);
      await expect(second).resolves.toEqual(expanded);
      expect(worker.terminate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("gives up on a queue when no answer comes for the whole wait", async () => {
      vi.useFakeTimers();
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker, timeoutMs: 1000 });
      const first = decoder.decode(yearBytes(year));
      await vi.advanceTimersByTimeAsync(500);
      const second = decoder.decode(yearBytes(year));

      // A later request does not put the deadline off
      await vi.advanceTimersByTimeAsync(500);

      expect(worker.terminate).toHaveBeenCalledTimes(1);
      await expect(first).resolves.toEqual(expanded);
      await expect(second).resolves.toEqual(expanded);
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
      const bad = decoder.decode(yearBytes(null));

      // The error itself, not the text the worker sent
      await expect(bad).rejects.toThrow(/expected an object/);
      expect(logError).toHaveBeenCalledWith(
        "Year worker could not decode:",
        expect.stringContaining("expected an object"),
      );
      expect(worker.terminate).not.toHaveBeenCalled();
      await expect(decoder.decode(yearBytes(year))).resolves.toEqual(expanded);
      expect(worker.requests).toHaveLength(2);
    });

    it("takes a file of another release from the worker, without reading it again", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      // Bytes the page could read: it does not, as the worker's answer is
      // the file's, which only another release would read
      const stale = decoder.decode(yearBytes(year));

      worker.say({
        id: 0,
        error: "format 5, expected 6; written by another release",
        name: "StaleDataError",
        format: DATA_FORMAT_VERSION,
      });

      await expect(stale).rejects.toMatchObject({
        name: "StaleDataError",
        message: expect.stringContaining("another release") as string,
      });
      expect(logError).not.toHaveBeenCalled();
    });

    it("decodes here when a worker of another deploy calls the file stale", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      // The worker's script is newer than the page and its year file
      const owed = decoder.decode(yearBytes(year));

      worker.say({
        id: 0,
        error: "written by another release",
        name: "StaleDataError",
        format: DATA_FORMAT_VERSION + 1,
      });

      await expect(owed).resolves.toEqual(expanded);
      expect(logError).toHaveBeenCalledWith(
        "Year worker could not decode:",
        "written by another release",
      );
    });

    it("decodes here when the worker failed over a file that is fine", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const owed = decoder.decode(yearBytes(year));

      worker.say({
        id: 0,
        error: "out of memory",
        name: "RangeError",
        format: DATA_FORMAT_VERSION,
      });

      await expect(owed).resolves.toEqual(expanded);
    });
  });

  describe("the heat sources", () => {
    const points: [number, number][] = [
      [50, 8],
      [50.01, 8.01],
      [50.02, 8.02],
    ];
    const weights = [1, 2, 0.5];
    const segments = [0, 1, 2].map((i) =>
      createSegment({
        path_id: 1,
        time: i * 4,
        coords: [
          [50 + i / 100, 8 + i / 100],
          [50 + (i + 1) / 100, 8 + (i + 1) / 100],
        ],
      }),
    );
    /** The arguments of linesSource for all of `segments` */
    const lines = (): Parameters<
      ReturnType<typeof createYearDecoder>["linesSource"]
    > => [
      flatCurves(segments),
      segments,
      () => true,
      heatWeight,
      (seconds) => seconds,
    ];

    /** Whether `drawn` is `points` drawn as drawHeat draws them */
    async function expectDrawn(
      drawn: ReturnType<typeof drawHeat>,
    ): Promise<void> {
      const expected = drawHeat(heatColumns(points, weights));
      expect(drawn.exposure).toBe(expected.exposure);
      expect(await drawn.source.text()).toBe(await expected.source.text());
    }

    it("asks the worker to draw a heat, packed here and copied, not handed over", async () => {
      const decoder = createYearDecoder({ createWorker });
      const postMessage = vi.spyOn(worker, "postMessage");

      await expectDrawn(await decoder.drawHeat(points, weights));

      const [request] = postMessage.mock.calls[0]!;
      expect(request).toEqual({ id: 0, heat: heatColumns(points, weights) });
      expect(postMessage.mock.calls[0]).toHaveLength(1);
      expect(logError).not.toHaveBeenCalled();
    });

    it("works the heat lines out here and has the worker write them", async () => {
      const decoder = createYearDecoder({ createWorker });

      const source = await decoder.linesSource(...lines());

      expect(worker.requests[0]).toMatchObject({ id: 0 });
      expect("lines" in worker.requests[0]!).toBe(true);
      expect(await source.text()).toBe(
        JSON.stringify(heatLineFeatures(segments, () => true)),
      );
    });

    it("draws and writes here where there are no workers", async () => {
      vi.stubGlobal("Worker", undefined);
      const decoder = createYearDecoder();

      await expectDrawn(await decoder.drawHeat(points, weights));
      expect(await (await decoder.linesSource(...lines())).text()).toBe(
        JSON.stringify(heatLineFeatures(segments, () => true)),
      );
    });

    it("draws here what the worker failed over, and keeps the worker", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const owed = decoder.drawHeat(points, weights);

      worker.say({
        id: 0,
        error: "out of memory",
        name: "RangeError",
        format: DATA_FORMAT_VERSION,
      });

      await expectDrawn(await owed);
      expect(logError).toHaveBeenCalledWith(
        "Year worker could not draw the heat:",
        "out of memory",
      );
      expect(worker.terminate).not.toHaveBeenCalled();
    });

    it("draws nothing after the app has ended", async () => {
      const decoder = createYearDecoder({ createWorker });

      decoder.destroy();

      await expect(decoder.drawHeat(points, weights)).rejects.toThrow(
        "year decoder destroyed",
      );
      await expect(decoder.linesSource(...lines())).rejects.toThrow(
        "year decoder destroyed",
      );
      expect(worker.requests).toEqual([]);
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
      expect(() =>
        worker.say({
          id: 99,
          error: "stray",
          name: "Error",
          format: DATA_FORMAT_VERSION,
        }),
      ).not.toThrow();
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
