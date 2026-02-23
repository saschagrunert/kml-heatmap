/**
 * Mock implementation of leaflet for testing
 */
import { vi } from "vitest";

export const polyline = vi.fn(() => {
  const obj: Record<string, ReturnType<typeof vi.fn>> = {
    addTo: vi.fn(),
    remove: vi.fn(),
    setStyle: vi.fn(),
    bindPopup: vi.fn(),
    on: vi.fn(),
  };
  obj.bindPopup.mockReturnValue(obj);
  obj.addTo.mockReturnValue(obj);
  return obj;
});

export const marker = vi.fn(() => {
  const obj: Record<string, ReturnType<typeof vi.fn>> = {
    addTo: vi.fn(),
    remove: vi.fn(),
    setLatLng: vi.fn(),
    bindPopup: vi.fn(),
    openPopup: vi.fn(),
    closePopup: vi.fn(),
    getPopup: vi.fn(() => null),
    isPopupOpen: vi.fn(() => false),
    getElement: vi.fn(() => null),
    on: vi.fn(),
  };
  obj.bindPopup.mockReturnValue(obj);
  obj.addTo.mockReturnValue(obj);
  return obj;
});

export const layerGroup = vi.fn(() => ({
  addTo: vi.fn(),
  clearLayers: vi.fn(),
  removeFrom: vi.fn(),
  hasLayer: vi.fn(() => false),
  addLayer: vi.fn(),
  removeLayer: vi.fn(),
}));

export const map = vi.fn(() => ({
  addLayer: vi.fn(),
  removeLayer: vi.fn(),
  hasLayer: vi.fn(() => false),
  setView: vi.fn(),
  fitBounds: vi.fn(),
  panTo: vi.fn(),
  setZoom: vi.fn(),
  getZoom: vi.fn(() => 10),
  getCenter: vi.fn(() => ({ lat: 0, lng: 0 })),
  getSize: vi.fn(() => ({ x: 800, y: 600 })),
  latLngToContainerPoint: vi.fn(() => ({ x: 400, y: 300 })),
  invalidateSize: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

export const tileLayer = vi.fn(() => ({
  addTo: vi.fn(),
  remove: vi.fn(),
}));

export const svg = vi.fn(() => ({}));

export const divIcon = vi.fn(() => ({}));

export const latLngBounds = vi.fn(() => ({
  extend: vi.fn(),
  isValid: vi.fn(() => true),
  getCenter: vi.fn(() => ({ lat: 50.0, lng: 8.0 })),
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
  divIcon,
  latLngBounds,
  DomEvent,
};
