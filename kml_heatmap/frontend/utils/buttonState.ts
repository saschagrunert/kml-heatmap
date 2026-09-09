/**
 * Store-driven toggle button state.
 * The store is the single source of truth: a button reflects its boolean
 * store key through `aria-pressed`, the `active` class and its opacity.
 */
import type { AppStore, StoreState } from "../state/store";
import { domCache } from "./domCache";

/** Store keys holding a boolean value */
export type BooleanStoreKey = {
  [K in keyof StoreState]: StoreState[K] extends boolean ? K : never;
}[keyof StoreState];

/**
 * Apply a toggle state to a button element
 */
export function applyToggleButtonState(
  button: HTMLElement,
  active: boolean,
): void {
  button.setAttribute("aria-pressed", String(active));
  button.classList.toggle("active", active);
  button.style.opacity = active ? "1.0" : "0.5";
}

/**
 * Keep a toggle button in sync with a boolean store key.
 * Applies the current value immediately and on every change.
 * @returns Unsubscribe function
 */
export function syncToggleButton(
  store: AppStore,
  key: BooleanStoreKey,
  buttonId: string,
): () => void {
  const apply = (value: boolean): void => {
    const button = domCache.get(buttonId);
    if (button) applyToggleButtonState(button, value);
  };
  apply(store.get(key));
  return store.subscribe(key, (value) => apply(value));
}
