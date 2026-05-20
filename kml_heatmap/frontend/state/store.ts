/**
 * Observable state store for centralized MapApp state management.
 * Provides get/set access with listener subscriptions and batched updates.
 */

import type {
  PathInfo,
  PathSegment,
  FilteredStatistics,
  KMLDataset,
} from "../types";

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
  buttonsHidden: boolean;
  currentData: KMLDataset | null;
  fullPathInfo: PathInfo[] | null;
  fullPathSegments: PathSegment[] | null;
  fullStats: FilteredStatistics | null;
  altitudeRange: Range;
  airspeedRange: Range;
}

type Listener<T> = (newVal: T, oldVal: T) => void;

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
    buttonsHidden: false,
    currentData: null,
    fullPathInfo: null,
    fullPathSegments: null,
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

  constructor(initial?: Partial<StoreState>) {
    this.state = { ...createDefaultState(), ...initial };
    this.listeners = new Map();
    this.batchDepth = 0;
    this.pendingOldValues = new Map();
  }

  get<K extends keyof StoreState>(key: K): StoreState[K] {
    return this.state[key];
  }

  set<K extends keyof StoreState>(key: K, value: StoreState[K]): void {
    const oldVal = this.state[key];
    if (oldVal === value) return;
    this.state[key] = value;
    if (this.batchDepth > 0) {
      if (!this.pendingOldValues.has(key)) {
        this.pendingOldValues.set(key, oldVal);
      }
    } else {
      this.notify(key, value, oldVal);
    }
  }

  update<K extends keyof StoreState>(
    key: K,
    fn: (prev: StoreState[K]) => StoreState[K]
  ): void {
    this.set(key, fn(this.state[key]));
  }

  notifyMutation<K extends keyof StoreState>(key: K): void {
    const val = this.state[key];
    this.notify(key, val, val);
  }

  subscribe<K extends keyof StoreState>(
    key: K,
    fn: Listener<StoreState[K]>
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
    oldVal: StoreState[K]
  ): void {
    const list = this.listeners.get(key);
    if (list) {
      for (const fn of [...list]) {
        (fn as Listener<StoreState[K]>)(newVal, oldVal);
      }
    }
  }

  private flush(): void {
    const pending = new Map(this.pendingOldValues);
    this.pendingOldValues.clear();
    for (const [key, oldVal] of pending) {
      if (this.state[key] !== oldVal) {
        this.notify(
          key,
          this.state[key],
          oldVal as StoreState[keyof StoreState]
        );
      }
    }
  }
}
