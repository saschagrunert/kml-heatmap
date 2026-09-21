/**
 * The published page carries its third-party code itself.
 *
 * Leaflet, leaflet.heat and the image export library used to be loaded from
 * unpkg and jsdelivr with subresource integrity hashes. Nothing could check
 * those against the real CDN: the e2e fixture answers from node_modules, so
 * a moved path or changed bytes only showed up as a blank map for visitors.
 * scripts/vendor.js copies the files out of node_modules instead, which
 * makes the question a local one these tests can actually answer.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VENDOR_FILES } from "../../../scripts/vendor.js";
import { HTML_TO_IMAGE_URL } from "../../../kml_heatmap/frontend/ui/uiToggles";

const REPO_ROOT = join(__dirname, "../../..");
const VENDOR_DIR = join(REPO_ROOT, "kml_heatmap/static/vendor");
const TEMPLATE = readFileSync(
  join(REPO_ROOT, "kml_heatmap/templates/map_template.html"),
  "utf8",
);

/** vendor/ is a build output; `npm run build` fills it */
const built = existsSync(join(VENDOR_DIR, "leaflet.js"));
const whenBuilt = built || process.env["CI"] ? it : it.skip;

describe("vendored third-party files", () => {
  it.each(Object.entries(VENDOR_FILES))(
    "%s is declared as a copy of node_modules/%s",
    (_published, source) => {
      expect(existsSync(join(REPO_ROOT, "node_modules", source))).toBe(true);
    },
  );

  whenBuilt("copies every declared file byte for byte", () => {
    for (const [published, source] of Object.entries(VENDOR_FILES)) {
      const copied = readFileSync(join(VENDOR_DIR, published));
      const original = readFileSync(join(REPO_ROOT, "node_modules", source));
      expect(copied.equals(original), `${published} differs`).toBe(true);
    }
  });

  it("covers the images leaflet.css asks for", () => {
    const css = readFileSync(
      join(REPO_ROOT, "node_modules/leaflet/dist/leaflet.css"),
      "utf8",
    );
    const referenced = [...css.matchAll(/url\((images\/[^)]+)\)/g)].map(
      (match) => match[1]!,
    );
    expect(referenced.length).toBeGreaterThan(0);
    for (const image of referenced) {
      expect(Object.keys(VENDOR_FILES)).toContain(image);
    }
  });
});

describe("the page loads nothing from a third party", () => {
  it.each(["unpkg.com", "cdn.jsdelivr.net"])(
    "the template does not mention %s",
    (host) => {
      expect(TEMPLATE).not.toContain(host);
    },
  );

  it("every script and stylesheet the template loads is relative", () => {
    const tags = TEMPLATE.matchAll(/<(?:script|link)\b[^>]*>/g);
    for (const [tag] of tags) {
      const url = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1];
      // <link rel="preconnect"> names an origin on purpose; only fetched
      // subresources have to be same-origin
      if (!url || /rel="(?:preconnect|dns-prefetch)"/.test(tag)) continue;
      expect(url, `${tag} is not same-origin`).not.toMatch(/^https?:/);
    }
  });

  it("the CSP allows scripts and styles from the page itself only", () => {
    const csp = /content="(default-src[^"]+)"/.exec(TEMPLATE)?.[1];
    expect(csp).toBeDefined();
    const directive = (name: string) =>
      csp!
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(name));

    expect(directive("script-src")).toBe("script-src 'self'");
    // No 'unsafe-inline': the page sets its data-driven colours through the
    // CSSOM, which the policy does not govern, never through style attributes
    expect(directive("style-src")).toBe("style-src 'self'");
    // Nothing is read from disk: the page is served, never opened as a file
    expect(csp).not.toContain("file:");
    // The map tiles are the only third party left
    expect(csp).not.toContain("unpkg.com");
    expect(csp).not.toContain("jsdelivr");
  });

  it("html-to-image is loaded from the site, not from a CDN", () => {
    expect(HTML_TO_IMAGE_URL).toBe("./vendor/html-to-image.js");
  });
});
