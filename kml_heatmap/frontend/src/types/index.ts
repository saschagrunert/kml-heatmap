export interface AppConfig {
  center: [number, number];
  bounds: [[number, number], [number, number]];
  stadiaApiKey: string;
  openaipApiKey: string;
  dataDir: string;
}

export interface Coordinate {
  lat: number;
  lon: number;
  alt?: number;
}

export interface PathSegment {
  path_id: string;
  coords: [Coordinate, Coordinate];
  altitude?: [number, number];
  groundspeed?: [number, number];
  timestamp?: [number, number];
}

export interface PathInfo {
  id: string;
  year?: number;
  aircraft_registration?: string;
  aircraft_model?: string;
  start_airport?: string;
  end_airport?: string;
  distance_km?: number;
  duration_seconds?: number;
}

export interface FlightData {
  coordinates: [number, number][];
  downsampled_points: number;
  path_segments?: PathSegment[];
  path_info?: PathInfo[];
  altitude_range?: { min: number; max: number };
  airspeed_range?: { min: number; max: number };
}

export interface Airport {
  name: string;
  lat: number;
  lon: number;
  flight_count: number;
}

export interface Statistics {
  total_distance_km: number;
  total_distance_nm: number;
  min_altitude_ft: number;
  max_altitude_ft: number;
  airports_visited: number;
  total_flight_time_seconds: number;
  paths?: PathInfo[];
}

export interface MapState {
  center: { lat: number; lng: number };
  zoom: number;
  heatmapVisible: boolean;
  altitudeVisible: boolean;
  airspeedVisible: boolean;
  airportsVisible: boolean;
  aviationVisible: boolean;
  selectedYear: string;
  selectedAircraft: string;
  selectedPathIds: string[];
  statsPanelVisible: boolean;
  replayActive: boolean;
  replayPlaying: boolean;
  replayCurrentTime: number;
  replaySpeed: number;
  replayAutoZoom: boolean;
}

export interface LayerVisibility {
  heatmap: boolean;
  altitude: boolean;
  airspeed: boolean;
  airports: boolean;
  aviation: boolean;
}

export interface Layers {
  heatmap: any | null; // L.HeatLayer
  altitude: any; // L.LayerGroup
  airspeed: any; // L.LayerGroup
  airport: any; // L.LayerGroup
  replay: any | null; // L.LayerGroup
}

export interface ReplayState {
  active: boolean;
  playing: boolean;
  currentTime: number;
  maxTime: number;
  speed: number;
  interval: number | null;
  layer: any | null; // L.LayerGroup
  segments: ReplaySegment[];
  airplaneMarker: any | null; // L.Marker
  lastDrawnIndex: number;
  lastBearing: number | null;
  animationFrameId: number | null;
  lastFrameTime: number | null;
  colorMinAlt: number;
  colorMaxAlt: number;
  colorMinSpeed: number;
  colorMaxSpeed: number;
  autoZoom: boolean;
  lastZoom: number | null;
  recenterTimestamps: number[];
}

export interface ReplaySegment {
  coords: [number, number][];
  altitude: number[];
  groundspeed: number[];
  timestamp: number[];
  path_id: string;
}

export interface AirportMarkerData {
  marker: any; // L.Marker
  name: string;
  visitCount: number;
}

export type ResolutionLevel = "z0_4" | "z5_7" | "z8_10" | "z11_13" | "z14_plus";

export interface YearStats {
  year: number;
  distance_km: number;
  flight_time_seconds: number;
  airports_visited: Set<string>;
  paths_count: number;
}
