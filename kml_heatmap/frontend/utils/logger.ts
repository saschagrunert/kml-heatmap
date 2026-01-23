/**
 * Internal logger utility
 * Only logs when debug mode is enabled via URL parameter
 */

let debugEnabled: boolean | null = null;

/**
 * Initialize logger with debug state (auto-initializes on first use if not called)
 */
export function initLogger(): void {
  const urlParams = new URLSearchParams(window.location.search);
  debugEnabled = urlParams.get("debug") === "true";
}

/**
 * Auto-initialize if not already done
 */
function ensureInitialized(): void {
  if (debugEnabled === null) {
    initLogger();
  }
}

/**
 * Log a debug message (only if debug mode is enabled)
 */
export function logDebug(...args: unknown[]): void {
  ensureInitialized();
  if (debugEnabled) {
    console.log(...args);
  }
}

/**
 * Log an info message (only if debug mode is enabled)
 */
export function logInfo(...args: unknown[]): void {
  ensureInitialized();
  if (debugEnabled) {
    console.info(...args);
  }
}

/**
 * Log a warning (always shown)
 */
export function logWarn(...args: unknown[]): void {
  console.warn(...args);
}

/**
 * Log an error (always shown)
 */
export function logError(...args: unknown[]): void {
  console.error(...args);
}

/**
 * Check if debug mode is enabled
 */
export function isDebugEnabled(): boolean {
  ensureInitialized();
  return debugEnabled === true;
}
