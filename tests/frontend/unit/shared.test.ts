/**
 * The two bundles have to agree on what they share.
 *
 * mapApp.bundle.js publishes the modules in shared.ts on a global and the
 * build resolves features.bundle.js's imports of scripts/shared-modules.js
 * against it. If the two lists drift apart, an import resolves to undefined
 * at runtime, or a module gets a second copy with its own state, and neither
 * shows up until someone opens Replay or Wrapped.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHARED_GLOBAL,
  SHARED_MODULES,
} from "../../../scripts/shared-modules.js";
import { sharedModules } from "../../../kml_heatmap/frontend/shared";

const REPO_ROOT = join(__dirname, "../../..");

describe("the shared module registry", () => {
  it("publishes exactly the modules the build resolves against", () => {
    expect(Object.keys(sharedModules).sort()).toEqual(
      [...SHARED_MODULES].sort(),
    );
  });

  it("publishes a real module namespace for each of them", () => {
    for (const name of SHARED_MODULES) {
      const module = sharedModules[name];
      expect(module, name).toBeTypeOf("object");
      expect(Object.keys(module as object).length, name).toBeGreaterThan(0);
    }
  });

  it("puts them on the window under the name the build uses", () => {
    expect(window[SHARED_GLOBAL as "__kmlShared"]).toBe(sharedModules);
  });

  it("covers the modules that must not exist twice", () => {
    // Each of these holds state: a second copy would not be a duplicate so
    // much as a second, disagreeing instance
    for (const stateful of [
      "utils/domCache",
      "utils/toast",
      "ui/replayState",
    ]) {
      expect(SHARED_MODULES).toContain(stateful);
    }
  });

  it("is what the built feature bundle reads the stateful modules from", () => {
    // build.js fails when a module lands in both bundles, but that guard is
    // itself a few lines of build script. This looks at the artifact: the
    // modules that must exist once have to be read from the global, not
    // inlined a second time.
    const bundle = join(REPO_ROOT, "kml_heatmap/static/features.bundle.js");
    if (!existsSync(bundle) && !process.env["CI"]) return;
    const source = readFileSync(bundle, "utf8");

    for (const stateful of ["utils/domCache", "utils/toast"]) {
      expect(source, stateful).toContain(
        `${SHARED_GLOBAL}[${JSON.stringify(stateful)}]`,
      );
    }
    // The replay precondition lives in a shared module, so its text belongs
    // to the main bundle alone
    expect(source).not.toContain("Select exactly one flight with timing data");
  });

  it("is imported by the main bundle's entry point for its side effect", () => {
    const mapApp = readFileSync(
      join(REPO_ROOT, "kml_heatmap/frontend/mapApp.ts"),
      "utf8",
    );
    expect(mapApp).toContain('import "./shared"');
  });
});
