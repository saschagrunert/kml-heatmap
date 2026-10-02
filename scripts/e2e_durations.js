#!/usr/bin/env node
/**
 * The slowest e2e tests of one or more runs, from the report the JSON
 * reporter of playwright.config.ts writes in CI (test-results/e2e-timings.json,
 * in the e2e-timings-* artifacts of every e2e job). A test that creeps up on
 * its timeout shows here before it times out.
 *
 *   node scripts/e2e_durations.js [--limit N] <e2e-timings.json>...
 *
 * Each attempt of a test is listed with its project, since a test runs in
 * several and a retry is an attempt of its own. No dependencies, so it runs
 * on a downloaded artifact without `npm ci`.
 */
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The parts of Playwright's JSON report read here
 * @typedef {{ duration: number; status: string; retry: number }} Result
 * @typedef {{ projectName: string; timeout: number; results: Result[] }} Test
 * @typedef {{ title: string; file: string; line: number; tests: Test[] }} Spec
 * @typedef {{ title: string; specs?: Spec[]; suites?: Suite[] }} Suite
 * @typedef {{ suites?: Suite[] }} Report
 */

/**
 * @typedef {object} Attempt
 * @property {number} duration In milliseconds
 * @property {number} timeout The test's budget, 0 for none
 * @property {string} status
 * @property {number} retry
 * @property {string} project
 * @property {string} title The describes and the test, joined
 * @property {string} where The spec file and line
 */

const USAGE = "usage: node scripts/e2e_durations.js [--limit N] <file>...";

/**
 * Every attempt of every test under `suite`, with the titles of the
 * describes it sits in
 * @param {Suite} suite
 * @param {string[]} titles
 * @returns {Attempt[]}
 */
export function attempts(suite, titles) {
  // The file's own suite is titled with the file name, which `where` says
  const path =
    suite.title && !suite.title.endsWith(".ts")
      ? [...titles, suite.title]
      : titles;
  const own = (suite.specs ?? []).flatMap((spec) =>
    spec.tests.flatMap((test) =>
      test.results.map((result) => ({
        duration: result.duration,
        timeout: test.timeout,
        status: result.status,
        retry: result.retry,
        project: test.projectName,
        title: [...path, spec.title].join(" › "),
        where: `${basename(spec.file)}:${spec.line}`,
      })),
    ),
  );
  return [
    ...own,
    ...(suite.suites ?? []).flatMap((child) => attempts(child, path)),
  ];
}

/**
 * @param {number} ms
 * @returns {string}
 */
function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The arguments: the files, and how many attempts to list; null for
 * --help
 * @param {string[]} args
 * @returns {{ files: string[]; limit: number } | null}
 */
export function parseArgs(args) {
  const files = [];
  let limit = 20;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--limit") {
      limit = Number(args[++i]);
      if (!Number.isInteger(limit) || limit < 1) throw new Error(USAGE);
    } else if (arg === "-h" || arg === "--help") {
      return null;
    } else if (arg !== undefined) {
      files.push(arg);
    }
  }
  if (files.length === 0) throw new Error(USAGE);
  return { files, limit };
}

/**
 * The lines the script prints for the reports `files`: the `limit`
 * slowest attempts, then how many there were
 * @param {Report[]} reports
 * @param {number} limit
 * @returns {string[]}
 */
export function slowestAttempts(reports, limit) {
  const all = reports.flatMap((report) =>
    (report.suites ?? []).flatMap((suite) => attempts(suite, [])),
  );
  const slowest = all.sort((a, b) => b.duration - a.duration).slice(0, limit);
  const lines = slowest.map((attempt) => {
    // How much of its budget the attempt took, where it had one
    const share = attempt.timeout
      ? ` ${Math.round((attempt.duration / attempt.timeout) * 100)}%`.padStart(
          5,
        )
      : "     ";
    const retry = attempt.retry ? ` (retry ${attempt.retry})` : "";
    return `${seconds(attempt.duration).padStart(8)}${share}  ${attempt.status.padEnd(9)} [${attempt.project}] ${attempt.where} ${attempt.title}${retry}`;
  });
  return [...lines, `${all.length} attempts in ${reports.length} file(s)`];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.log(USAGE);
    return;
  }
  /** @type {Report[]} */
  const reports = args.files.map((file) =>
    JSON.parse(readFileSync(file, "utf8")),
  );
  for (const line of slowestAttempts(reports, args.limit)) console.log(line);
}

// Run as a script, not when a test imports it
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
