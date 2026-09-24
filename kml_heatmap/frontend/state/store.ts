/**
 * Observable state store for centralized MapApp state management.
 * Provides get/set access with listener subscriptions and batched updates.
 */

import { logError } from "../utils/logger";
import type { KMLDataset } from "../types";

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
  /** Whether the map is drawn as a globe rather than in Mercator */
  globeVisible: boolean;
  /** Whether the flights are lifted to their altitude (calculations/lift.ts) */
  threeDVisible: boolean;
  /**
   * Whether the 3D view draws the relief, and the flights stand on the
   * sampled ground (see LayerManager.syncTerrain, its only writer)
   */
  terrainActive: boolean;
  /**
   * Whether the 3D view shades the relief: where it draws it, and on the
   * globe, which leaves the relief itself out (see LayerManager.syncTerrain,
   * its only writer)
   */
  reliefShaded: boolean;
  /**
   * Whether a replay is running. The layer flags keep what the user chose;
   * what the map shows follows from both (see ui/layerVisibility.ts).
   */
  replayActive: boolean;
  statsPanelVisible: boolean;
  /** Wrapped modal visibility */
  wrappedVisible: boolean;
  currentData: KMLDataset | null;
  /** Whether the exported flights carry groundspeeds (metadata.json) */
  hasTimingData: boolean;
}

type Listener<T> = (newVal: T, oldVal: T) => void;

/**
 * How many rounds of listener-triggered changes one flush delivers before
 * the remaining ones are deferred to the next top-level set()
 */
const MAX_FLUSH_DEPTH = 10;

/**
 * Colour range defaults of MapApp's plain range fields; features/layers.ts
 * falls back to the same values
 */
export const DEFAULT_ALTITUDE_RANGE: Range = { min: 0, max: 10000 };
export const DEFAULT_AIRSPEED_RANGE: Range = { min: 0, max: 200 };

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
  "globeVisible",
  "threeDVisible",
  "terrainActive",
  "reliefShaded",
  "replayActive",
  "currentData",
  "hasTimingData",
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
    globeVisible: false,
    threeDVisible: false,
    terrainActive: false,
    reliefShaded: false,
    replayActive: false,
    statsPanelVisible: false,
    wrappedVisible: false,
    currentData: null,
    hasTimingData: false,
  };
}

export class AppStore {
  private state: StoreState;
  private listeners: Map<keyof StoreState, Listener<unknown>[]>;
  private batchDepth: number;
  private pendingOldValues: Map<keyof StoreState, unknown>;
  /** Keys whose value was changed in place (notifyMutation) while pending */
  private pendingMutations = new Set<keyof StoreState>();
  private isNotifying: boolean;
  private flushDepth: number;
  /** subscribeKeys listeners that already ran in the current flush pass */
  private flushRan: Set<() => void> | null = null;

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

  notifyMutation<K extends keyof StoreState>(key: K): void {
    const val = this.state[key];
    if (this.batchDepth > 0 || this.isNotifying) {
      if (!this.pendingOldValues.has(key)) {
        this.pendingOldValues.set(key, val);
      }
      this.pendingMutations.add(key);
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

  /** Drop every listener; the owner is going away */
  unsubscribeAll(): void {
    this.listeners.clear();
  }

  /**
   * Call `fn` once per update that changes any of `keys`. A batch that
   * changes three of them would otherwise run it three times, each against
   * the same final state.
   */
  subscribeKeys(
    keys: readonly (keyof StoreState)[],
    fn: () => void,
  ): () => void {
    const listener = (): void => {
      const ran = this.flushRan;
      if (ran) {
        if (ran.has(listener)) return;
        ran.add(listener);
      }
      fn();
    };
    const unsubscribes = keys.map((key) => this.subscribe(key, listener));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  batch(fn: () => void): void {
    this.batchDepth++;
    try {
      fn();
    } finally {
      this.batchDepth--;
      // A batch opened by a listener leaves its changes to the flush or
      // notification that is already running
      if (this.batchDepth === 0 && this.flushDepth === 0 && !this.isNotifying) {
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
          // A listener that throws must not keep the others, or the keys
          // still pending in this flush, from being notified
          try {
            (fn as Listener<StoreState[K]>)(newVal, oldVal);
          } catch (error) {
            logError(`Store listener for ${key} failed:`, error);
          }
        }
      } finally {
        this.isNotifying = wasNotifying;
        // A flush in progress picks up what the listeners set itself
        if (
          !this.isNotifying &&
          this.flushDepth === 0 &&
          this.pendingOldValues.size > 0
        ) {
          this.flush();
        }
      }
    }
  }

  private flush(): void {
    this.flushDepth++;
    // Pending keys are drained from the live map, so a key a listener sets
    // while the flush runs is delivered once, against the value it had before
    // the batch, instead of once by a nested flush and once more from a
    // snapshot with a stale old value. Keys set by listeners land behind the
    // ones of the batch and form the next round: subscribeKeys listeners run
    // once per round, since the state changed after their last run.
    const outerRan = this.flushRan;
    this.flushRan = new Set();
    let round = 0;
    let roundKeys = new Set(this.pendingOldValues.keys());
    try {
      while (this.pendingOldValues.size > 0) {
        const [key, oldVal] = this.pendingOldValues.entries().next().value!;
        if (!roundKeys.has(key)) {
          round++;
          if (round > MAX_FLUSH_DEPTH) {
            // Listeners this deep in each other's changes would keep the UI
            // re-entering the store instead of settling. Make the stall
            // visible instead of swallowing it; the pending entries are
            // kept, the next top-level set() flushes them.
            logError(
              `Store flush exceeded ${MAX_FLUSH_DEPTH} rounds; deferring ` +
                `updates for: ${[...this.pendingOldValues.keys()].join(", ")}`,
            );
            return;
          }
          roundKeys = new Set(this.pendingOldValues.keys());
          this.flushRan = new Set();
        }
        roundKeys.delete(key);
        this.pendingOldValues.delete(key);
        const mutated = this.pendingMutations.delete(key);
        const currentVal = this.state[key];
        // A value set and set back within a batch changed nothing; one
        // changed in place keeps its reference and is announced anyway
        if (currentVal !== oldVal || mutated) {
          this.notify(key, currentVal, oldVal as StoreState[keyof StoreState]);
        }
      }
    } finally {
      this.flushRan = outerRan;
      this.flushDepth--;
    }
  }
}
