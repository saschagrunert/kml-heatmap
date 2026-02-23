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

export const marker = vi.fn(() => ({
  addTo: vi.fn(),
  remove: vi.fn(),
  setLatLng: vi.fn(),
  bindPopup: vi.fn(),
  openPopup: vi.fn(),
  closePopup: vi.fn(),
  on: vi.fn(),
}));

export const layerGroup = vi.fn(() => ({
  addTo: vi.fn(),
  clearLayers: vi.fn(),
  removeFrom: vi.fn(),
  hasLayer: vi.fn(() => false),
  addLayer: vi.fn(),
  removeLayer: vi.fn(),
}));

export default {
  polyline,
  marker,
  layerGroup,
};
