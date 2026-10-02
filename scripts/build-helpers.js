/**
 * The parts of build.js that do no building: the shaders written as a
 * minified build ships them, the sizes of the files and what esbuild
 * wrote, the composition of a bundle and its comparison with an earlier
 * build, and the flags of the command. build.js runs a build as it is
 * imported, so what is tested lives here
 * (tests/frontend/unit/glsl.test.ts, tests/frontend/unit/buildHelpers.test.ts).
 */

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import ts from "typescript";

/**
 * GLSL as a minified build ships it: `text` without its comments, and each
 * line without its indentation and the spaces around the punctuation that
 * separates tokens anyway. Not around + and -, where "a - -b" would become
 * a decrement, and not in a directive, where "#define A (b)" would become a
 * macro of a parameter. The lines stay lines, for the preprocessor and for
 * the line numbers a compiler's error names. `open` and `close` say
 * whether the text starts or ends a line rather than meets an
 * interpolation, whose value a space may separate from a word.
 * @param {string} text
 * @param {boolean} open
 * @param {boolean} close
 * @returns {string}
 */
export function tightenGlsl(text, open, close) {
  const lines = text
    // Whichever comment opens first, a block one as a space or the breaks
    // of the lines it spans
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (comment) =>
      comment.startsWith("//") ? "" : comment.replace(/[^\n]+/g, " "),
    )
    .split("\n");
  return lines
    .map((line, i) => {
      let tight = line.replace(/[ \t]+/g, " ");
      if (!/^ ?#/.test(tight)) {
        tight = tight.replace(/ ?([=,;(){}[\]*/<>?:&|!]) ?/g, "$1");
      }
      if (i > 0 || open) tight = tight.trimStart();
      if (i < lines.length - 1 || close) tight = tight.trimEnd();
      return tight;
    })
    .join("\n");
}

/**
 * The parts of the template literals of `source` that hold GLSL, in the
 * order they are written: the text of a literal without substitutions, or
 * of the head and each span of one with them. A literal is taken for GLSL
 * where its text holds "gl_" or "uniform ", and only its text, never the
 * expressions it interpolates.
 * @param {string} source
 * @param {string} [path] - For the parser's messages
 * @returns {{start: number, end: number, raw: string}[]}
 */
export function glslLiterals(source, path = "shader.ts") {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
  /** @type {{start: number, end: number, raw: string}[]} */
  const parts = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    const literals = ts.isTemplateExpression(node)
      ? [node.head, ...node.templateSpans.map((span) => span.literal)]
      : ts.isNoSubstitutionTemplateLiteral(node)
        ? [node]
        : [];
    if (/gl_|uniform /.test(literals.map((part) => part.text).join(""))) {
      for (const part of literals) {
        const start = part.getStart(file);
        parts.push({
          start,
          end: part.end,
          raw: source.slice(start, part.end),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return parts;
}

/**
 * `source` with the GLSL of its template literals tightened (tightenGlsl):
 * what the shader plugin of build.js hands esbuild for a ui/*Layer.ts or
 * ui/*Shaders.ts.
 * @param {string} source
 * @param {string} [path]
 * @returns {string}
 */
export function tightenShaders(source, path) {
  // From the end, so the offsets of those before stay where they were
  const parts = glslLiterals(source, path).sort((a, b) => b.end - a.end);
  let contents = source;
  for (const { start, end, raw } of parts) {
    // Between the backtick or the brace it opens with and the backtick or
    // "${" it closes with
    const close = raw.endsWith("${") ? 2 : 1;
    const text = tightenGlsl(raw.slice(1, -close), raw[0] === "`", close === 1);
    contents =
      contents.slice(0, start + 1) + text + contents.slice(end - close);
  }
  return contents;
}

/**
 * Format bytes to human-readable size
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Size of a file as written and gzipped at the highest level
 * @param {string} path
 * @returns {{raw: number, gzip: number}}
 */
export function measure(path) {
  const content = readFileSync(path);
  return {
    raw: content.length,
    gzip: gzipSync(content, { level: 9 }).length,
  };
}

/**
 * Fail the build when it wrote any JavaScript but `expected`.
 *
 * The site publishes the bundles by name (SITE_FILES in
 * kml_heatmap/site_assets.py) and the page preloads the shared chunk by
 * name. A module the lazy entry points share without the app, another
 * entry point or a second dynamic import would make esbuild write further
 * chunks, all called shared.bundle.js; that has to be a decision about
 * naming, not a surprise.
 * @param {({outputs: Record<string, unknown>} | undefined)[]} metafiles
 * @param {string[]} expected - The names of the files the site publishes
 */
export function assertExpectedOutputs(metafiles, expected) {
  const written = metafiles
    .flatMap((metafile) => Object.keys(metafile?.outputs ?? {}))
    .filter((path) => path.endsWith(".js"))
    .map((path) => path.slice(path.lastIndexOf("/") + 1))
    .sort();
  const wanted = [...expected].sort();
  if (written.join() !== wanted.join()) {
    throw new Error(
      `the build wrote ${written.join(", ")} but the site publishes ` +
        `${wanted.join(", ")}; see chunkNames in build.js`,
    );
  }
}

/**
 * @typedef {object} Output
 * @property {number} bytes
 * @property {Record<string, {bytesInOutput: number}>} inputs
 */

/**
 * The output of a metafile that is the file `fileName`, whichever
 * directory it was written to
 * @param {{outputs: Record<string, Output>}} metafile
 * @param {string} fileName
 * @returns {Output | undefined}
 */
export function outputNamed(metafile, fileName) {
  return Object.entries(metafile.outputs).find(([path]) =>
    path.endsWith(`/${fileName}`),
  )?.[1];
}

/**
 * The inputs that take the most of an output, largest first
 * @param {Output} output
 * @param {number} [count]
 * @returns {[input: string, bytes: number][]}
 */
export function largestInputs(output, count = 10) {
  return Object.entries(output.inputs)
    .map(
      ([input, { bytesInOutput }]) =>
        /** @type {[string, number]} */ ([input, bytesInOutput]),
    )
    .sort(([, a], [, b]) => b - a)
    .slice(0, count);
}

/**
 * What changed in the output `fileName` from the build of `before` to the
 * one of `after`: the bytes of every input that grew, shrank, came or
 * went, the largest change first, and of the output as a whole
 * @param {{outputs: Record<string, Output>}} before
 * @param {{outputs: Record<string, Output>}} after
 * @param {string} fileName
 * @returns {{total: number, inputs: [input: string, delta: number][]}}
 */
export function inputDeltas(before, after, fileName) {
  const old = outputNamed(before, fileName);
  const now = outputNamed(after, fileName);
  /** @type {Map<string, number>} */
  const deltas = new Map();
  for (const [input, { bytesInOutput }] of Object.entries(old?.inputs ?? {})) {
    deltas.set(input, -bytesInOutput);
  }
  for (const [input, { bytesInOutput }] of Object.entries(now?.inputs ?? {})) {
    deltas.set(input, (deltas.get(input) ?? 0) + bytesInOutput);
  }
  return {
    total: (now?.bytes ?? 0) - (old?.bytes ?? 0),
    inputs: [...deltas]
      .filter(([, delta]) => delta !== 0)
      .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a)),
  };
}

/**
 * The flags of `node build.js`: `--watch`, `--metafile [path]`, which
 * writes esbuild's metafile (to `defaultMetafile` without a path), and
 * `--compare <path>`, which prints what changed from the build of an
 * earlier metafile
 * @param {string[]} args - process.argv without the first two
 * @param {string} defaultMetafile
 * @returns {{watch: boolean, metafile: string | null, compare: string | null}}
 */
export function parseBuildArgs(args, defaultMetafile) {
  /** @param {number} at */
  const value = (at) => {
    const next = args[at + 1];
    return next !== undefined && !next.startsWith("--") ? next : null;
  };
  const metafileAt = args.indexOf("--metafile");
  const compareAt = args.indexOf("--compare");
  const compare = compareAt >= 0 ? value(compareAt) : null;
  if (compareAt >= 0 && !compare) {
    throw new Error("--compare needs the path of a metafile");
  }
  return {
    watch: args.includes("--watch"),
    metafile: metafileAt >= 0 ? (value(metafileAt) ?? defaultMetafile) : null,
    compare,
  };
}
