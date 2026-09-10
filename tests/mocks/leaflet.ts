/**
 * Mock implementation of leaflet for testing.
 *
 * Factories validate `[lat, lng]` tuples so tests fail loudly when code
 * passes NaN, out-of-range or malformed coordinates to Leaflet.
 */
import { vi, type Mock } from "vitest";

export type LatLngTuple = [number, number];

export interface MockLatLng {
  lat: number;
  lng: number;
}

/**
 * Validate a `[lat, lng]` tuple (or `{lat, lng}` object). Throws on NaN or
 * out-of-range values.
 */
export function assertLatLng(value: unknown, context = "latlng"): MockLatLng {
  let lat: unknown;
  let lng: unknown;
  if (Array.isArray(value)) {
    if (value.length < 2) {
      throw new Error(`${context}: expected [lat, lng], got ${String(value)}`);
    }
    [lat, lng] = value as unknown[];
  } else if (typeof value === "object" && value !== null) {
    lat = (value as { lat?: unknown }).lat;
    lng = (value as { lng?: unknown }).lng;
  } else {
    throw new Error(`${context}: expected [lat, lng], got ${String(value)}`);
  }
  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new Error(`${context}: lat/lng must be numbers`);
  }
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    throw new Error(`${context}: lat/lng must not be NaN`);
  }
  if (lat < -90 || lat > 90) {
    throw new Error(`${context}: latitude ${lat} out of range [-90, 90]`);
  }
  if (lng < -180 || lng > 180) {
    throw new Error(`${context}: longitude ${lng} out of range [-180, 180]`);
  }
  return { lat, lng };
}

export interface MockPolyline {
  addTo: Mock;
  remove: Mock;
  setStyle: Mock;
  bindPopup: Mock;
  bindTooltip: Mock;
  setTooltipContent: Mock;
  getLatLngs: Mock;
  setLatLngs: Mock;
  on: Mock;
  /** Recorded constructor arguments */
  latlngs: LatLngTuple[];
  options: Record<string, unknown>;
}

export const polyline: Mock<
  (latlngs: LatLngTuple[], options?: Record<string, unknown>) => MockPolyline
> = vi.fn((latlngs: LatLngTuple[], options: Record<string, unknown> = {}) => {
  if (!Array.isArray(latlngs)) {
    throw new Error("polyline: latlngs must be an array");
  }
  latlngs.forEach((ll, i) => assertLatLng(ll, `polyline latlngs[${i}]`));
  const obj: MockPolyline = {
    addTo: vi.fn(),
    remove: vi.fn(),
    setStyle: vi.fn(),
    bindPopup: vi.fn(),
    bindTooltip: vi.fn(),
    setTooltipContent: vi.fn(),
    getLatLngs: vi.fn(() => latlngs),
    setLatLngs: vi.fn(),
    on: vi.fn(),
    latlngs,
    options,
  };
  obj.bindPopup.mockReturnValue(obj);
  obj.bindTooltip.mockReturnValue(obj);
  obj.addTo.mockReturnValue(obj);
  obj.on.mockReturnValue(obj);
  obj.setStyle.mockReturnValue(obj);
  obj.setLatLngs.mockReturnValue(obj);
  return obj;
});

export interface MockMarker {
  addTo: Mock;
  remove: Mock;
  setLatLng: Mock;
  getLatLng: Mock;
  setIcon: Mock;
  setOpacity: Mock;
  bindPopup: Mock;
  setPopupContent: Mock;
  openPopup: Mock;
  closePopup: Mock;
  getPopup: Mock;
  isPopupOpen: Mock;
  getElement: Mock;
  on: Mock;
  /** Recorded constructor arguments */
  latlng: MockLatLng;
  options: Record<string, unknown>;
  /** Latest popup content, whether it was bound or set (test convenience) */
  popupContent: () => string | null;
}

export const marker: Mock<
  (latlng: LatLngTuple, options?: Record<string, unknown>) => MockMarker
> = vi.fn((latlng: LatLngTuple, options: Record<string, unknown> = {}) => {
  const validated = assertLatLng(latlng, "marker");
  // Leaflet keeps the popup once it is bound; the mock does the same so that
  // "bind on first update, set content afterwards" behaves as it does live
  let popup: { content: string } | null = null;
  const obj: MockMarker = {
    addTo: vi.fn(),
    remove: vi.fn(),
    setLatLng: vi.fn((next: unknown) => assertLatLng(next, "marker.setLatLng")),
    getLatLng: vi.fn(() => validated),
    setIcon: vi.fn(),
    setOpacity: vi.fn(),
    bindPopup: vi.fn(),
    setPopupContent: vi.fn((content: unknown) => {
      if (popup) popup.content = String(content);
    }),
    openPopup: vi.fn(),
    closePopup: vi.fn(),
    getPopup: vi.fn(() => popup),
    isPopupOpen: vi.fn(() => false),
    getElement: vi.fn(() => null),
    on: vi.fn(),
    latlng: validated,
    options,
    popupContent: () => popup?.content ?? null,
  };
  // mockReturnValue would replace the implementation, so chainable methods
  // that also record something use mockImplementation
  obj.bindPopup.mockImplementation((content: unknown) => {
    popup = { content: String(content) };
    return obj;
  });
  obj.addTo.mockReturnValue(obj);
  obj.setIcon.mockReturnValue(obj);
  obj.on.mockReturnValue(obj);
  return obj;
});

export interface MockLayerGroup {
  addTo: Mock;
  clearLayers: Mock;
  removeFrom: Mock;
  hasLayer: Mock;
  addLayer: Mock;
  removeLayer: Mock;
}

export const layerGroup: Mock<() => MockLayerGroup> = vi.fn(() => ({
  addTo: vi.fn(),
  clearLayers: vi.fn(),
  removeFrom: vi.fn(),
  hasLayer: vi.fn(() => false),
  addLayer: vi.fn(),
  removeLayer: vi.fn(),
}));

export interface MockMap {
  addLayer: Mock;
  removeLayer: Mock;
  hasLayer: Mock;
  setView: Mock;
  fitBounds: Mock;
  panTo: Mock;
  setZoom: Mock;
  getZoom: Mock;
  getCenter: Mock;
  getSize: Mock;
  latLngToContainerPoint: Mock;
  invalidateSize: Mock;
  on: Mock;
  off: Mock;
}

export const map: Mock<() => MockMap> = vi.fn(() => ({
  addLayer: vi.fn(),
  removeLayer: vi.fn(),
  hasLayer: vi.fn(() => false),
  setView: vi.fn((center: unknown) => assertLatLng(center, "map.setView")),
  fitBounds: vi.fn(),
  panTo: vi.fn((center: unknown) => assertLatLng(center, "map.panTo")),
  setZoom: vi.fn(),
  getZoom: vi.fn(() => 10),
  getCenter: vi.fn(() => ({ lat: 0, lng: 0 })),
  getSize: vi.fn(() => ({ x: 800, y: 600 })),
  latLngToContainerPoint: vi.fn(() => ({ x: 400, y: 300 })),
  invalidateSize: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

const tileLayerInstance = {
  addTo: vi.fn(),
  remove: vi.fn(),
  on: vi.fn(() => tileLayerInstance),
};
export const tileLayer = vi.fn(() => tileLayerInstance);

export const svg = vi.fn(() => ({}));

export const canvas = vi.fn((options: Record<string, unknown> = {}) => ({
  options,
}));

export const divIcon = vi.fn((options: Record<string, unknown> = {}) => ({
  options,
}));

export const latLng = vi.fn((lat: number, lng: number) =>
  assertLatLng([lat, lng], "latLng"),
);

export const latLngBounds = vi.fn(() => ({
  extend: vi.fn(),
  isValid: vi.fn(() => true),
  getCenter: vi.fn(() => ({ lat: 50.0, lng: 8.0 })),
}));

export interface MockPopup {
  setLatLng: Mock;
  setContent: Mock;
  openOn: Mock;
}

export const popup: Mock<() => MockPopup> = vi.fn(() => {
  const obj: MockPopup = {
    setLatLng: vi.fn((ll: unknown) => {
      assertLatLng(ll, "popup.setLatLng");
      return obj;
    }),
    setContent: vi.fn(),
    openOn: vi.fn(),
  };
  obj.setContent.mockReturnValue(obj);
  obj.openOn.mockReturnValue(obj);
  return obj;
});

export const control = {
  attribution: vi.fn(() => ({ addTo: vi.fn() })),
};

export interface MockHeatLayer {
  addTo: Mock;
  remove: Mock;
  _canvas?: { style: { pointerEvents: string } };
}

/** leaflet.heat plugin; the real one augments the global L namespace */
export const heatLayer: Mock<() => MockHeatLayer> = vi.fn(() => ({
  addTo: vi.fn(),
  remove: vi.fn(),
}));

export const DomEvent = {
  stopPropagation: vi.fn(),
};

export default {
  polyline,
  marker,
  layerGroup,
  map,
  tileLayer,
  svg,
  canvas,
  divIcon,
  latLng,
  latLngBounds,
  popup,
  control,
  DomEvent,
  heatLayer,
};
