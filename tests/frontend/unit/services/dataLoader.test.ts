import {
  describe,
  it,
  expect,
  afterEach,
  beforeEach,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
// jsdom has no streams; Node's are the ones its Response is built on
import {
  ReadableStream as NodeReadableStream,
  TransformStream as NodeTransformStream,
} from "node:stream/web";
import {
  combineYearData,
  DATA_FORMAT_VERSION,
  expandYearData,
  isValidYear,
  fetchJson,
  loadStylesheet,
  resetStylesheetLoader,
  DataLoader,
} from "../../../../kml_heatmap/frontend/services/dataLoader";
import {
  logDebug,
  logError,
} from "../../../../kml_heatmap/frontend/utils/logger";
import type {
  DataLoaderOptions,
  KMLDataset,
  LoadingState,
  Metadata,
  RawColumns,
  RawPathSegments,
  RawYearData,
} from "../../../../kml_heatmap/frontend/types";

// Mock logger
vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

type MockWindow = Window & typeof globalThis & Record<string, unknown>;

/**
 * Column scales of the wire format, mirroring kml_heatmap/segment_codec.py
 * (the altitude column counts hundreds of feet). The helpers below take rows
 * in the units a reader thinks in and encode them, so a test says what it
 * means and the decoder is still checked against an independent encoder.
 */
const SCALES = [1e5, 1e5, 1 / 100, 10, 10];

/** One path's exported segments, given as plain `[lat, lon, ft, kt, s?]` rows */
function path(start: [number, number], rows: number[][]): RawPathSegments {
  const scaledStart = [
    Math.round(start[0] * SCALES[0]!),
    Math.round(start[1] * SCALES[1]!),
  ];
  const running = [scaledStart[0]!, scaledStart[1]!, 0, 0, 0];
  // The time column is only written when some row has a time
  const columns: (number | null)[][] = [[], [], [], []];
  if (rows.some((row) => row.length > 4)) columns.push([]);
  for (const row of rows) {
    columns.forEach((column, index) => {
      const value = row[index];
      if (value === undefined) {
        column.push(null);
        return;
      }
      const scaled = Math.round(value * SCALES[index]!);
      column.push(scaled - running[index]!);
      running[index] = scaled;
    });
  }
  return { start: scaledStart, columns: columns as RawColumns };
}

function rawYear(
  year: number,
  segments: RawYearData["segments"],
  pathInfo: RawYearData["path_info"] = [],
  originalPoints = 0,
): RawYearData {
  return {
    format: DATA_FORMAT_VERSION,
    year,
    original_points: originalPoints,
    path_info: pathInfo,
    segments,
  };
}

function dataset(
  segmentsCount: number,
  pathIdStart = 1,
  originalPoints = segmentsCount,
): KMLDataset {
  const path_segments = Array.from({ length: segmentsCount }, (_, i) => ({
    path_id: pathIdStart + i,
    coords: [
      [50, 8],
      [50.1, 8.1],
    ] as [[number, number], [number, number]],
    altitude_ft: 1000,
    groundspeed_knots: 100,
  }));
  return {
    coordinates: path_segments.map((s) => s.coords[0]),
    path_segments,
    path_info: path_segments.map((s) => ({ id: s.path_id })),
    original_points: originalPoints,
  };
}

describe("fetchJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("fetches the URL and returns the parsed body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"a":1}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJson("data/test.json")).resolves.toEqual({ a: 1 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("data/test.json");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects on an error status, which says more than a script tag did", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("", { status: 404 })),
    );

    const failure = await fetchJson("bad.json").catch((e: unknown) => e);

    expect(failure).toEqual(new Error("Failed to load bad.json"));
    expect((failure as Error).cause).toEqual(new Error("HTTP 404"));
  });

  it("rejects when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")),
    );

    await expect(fetchJson("bad.json")).rejects.toThrow(
      "Failed to load bad.json",
    );
  });

  it("rejects on a body that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("<html>", { status: 200 })),
    );

    await expect(fetchJson("page.json")).rejects.toThrow(
      "Failed to load page.json",
    );
  });

  it("aborts a request that neither answers nor fails", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation((_url, init) => {
        signal = init!.signal!;
        return new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }),
    );

    const pending = fetchJson("stalled.json", { timeoutMs: 5000 });
    const outcome = expect(pending).rejects.toThrow(
      "Timed out loading stalled.json",
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(signal!.aborted).toBe(true);
  });

  it("does not leave the timer running once the file has loaded", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("[]")),
    );

    await fetchJson("fast.json", { timeoutMs: 10 });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fetchJson with a progress callback", () => {
  beforeEach(() => {
    vi.stubGlobal("TransformStream", NodeTransformStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const encoder = new TextEncoder();

  /** A body whose source is written out by the test */
  function streamOf(
    start: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  ): ReadableStream<Uint8Array> {
    return new NodeReadableStream<Uint8Array>({
      start,
    }) as ReadableStream<Uint8Array>;
  }

  /** A 200 whose body arrives in the given pieces */
  function chunked(chunks: Uint8Array[]): Response {
    return new Response(
      streamOf((controller) => {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      }),
    );
  }

  function stubFetch(response: Response): void {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
  }

  it("reports every chunk, ending at the size of the body", async () => {
    const body = JSON.stringify({ name: "Zürich", values: [1, 2, 3] });
    const bytes = encoder.encode(body);
    // The second cut falls inside the two bytes of the ü, which only a
    // decoder that carries state across chunks puts back together
    const cut = bytes.indexOf(0xc3) + 1;
    stubFetch(
      chunked([bytes.slice(0, 5), bytes.slice(5, cut), bytes.slice(cut)]),
    );
    const onProgress = vi.fn<(loadedBytes: number) => void>();

    const parsed = await fetchJson("data/2025/data.json", { onProgress });

    expect(parsed).toEqual({ name: "Zürich", values: [1, 2, 3] });
    const reported = onProgress.mock.calls.map(([loaded]) => loaded);
    expect(reported).toEqual([5, cut, bytes.length]);
    // Bytes, not characters: the ü counts twice
    expect(bytes.length).toBe(body.length + 1);
  });

  it("reports nothing for an empty body, and fails on parsing it", async () => {
    stubFetch(chunked([]));
    const onProgress = vi.fn();

    await expect(fetchJson("empty.json", { onProgress })).rejects.toThrow(
      "Failed to load empty.json",
    );
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("parses a response without a body stream, reporting nothing", async () => {
    const response = new Response('{"a":1}');
    Object.defineProperty(response, "body", { value: null });
    stubFetch(response);
    const onProgress = vi.fn();

    await expect(fetchJson("a.json", { onProgress })).resolves.toEqual({
      a: 1,
    });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("rejects on a body that is not JSON", async () => {
    stubFetch(chunked([encoder.encode("<html>")]));

    const failure = await fetchJson("page.json", { onProgress: vi.fn() }).catch(
      (e: unknown) => e,
    );

    expect(failure).toEqual(new Error("Failed to load page.json"));
    // Thrown by the parser of Node's Response, whose SyntaxError is not
    // the one of this realm
    expect(((failure as Error).cause as Error).name).toBe("SyntaxError");
  });

  it("parses the body natively where streams cannot be transformed", async () => {
    // jsdom has none of its own, so taking the stub away is enough
    vi.unstubAllGlobals();
    const response = chunked([encoder.encode('{"a":1}')]);
    const json = vi.spyOn(response, "json");
    stubFetch(response);
    const onProgress = vi.fn();

    await expect(fetchJson("a.json", { onProgress })).resolves.toEqual({
      a: 1,
    });
    expect(json).toHaveBeenCalledOnce();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("hands the body to the native parser when nobody counts", async () => {
    const response = chunked([encoder.encode('{"a":1}')]);
    const json = vi.spyOn(response, "json");
    stubFetch(response);

    await expect(fetchJson("a.json")).resolves.toEqual({ a: 1 });
    expect(json).toHaveBeenCalledOnce();
  });

  it("loads the file all the same when the progress callback throws", async () => {
    const bytes = encoder.encode('{"a":[1,2,3]}');
    stubFetch(chunked([bytes.slice(0, 4), bytes.slice(4, 8), bytes.slice(8)]));
    const onProgress = vi.fn<(loadedBytes: number) => void>(() => {
      throw new Error("no such element");
    });

    await expect(fetchJson("a.json", { onProgress })).resolves.toEqual({
      a: [1, 2, 3],
    });
    // Asked once, and left alone after it failed
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(4);
    expect(logError).toHaveBeenCalledWith(
      "Progress callback failed:",
      new Error("no such element"),
    );
  });

  it("rejects on an error status without reading the body", async () => {
    stubFetch(new Response("not found", { status: 404 }));
    const onProgress = vi.fn();

    const failure = await fetchJson("bad.json", { onProgress }).catch(
      (e: unknown) => e,
    );

    expect(failure).toEqual(new Error("Failed to load bad.json"));
    expect((failure as Error).cause).toEqual(new Error("HTTP 404"));
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("rejects when the connection breaks halfway through the body", async () => {
    stubFetch(
      new Response(
        streamOf((controller) => {
          controller.enqueue(encoder.encode('{"a":'));
          controller.error(new TypeError("network error"));
        }),
      ),
    );
    const onProgress = vi.fn();

    await expect(fetchJson("cut.json", { onProgress })).rejects.toThrow(
      "Failed to load cut.json",
    );
  });

  it("aborts a body that stalls after its first chunk", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation((_url, init) => {
        signal = init!.signal!;
        return Promise.resolve(
          new Response(
            streamOf((controller) => {
              controller.enqueue(encoder.encode('{"a":'));
              // What the browser does to the body of an aborted fetch
              signal!.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
              );
            }),
          ),
        );
      }),
    );
    const onProgress = vi.fn();

    const pending = fetchJson("stalled.json", {
      timeoutMs: 5000,
      onProgress,
    });
    const outcome = expect(pending).rejects.toThrow(
      "Timed out loading stalled.json",
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(5);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("loadStylesheet", () => {
  /** Whatever a test appended, gone before the next one queries the head */
  afterEach(() => {
    resetStylesheetLoader();
    document.head
      .querySelectorAll('link[rel="stylesheet"]')
      .forEach((link) => link.remove());
  });

  it("appends a stylesheet link to document.head and resolves on load", async () => {
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        (node as HTMLLinkElement).onload?.(new Event("load"));
        return node;
      });

    await loadStylesheet("test.css");

    const link = appendChildSpy.mock.calls[0]![0] as HTMLLinkElement;
    expect(link.tagName).toBe("LINK");
    expect(link.rel).toBe("stylesheet");
    expect(link.href).toContain("test.css");

    appendChildSpy.mockRestore();
  });

  it("leaves the link in the document, unlike a script", async () => {
    // A link only applies while it is in the head; removing it as loadScript
    // removes its script would undo the styles it just brought in
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        document.head.append(node);
        (node as HTMLLinkElement).onload?.(new Event("load"));
        return node;
      });

    await loadStylesheet("kept.css");

    const link = document.head.querySelector('link[data-href="kept.css"]');
    expect(link).not.toBeNull();
    // and nothing left behind to fire later
    expect((link as HTMLLinkElement).onload).toBeNull();

    appendChildSpy.mockRestore();
  });

  it("does not add a second link for a href it already has", async () => {
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        document.head.append(node);
        (node as HTMLLinkElement).onload?.(new Event("load"));
        return node;
      });

    await loadStylesheet("once.css");
    await loadStylesheet("once.css");

    expect(
      document.head.querySelectorAll('link[data-href="once.css"]'),
    ).toHaveLength(1);

    appendChildSpy.mockRestore();
  });

  it("rejects and takes the link back out on error", async () => {
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        document.head.append(node);
        (node as HTMLLinkElement).onerror?.(new Event("error"));
        return node;
      });

    await expect(loadStylesheet("bad.css")).rejects.toThrow(
      "Failed to load stylesheet: bad.css",
    );
    expect(document.head.querySelector('link[data-href="bad.css"]')).toBeNull();

    appendChildSpy.mockRestore();
  });

  it("does not report a stylesheet that is still in flight as applied", async () => {
    // Deduping on the link being in the head said "loaded" for a request
    // that had not loaded, so a caller drew a panel the styles had not
    // reached yet. The second caller has to wait on the same request.
    vi.useFakeTimers();
    const links: HTMLLinkElement[] = [];
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        links.push(node as HTMLLinkElement);
        document.head.append(node);
        return node;
      });

    // Neither loads nor errors: still on the wire
    const first = loadStylesheet("features.css", 30_000);
    first.catch(() => undefined);
    let settled = false;
    const second = loadStylesheet("features.css", 30_000);
    void second.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(links).toHaveLength(1);
    expect(settled).toBe(false);

    // and it resolves once that one request does
    links[0]!.onload?.(new Event("load"));
    await expect(second).resolves.toBeUndefined();

    appendChildSpy.mockRestore();
    vi.useRealTimers();
  });

  it("does not let an abandoned attempt remove a later caller's stylesheet", async () => {
    // The bundle can fail while the sheet is still in flight, and the user
    // opens the feature again. Sharing one request means the timeout that
    // removes the link also rejects everyone waiting on it, instead of
    // pulling the stylesheet out from under a caller that was told it had
    // arrived.
    vi.useFakeTimers();
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        document.head.append(node);
        return node;
      });

    const first = loadStylesheet("features.css", 30_000);
    first.catch(() => undefined);
    const second = loadStylesheet("features.css", 30_000);
    const outcome = second.then(
      () => "resolved",
      () => "rejected",
    );

    vi.advanceTimersByTime(30_000);

    await expect(outcome).resolves.toBe("rejected");
    expect(
      document.head.querySelector('link[data-href="features.css"]'),
    ).toBeNull();

    appendChildSpy.mockRestore();
    vi.useRealTimers();
  });

  it("starts over after a failure instead of caching it", async () => {
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementationOnce((node: Node) => {
        document.head.append(node);
        (node as HTMLLinkElement).onerror?.(new Event("error"));
        return node;
      })
      .mockImplementationOnce((node: Node) => {
        document.head.append(node);
        (node as HTMLLinkElement).onload?.(new Event("load"));
        return node;
      });

    await expect(loadStylesheet("retry.css")).rejects.toThrow();
    await expect(loadStylesheet("retry.css")).resolves.toBeUndefined();

    expect(appendChildSpy).toHaveBeenCalledTimes(2);
    appendChildSpy.mockRestore();
  });

  it("gives up on a stylesheet that neither loads nor errors", async () => {
    vi.useFakeTimers();
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        document.head.append(node);
        return node;
      });

    const pending = loadStylesheet("stalled.css", 5000);
    vi.advanceTimersByTime(4999);
    expect(
      document.head.querySelector('link[data-href="stalled.css"]'),
    ).not.toBeNull();
    vi.advanceTimersByTime(1);

    await expect(pending).rejects.toThrow(
      "Timed out loading stylesheet: stalled.css",
    );
    // Taken back out, so the next attempt is not short-circuited by it
    expect(
      document.head.querySelector('link[data-href="stalled.css"]'),
    ).toBeNull();

    appendChildSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe("isValidYear", () => {
  it("accepts 'all' and 4-digit years in range", () => {
    expect(isValidYear("all")).toBe(true);
    expect(isValidYear("2000")).toBe(true);
    expect(isValidYear("2099")).toBe(true);
  });

  it("accepts any four-digit year", () => {
    expect(isValidYear("1999")).toBe(true);
    expect(isValidYear("2100")).toBe(true);
  });

  it("rejects anything that is not four digits", () => {
    expect(isValidYear("abc")).toBe(false);
    expect(isValidYear("../etc")).toBe(false);
    expect(isValidYear("20255")).toBe(false);
    expect(isValidYear("2025/..")).toBe(false);
  });
});

describe("expandYearData", () => {
  it("expands segment rows into path segments and heatmap coordinates", () => {
    const raw = rawYear(
      2025,
      {
        "4": path(
          [50, 8],
          [
            [50.1, 8.1, 1000, 90, 0],
            [50.2, 8.2, 1100, 95, 10],
          ],
        ),
        "7": path([51, 9], [[51.1, 9.1, 500, 80]]),
      },
      [
        { id: 4, year: 2025 },
        { id: 7, year: 2025 },
      ],
      42,
    );

    const data = expandYearData(raw);

    expect(data.original_points).toBe(42);
    expect(data.path_info).toBe(raw.path_info);
    expect(data.path_segments).toEqual([
      {
        path_id: 4,
        coords: [
          [50, 8],
          [50.1, 8.1],
        ],
        altitude_ft: 1000,
        groundspeed_knots: 90,
        time: 0,
      },
      {
        path_id: 4,
        coords: [
          [50.1, 8.1],
          [50.2, 8.2],
        ],
        altitude_ft: 1100,
        groundspeed_knots: 95,
        time: 10,
      },
      {
        path_id: 7,
        coords: [
          [51, 9],
          [51.1, 9.1],
        ],
        altitude_ft: 500,
        groundspeed_knots: 80,
      },
    ]);
    // start of every segment + end of the last segment per path
    expect(data.coordinates).toEqual([
      [50, 8],
      [50.1, 8.1],
      [50.2, 8.2],
      [51, 9],
      [51.1, 9.1],
    ]);
  });

  it("omits time when the row has four entries", () => {
    const data = expandYearData(
      rawYear(2025, { "1": path([50, 8], [[50.1, 8.1, 1000, 90]]) }),
    );
    expect("time" in data.path_segments[0]!).toBe(false);
  });

  it("orders paths like path_info, whatever their ids", () => {
    // Ids are content hashes; JavaScript would list "2" before the others
    const data = expandYearData(
      rawYear(
        2025,
        {
          "840108108563": path([50, 8], [[50.1, 8.1, 1, 1]]),
          "10": path([50, 8], [[50.1, 8.1, 1, 1]]),
          "2": path([50, 8], [[50.1, 8.1, 1, 1]]),
        },
        [
          { id: 840108108563, year: 2025 },
          { id: 10, year: 2025 },
          { id: 2, year: 2025 },
        ],
      ),
    );
    expect(data.path_segments.map((s) => s.path_id)).toEqual([
      840108108563, 10, 2,
    ]);
  });

  it("still expands segments that path_info does not list", () => {
    const data = expandYearData(
      rawYear(
        2025,
        {
          "10": path([50, 8], [[50.1, 8.1, 1, 1]]),
          "2": path([50, 8], [[50.1, 8.1, 1, 1]]),
        },
        [{ id: 10, year: 2025 }],
      ),
    );
    expect(data.path_segments.map((s) => s.path_id)).toEqual([10, 2]);
  });

  it("expands an unlisted path even when the counts match", () => {
    const data = expandYearData(
      rawYear(
        2025,
        {
          "10": path([50, 8], [[50.1, 8.1, 1, 1]]),
          "30": path([50, 8], [[50.1, 8.1, 1, 1]]),
        },
        [
          { id: 10, year: 2025 },
          { id: 20, year: 2025 },
        ],
      ),
    );
    expect(data.path_segments.map((s) => s.path_id)).toEqual([10, 30]);
  });

  it("expands a path listed twice once", () => {
    const data = expandYearData(
      rawYear(2025, { "10": path([50, 8], [[50.1, 8.1, 1, 1]]) }, [
        { id: 10, year: 2025 },
        { id: 10, year: 2025 },
      ]),
    );
    expect(data.path_segments).toHaveLength(1);
  });

  it("skips paths without segments and has no holes in the arrays", () => {
    const data = expandYearData(
      rawYear(2025, {
        "1": path([50, 8], []),
        "2": path([50, 8], [[50.1, 8.1, 1, 1]]),
      }),
    );
    expect(data.path_segments).toHaveLength(1);
    expect(data.coordinates).toHaveLength(2);
    expect(data.coordinates.every((c) => Array.isArray(c))).toBe(true);
  });

  it("shares the start coordinate array between segment and heatmap point", () => {
    const data = expandYearData(
      rawYear(2025, { "1": path([50, 8], [[50.1, 8.1, 1, 1]]) }),
    );
    expect(data.coordinates[0]).toBe(data.path_segments[0]!.coords![0]);
  });

  it("shares one coordinate array between neighbouring segments", () => {
    const data = expandYearData(
      rawYear(2025, {
        "1": path(
          [50, 8],
          [
            [50.1, 8.1, 1, 1],
            [50.2, 8.2, 1, 1],
          ],
        ),
      }),
    );
    // The end of a segment is the very same array as the next one's start
    expect(data.path_segments[0]!.coords![1]).toBe(
      data.path_segments[1]!.coords![0],
    );
  });

  describe("malformed paths", () => {
    let warn: MockInstance<typeof console.warn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    const good = (): RawPathSegments => path([51, 9], [[51.1, 9.1, 500, 80]]);

    /** Expand path "1" next to a good path "2" */
    function expandWith(bad: unknown): KMLDataset {
      return expandYearData(
        rawYear(2025, { "1": bad as RawPathSegments, "2": good() }),
      );
    }

    /** Only the good path made it, and it has no holes or NaN in it */
    function expectOnlyTheGoodPath(data: KMLDataset): void {
      expect(data.path_segments.map((s) => s.path_id)).toEqual([2]);
      expect(data.coordinates).toEqual([
        [51, 9],
        [51.1, 9.1],
      ]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("Path 1");
    }

    it.each([
      ["no start point", { ...good(), start: [] }],
      ["a start point that is not numeric", { ...good(), start: ["x", 1] }],
      [
        "a missing column",
        { start: [0, 0], columns: [[1], [1], [1], undefined] },
      ],
      ["columns that are not an array", { start: [0, 0], columns: {} }],
      ["no columns at all", { start: [0, 0] }],
    ])("leaves out a path with %s and warns", (_, bad) => {
      expectOnlyTheGoodPath(expandWith(bad));
    });

    it.each([NaN, Infinity, "1", undefined, {}])(
      "cuts a path short at a row holding %s, keeping the rows before it",
      (value) => {
        const raw = path(
          [50, 8],
          [
            [50.1, 8.1, 500, 80, 0],
            [50.2, 8.2, 500, 80, 1],
            [50.3, 8.3, 500, 80, 2],
          ],
        );
        (raw.columns[1] as unknown[])[1] = value;

        const data = expandWith(raw);

        // A difference is lost, so nothing after it has a known position
        expect(data.path_segments.map((s) => s.path_id)).toEqual([1, 2]);
        expect(data.coordinates).toEqual([
          [50, 8],
          [50.1, 8.1],
          [51, 9],
          [51.1, 9.1],
        ]);
        // Every slot is filled: the preallocated arrays are trimmed
        expect(data.path_segments.every(Boolean)).toBe(true);
        expect(warn).toHaveBeenCalledOnce();
      },
    );

    it("cuts a path short where a column ends early", () => {
      const data = expandWith({
        start: [0, 0],
        columns: [[1, 2], [1], [1], [1]],
      });

      expect(data.path_segments.map((s) => s.path_id)).toEqual([1, 2]);
      expect(warn).toHaveBeenCalledOnce();
    });

    it.each([2, 3])("checks column %i as well", (column) => {
      const raw = path([50, 8], [[50.1, 8.1, 500, 80]]);
      (raw.columns[column] as unknown[])[0] = "high";

      expectOnlyTheGoodPath(expandWith(raw));
    });

    it("rejects a time that is present but not numeric", () => {
      const raw = path([50, 8], [[50.1, 8.1, 500, 80, 0]]);
      (raw.columns[4] as unknown[])[0] = "soon";

      expectOnlyTheGoodPath(expandWith(raw));
    });

    it("reads a time column that ends early as rows without a time", () => {
      const data = expandWith({
        start: [0, 0],
        columns: [[1], [1], [1], [1], []],
      });

      expect(data.path_segments.map((s) => s.time)).toEqual([
        undefined,
        undefined,
      ]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("reads a null time as a row without one", () => {
    const data = expandYearData(
      rawYear(2025, {
        "1": path(
          [50, 8],
          [
            [50.1, 8.1, 500, 80, 10],
            [50.2, 8.2, 500, 80],
            [50.3, 8.3, 500, 80, 30],
          ],
        ),
      }),
    );

    expect(data.path_segments.map((s) => s.time)).toEqual([10, undefined, 30]);
    expect("time" in data.path_segments[1]!).toBe(false);
  });

  it("defaults missing path_info and original_points", () => {
    const data = expandYearData({
      format: DATA_FORMAT_VERSION,
      year: 2025,
      segments: {},
    } as RawYearData);
    expect(data.path_info).toEqual([]);
    expect(data.original_points).toBe(0);
    expect(data.path_segments).toEqual([]);
  });

  it("throws for invalid input", () => {
    expect(() => expandYearData(null as unknown as RawYearData)).toThrow();
    expect(() =>
      expandYearData({
        format: DATA_FORMAT_VERSION,
        path_segments: [],
      } as unknown as RawYearData),
    ).toThrow("segments");
  });

  it.each([undefined, 2, 4, "3"])(
    "refuses a year file written in format %s",
    (format) => {
      expect(() =>
        expandYearData({
          format,
          year: 2025,
          segments: {},
        } as unknown as RawYearData),
      ).toThrow("another release");
    },
  );

  it("decodes the scaled differences back to plain values", () => {
    const data = expandYearData(
      rawYear(2025, {
        "1": path(
          [50, 8],
          [
            [50.1, 8.1, 500, 1.5, 2],
            [50.2, 8.2, 600, 2.5, 4],
          ],
        ),
      }),
    );

    expect(data.path_segments[0]!.coords).toEqual([
      [50, 8],
      [50.1, 8.1],
    ]);
    expect(data.path_segments[0]!.altitude_ft).toBe(500);
    expect(data.path_segments[0]!.groundspeed_knots).toBe(1.5);
    expect(data.path_segments[0]!.time).toBe(2);
    expect(data.path_segments[1]!.coords).toEqual([
      [50.1, 8.1],
      [50.2, 8.2],
    ]);
    expect(data.path_segments[1]!.altitude_ft).toBe(600);
    expect(data.path_segments[1]!.groundspeed_knots).toBe(2.5);
    expect(data.path_segments[1]!.time).toBe(4);
  });
});

describe("combineYearData", () => {
  it("concatenates datasets without remapping or copying objects", () => {
    const a = dataset(2, 1, 100);
    const b = dataset(1, 3, 200);

    const result = combineYearData([a, b]);

    expect(result.coordinates).toHaveLength(3);
    expect(result.path_segments).toHaveLength(3);
    expect(result.path_info).toHaveLength(3);
    expect(result.original_points).toBe(300);
    expect(result.path_segments.map((s) => s.path_id)).toEqual([1, 2, 3]);
    // Same object references (no copies)
    expect(result.path_segments[0]).toBe(a.path_segments[0]);
    expect(result.path_segments[2]).toBe(b.path_segments[0]);
    expect(result.path_info[2]).toBe(b.path_info[0]);
    expect(result.coordinates[0]).toBe(a.coordinates[0]);
  });

  it("skips null or undefined datasets", () => {
    const result = combineYearData([dataset(1), null, undefined]);
    expect(result.coordinates).toHaveLength(1);
    expect(result.original_points).toBe(1);
  });

  it("returns an empty dataset for no input", () => {
    expect(combineYearData([])).toEqual({
      coordinates: [],
      path_segments: [],
      path_info: [],
      original_points: 0,
    });
  });
});

describe("DataLoader", () => {
  let loader: DataLoader;
  let mockWindow: MockWindow;
  let mockFetchJson: Mock<NonNullable<DataLoaderOptions["fetchJson"]>>;
  /** What the site serves, by URL; anything else is a 404 */
  let files: Record<string, unknown>;
  let mockShowLoading: Mock<(state: LoadingState) => void>;
  let mockHideLoading: Mock<() => void>;
  let onLoadError: Mock<(years: string[]) => void>;

  function defineYear(
    year: number,
    segments: RawYearData["segments"] = {
      "1": path([50, 8], [[50.1, 8.1, 1000, 100, 0]]),
    },
  ): void {
    files[`test-data/${year}/data.json`] = rawYear(
      year,
      segments,
      [{ id: 1, year }],
      1,
    );
  }

  /** Metadata that knows these sizes, and the years they belong to */
  function withSizes(sizes: Record<string, number>): void {
    mockWindow.KML_METADATA = {
      available_years: Object.keys(sizes).map(Number),
      year_file_bytes: sizes,
    } as Metadata;
  }

  function serve(url: string): Promise<unknown> {
    return url in files
      ? Promise.resolve(files[url])
      : Promise.reject(new Error("HTTP 404"));
  }

  beforeEach(() => {
    mockWindow = {} as MockWindow;
    files = {};
    mockFetchJson = vi.fn<NonNullable<DataLoaderOptions["fetchJson"]>>();
    mockFetchJson.mockImplementation(serve);
    mockShowLoading = vi.fn();
    mockHideLoading = vi.fn();
    onLoadError = vi.fn();

    loader = new DataLoader({
      dataDir: "test-data",
      fetchJson: mockFetchJson,
      showLoading: mockShowLoading,
      hideLoading: mockHideLoading,
      getWindow: () => mockWindow,
      onLoadError,
    });
  });

  describe("input validation", () => {
    it("rejects invalid years without loading", async () => {
      expect(await loader.loadData("abc")).toBeNull();
      expect(await loader.loadData("../data")).toBeNull();
      expect(await loader.loadData("20255")).toBeNull();
      expect(mockFetchJson).not.toHaveBeenCalled();
      expect(onLoadError).not.toHaveBeenCalled();
    });
  });

  describe("loadData", () => {
    it("loads and expands data for a specific year", async () => {
      defineYear(2025);

      const result = await loader.loadData("2025");

      expect(mockFetchJson).toHaveBeenCalledWith(
        "test-data/2025/data.json",
        undefined,
      );
      expect(result).not.toBeNull();
      expect(result!.path_segments).toHaveLength(1);
      expect(result!.path_segments[0]!.path_id).toBe(1);
      expect(result!.coordinates).toHaveLength(2);
      expect(mockShowLoading).toHaveBeenCalledTimes(1);
      expect(mockHideLoading).toHaveBeenCalledTimes(1);
    });

    it("reports year and file size to the loading indicator", async () => {
      withSizes({ "2024": 100, "2025": 2048 });
      defineYear(2025);

      await loader.loadData("2025");

      expect(mockShowLoading).toHaveBeenCalledExactlyOnceWith({
        operation: 1,
        all: false,
        years: ["2025"],
        fileBytes: 2048,
        loadedBytes: 0,
        totalBytes: 2048,
      });
    });

    it("reports the year without size when metadata is unavailable", async () => {
      defineYear(2025);

      await loader.loadData("2025");

      expect(mockShowLoading).toHaveBeenCalledExactlyOnceWith({
        operation: 1,
        all: false,
        years: ["2025"],
        fileBytes: undefined,
        loadedBytes: 0,
        totalBytes: undefined,
      });
    });

    it("uses cached data on second call", async () => {
      defineYear(2025);

      const first = await loader.loadData("2025");
      const second = await loader.loadData("2025");

      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    });

    it("dedupes concurrent loads of the same year", async () => {
      defineYear(2025);
      let answer: () => void = () => {};
      mockFetchJson.mockImplementationOnce(
        (url) =>
          new Promise((resolve) => {
            answer = () => resolve(files[url]);
          }),
      );

      const p1 = loader.loadData("2025");
      const p2 = loader.loadData("2025");
      answer();
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      expect(r1).toBe(r2);
    });

    it("returns null and reports the year when the file fails to load", async () => {
      mockFetchJson.mockRejectedValueOnce(new Error("Failed to load"));

      const result = await loader.loadData("2025");

      expect(result).toBeNull();
      expect(onLoadError).toHaveBeenCalledWith(["2025"]);
      expect(mockHideLoading).toHaveBeenCalled();
    });

    it("returns null when the file is not a year file", async () => {
      files["test-data/2025/data.json"] = null;

      const result = await loader.loadData("2025");

      expect(result).toBeNull();
      expect(onLoadError).toHaveBeenCalledWith(["2025"]);
    });

    it('defaults to "all" if year not specified', async () => {
      mockWindow.KML_METADATA = { available_years: [2025] } as never;
      defineYear(2025);

      const result = await loader.loadData();

      expect(result).not.toBeNull();
      expect(result!.path_segments).toHaveLength(1);
    });

    it("does not cache failed loads", async () => {
      mockFetchJson.mockRejectedValueOnce(new Error("boom"));
      expect(await loader.loadData("2025")).toBeNull();

      defineYear(2025);
      expect(await loader.loadData("2025")).not.toBeNull();
      // The failure was not remembered: the file was requested again
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });
  });

  describe("loadAndCombineAllYears", () => {
    it("loads and combines all years in parallel", async () => {
      mockWindow.KML_METADATA = { available_years: [2024, 2025] } as never;
      defineYear(2024);
      defineYear(2025);

      const result = await loader.loadAndCombineAllYears();

      expect(result).not.toBeNull();
      expect(result!.path_segments).toHaveLength(2);
      expect(result!.original_points).toBe(2);
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
      expect(onLoadError).not.toHaveBeenCalled();
    });

    it("loads metadata first when not present", async () => {
      files["test-data/metadata.json"] = { available_years: [2025] };
      defineYear(2025);

      const result = await loader.loadAndCombineAllYears();

      expect(result).not.toBeNull();
      expect(mockFetchJson).toHaveBeenCalledWith("test-data/metadata.json");
    });

    it("reports the total size of all year files", async () => {
      withSizes({ "2024": 100, "2025": 2048 });
      defineYear(2024);
      defineYear(2025);

      await loader.loadAndCombineAllYears();

      expect(mockShowLoading).toHaveBeenCalledWith({
        operation: 2,
        all: true,
        years: ["2024", "2025"],
        fileBytes: 2148,
        loadedBytes: 0,
        totalBytes: 2148,
      });
    });

    it("keeps the loading indicator visible until all years are loaded", async () => {
      mockWindow.KML_METADATA = { available_years: [2024, 2025] } as never;
      defineYear(2024);
      defineYear(2025);
      const resolvers: (() => void)[] = [];
      mockFetchJson.mockImplementation(
        (url: string) =>
          new Promise((resolve) => {
            resolvers.push(() => resolve(files[url]));
          }),
      );

      const promise = loader.loadAndCombineAllYears();
      await Promise.resolve();
      expect(resolvers).toHaveLength(2);

      resolvers[0]!();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockHideLoading).not.toHaveBeenCalled();

      resolvers[1]!();
      await promise;

      expect(mockHideLoading).toHaveBeenCalledTimes(1);
      // Nothing is shown again once the indicator is down
      expect(mockShowLoading.mock.invocationCallOrder.at(-1)).toBeLessThan(
        mockHideLoading.mock.invocationCallOrder[0]!,
      );
    });

    it("uses cached combined data", async () => {
      mockWindow.KML_METADATA = { available_years: [2025] } as never;
      defineYear(2025);

      const first = await loader.loadAndCombineAllYears();
      const second = await loader.loadAndCombineAllYears();

      expect(second).toBe(first);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it("dedupes concurrent 'all' loads", async () => {
      mockWindow.KML_METADATA = { available_years: [2025] } as never;
      defineYear(2025);

      const [a, b] = await Promise.all([
        loader.loadData("all"),
        loader.loadData("all"),
      ]);

      expect(a).toBe(b);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it("returns null if metadata is missing", async () => {
      const result = await loader.loadAndCombineAllYears();

      expect(result).toBeNull();
      expect(mockHideLoading).toHaveBeenCalled();
    });

    it("returns null if available_years is missing", async () => {
      mockWindow.KML_METADATA = {} as never;

      const result = await loader.loadAndCombineAllYears();

      expect(result).toBeNull();
    });

    it("returns partial data and reports the failed years", async () => {
      mockWindow.KML_METADATA = { available_years: [2024, 2025] } as never;
      defineYear(2025);

      const result = await loader.loadAndCombineAllYears();

      expect(result).not.toBeNull();
      expect(result!.path_segments).toHaveLength(1);
      expect(result!.incomplete).toBe(true);
      expect(onLoadError).toHaveBeenCalledTimes(1);
      expect(onLoadError).toHaveBeenCalledWith(["2024"]);
    });

    it("returns null and lists every year when all fail", async () => {
      mockWindow.KML_METADATA = { available_years: [2024, 2025] } as never;
      mockFetchJson.mockRejectedValue(new Error("Network error"));

      const result = await loader.loadAndCombineAllYears();

      expect(result).toBeNull();
      expect(onLoadError).toHaveBeenCalledWith(["2024", "2025"]);
      expect(mockHideLoading).toHaveBeenCalled();

      // Nothing was cached, so the next call tries the files again
      mockFetchJson.mockClear();
      expect(await loader.loadAndCombineAllYears()).toBeNull();
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });
  });

  describe("download progress", () => {
    /** Per URL: report bytes as read, and let the request succeed or fail */
    let requests: Record<
      string,
      { read: (loadedBytes: number) => void; settle: (ok?: boolean) => void }
    >;

    beforeEach(() => {
      requests = {};
      mockFetchJson.mockImplementation((url, options) => {
        if (!url.endsWith("/data.json")) return serve(url);
        return new Promise((resolve, reject) => {
          requests[url] = {
            read: (loadedBytes) => options?.onProgress?.(loadedBytes),
            settle: (ok = true) =>
              ok ? resolve(files[url]) : reject(new Error("HTTP 500")),
          };
        });
      });
    });

    const request = (year: number): (typeof requests)[string] =>
      requests[`test-data/${year}/data.json`]!;

    /** What the indicator was told, as "years (size) loaded/total" */
    const shown = (): string[] =>
      mockShowLoading.mock.calls.map(
        ([{ all, years, fileBytes, loadedBytes, totalBytes }]) =>
          `${all ? "all:" : ""}${years.join("+")} (${fileBytes}) ` +
          `${loadedBytes}/${totalBytes}`,
      );

    /** Let the promise chains of settled requests run */
    const settled = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    it("reports the bytes of a year against its size on disk", async () => {
      withSizes({ "2025": 1000 });
      defineYear(2025);

      const loading = loader.loadData("2025");
      request(2025).read(400);
      request(2025).read(1000);
      request(2025).settle();
      await loading;

      // Nothing is reported for the file having settled: the indicator goes
      // away instead
      expect(shown()).toEqual([
        "2025 (1000) 0/1000",
        "2025 (1000) 400/1000",
        "2025 (1000) 1000/1000",
      ]);
      expect(mockHideLoading).toHaveBeenCalledOnce();
    });

    it("counts a file no further than its expected size, and never back", async () => {
      withSizes({ "2025": 1000 });
      defineYear(2025);

      const loading = loader.loadData("2025");
      request(2025).read(600);
      request(2025).read(500);
      request(2025).read(1500);
      request(2025).read(1600);
      request(2025).settle();
      await loading;

      expect(shown()).toEqual([
        "2025 (1000) 0/1000",
        "2025 (1000) 600/1000",
        // Once: the chunks past the size change nothing on screen
        "2025 (1000) 1000/1000",
      ]);
      // Said once, not for every chunk past the size
      expect(
        vi
          .mocked(logDebug)
          .mock.calls.filter(([message]) => String(message).includes("larger")),
      ).toEqual([
        ["Year file is larger than metadata.year_file_bytes says:", 1000],
      ]);
    });

    it.each([
      ["without metadata", undefined],
      ["for a year the metadata has no size for", { "2024": 10 }],
      ["for a size of zero", { "2025": 0 }],
    ])("asks for no byte counts %s", async (_name, sizes) => {
      if (sizes) withSizes(sizes);
      defineYear(2025);

      const loading = loader.loadData("2025");
      request(2025).settle();
      await loading;

      expect(mockFetchJson).toHaveBeenCalledExactlyOnceWith(
        "test-data/2025/data.json",
        undefined,
      );
      expect(shown()).toEqual(["2025 (undefined) 0/undefined"]);
    });

    it("sums the years of 'all' into one share", async () => {
      withSizes({ "2024": 100, "2025": 300 });
      defineYear(2024);
      defineYear(2025);

      const loading = loader.loadAndCombineAllYears();
      await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(2));
      request(2025).read(150);
      request(2024).read(60);
      request(2024).settle();
      await settled();
      request(2025).read(300);
      request(2025).settle();
      await loading;

      // The first three are one frame to the indicator, which draws the last
      expect(shown()).toEqual([
        "all: (undefined) 0/undefined",
        "all:2024 (100) 0/100",
        "all:2024+2025 (400) 0/400",
        "all:2024+2025 (400) 150/400",
        "all:2024+2025 (400) 210/400",
        // Arrived, so it counts in full whatever was counted on the way
        "all:2024+2025 (400) 250/400",
        "all:2024+2025 (400) 400/400",
        "all:2024+2025 (400) 400/400",
      ]);
    });

    it("shows no share while one size of 'all' is unknown", async () => {
      withSizes({ "2024": 100 });
      mockWindow.KML_METADATA!.available_years = [2024, 2025];
      defineYear(2024);
      defineYear(2025);

      const loading = loader.loadAndCombineAllYears();
      await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(2));
      request(2024).read(50);
      request(2024).settle();
      request(2025).settle();
      await loading;

      expect(new Set(shown().slice(2))).toEqual(
        new Set(["all:2024+2025 (undefined) 0/undefined"]),
      );
    });

    it("starts over without a year that failed, counting no bytes that never arrived", async () => {
      withSizes({ "2023": 100, "2024": 100, "2025": 300 });
      defineYear(2025);

      const loading = loader.loadAndCombineAllYears();
      await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(3));
      mockShowLoading.mockClear();
      request(2025).read(150);
      request(2024).read(20);
      request(2023).settle(false);
      request(2024).settle(false);
      await settled();
      request(2025).read(225);
      request(2025).settle();
      await loading;

      expect(shown()).toEqual([
        "all:2023+2024+2025 (500) 150/500",
        "all:2023+2024+2025 (500) 170/500",
        // What is left: 80 bytes of 2024 and the half of 2025 still to come.
        // The size is that of the whole files, as the label names them.
        "all:2024+2025 (400) 0/230",
        "all:2025 (300) 0/150",
        "all:2025 (300) 75/150",
        "all:2025 (300) 150/150",
      ]);
      expect(onLoadError).toHaveBeenCalledWith(["2023", "2024"]);
    });

    it("starts over when another year joins, with what is still to come", async () => {
      withSizes({ "2024": 100, "2025": 300 });
      defineYear(2024);
      defineYear(2025);

      const first = loader.loadData("2025");
      request(2025).read(270);
      const second = loader.loadData("2024");
      request(2025).read(285);
      request(2025).settle();
      await first;
      request(2024).read(50);
      request(2024).settle();
      await second;

      expect(shown()).toEqual([
        "2025 (300) 0/300",
        "2025 (300) 270/300",
        // Not 270 of 400: the bar is about the 130 bytes that the two files
        // still have to deliver, the label about the files
        "2025+2024 (400) 0/130",
        "2025+2024 (400) 15/130",
        "2025+2024 (400) 30/130",
        "2025+2024 (400) 80/130",
      ]);
      expect(mockHideLoading).toHaveBeenCalledOnce();
    });

    it("leaves a settled year out of the load that joins after it", async () => {
      withSizes({ "2023": 50, "2024": 100, "2025": 300 });
      defineYear(2023);
      defineYear(2024);
      defineYear(2025);

      const first = loader.loadData("2025");
      const second = loader.loadData("2024");
      request(2025).read(300);
      request(2025).settle();
      await first;
      mockShowLoading.mockClear();
      const third = loader.loadData("2023");
      request(2024).settle();
      request(2023).settle();
      await Promise.all([second, third]);

      expect(shown()[0]).toBe("2024+2023 (150) 0/150");
    });

    it("leaves a cached year out of label and bar alike", async () => {
      withSizes({ "2024": 100, "2025": 300 });
      defineYear(2024);
      defineYear(2025);
      const first = loader.loadData("2024");
      request(2024).settle();
      await first;
      mockShowLoading.mockClear();

      const loading = loader.loadAndCombineAllYears();
      await vi.waitFor(() => expect(requests["test-data/2025/data.json"]));
      request(2025).read(150);
      request(2025).settle();
      await loading;

      expect(shown()).toEqual([
        "all: (undefined) 0/undefined",
        "all:2025 (300) 0/300",
        "all:2025 (300) 150/300",
        "all:2025 (300) 300/300",
      ]);
    });

    it.each(["showLoading", "hideLoading"] as const)(
      "finishes the load when %s throws",
      async (callback) => {
        withSizes({ "2024": 100, "2025": 300 });
        defineYear(2024);
        defineYear(2025);
        const broken =
          callback === "showLoading" ? mockShowLoading : mockHideLoading;
        broken.mockImplementation(() => {
          throw new Error("no such element");
        });

        const loading = loader.loadAndCombineAllYears();
        await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(2));
        request(2024).read(50);
        request(2024).settle();
        request(2025).settle();

        const data = await loading;
        expect(data!.path_segments).toHaveLength(2);
        expect(onLoadError).not.toHaveBeenCalled();
        // The count of loads came out even: the indicator was taken down
        expect(mockHideLoading).toHaveBeenCalledOnce();
        expect(logError).toHaveBeenCalledWith(
          "Loading indicator failed:",
          new Error("no such element"),
        );
      },
    );

    it("counts the operations: one more for every load that joins or fails", async () => {
      withSizes({ "2024": 100, "2025": 100 });
      defineYear(2025);

      const first = loader.loadData("2025");
      request(2025).read(50);
      // Y2 joins with as many bytes as Y1 still lacks: nothing but the
      // count tells this operation from the last
      const second = loader.loadData("2024");
      request(2024).settle(false);
      await second;
      request(2025).read(60);
      request(2025).settle();
      await first;

      expect(
        mockShowLoading.mock.calls.map(
          ([{ operation, loadedBytes, totalBytes }]) =>
            `${operation}: ${loadedBytes}/${totalBytes}`,
        ),
      ).toEqual(["1: 0/100", "1: 50/100", "2: 0/150", "3: 0/50", "3: 10/50"]);
    });

    it("keeps the bar full when a failure leaves nothing to download", async () => {
      withSizes({ "2024": 100, "2025": 300 });
      defineYear(2025);

      const loading = loader.loadAndCombineAllYears();
      await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(2));
      mockShowLoading.mockClear();
      // All of 2025 is in and is being read when 2024 fails
      request(2025).read(300);
      request(2024).settle(false);
      await settled();
      request(2025).settle();
      await loading;

      // Nothing of the new operation is left to download: a total of zero,
      // which the indicator shows as a bar that stays full
      expect(shown()).toEqual([
        "all:2024+2025 (400) 300/400",
        "all:2025 (300) 0/0",
        "all:2025 (300) 0/0",
      ]);
    });

    it("ignores bytes reported for a download that is over", async () => {
      withSizes({ "2024": 100, "2025": 300 });
      defineYear(2025);

      const first = loader.loadData("2024");
      const second = loader.loadData("2025");
      request(2024).settle(false);
      await first;
      mockShowLoading.mockClear();
      // What a request that timed out may still do
      request(2024).read(80);
      request(2025).settle();
      await second;
      request(2025).read(400);

      expect(shown()).toEqual([]);
      expect(mockHideLoading).toHaveBeenCalledOnce();
    });

    it("says so when a file came out smaller than its recorded size", async () => {
      withSizes({ "2025": 1000 });
      defineYear(2025);

      const loading = loader.loadData("2025");
      request(2025).read(700);
      request(2025).settle();
      await loading;

      expect(logDebug).toHaveBeenCalledWith(
        "Year file is smaller than metadata.year_file_bytes says:",
        { size: 1000, received: 700 },
      );
    });

    it("has nothing to say about a file of the recorded size", async () => {
      withSizes({ "2025": 1000 });
      defineYear(2025);

      const loading = loader.loadData("2025");
      request(2025).read(1000);
      request(2025).settle();
      await loading;

      expect(logDebug).not.toHaveBeenCalledWith(
        expect.stringContaining("year_file_bytes"),
        expect.anything(),
      );
    });

    it("asks for no progress on the index files", async () => {
      files["test-data/metadata.json"] = { available_years: [] };
      files["test-data/airports.json"] = { airports: [] };

      await loader.loadMetadata();
      await loader.loadAirports();

      expect(mockFetchJson.mock.calls).toEqual([
        ["test-data/metadata.json"],
        ["test-data/airports.json"],
      ]);
      expect(mockShowLoading).not.toHaveBeenCalled();
    });

    it("takes the exported fetchJson as it is", () => {
      // One signature: the function is a valid option, with no adapter that
      // could put the callback where the timeout goes
      expect(() => new DataLoader({ fetchJson })).not.toThrow();
    });
  });

  describe("loadAirports", () => {
    it("loads airports data", async () => {
      const mockAirports = [
        { name: "EDDF", lat: 50.0, lon: 8.0 },
        { name: "EDDM", lat: 48.3, lon: 11.7 },
      ];

      files["test-data/airports.json"] = { airports: mockAirports };

      const result = await loader.loadAirports();

      expect(mockFetchJson).toHaveBeenCalledWith("test-data/airports.json");
      expect(result).toBe(mockAirports);
    });

    it("skips loading if already loaded", async () => {
      const mockAirports = [{ name: "EDDF", lat: 50, lon: 8 }];
      mockWindow.KML_AIRPORTS = { airports: mockAirports };

      const result = await loader.loadAirports();

      expect(mockFetchJson).not.toHaveBeenCalled();
      expect(result).toBe(mockAirports);
    });

    it("returns empty array on error", async () => {
      mockFetchJson.mockRejectedValueOnce(new Error("Failed"));

      const result = await loader.loadAirports();

      expect(result).toEqual([]);
    });
    it("publishes the list on window and shares one request", async () => {
      const mockAirports = [{ name: "EDDF", lat: 50, lon: 8 }];
      files["test-data/airports.json"] = { airports: mockAirports };

      const [a, b] = await Promise.all([
        loader.loadAirports(),
        loader.loadAirports(),
      ]);

      expect(a).toBe(b);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      expect(mockWindow.KML_AIRPORTS).toEqual({ airports: mockAirports });
    });

    it("asks again after a failure", async () => {
      expect(await loader.loadAirports()).toEqual([]);

      files["test-data/airports.json"] = { airports: [] };
      await loader.loadAirports();

      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });
  });

  describe("loadMetadata", () => {
    it("loads metadata", async () => {
      const mockMetadata = { available_years: [2024, 2025] };

      files["test-data/metadata.json"] = mockMetadata;

      const result = await loader.loadMetadata();

      expect(mockFetchJson).toHaveBeenCalledWith("test-data/metadata.json");
      expect(result).toBe(mockMetadata);
    });

    it("skips loading if already loaded", async () => {
      const mockMetadata = { available_years: [2025] };
      mockWindow.KML_METADATA = mockMetadata as never;

      const result = await loader.loadMetadata();

      expect(mockFetchJson).not.toHaveBeenCalled();
      expect(result).toBe(mockMetadata);
    });

    it("returns null on error", async () => {
      mockFetchJson.mockRejectedValueOnce(new Error("Failed"));

      const result = await loader.loadMetadata();

      expect(result).toBeNull();
    });
  });

  describe("default options", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      delete window.KML_METADATA;
    });

    it("fetches from the data directory next to the page by default", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify(
              rawYear(2025, { "1": path([50, 8], [[50.1, 8.1, 1000, 100]]) }),
            ),
          ),
        );
      vi.stubGlobal("fetch", fetchMock);

      const result = await new DataLoader().loadData("2025");

      expect(result!.path_segments).toHaveLength(1);
      expect(fetchMock.mock.calls[0]![0]).toBe("data/2025/data.json");
    });

    it("publishes the metadata on window by default", async () => {
      const metadata = { available_years: [2025] };
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(JSON.stringify(metadata))),
      );

      await expect(new DataLoader().loadMetadata()).resolves.toEqual(metadata);

      expect(window.KML_METADATA).toEqual(metadata);
    });
  });
});
