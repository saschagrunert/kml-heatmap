/**
 * The import of a file the app fetches on first use, and of the same file
 * again after a failure.
 *
 * A browser may remember a failed import for as long as the page is open
 * and answer every later import() of that URL with the same failure,
 * without asking the server again. A retry therefore names the file under a
 * URL the page has not tried yet. The first attempt is the caller's own: the
 * build resolves its literal specifier (to a lazy bundle, which shares its
 * modules with the app through shared.bundle.js, or to a vendored module)
 * and leaves the computed one of a retry alone. Every bundle sits next to
 * this one, so `file` resolves the same from whichever holds this module.
 * @param first - The first attempt, an import() with a literal specifier
 * @param file - What the build names the file, relative to the bundles
 * @param failedImports - Imports that were rejected before this one
 */
export function importWithRetry<T>(
  first: () => Promise<T>,
  file: string,
  failedImports: number,
): Promise<T> {
  return failedImports === 0
    ? first()
    : (import(
        new URL(`${file}?retry=${failedImports}`, import.meta.url).href
      ) as Promise<T>);
}
