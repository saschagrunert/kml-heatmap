/**
 * The page's side of the year worker (services/yearWorker.ts).
 *
 * Parsing and decoding a year file of a few megabytes took the main thread
 * some tens of milliseconds per year, in one piece. The worker does both and
 * answers with typed arrays, from which the dataset is built a slice at a
 * time (services/yearDataset.ts). One worker serves every year; it is
 * started with the first year file and ended with the app.
 *
 * This module is part of yearWorker.bundle.js like everything else that
 * works on year data, so that a first visit does not download it with the
 * app: the page imports that file (services/dataLoader.ts), and the file
 * starts itself a second time as the worker. That also puts the decoder at
 * hand here: a worker that does not start (an old browser, a blocked
 * script), that reports an error or that does not answer is given up on for
 * the rest of the visit, and the years are decoded on the main thread.
 */

import { logError } from "../utils/logger";
import { decodeYearBytes } from "./yearDecode";
import { buildDatasetInSlices, combineYearData } from "./yearDataset";
import type { KMLDataset } from "../types";
import type { YearRequest, YearResponse } from "./yearWorker";

/**
 * How long the worker may take over one year. Decoding takes it some
 * milliseconds, so this only ever ends a wait for a worker that hangs.
 */
const DECODE_TIMEOUT_MS = 30_000;

/** As much of a Worker as the decoder uses, so that tests can stand in */
export type YearWorkerLike = Pick<
  Worker,
  "postMessage" | "terminate" | "addEventListener"
>;

export interface YearDecoderOptions {
  /** Starts the worker; throws where there are no module workers */
  createWorker?: () => YearWorkerLike;
  timeoutMs?: number;
}

export interface YearDecoder {
  /**
   * Turn the body of a year file into its dataset
   * @param bytes - Body of <year>/data.json
   * @returns Rejects for a file that cannot be decoded
   */
  decode(bytes: ArrayBuffer): Promise<KMLDataset>;
  /** combineYearData of services/yearDataset.ts */
  combine: typeof combineYearData;
  /** End the worker, and the wait of whoever still waits for it */
  destroy(): void;
}

/**
 * The bundle is one file, so the URL of this module is the URL of the
 * worker, under whichever name the page imported it
 */
const startWorker = (): YearWorkerLike =>
  new Worker(import.meta.url, { type: "module" });

/**
 * Ends the wait for one answer of the worker: with the answer, with null
 * when the main thread has to decode instead, or with why there is none
 */
type Settle = (answer: YearResponse | Error | null) => void;

/**
 * Start the year worker
 * @param options - Stand-ins for tests
 * @returns What decodes the year files of one app
 */
export function createYearDecoder(
  options: YearDecoderOptions = {},
): YearDecoder {
  const { createWorker = startWorker, timeoutMs = DECODE_TIMEOUT_MS } = options;
  let worker: YearWorkerLike | null = null;
  /** Set once the worker has been given up on, or the app has ended */
  let workerDone = false;
  let destroyed = false;
  let nextId = 0;
  const pending = new Map<number, Settle>();

  /** Settle every request without an answer; none is waited for after */
  const settleAll = (answer: Error | null): void => {
    for (const settle of [...pending.values()]) settle(answer);
  };

  /** Stop using the worker; what it still owed is decoded here */
  const giveUpOnWorker = (reason: unknown): void => {
    if (workerDone) return;
    workerDone = true;
    logError("Year worker failed, decoding on the main thread:", reason);
    worker?.terminate();
    worker = null;
    settleAll(null);
  };

  /** The worker's answer; null when the main thread has to decode */
  const askWorker = (
    target: YearWorkerLike,
    bytes: ArrayBuffer,
  ): Promise<YearResponse | null> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const settle: Settle = (answer) => {
        pending.delete(id);
        clearTimeout(timer);
        if (answer instanceof Error) reject(answer);
        else resolve(answer);
      };
      const timer = setTimeout(() => giveUpOnWorker("no answer"), timeoutMs);
      pending.set(id, settle);
      // Copied, not transferred: the copy is a fraction of a millisecond,
      // and the bytes are still here if the worker fails over them
      const request: YearRequest = { id, bytes };
      try {
        target.postMessage(request);
      } catch (error) {
        giveUpOnWorker(error);
      }
    });

  try {
    worker = createWorker();
    worker.addEventListener("message", (event) => {
      const answer = (event as MessageEvent<YearResponse>).data;
      pending.get(answer.id)?.(answer);
    });
    // A script that did not load, or an error nobody caught in it
    worker.addEventListener("error", (event) => giveUpOnWorker(event.message));
    worker.addEventListener("messageerror", giveUpOnWorker);
  } catch (error) {
    giveUpOnWorker(error);
  }

  return {
    async decode(bytes) {
      if (destroyed) throw new Error("year decoder destroyed");
      const answer = worker ? await askWorker(worker, bytes) : null;
      let decoded = answer && "decoded" in answer ? answer.decoded : null;
      if (!decoded) {
        // A file the worker failed over is decoded again: if the file is
        // at fault it fails the same way, with the error and not its text
        if (answer && "error" in answer) {
          logError("Year worker could not decode:", answer.error);
        }
        decoded = decodeYearBytes(bytes);
      }
      for (const warning of decoded.warnings) console.warn(warning);
      return buildDatasetInSlices(decoded);
    },
    combine: combineYearData,
    destroy() {
      destroyed = workerDone = true;
      worker?.terminate();
      worker = null;
      settleAll(new Error("year decoder destroyed"));
    },
  };
}
