/**
 * The year worker: parses and decodes year files off the main thread, and
 * writes the content of the heat sources (services/heatSource.ts).
 *
 * An entry point of its own (yearWorker.bundle.js, see build.js), run as a
 * module worker of the site's own origin, which the page's CSP allows with
 * `worker-src 'self'`. The page imports the same file first: for what has to
 * be done to year data on the main thread (starting this worker, building
 * and combining the datasets), and to decode there when the worker cannot be
 * used. So all of it exists once, and outside of what a first visit
 * downloads with the app. Imported like that the file only exports: the
 * message handler is installed in a worker and nowhere else.
 */

import { decodeYearBytes } from "./yearDecode";
import { transferablesOf } from "./yearDataset";
import { createYearDecoder } from "./yearDecoder";
import {
  drawHeat,
  linesSource,
  type DrawnHeat,
  type FlatLines,
} from "./heatSource";
import type { DecodedYear } from "./yearDataset";

// What the page uses of this file (services/dataLoader.ts)
export { createYearDecoder };

/**
 * What the page sends, under a number of its choice: the body of a year
 * file, the heat of a heat source (see drawHeat) or the lines of the heat
 * line source (see linesSource)
 */
export type YearRequest = { id: number } & (
  { bytes: ArrayBuffer } | { heat: Float64Array } | { lines: FlatLines }
);

/** What the worker answers with, under the number of the request */
export type YearResponse = { id: number } & (
  | { decoded: DecodedYear }
  | { drawn: DrawnHeat }
  | { source: Blob }
  | { error: string }
);

/**
 * Answer one request. A file that cannot be decoded is an answer like any
 * other, so that one bad year does not take the worker down for the rest.
 * A Blob is sent as it is: the page is given a handle, not a copy.
 * @param request - Message of the page
 * @returns The answer and the buffers to hand over with it
 */
export function handleRequest(request: YearRequest): {
  response: YearResponse;
  transfer: ArrayBuffer[];
} {
  const { id } = request;
  try {
    if ("heat" in request) {
      return { response: { id, drawn: drawHeat(request.heat) }, transfer: [] };
    }
    if ("lines" in request) {
      return {
        response: { id, source: linesSource(request.lines) },
        transfer: [],
      };
    }
    const decoded = decodeYearBytes(request.bytes);
    return { response: { id, decoded }, transfer: transferablesOf(decoded) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { response: { id, error: message }, transfer: [] };
  }
}

/** As much of a worker's global scope as this file uses */
export interface YearWorkerScope {
  onmessage: ((event: MessageEvent<YearRequest>) => void) | null;
  postMessage(message: YearResponse, transfer: Transferable[]): void;
}

/**
 * Answer the requests that arrive in `scope`
 * @param scope - Global scope of the worker
 */
export function serveRequests(scope: YearWorkerScope): void {
  scope.onmessage = (event) => {
    const { response, transfer } = handleRequest(event.data);
    scope.postMessage(response, transfer);
  };
}

// Only a worker has this constructor; a page that imports the file does not
if ("WorkerGlobalScope" in globalThis) {
  serveRequests(globalThis as unknown as YearWorkerScope);
}
