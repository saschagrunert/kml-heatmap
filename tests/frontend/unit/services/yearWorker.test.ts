import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createYearDecoder,
  handleRequest,
  serveRequests,
  type YearRequest,
  type YearResponse,
  type YearWorkerScope,
} from "../../../../kml_heatmap/frontend/services/yearWorker";
import { decodeYear } from "../../../../kml_heatmap/frontend/services/yearDecode";
import { path, rawYear, yearBytes } from "../../yearFixtures";

const year = rawYear(2025, { "1": path([50, 8], [[50.1, 8.1, 500, 100]]) });

describe("handleRequest", () => {
  it("answers with the decoded year under the id of the request", () => {
    const { response } = handleRequest({ id: 7, bytes: yearBytes(year) });

    expect(response).toEqual({ id: 7, decoded: decodeYear(year) });
  });

  it("hands the buffers of the columns over instead of copying them", () => {
    const { response, transfer } = handleRequest({
      id: 1,
      bytes: yearBytes(year),
    });

    if (!("decoded" in response)) throw new Error("not decoded");
    const { lats } = response.decoded;
    expect(transfer).toHaveLength(8);
    expect(transfer).toContain(lats.buffer);
    // The transfer a real worker would make: the columns arrive whole, and
    // are gone on the side that sent them
    const arrived = structuredClone(response, { transfer });
    expect([...arrived.decoded.lats]).toEqual([50, 50.1]);
    expect([...arrived.decoded.altitudes]).toEqual([500]);
    expect(lats.buffer.byteLength).toBe(0);
  });

  it("answers a file it cannot decode with the reason, and does not throw", () => {
    const { response, transfer } = handleRequest({
      id: 3,
      bytes: yearBytes({ format: -1 }),
    });

    expect(response).toEqual({
      id: 3,
      error: expect.stringContaining("another release") as string,
    });
    expect(transfer).toEqual([]);
  });

  it("answers a body that is not JSON the same way", () => {
    const { response } = handleRequest({
      id: 4,
      bytes: new Uint8Array([60, 104]).buffer,
    });

    expect(response).toMatchObject({ id: 4 });
    expect("error" in response && typeof response.error).toBe("string");
  });

  it("puts what is thrown into words even when it is no Error", () => {
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "odd";
    });

    const { response } = handleRequest({ id: 5, bytes: yearBytes(year) });

    parse.mockRestore();
    expect(response).toEqual({ id: 5, error: "odd" });
  });
});

describe("serveRequests", () => {
  it("answers every message of the scope, transfer list included", () => {
    const scope: YearWorkerScope = { onmessage: null, postMessage: vi.fn() };

    serveRequests(scope);
    scope.onmessage!({
      data: { id: 2, bytes: yearBytes(year) },
    } as MessageEvent<YearRequest>);

    expect(scope.postMessage).toHaveBeenCalledTimes(1);
    const [response, transfer] = vi.mocked(scope.postMessage).mock.calls[0]!;
    expect(response).toEqual({ id: 2, decoded: decodeYear(year) });
    expect(transfer).toHaveLength(8);
  });
});

describe("the module", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("installs no message handler in a page that imports it", () => {
    // Imported above, in a window: the page's own onmessage is untouched
    expect(globalThis.onmessage).toBeNull();
  });

  it("serves requests when it runs as a worker", async () => {
    const postMessage = vi.fn<(response: YearResponse) => void>();
    vi.stubGlobal("WorkerGlobalScope", class {});
    vi.stubGlobal("postMessage", postMessage);
    vi.stubGlobal("onmessage", null);
    vi.resetModules();

    await import("../../../../kml_heatmap/frontend/services/yearWorker");
    (globalThis as unknown as YearWorkerScope).onmessage!({
      data: { id: 9, bytes: yearBytes(year) },
    } as MessageEvent<YearRequest>);

    expect(postMessage.mock.calls[0]![0]).toMatchObject({ id: 9 });
  });

  it("exports what the page starts the worker with", () => {
    expect(createYearDecoder).toBeTypeOf("function");
  });
});
