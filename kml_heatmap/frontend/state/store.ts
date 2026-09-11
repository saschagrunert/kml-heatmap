/**
 * Observable state store for centralized MapApp state management.
 * Provides get/set access with listener subscriptions and batched updates.
 */

import { logError } from "../utils/logger";
import type { FilteredStatistics, KMLDataset } from "../types";

export interface Range {
  min: number;
  max: number;
}

export interface StoreState {
  selectedYear: string;
  selectedAircraft: string;
  selectedPathIds: Set<number>;
  isolateSelection: boolean;
  heatmapVisible: boolean;
  altitudeVisible: boolean;
  airspeedVisible: boolean;
  airportsVisible: boolean;
  aviationVisible: boolean;
  statsPanelVisible: boolean;
  /**
   * Wrapped modal visibility. `undefined` means "not tracked by the store
   * yet" and state persistence falls back to inspecting the DOM.
   */
  wrappedVisible: boolean | undefined;
  currentData: KMLDataset | null;
  fullStats: FilteredStatistics | null;
  altitudeRange: Range;
  airspeedRange: Range;
}

type Listener<T> = (newVal: T, oldVal: T) => void;

/** Listener re-entrancy budget before pending notifications are abandoned */
const MAX_FLUSH_DEPTH = 10;

/**
 * Store keys that MapApp exposes as plain properties. Reading one reads the
 * store, assigning one writes it, so the managers never have to know which
 * state lives in the store and which does not.
 */
export const STORE_ACCESSOR_KEYS = [
  "selectedYear",
  "selectedAircraft",
  "selectedPathIds",
  "isolateSelection",
  "heatmapVisible",
  "altitudeVisible",
  "airspeedVisible",
  "airportsVisible",
  "aviationVisible",
  "currentData",
  "fullStats",
  "altitudeRange",
  "airspeedRange",
] as const;

export type StoreAccessorKey = (typeof STORE_ACCESSOR_KEYS)[number];

/** The accessor properties, typed exactly like the store keys they wrap */
export type StoreAccessors = Pick<StoreState, StoreAccessorKey>;

/**
 * Define a getter/setter pair per key on `target` that forwards to
 * `target.store`. Used on the MapApp prototype and on test doubles, so the
 * two cannot drift apart.
 */
export function defineStoreAccessors(
  target: { store: AppStore },
  keys: readonly StoreAccessorKey[] = STORE_ACCESSOR_KEYS,
): void {
  for (const key of keys) {
    Object.defineProperty(target, key, {
      get(this: { store: AppStore }) {
        return this.store.get(key);
      },
      set(this: { store: AppStore }, value: StoreState[typeof key]) {
        this.store.set(key, value);
      },
      enumerable: true,
      configurable: true,
    });
  }
}

export function createDefaultState(): StoreState {
  return {
    selectedYear: "all",
    selectedAircraft: "all",
    selectedPathIds: new Set(),
    isolateSelection: false,
    heatmapVisible: true,
    altitudeVisible: false,
    airspeedVisible: false,
    airportsVisible: true,
    aviationVisible: false,
    statsPanelVisible: false,
    wrappedVisible: undefined,
    currentData: null,
    fullStats: null,
    altitudeRange: { min: 0, max: 10000 },
    airspeedRange: { min: 0, max: 200 },
  };
}

export class AppStore {
  private state: StoreState;
  private listeners: Map<keyof StoreState, Listener<unknown>[]>;
  private batchDepth: number;
  private pendingOldValues: Map<keyof StoreState, unknown>;
  private isNotifying: boolean;
  private flushDepth: number;

  constructor(initial?: Partial<StoreState>) {
    this.state = { ...createDefaultState(), ...initial };
    this.listeners = new Map();
    this.batchDepth = 0;
    this.pendingOldValues = new Map();
    this.isNotifying = false;
    this.flushDepth = 0;
  }

  get<K extends keyof StoreState>(key: K): StoreState[K] {
    return this.state[key];
  }

  set<K extends keyof StoreState>(key: K, value: StoreState[K]): void {
    const oldVal = this.state[key];
    if (oldVal === value) return;
    this.state[key] = value;
    if (this.batchDepth > 0 || this.isNotifying) {
      if (!this.pendingOldValues.has(key)) {
        this.pendingOldValues.set(key, oldVal);
      }
    } else {
      this.notify(key, value, oldVal);
    }
  }

  update<K extends keyof StoreState>(
    key: K,
    fn: (prev: StoreState[K]) => StoreState[K],
  ): void {
    this.set(key, fn(this.state[key]));
  }

  notifyMutation<K extends keyof StoreState>(key: K): void {
    const val = this.state[key];
    if (this.batchDepth > 0 || this.isNotifying) {
      if (!this.pendingOldValues.has(key)) {
        this.pendingOldValues.set(key, val);
      }
    } else {
      this.notify(key, val, val);
    }
  }

  subscribe<K extends keyof StoreState>(
    key: K,
    fn: Listener<StoreState[K]>,
  ): () => void {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, []);
    }
    this.listeners.get(key)!.push(fn as Listener<unknown>);
    return () => {
      const list = this.listeners.get(key);
      if (list) {
        const idx = list.indexOf(fn as Listener<unknown>);
        if (idx >= 0) list.splice(idx, 1);
      }
    };
  }

  batch(fn: () => void): void {
    this.batchDepth++;
    try {
      fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) {
        this.flush();
      }
    }
  }

  private notify<K extends keyof StoreState>(
    key: K,
    newVal: StoreState[K],
    oldVal: StoreState[K],
  ): void {
    const list = this.listeners.get(key);
    if (list) {
      const wasNotifying = this.isNotifying;
      this.isNotifying = true;
      try {
        for (const fn of [...list]) {
          (fn as Listener<StoreState[K]>)(newVal, oldVal);
        }
      } finally {
        this.isNotifying = wasNotifying;
        if (!this.isNotifying && this.pendingOldValues.size > 0) {
          this.flush();
        }
      }
    }
  }

  private flush(): void {
    if (this.flushDepth > MAX_FLUSH_DEPTH) {
      // A listener cycle this deep means the UI would keep re-entering the
      // store instead of settling. Unwinding is the only way out, so make the
      // stall visible instead of swallowing it. The pending entries are kept:
      // once the stack has unwound, the next top-level set() flushes them.
      logError(
        `Store flush exceeded ${MAX_FLUSH_DEPTH} levels; deferring updates ` +
          `for: ${[...this.pendingOldValues.keys()].join(", ")}`,
      );
      return;
    }
    this.flushDepth++;
    try {
      const pending = new Map(this.pendingOldValues);
      this.pendingOldValues.clear();
      for (const [key, oldVal] of pending) {
        const currentVal = this.state[key];
        if (
          currentVal !== oldVal ||
          currentVal instanceof Set ||
          (typeof currentVal === "object" && currentVal !== null)
        ) {
          this.notify(key, currentVal, oldVal as StoreState[keyof StoreState]);
        }
      }
    } finally {
      this.flushDepth--;
    }
  }
}
