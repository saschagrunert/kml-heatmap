import * as api from "./exports";

export * from "./exports";

if (typeof window !== "undefined") {
  window.KMLHeatmap = api;
}
