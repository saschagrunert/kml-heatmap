/**
 * The loading indicator shows how much of a year file has arrived.
 *
 * `route.fulfill` hands over a whole body at once, so a half loaded file
 * cannot be staged with it. The year file is sent to a small server of the
 * spec's own instead, which writes a bit more than half of it and holds the
 * rest until the spec has looked at the indicator. Nothing here waits on a
 * timer: the page is held at a known share for as long as the assertions
 * take. The redirection happens below the page, which still sees a same
 * origin answer to the URL it asked for.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";
import { readSiteBytes, readSiteFile } from "./site-check";
import { SITES } from "./sites";

/** Share of the file sent before the hold; the bar shows the step below it */
const SHARE_SENT = 0.55;

/** What the bar is drawn from, 0 to 1; NaN while it has no share */
const drawnShare = (bar: Locator): Promise<number> =>
  bar.evaluate((element) =>
    parseFloat(element.style.getPropertyValue("--loading-progress")),
  );

let server: Server | undefined;

test.afterEach(async () => {
  await new Promise((resolve) => {
    if (!server) return resolve(undefined);
    server.closeAllConnections();
    server.close(resolve);
  });
  server = undefined;
});

test("the indicator fills while the year file arrives", async ({
  page,
  site,
}) => {
  // The files on disk of the very site the project serves
  const siteFiles = SITES[site];
  const metadata = JSON.parse(
    readSiteFile(siteFiles, "data/metadata.json"),
  ) as {
    available_years: number[];
    year_file_bytes: Record<string, number>;
  };
  const latest = Math.max(...metadata.available_years);
  const file = readSiteBytes(siteFiles, `data/${latest}/data.json`);
  // The total the bar is measured against is the size on disk
  expect(metadata.year_file_bytes[String(latest)]).toBe(file.length);

  const cut = Math.ceil(file.length * SHARE_SENT);

  let release = (): void => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let served = 0;
  server = createServer((_request, response) => {
    served++;
    // No Content-Length: the page has to take the total from the metadata
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write(file.subarray(0, cut));
    void released.then(() => response.end(file.subarray(cut)));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await page.route(`**/data/${latest}/data.json`, (route) =>
    route.continue({ url: `http://127.0.0.1:${port}/data.json` }),
  );

  await page.goto("/index.html");

  const indicator = page.locator("#loading");
  const bar = page.locator("#loading-progress");
  // Waits for the share itself: the step of 50 is reached by any frame drawn
  // from 50% on, which need not be the last one before the hold
  await expect.poll(() => drawnShare(bar)).toBeCloseTo(cut / file.length, 6);
  await expect(bar).toHaveAttribute("aria-valuenow", "50");
  await expect(indicator).toBeVisible();
  await expect(indicator).toContainText(`Loading ${latest} flights`);
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("aria-valuemin", "0");
  await expect(bar).toHaveAttribute("aria-valuemax", "100");
  await expect(bar).toHaveAccessibleName("Download progress");
  const drawn = await bar.evaluate((element) => ({
    track: element.getBoundingClientRect().width,
    fill: parseFloat(getComputedStyle(element).backgroundSize),
  }));
  // The fill is drawn, not only described: the computed size is a percentage
  expect(drawn.fill).toBeCloseTo(SHARE_SENT * 100, 1);
  expect(drawn.track).toBeGreaterThan(0);

  release();
  await waitForAppReady(page);

  await expect(indicator).toBeHidden();
  await expect(bar).not.toHaveAttribute("aria-valuenow");
  await expect(bar).toHaveAttribute("hidden", "");
  // The preload and the loader's fetch are still one request
  expect(served).toBe(1);
  const segments = await page.evaluate(
    () => window.mapApp!.currentData?.path_segments.length ?? 0,
  );
  expect(segments).toBeGreaterThan(0);
});
