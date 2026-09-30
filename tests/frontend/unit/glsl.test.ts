/**
 * The shaders a minified build ships (tightenGlsl and tightenShaders in
 * scripts/build-helpers.js). The unit tests of the layers compile nothing,
 * and the build only tightens the GLSL when it minifies, so what these
 * tests hold is the one check that the shipped shaders say what the
 * written ones say.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertExpectedOutputs,
  glslLiterals,
  tightenGlsl,
  tightenShaders,
} from "../../../scripts/build-helpers.js";

const UI_DIR = join(__dirname, "../../../kml_heatmap/frontend/ui");
const LAYERS = readdirSync(UI_DIR).filter((name) => /Layer\.ts$/.test(name));

/**
 * The tokens of GLSL, its comments and white space left out: a word or a
 * number, an operator of two characters, or any other character
 */
function tokens(glsl: string): string[] {
  const code = glsl.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  return (
    code.match(
      /[A-Za-z_]\w*|\d[\w.]*|\.\d\w*|\+\+|--|&&|\|\||<<|>>|[-+*/<>=!&|^%]=|\S/g,
    ) ?? []
  );
}

/** A literal's text between its delimiters, and where it meets a line */
function parts(raw: string): { text: string; open: boolean; close: boolean } {
  const close = raw.endsWith("${") ? 2 : 1;
  return {
    text: raw.slice(1, -close),
    open: raw[0] === "`",
    close: close === 1,
  };
}

describe("the shaders of the custom layers, tightened", () => {
  it("finds shaders in every layer that has them", () => {
    const found = LAYERS.filter(
      (name) =>
        glslLiterals(readFileSync(join(UI_DIR, name), "utf8")).length > 0,
    );
    expect(found).toEqual(
      expect.arrayContaining(["heatCloudLayer.ts", "replayAllLayer.ts"]),
    );
  });

  it.each(LAYERS)(
    "%s: are the same tokens as written, line for line",
    (name) => {
      const source = readFileSync(join(UI_DIR, name), "utf8");
      for (const { raw } of glslLiterals(source, name)) {
        const { text, open, close } = parts(raw);
        const tight = tightenGlsl(text, open, close);
        expect(tokens(tight)).toEqual(tokens(text));
        // The line numbers a compiler's error names stay where they were
        expect(tight.split("\n")).toHaveLength(text.split("\n").length);
        // A directive still starts its own line
        for (const line of tight.split("\n")) {
          if (line.includes("#")) expect(line).toMatch(/^#/);
        }
      }
    },
  );

  it.each(LAYERS)("%s: is left as it is outside its shaders", (name) => {
    const source = readFileSync(join(UI_DIR, name), "utf8");
    const tight = tightenShaders(source, name);
    // Every literal is tightened in place: what lies between them is
    // the source's own, byte for byte
    const literals = glslLiterals(source, name);
    const tightLiterals = glslLiterals(tight, name);
    expect(tightLiterals).toHaveLength(literals.length);
    let at = 0;
    let tightAt = 0;
    literals.forEach(({ start, end }, i) => {
      const other = tightLiterals[i]!;
      expect(tight.slice(tightAt, other.start)).toBe(source.slice(at, start));
      at = end;
      tightAt = other.end;
    });
    expect(tight.slice(tightAt)).toBe(source.slice(at));
  });
});

describe("tightenGlsl", () => {
  it("takes out the spaces around the punctuation that separates tokens", () => {
    expect(tightenGlsl("  x = f( a , b ) ;", true, true)).toBe("x=f(a,b);");
    expect(tightenGlsl("if (a < b && c) { d = e ? f : g; }", true, true)).toBe(
      "if(a<b&&c){d=e?f:g;}",
    );
  });

  it("keeps the space of a negation after a minus, and around + and -", () => {
    // "a--b" would be a decrement
    expect(tightenGlsl("a - -b", true, true)).toBe("a - -b");
    expect(tightenGlsl("c = a + +b;", true, true)).toBe("c=a + +b;");
  });

  it("leaves a directive as it is written", () => {
    // "#define A(b)" would be a macro of a parameter
    expect(tightenGlsl("#define A (b)", true, true)).toBe("#define A (b)");
    expect(tightenGlsl("x = 1;\n  #ifdef A\ny;", true, true)).toBe(
      "x=1;\n#ifdef A\ny;",
    );
  });

  it("keeps the lines of a block comment that spans them", () => {
    expect(tightenGlsl("a;/* one\ntwo */b;\nc;", true, true)).toBe(
      "a;\nb;\nc;",
    );
    // The comment that opens first wins, a // inside a block one included
    expect(tightenGlsl("a; /* // */ b; // c */\nd;", true, true)).toBe(
      "a;b;\nd;",
    );
  });

  it("keeps the space next to an interpolation, which may meet a word", () => {
    // `uniform ${type} u;`: the text around the value is not a line's end
    expect(tightenGlsl("uniform ", true, false)).toBe("uniform ");
    expect(tightenGlsl(" u;\n  v;", false, true)).toBe(" u;\nv;");
  });
});

describe("assertExpectedOutputs", () => {
  const outputs = (...names: string[]) => ({
    outputs: Object.fromEntries(
      names.map((name) => [`kml_heatmap/static/${name}`, {}]),
    ),
  });

  it("passes the files the site publishes, whatever else is written", () => {
    expect(() =>
      assertExpectedOutputs(
        [outputs("a.bundle.js", "a.bundle.js.map"), outputs("b.bundle.js")],
        ["b.bundle.js", "a.bundle.js"],
      ),
    ).not.toThrow();
  });

  it("fails on a chunk the site does not publish, and on one missing", () => {
    expect(() =>
      assertExpectedOutputs(
        [outputs("a.bundle.js", "shared.bundle.js", "shared.bundle2.js")],
        ["a.bundle.js", "shared.bundle.js"],
      ),
    ).toThrow(/wrote a\.bundle\.js, shared\.bundle\.js, shared\.bundle2\.js/);
    expect(() =>
      assertExpectedOutputs(
        [outputs("a.bundle.js"), undefined],
        ["a.bundle.js", "b.bundle.js"],
      ),
    ).toThrow(/publishes a\.bundle\.js, b\.bundle\.js/);
  });
});
