/**
 * The published page carries its third-party code itself.
 *
 * The map library and the image export library used to be loaded from
 * unpkg and jsdelivr with subresource integrity hashes. Nothing could check
 * those against the real CDN: the e2e fixture answers from node_modules, so
 * a moved path or changed bytes only showed up as a blank map for visitors.
 * scripts/vendor.js copies the files out of node_modules instead, which
 * makes the question a local one these tests can actually answer.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VENDOR_FILES,
  VENDOR_MODULES,
  VENDOR_PATCHES,
  applyVendorPatches,
  stripSourceMapComment,
} from "../../../scripts/vendor.js";
import { HTML_TO_IMAGE_URL } from "../../../kml_heatmap/frontend/ui/uiToggles";

const REPO_ROOT = join(__dirname, "../../..");
const VENDOR_DIR = join(REPO_ROOT, "kml_heatmap/static/vendor");
const TEMPLATE = readFileSync(
  join(REPO_ROOT, "kml_heatmap/templates/map_template.html"),
  "utf8",
);

/** vendor/ is a build output; `npm run build` fills it */
const built = existsSync(join(VENDOR_DIR, "maplibre-gl.mjs"));
const whenBuilt = built || process.env["CI"] ? it : it.skip;

describe("vendored third-party files", () => {
  it.each(Object.entries(VENDOR_FILES))(
    "%s is declared as a copy of node_modules/%s",
    (_published, source) => {
      expect(existsSync(join(REPO_ROOT, "node_modules", source))).toBe(true);
    },
  );

  whenBuilt(
    "copies every declared file byte for byte, up to a closing source map comment and its fixes",
    () => {
      for (const [published, source] of Object.entries(VENDOR_FILES)) {
        const copied = readFileSync(join(VENDOR_DIR, published));
        const original = readFileSync(join(REPO_ROOT, "node_modules", source));
        // The helpers themselves say what may be left off and changed, so
        // the two cannot disagree about the forms a closing comment takes
        expect(
          copied.equals(
            applyVendorPatches(
              stripSourceMapComment(original, published),
              published,
            ),
          ),
          `${published} differs`,
        ).toBe(true);
        if (Object.hasOwn(VENDOR_PATCHES, published)) continue;
        expect(
          original.subarray(0, copied.length).equals(copied),
          `${published} is not a prefix of its original`,
        ).toBe(true);
      }
    },
  );

  describe("the fixes of MapLibre", () => {
    const entry = (): Buffer =>
      readFileSync(
        join(REPO_ROOT, "node_modules", VENDOR_FILES["maplibre-gl.mjs"]!),
      );

    it("are made to vendored files only", () => {
      for (const published of Object.keys(VENDOR_PATCHES)) {
        expect(Object.keys(VENDOR_FILES)).toContain(published);
      }
    });

    it("each find their code once in the pinned version, and change it", () => {
      // What the build asks as well, which fails it once MapLibre changes
      const original = entry().toString("latin1");
      const patched = applyVendorPatches(entry(), "maplibre-gl.mjs").toString(
        "latin1",
      );
      for (const { find } of VENDOR_PATCHES["maplibre-gl.mjs"]!) {
        expect([
          ...original.matchAll(new RegExp(find.source, "g")),
        ]).toHaveLength(1);
        // Applied, a fix does not find its code again
        expect(patched).not.toMatch(find);
      }
      expect(patched).not.toBe(original);
    });

    it("keep the relief's tiles under a camera that looks at a point above it", () => {
      const patched = applyVendorPatches(entry(), "maplibre-gl.mjs").toString(
        "latin1",
      );
      // Mercator's box of a tile reaches up to the camera's centre, as the
      // globe's does already
      expect(
        patched.match(
          /getTileBoundingVolume\(\w+,\w+,\w+,\w+\)\{let \w+=Math\.min\(0,\w+\),(\w+)=[^}]*\}/g,
        )?.[0],
      ).toMatch(/(\w+)=Math\.max\(\w+\.maxElevation\?\?\1,\1\)/);
      // A tile that loads empty lets go of the raw data it held
      expect(patched).toMatch(
        /this\.collisionBoxArray=new \w+,this\.latestRawTileData=null,this\.latestEncoding=null;return\}/,
      );
    });

    it("fail loudly once the code they fix has changed", () => {
      const moved = Buffer.from(
        entry()
          .toString("latin1")
          .replace(/this\.collisionBoxArray=new/, "this.collisionBoxes=new"),
        "latin1",
      );
      expect(() => applyVendorPatches(moved, "maplibre-gl.mjs")).toThrow(
        /matches 0 places in maplibre-gl\.mjs/,
      );
      const twice = Buffer.concat([entry(), entry()]);
      expect(() => applyVendorPatches(twice, "maplibre-gl.mjs")).toThrow(
        /matches 2 places/,
      );
    });

    it("leave every byte around them as it was", () => {
      // Bytes that are no text in UTF-8 come back as they went in
      const tail = Buffer.from([0x0a, 0xc3, 0xa0, 0xff, 0x00]);
      const patched = applyVendorPatches(
        Buffer.concat([entry(), tail]),
        "maplibre-gl.mjs",
      );
      expect(patched.subarray(patched.length - tail.length).equals(tail)).toBe(
        true,
      );
      // A file without fixes is the very same buffer
      const css = Buffer.from("a{}");
      expect(applyVendorPatches(css, "maplibre-gl.css")).toBe(css);
    });
  });

  whenBuilt("no vendored file names a source map that is not shipped", () => {
    for (const published of Object.keys(VENDOR_FILES)) {
      if (!/\.(?:mjs|js|css)$/.test(published)) continue;
      const text = readFileSync(join(VENDOR_DIR, published), "utf8");
      for (const [, map] of text.matchAll(/sourceMappingURL=([^\s*"'`]+)/g)) {
        // Resolved against the file's own directory, as a browser would
        const shipped = posix.normalize(
          posix.join(posix.dirname(published), map!),
        );
        expect(
          Object.keys(VENDOR_FILES),
          `${published} names ${map}`,
        ).toContain(shipped);
      }
    }
  });

  it("the packages still name the maps that are left out", () => {
    // If this stops holding, stripSourceMapComment has nothing left to do
    const entry = readFileSync(
      join(REPO_ROOT, "node_modules", VENDOR_FILES["maplibre-gl.mjs"]!),
    );
    expect(stripSourceMapComment(entry).length).toBeLessThan(entry.length);
  });

  it.each([
    ["a line comment", "code();\n//# sourceMappingURL=a.js.map", "code();\n"],
    [
      "a trailing newline",
      "code();\n//# sourceMappingURL=a.js.map\n",
      "code();\n",
    ],
    ["a block comment", "a{}\n/*# sourceMappingURL=a.css.map */\n", "a{}\n"],
  ])("takes %s off the end of a file", (_name, input, expected) => {
    expect(stripSourceMapComment(Buffer.from(input)).toString()).toBe(expected);
  });

  it("leaves a sourceMappingURL that does not close the file alone", () => {
    const inCode =
      'const tail = "//# sourceMappingURL=a.js.map";\nrun(tail);\n';
    const twice = `//# sourceMappingURL=first.map\n${inCode}//# sourceMappingURL=last.map\n`;
    expect(stripSourceMapComment(Buffer.from(inCode)).toString()).toBe(inCode);
    expect(stripSourceMapComment(Buffer.from(twice)).toString()).toBe(
      `//# sourceMappingURL=first.map\n${inCode}`,
    );
  });

  it("only takes a comment that stands on a line of its own", () => {
    // Cutting here would leave the block comment open and the file broken
    const inBlock = "a{}\n/* built with //# sourceMappingURL=x.map*/\n";
    expect(stripSourceMapComment(Buffer.from(inBlock)).toString()).toBe(
      inBlock,
    );
    const afterCode = "run(); //# sourceMappingURL=x.map\n";
    expect(stripSourceMapComment(Buffer.from(afterCode)).toString()).toBe(
      afterCode,
    );
  });

  it("does not take a name every object inherits for a vendored file", () => {
    const input = "code();\n//# sourceMappingURL=constructor\n";
    expect(stripSourceMapComment(Buffer.from(input)).toString()).toBe(
      "code();\n",
    );
  });

  it("takes a comment off whose map has a name that is not ASCII", () => {
    const input = "code();\n//# sourceMappingURL=cart\u00e0.js.map\n";
    expect(stripSourceMapComment(Buffer.from(input, "utf8")).toString()).toBe(
      "code();\n",
    );
  });

  it("resolves the map against the directory the file is published in", () => {
    // `./` and a nested path both name the stylesheet that is vendored
    const dotted = "code();\n//# sourceMappingURL=./maplibre-gl.css\n";
    expect(
      stripSourceMapComment(Buffer.from(dotted), "maplibre-gl.mjs").toString(),
    ).toBe(dotted);
    const nested = "code();\n//# sourceMappingURL=../maplibre-gl.css\n";
    expect(
      stripSourceMapComment(Buffer.from(nested), "sub/a.js").toString(),
    ).toBe(nested);
    expect(stripSourceMapComment(Buffer.from(nested), "a.js").toString()).toBe(
      "code();\n",
    );
  });

  it("keeps a comment whose map is vendored, and bytes that are not text", () => {
    const shipped = "code();\n//# sourceMappingURL=maplibre-gl.css\n";
    expect(stripSourceMapComment(Buffer.from(shipped)).toString()).toBe(
      shipped,
    );
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a]);
    expect(stripSourceMapComment(binary).equals(binary)).toBe(true);
  });

  it("maplibre-gl.css needs no file beside itself", () => {
    const css = readFileSync(
      join(REPO_ROOT, "node_modules/maplibre-gl/dist/maplibre-gl.css"),
      "utf8",
    );
    const referenced = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) =>
      match[1]!.replace(/^["']/, ""),
    );
    // Its icons are inlined; an `images/` directory would have to be
    // vendored with it, as Leaflet's was
    expect(referenced.length).toBeGreaterThan(0);
    for (const url of referenced) expect(url.startsWith("data:")).toBe(true);
  });

  it("carries the modules MapLibre loads by their relative names", () => {
    const entry = readFileSync(
      join(REPO_ROOT, "node_modules/maplibre-gl/dist/maplibre-gl.mjs"),
      "utf8",
    );
    // The entry imports the shared module and starts the worker from a URL
    // relative to its own, so both have to be published under these names
    const siblings = new Set(
      [...entry.matchAll(/maplibre-gl[\w-]*\.mjs/g)].map((match) => match[0]),
    );
    // The -dev worker is only named for the -dev build, which is not shipped
    siblings.delete("maplibre-gl-worker-dev.mjs");
    expect(siblings).toContain("maplibre-gl-shared.mjs");
    expect(siblings).toContain("maplibre-gl-worker.mjs");
    for (const name of siblings) {
      expect(Object.keys(VENDOR_FILES)).toContain(name);
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

  it("html-to-image is imported from the site, not from a CDN", () => {
    expect(HTML_TO_IMAGE_URL).toBe("./vendor/html-to-image.mjs");
    expect(Object.keys(VENDOR_MODULES)).toContain(
      posix.basename(HTML_TO_IMAGE_URL),
    );
  });
});

describe("vendored modules that are bundled from their package", () => {
  const lock = JSON.parse(
    readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8"),
  ) as { packages: Record<string, { version: string }> };

  it.each(Object.entries(VENDOR_MODULES))(
    "%s comes from a package that has a module entry point",
    (_published, name) => {
      const manifest = JSON.parse(
        readFileSync(
          join(REPO_ROOT, "node_modules", name, "package.json"),
          "utf8",
        ),
      ) as { module?: string };

      expect(
        existsSync(join(REPO_ROOT, "node_modules", name, manifest.module!)),
      ).toBe(true);
    },
  );

  whenBuilt(
    "each is one module that names its package, version and licence",
    () => {
      for (const [published, name] of Object.entries(VENDOR_MODULES)) {
        const text = readFileSync(join(VENDOR_DIR, published), "utf8");
        const { version } = lock.packages[`node_modules/${name}`]!;
        expect(text.startsWith(`/* ${name} ${version}, MIT licence, `)).toBe(
          true,
        );
        // One file: nothing left to import, and no map the site lacks. The
        // lookbehind spares the CSS at-rule, which html-to-image handles.
        expect(text).not.toMatch(/(?<![@\w.$])import\s*[{("'*]/);
        expect(text).not.toContain("sourceMappingURL");
      }
    },
  );

  whenBuilt("html-to-image exports what the export uses", async () => {
    const library = (await import(
      /* @vite-ignore */ join(VENDOR_DIR, "html-to-image.mjs")
    )) as Record<string, unknown>;

    expect(library["toJpeg"]).toBeTypeOf("function");
  });
});
