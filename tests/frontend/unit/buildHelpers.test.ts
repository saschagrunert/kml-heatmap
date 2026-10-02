/**
 * What build.js prints of the bundles and the flags it takes
 * (scripts/build-helpers.js). The shaders and the outputs the site
 * publishes are in glsl.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  inputDeltas,
  largestInputs,
  overrunSummary,
  parseBuildArgs,
} from "../../../scripts/build-helpers.js";

/** A metafile of one output and the bytes each input takes of it */
const metafile = (name: string, inputs: Record<string, number>) => ({
  outputs: {
    [`kml_heatmap/static/${name}`]: {
      bytes: Object.values(inputs).reduce((sum, bytes) => sum + bytes, 0),
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([input, bytesInOutput]) => [
          input,
          { bytesInOutput },
        ]),
      ),
    },
  },
});

describe("formatBytes", () => {
  it("names bytes, kilobytes and megabytes, and a change that shrank", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(-2048)).toBe("-2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
  });
});

describe("largestInputs", () => {
  it("lists the modules that take the most of a bundle first", () => {
    const { outputs } = metafile("a.js", { x: 5, y: 50, z: 20 });
    const output = outputs["kml_heatmap/static/a.js"]!;
    expect(largestInputs(output, 2)).toEqual([
      ["y", 50],
      ["z", 20],
    ]);
  });
});

describe("inputDeltas", () => {
  it("names what grew, shrank, came and went, the largest change first", () => {
    const before = metafile("a.js", { kept: 10, grown: 10, gone: 30 });
    const after = metafile("a.js", { kept: 10, grown: 15, new: 100 });
    expect(inputDeltas(before, after, "a.js")).toEqual({
      total: 125 - 50,
      inputs: [
        ["new", 100],
        ["gone", -30],
        ["grown", 5],
      ],
    });
  });

  it("takes a bundle one of the builds lacks for an empty one", () => {
    const after = metafile("a.js", { only: 7 });
    expect(inputDeltas({ outputs: {} }, after, "a.js")).toEqual({
      total: 7,
      inputs: [["only", 7]],
    });
  });
});

describe("parseBuildArgs", () => {
  it("reads the flags, with a default path for the metafile", () => {
    expect(parseBuildArgs([], "meta.json")).toEqual({
      watch: false,
      metafile: null,
      compare: null,
    });
    expect(parseBuildArgs(["--metafile", "--watch"], "meta.json")).toEqual({
      watch: true,
      metafile: "meta.json",
      compare: null,
    });
    expect(
      parseBuildArgs(
        ["--metafile", "out.json", "--compare", "old.json"],
        "meta.json",
      ),
    ).toEqual({ watch: false, metafile: "out.json", compare: "old.json" });
  });

  it("asks for the metafile to compare with", () => {
    expect(() => parseBuildArgs(["--compare"], "meta.json")).toThrow(
      /--compare needs the path of a metafile/,
    );
  });
});

describe("overrunSummary", () => {
  it("names each budget a bundle exceeds and the bytes over", () => {
    expect(
      overrunSummary([
        {
          what: "features.bundle.js",
          kind: "gzip",
          size: 53_288,
          budget: 53_248,
        },
        {
          what: "wrapped.bundle.js",
          kind: "raw",
          size: 44_100,
          budget: 44_032,
        },
        {
          what: "vendor/html-to-image.mjs",
          kind: "raw",
          size: NaN,
          budget: 14_336,
        },
      ]),
    ).toEqual([
      "❌ Bundle size budget exceeded:",
      "  features.bundle.js: 53288 B gzipped, budget 53248 B, 40 B over",
      "  wrapped.bundle.js: 44100 B raw, budget 44032 B, 68 B over",
      "  vendor/html-to-image.mjs: could not be measured",
    ]);
  });
});
