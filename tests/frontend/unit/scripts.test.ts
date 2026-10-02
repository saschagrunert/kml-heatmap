/**
 * The build scripts without a test file of their own: the slowest e2e tests
 * of a CI run (scripts/e2e_durations.js) and the hash of the sources every
 * bundle carries (scripts/source-hash.js, which tests/test_site_assets.py
 * also holds to its Python mirror).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attempts,
  parseArgs,
  slowestAttempts,
} from "../../../scripts/e2e_durations.js";
import {
  BANNER_PATTERN,
  buildBanner,
  computeSourceHash,
} from "../../../scripts/source-hash.js";

/** A report of one spec file with a describe, as Playwright's JSON reporter writes */
const report = {
  suites: [
    {
      title: "replay.spec.ts",
      specs: [
        {
          title: "starts",
          file: "tests/e2e/replay.spec.ts",
          line: 12,
          tests: [
            {
              projectName: "desktop",
              timeout: 45000,
              results: [
                { duration: 9000, status: "failed", retry: 0 },
                { duration: 4500, status: "passed", retry: 1 },
              ],
            },
          ],
        },
      ],
      suites: [
        {
          title: "Replay all",
          specs: [
            {
              title: "plays",
              file: "tests/e2e/replay.spec.ts",
              line: 40,
              tests: [
                {
                  projectName: "mobile",
                  timeout: 0,
                  results: [{ duration: 30000, status: "passed", retry: 0 }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("e2e_durations", () => {
  it("lists every attempt with its project and describes", () => {
    const listed = report.suites.flatMap((suite) => attempts(suite, []));
    expect(listed.map((attempt) => [attempt.title, attempt.where])).toEqual([
      ["starts", "replay.spec.ts:12"],
      ["starts", "replay.spec.ts:12"],
      ["Replay all › plays", "replay.spec.ts:40"],
    ]);
  });

  it("prints the slowest first, with the share of their timeout", () => {
    expect(slowestAttempts([report, {}], 2)).toEqual([
      "  30.0 s       passed    [mobile] replay.spec.ts:40 Replay all › plays",
      "   9.0 s  20%  failed    [desktop] replay.spec.ts:12 starts",
      "3 attempts in 2 file(s)",
    ]);
    expect(slowestAttempts([report], 3)[2]).toBe(
      "   4.5 s  10%  passed    [desktop] replay.spec.ts:12 starts (retry 1)",
    );
  });

  it("reads the files and the limit, and refuses neither", () => {
    expect(parseArgs(["a.json", "--limit", "5", "b.json"])).toEqual({
      files: ["a.json", "b.json"],
      limit: 5,
    });
    expect(parseArgs(["a.json"])).toEqual({ files: ["a.json"], limit: 20 });
    expect(parseArgs(["--help"])).toBeNull();
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["a.json", "--limit", "0"])).toThrow(/usage/);
  });

  it("runs as a script through a symlink as well", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-durations-"));
    try {
      const link = join(dir, "durations.js");
      symlinkSync(resolve("scripts/e2e_durations.js"), link);
      const out = execFileSync(process.execPath, [link, "--help"], {
        encoding: "utf8",
      });
      expect(out).toMatch(/^usage: /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("source-hash", () => {
  it("hashes the sources into the banner every bundle starts with", () => {
    const hash = computeSourceHash();

    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(computeSourceHash()).toBe(hash);
    expect(buildBanner(hash).match(BANNER_PATTERN)?.[1]).toBe(hash);
  });
});
