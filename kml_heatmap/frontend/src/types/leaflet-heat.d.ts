declare module "leaflet.heat" {
  import * as L from "leaflet";

  export interface HeatLayerOptions {
    radius?: number;
    blur?: number;
    minOpacity?: number;
    maxOpacity?: number;
    max?: number;
    gradient?: Record<number, string>;
  }

  export class HeatLayer extends L.Layer {
    constructor(latlngs: L.LatLngExpression[], options?: HeatLayerOptions);
    setLatLngs(latlngs: L.LatLngExpression[]): this;
    addLatLng(latlng: L.LatLngExpression): this;
    setOptions(options: HeatLayerOptions): this;
  }
}

declare module "leaflet" {
  export function heatLayer(latlngs: any[], options?: any): any;

  export interface HeatLayer {
    setLatLngs(latlngs: any[]): any;
    addLatLng(latlng: any): any;
    setOptions(options: any): any;
  }
}
