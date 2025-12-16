/**
 * Leaflet module augmentation to fix import issues
 */

declare module "leaflet" {
  import * as L from "@types/leaflet";
  export = L;
  export as namespace L;
}
