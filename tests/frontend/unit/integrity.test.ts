/**
 * The subresource integrity hashes of the CDN scripts match the packages in
 * node_modules.
 *
 * The page loads Leaflet, leaflet.heat and (on the first export) dom-to-image
 * from a CDN with an integrity attribute, and the e2e fixture serves the
 * node_modules copies in their place. A version bump that forgets a hash
 * would pass every test here and fail for every user with the browser's
 * integrity error, so the hashes are checked against the files they name.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOM_TO_IMAGE_INTEGRITY,
  DOM_TO_IMAGE_URL,
} from "../../../kml_heatmap/frontend/ui/uiToggles";

const REPO_ROOT = join(__dirname, "../../..");

function sha384(path: string): string {
  const digest = createHash("sha384")
    .update(readFileSync(join(REPO_ROOT, path)))
    .digest("base64");
  return `sha384-${digest}`;
}

/** The integrity attribute of the template tag whose URL contains `needle` */
function templateIntegrity(needle: string): string | undefined {
  const template = readFileSync(
    join(REPO_ROOT, "kml_heatmap/templates/map_template.html"),
    "utf8",
  );
  const tag = /<(?:script|link)\b[^>]*>/g;
  for (const [match] of template.matchAll(tag)) {
    if (!match.includes(needle)) continue;
    return /integrity="([^"]+)"/.exec(match)?.[1];
  }
  return undefined;
}

describe("subresource integrity", () => {
  it.each([
    ["leaflet@1.9.4/dist/leaflet.js", "node_modules/leaflet/dist/leaflet.js"],
    ["leaflet@1.9.4/dist/leaflet.css", "node_modules/leaflet/dist/leaflet.css"],
    [
      "leaflet.heat@0.2.0/dist/leaflet-heat.js",
      "node_modules/leaflet.heat/dist/leaflet-heat.js",
    ],
  ])("the template hash of %s matches %s", (url, file) => {
    expect(templateIntegrity(url)).toBe(sha384(file));
  });

  it("the dom-to-image hash matches the package the URL names", () => {
    const version = /dom-to-image@([\d.]+)\//.exec(DOM_TO_IMAGE_URL)?.[1];
    const pkg = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "node_modules/dom-to-image/package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(version).toBe(pkg.version);
    expect(DOM_TO_IMAGE_INTEGRITY).toBe(
      sha384("node_modules/dom-to-image/dist/dom-to-image.min.js"),
    );
  });
});
