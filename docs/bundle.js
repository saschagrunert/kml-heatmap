"use strict";
var KMLHeatmapModules = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // kml_heatmap/frontend/main.ts
  var main_exports = {};
  __export(main_exports, {
    DataLoader: () => DataLoader,
    aggregateAircraft: () => aggregateAircraft,
    calculateAircraftColorClass: () => calculateAircraftColorClass,
    calculateAirportFlightCounts: () => calculateAirportFlightCounts,
    calculateAirportMarkerSize: () => calculateAirportMarkerSize,
    calculateAirportOpacity: () => calculateAirportOpacity,
    calculateAirportVisibility: () => calculateAirportVisibility,
    calculateAirspeedRange: () => calculateAirspeedRange,
    calculateAltitudeRange: () => calculateAltitudeRange,
    calculateAltitudeStats: () => calculateAltitudeStats,
    calculateAutoZoom: () => calculateAutoZoom,
    calculateBearing: () => calculateBearing,
    calculateDistance: () => calculateDistance,
    calculateFilteredStatistics: () => calculateFilteredStatistics,
    calculateFlightTime: () => calculateFlightTime,
    calculateLayerStats: () => calculateLayerStats,
    calculateLongestFlight: () => calculateLongestFlight,
    calculateReplayProgress: () => calculateReplayProgress,
    calculateSegmentProperties: () => calculateSegmentProperties,
    calculateSmoothedBearing: () => calculateSmoothedBearing,
    calculateSpeedStats: () => calculateSpeedStats,
    calculateTimeRange: () => calculateTimeRange,
    calculateTotalDistance: () => calculateTotalDistance,
    calculateYearStats: () => calculateYearStats,
    collectAirports: () => collectAirports,
    ddToDms: () => ddToDms,
    encodeStateToUrl: () => encodeStateToUrl,
    filterPaths: () => filterPaths,
    filterSegmentsForRendering: () => filterSegmentsForRendering,
    findHomeBase: () => findHomeBase,
    findSegmentsAtTime: () => findSegmentsAtTime,
    formatAirspeedLegendLabels: () => formatAirspeedLegendLabels,
    formatAltitude: () => formatAltitude,
    formatAltitudeLegendLabels: () => formatAltitudeLegendLabels,
    formatDistance: () => formatDistance,
    formatSpeed: () => formatSpeed,
    formatTime: () => formatTime,
    generateAirportPopup: () => generateAirportPopup,
    generateFunFacts: () => generateFunFacts,
    getColorForAirspeed: () => getColorForAirspeed,
    getColorForAltitude: () => getColorForAltitude,
    getDefaultState: () => getDefaultState,
    getDestinations: () => getDestinations,
    getResolutionForZoom: () => getResolutionForZoom,
    groupSegmentsByPath: () => groupSegmentsByPath,
    interpolatePosition: () => interpolatePosition,
    mergeState: () => mergeState,
    parseUrlParams: () => parseUrlParams,
    prepareReplaySegments: () => prepareReplaySegments,
    replayCalculateBearing: () => calculateBearing,
    selectDiverseFacts: () => selectDiverseFacts,
    shouldRecenter: () => shouldRecenter,
    shouldRenderSegment: () => shouldRenderSegment,
    validateReplayData: () => validateReplayData,
    wrappedFindHomeBase: () => findHomeBase2
  });

  // kml_heatmap/frontend/utils/geometry.ts
  function calculateDistance(coords1, coords2) {
    const [lat1Deg, lon1Deg] = coords1;
    const [lat2Deg, lon2Deg] = coords2;
    const lat1 = lat1Deg * Math.PI / 180;
    const lon1 = lon1Deg * Math.PI / 180;
    const lat2 = lat2Deg * Math.PI / 180;
    const lon2 = lon2Deg * Math.PI / 180;
    const dlat = lat2 - lat1;
    const dlon = lon2 - lon1;
    const a = Math.sin(dlat / 2) * Math.sin(dlat / 2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) * Math.sin(dlon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return 6371 * c;
  }
  function calculateBearing(lat1, lon1, lat2, lon2) {
    const \u03C61 = lat1 * Math.PI / 180;
    const \u03C62 = lat2 * Math.PI / 180;
    const \u0394\u03BB = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(\u0394\u03BB) * Math.cos(\u03C62);
    const x = Math.cos(\u03C61) * Math.sin(\u03C62) - Math.sin(\u03C61) * Math.cos(\u03C62) * Math.cos(\u0394\u03BB);
    const \u03B8 = Math.atan2(y, x);
    return (\u03B8 * 180 / Math.PI + 360) % 360;
  }
  function ddToDms(dd, isLat) {
    const direction = dd >= 0 ? isLat ? "N" : "E" : isLat ? "S" : "W";
    dd = Math.abs(dd);
    const degrees = Math.floor(dd);
    const minutes = Math.floor((dd - degrees) * 60);
    const seconds = ((dd - degrees) * 60 - minutes) * 60;
    return degrees + "\xB0" + minutes + "'" + seconds.toFixed(1) + '"' + direction;
  }

  // kml_heatmap/frontend/utils/formatters.ts
  function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const secs = Math.floor(seconds % 60);
    if (hours > 0) {
      return hours + ":" + minutes.toString().padStart(2, "0") + ":" + secs.toString().padStart(2, "0");
    }
    return minutes + ":" + secs.toString().padStart(2, "0");
  }
  function formatDistance(km, decimals = 0) {
    return km.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }) + " km";
  }
  function formatAltitude(meters) {
    const feet = Math.round(meters * 3.28084);
    return feet.toLocaleString("en-US") + " ft";
  }
  function formatSpeed(knots) {
    return Math.round(knots).toLocaleString("en-US") + " kt";
  }
  function getResolutionForZoom(zoom) {
    if (zoom <= 4) return "z0_4";
    if (zoom <= 7) return "z5_7";
    if (zoom <= 10) return "z8_10";
    if (zoom <= 13) return "z11_13";
    return "z14_plus";
  }

  // kml_heatmap/frontend/utils/colors.ts
  function getColorForAltitude(altitude, minAlt, maxAlt) {
    let normalized = (altitude - minAlt) / Math.max(maxAlt - minAlt, 1);
    normalized = Math.max(0, Math.min(1, normalized));
    let r, g, b;
    if (normalized < 0.2) {
      const t = normalized / 0.2;
      r = Math.round(80 * (1 - t));
      g = Math.round(160 + 95 * t);
      b = 255;
    } else if (normalized < 0.4) {
      const t = (normalized - 0.2) / 0.2;
      r = 0;
      g = 255;
      b = Math.round(255 * (1 - t));
    } else if (normalized < 0.6) {
      const t = (normalized - 0.4) / 0.2;
      r = Math.round(255 * t);
      g = 255;
      b = 0;
    } else if (normalized < 0.8) {
      const t = (normalized - 0.6) / 0.2;
      r = 255;
      g = Math.round(255 * (1 - t * 0.35));
      b = 0;
    } else {
      const t = (normalized - 0.8) / 0.2;
      r = 255;
      g = Math.round(165 * (1 - t * 0.6));
      b = Math.round(66 * t);
    }
    return "rgb(" + r + "," + g + "," + b + ")";
  }
  function getColorForAirspeed(speed, minSpeed, maxSpeed) {
    let normalized = (speed - minSpeed) / Math.max(maxSpeed - minSpeed, 1);
    normalized = Math.max(0, Math.min(1, normalized));
    let r, g, b;
    if (normalized < 0.2) {
      const t = normalized / 0.2;
      r = 0;
      g = Math.round(128 + 127 * t);
      b = 255;
    } else if (normalized < 0.4) {
      const t = (normalized - 0.2) / 0.2;
      r = 0;
      g = 255;
      b = Math.round(255 * (1 - t));
    } else if (normalized < 0.6) {
      const t = (normalized - 0.4) / 0.2;
      r = Math.round(255 * t);
      g = 255;
      b = 0;
    } else if (normalized < 0.8) {
      const t = (normalized - 0.6) / 0.2;
      r = 255;
      g = Math.round(255 * (1 - t * 0.5));
      b = 0;
    } else {
      const t = (normalized - 0.8) / 0.2;
      r = 255;
      g = Math.round(128 * (1 - t));
      b = 0;
    }
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  // kml_heatmap/frontend/state/urlState.ts
  function parseUrlParams(params) {
    let urlParams;
    if (typeof params === "string") {
      urlParams = new URLSearchParams(params);
    } else {
      urlParams = params;
    }
    if (urlParams.toString() === "") {
      return null;
    }
    const state = {};
    if (urlParams.has("y")) {
      const year = urlParams.get("y");
      if (year) {
        state.selectedYear = year;
      }
    }
    if (urlParams.has("a")) {
      const aircraft = urlParams.get("a");
      if (aircraft) {
        state.selectedAircraft = aircraft;
      }
    }
    if (urlParams.has("p")) {
      const pathStr = urlParams.get("p");
      if (pathStr) {
        state.selectedPathIds = pathStr.split(",").filter((id) => id.trim().length > 0).map((id) => parseInt(id, 10)).filter((id) => !isNaN(id));
      }
    }
    if (urlParams.has("v")) {
      const vis = urlParams.get("v");
      if (vis && vis.length === 6) {
        state.heatmapVisible = vis[0] === "1";
        state.altitudeVisible = vis[1] === "1";
        state.airspeedVisible = vis[2] === "1";
        state.airportsVisible = vis[3] === "1";
        state.aviationVisible = vis[4] === "1";
        state.statsPanelVisible = vis[5] === "1";
      }
    }
    if (urlParams.has("lat") && urlParams.has("lng")) {
      const latStr = urlParams.get("lat");
      const lngStr = urlParams.get("lng");
      if (latStr && lngStr) {
        const lat = parseFloat(latStr);
        const lng = parseFloat(lngStr);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          state.center = { lat, lng };
        }
      }
    }
    if (urlParams.has("z")) {
      const zoomStr = urlParams.get("z");
      if (zoomStr) {
        const zoom = parseFloat(zoomStr);
        if (!isNaN(zoom)) {
          state.zoom = Math.max(1, Math.min(18, zoom));
        }
      }
    }
    return state;
  }
  function encodeStateToUrl(state) {
    const params = new URLSearchParams();
    if (state.selectedYear) {
      params.set("y", state.selectedYear);
    }
    if (state.selectedAircraft && state.selectedAircraft !== "all") {
      params.set("a", state.selectedAircraft);
    }
    if (state.selectedPathIds && state.selectedPathIds.length > 0) {
      params.set("p", state.selectedPathIds.join(","));
    }
    const hasVisibility = state.heatmapVisible !== void 0 || state.altitudeVisible !== void 0 || state.airspeedVisible !== void 0 || state.airportsVisible !== void 0 || state.aviationVisible !== void 0 || state.statsPanelVisible !== void 0;
    if (hasVisibility) {
      const vis = [
        state.heatmapVisible ? "1" : "0",
        state.altitudeVisible ? "1" : "0",
        state.airspeedVisible ? "1" : "0",
        state.airportsVisible ? "1" : "0",
        state.aviationVisible ? "1" : "0",
        state.statsPanelVisible ? "1" : "0"
      ].join("");
      if (vis !== "100100") {
        params.set("v", vis);
      }
    }
    if (state.center) {
      params.set("lat", state.center.lat.toFixed(6));
      params.set("lng", state.center.lng.toFixed(6));
    }
    if (state.zoom !== void 0) {
      params.set("z", state.zoom.toFixed(2));
    }
    return params.toString();
  }
  function getDefaultState() {
    return {
      selectedYear: "all",
      selectedAircraft: "all",
      selectedPathIds: [],
      heatmapVisible: true,
      altitudeVisible: false,
      airspeedVisible: false,
      airportsVisible: true,
      aviationVisible: false,
      statsPanelVisible: false
    };
  }
  function mergeState(defaultState, urlState) {
    if (!urlState) {
      return { ...defaultState };
    }
    return { ...defaultState, ...urlState };
  }

  // kml_heatmap/frontend/calculations/statistics.ts
  function filterPaths(pathInfo, year, aircraft) {
    return pathInfo.filter(function(path) {
      if (year !== "all") {
        if (!path.year || path.year.toString() !== year) {
          return false;
        }
      }
      if (aircraft !== "all") {
        if (!path.aircraft_registration || path.aircraft_registration !== aircraft) {
          return false;
        }
      }
      return true;
    });
  }
  function collectAirports(pathInfo) {
    const airports = /* @__PURE__ */ new Set();
    pathInfo.forEach(function(path) {
      if (path.start_airport) airports.add(path.start_airport);
      if (path.end_airport) airports.add(path.end_airport);
    });
    return airports;
  }
  function aggregateAircraft(pathInfo) {
    const aircraftMap = {};
    pathInfo.forEach(function(path) {
      if (path.aircraft_registration) {
        const reg = path.aircraft_registration;
        if (!aircraftMap[reg]) {
          aircraftMap[reg] = {
            registration: reg,
            type: path.aircraft_type,
            flights: 0
          };
        }
        aircraftMap[reg].flights += 1;
      }
    });
    return Object.values(aircraftMap).sort(function(a, b) {
      return b.flights - a.flights;
    });
  }
  function filterSegmentsByPaths(segments, pathInfo) {
    const pathIds = new Set(pathInfo.map((p) => p.id));
    return segments.filter(function(segment) {
      return pathIds.has(segment.path_id);
    });
  }
  function calculateTotalDistance(segments) {
    let total = 0;
    segments.forEach(function(segment) {
      const coords = segment.coords;
      if (coords && coords.length === 2) {
        const distance = calculateDistance(coords[0], coords[1]);
        total += distance;
      }
    });
    return total;
  }
  function calculateAltitudeStats(segments) {
    const altitudes = segments.map((s) => s.altitude_m).filter((a) => a !== void 0);
    if (altitudes.length === 0) {
      return { min: 0, max: 0, gain: 0 };
    }
    let min = altitudes[0];
    let max = altitudes[0];
    for (let i = 1; i < altitudes.length; i++) {
      if (altitudes[i] < min) min = altitudes[i];
      if (altitudes[i] > max) max = altitudes[i];
    }
    let gain = 0;
    let prevAlt = null;
    segments.forEach(function(segment) {
      if (segment.altitude_m !== void 0 && prevAlt !== null && segment.altitude_m > prevAlt) {
        gain += segment.altitude_m - prevAlt;
      }
      if (segment.altitude_m !== void 0) {
        prevAlt = segment.altitude_m;
      }
    });
    return { min, max, gain };
  }
  function calculateSpeedStats(segments) {
    const speeds = segments.map((s) => s.groundspeed_knots).filter((s) => s !== void 0 && s > 0);
    if (speeds.length === 0) {
      return { max: 0, avg: 0 };
    }
    let max = speeds[0];
    let sum = 0;
    for (let i = 0; i < speeds.length; i++) {
      if (speeds[i] > max) max = speeds[i];
      sum += speeds[i];
    }
    const avg = sum / speeds.length;
    return { max, avg };
  }
  function calculateLongestFlight(segments) {
    const pathDistances = {};
    segments.forEach(function(segment) {
      const coords = segment.coords;
      if (coords && coords.length === 2) {
        const distance = calculateDistance(coords[0], coords[1]);
        if (!pathDistances[segment.path_id]) {
          pathDistances[segment.path_id] = 0;
        }
        pathDistances[segment.path_id] += distance;
      }
    });
    const distances = Object.values(pathDistances);
    if (distances.length === 0) return 0;
    let max = distances[0];
    for (let i = 1; i < distances.length; i++) {
      if (distances[i] > max) max = distances[i];
    }
    return max;
  }
  function calculateFlightTime(segments, pathInfo) {
    let totalSeconds = 0;
    const pathIds = new Set(pathInfo.map((p) => p.id));
    pathIds.forEach(function(pathId) {
      const pathSegments = segments.filter(
        (seg) => seg.path_id === pathId && seg.time !== void 0 && seg.time !== null
      );
      if (pathSegments.length > 0) {
        const times = pathSegments.map((seg) => seg.time);
        let minTime = times[0];
        let maxTime = times[0];
        for (let i = 1; i < times.length; i++) {
          if (times[i] < minTime) minTime = times[i];
          if (times[i] > maxTime) maxTime = times[i];
        }
        totalSeconds += maxTime - minTime;
      }
    });
    return totalSeconds;
  }
  function calculateFilteredStatistics(options) {
    const { pathInfo, segments, year = "all", aircraft = "all" } = options;
    if (!pathInfo || !segments) {
      return {
        total_points: 0,
        num_paths: 0,
        num_airports: 0,
        airport_names: [],
        num_aircraft: 0,
        aircraft_list: [],
        total_distance_nm: 0,
        total_distance_km: 0
      };
    }
    const filteredPaths = filterPaths(pathInfo, year, aircraft);
    if (filteredPaths.length === 0) {
      return {
        total_points: 0,
        num_paths: 0,
        num_airports: 0,
        airport_names: [],
        num_aircraft: 0,
        aircraft_list: [],
        total_distance_nm: 0,
        total_distance_km: 0
      };
    }
    const airports = collectAirports(filteredPaths);
    const aircraftList = aggregateAircraft(filteredPaths);
    const filteredSegments = filterSegmentsByPaths(segments, filteredPaths);
    const totalDistanceKm = calculateTotalDistance(filteredSegments);
    const altitudeStats = calculateAltitudeStats(filteredSegments);
    const speedStats = calculateSpeedStats(filteredSegments);
    const longestFlight = calculateLongestFlight(filteredSegments);
    const flightTime = calculateFlightTime(filteredSegments, filteredPaths);
    const maxAltitudeFt = altitudeStats.max !== void 0 ? altitudeStats.max * 3.28084 : void 0;
    const minAltitudeFt = altitudeStats.min !== void 0 ? altitudeStats.min * 3.28084 : void 0;
    const totalAltitudeGainFt = altitudeStats.gain !== void 0 ? altitudeStats.gain * 3.28084 : void 0;
    const longestFlightNm = longestFlight !== void 0 ? longestFlight * 0.539957 : void 0;
    const formatTime2 = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor(seconds % 3600 / 60);
      return `${hours}h ${minutes}m`;
    };
    const flightTimeStr = flightTime > 0 ? formatTime2(flightTime) : void 0;
    const cruiseSegments = filteredSegments.filter(
      (seg) => seg.altitude_m && seg.altitude_m > 304.8 && // >1000ft in meters
      seg.groundspeed_knots && seg.groundspeed_knots > 0
    );
    let cruiseSpeed;
    if (cruiseSegments.length > 0) {
      let totalDistanceNm = 0;
      let totalTimeHours = 0;
      cruiseSegments.forEach((seg) => {
        if (seg.coords && seg.coords.length === 2 && seg.groundspeed_knots && seg.groundspeed_knots > 0) {
          const distanceKm = calculateDistance(seg.coords[0], seg.coords[1]);
          const distanceNm = distanceKm * 0.539957;
          const timeHours = distanceNm / seg.groundspeed_knots;
          totalDistanceNm += distanceNm;
          totalTimeHours += timeHours;
        }
      });
      cruiseSpeed = totalTimeHours > 0 ? totalDistanceNm / totalTimeHours : void 0;
    }
    let mostCommonCruiseAltitudeFt;
    let mostCommonCruiseAltitudeM;
    if (cruiseSegments.length > 0) {
      const altitudeBuckets = {};
      cruiseSegments.forEach((seg) => {
        if (seg.altitude_m) {
          const altFt = seg.altitude_m * 3.28084;
          const bucketFt = Math.round(altFt / 100) * 100;
          altitudeBuckets[bucketFt] = (altitudeBuckets[bucketFt] || 0) + 1;
        }
      });
      const mostCommonBucket = Object.entries(altitudeBuckets).sort(
        (a, b) => b[1] - a[1]
      )[0];
      if (mostCommonBucket) {
        mostCommonCruiseAltitudeFt = Number(mostCommonBucket[0]);
        mostCommonCruiseAltitudeM = mostCommonCruiseAltitudeFt / 3.28084;
      }
    }
    const totalPoints = filteredSegments.length * 2;
    return {
      total_points: totalPoints,
      num_paths: filteredPaths.length,
      num_airports: airports.size,
      airport_names: Array.from(airports),
      num_aircraft: aircraftList.length,
      aircraft_list: aircraftList,
      total_distance_km: totalDistanceKm,
      total_distance_nm: totalDistanceKm * 0.539957,
      max_altitude_m: altitudeStats.max,
      min_altitude_m: altitudeStats.min,
      total_altitude_gain_m: altitudeStats.gain,
      max_altitude_ft: maxAltitudeFt,
      min_altitude_ft: minAltitudeFt,
      total_altitude_gain_ft: totalAltitudeGainFt,
      max_groundspeed_knots: speedStats.max,
      avg_groundspeed_knots: speedStats.avg,
      average_groundspeed_knots: speedStats.avg,
      // Alias
      cruise_speed_knots: cruiseSpeed,
      longest_flight_km: longestFlight,
      longest_flight_nm: longestFlightNm,
      total_flight_time_seconds: flightTime,
      total_flight_time_str: flightTimeStr,
      most_common_cruise_altitude_ft: mostCommonCruiseAltitudeFt,
      most_common_cruise_altitude_m: mostCommonCruiseAltitudeM
    };
  }

  // kml_heatmap/frontend/services/dataLoader.ts
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load script: " + url));
      document.head.appendChild(script);
    });
  }
  function combineYearData(yearDatasets, resolution) {
    const combined = {
      coordinates: [],
      path_segments: [],
      path_info: [],
      resolution,
      original_points: 0,
      downsampled_points: 0,
      compression_ratio: 100
    };
    yearDatasets.forEach((data) => {
      if (!data) return;
      if (data.coordinates) {
        combined.coordinates = combined.coordinates.concat(data.coordinates);
      }
      if (data.path_segments) {
        combined.path_segments = combined.path_segments.concat(
          data.path_segments
        );
      }
      if (data.path_info) {
        combined.path_info = combined.path_info.concat(data.path_info);
      }
      combined.original_points += data.original_points || 0;
      combined.downsampled_points += data.downsampled_points || 0;
    });
    combined.compression_ratio = combined.original_points > 0 ? combined.downsampled_points / combined.original_points * 100 : 100;
    return combined;
  }
  function getGlobalVarName(year, resolution) {
    return "KML_DATA_" + year + "_" + resolution.toUpperCase().replace(/-/g, "_");
  }
  function getCacheKey(resolution, year) {
    return resolution + "_" + year;
  }
  var DataLoader = class {
    constructor(options = {}) {
      this.dataDir = options.dataDir || "data";
      this.cache = {};
      this.scriptLoader = options.scriptLoader || loadScript;
      this.showLoading = options.showLoading || (() => {
      });
      this.hideLoading = options.hideLoading || (() => {
      });
      this.getWindow = options.getWindow || (() => window);
    }
    /**
     * Load data for a specific resolution and year
     * @param resolution - Resolution identifier (e.g., 'z14_plus')
     * @param year - Year string or 'all'
     * @returns Data object or null on error
     */
    async loadData(resolution, year = "all") {
      const cacheKey = getCacheKey(resolution, year);
      if (this.cache[cacheKey]) {
        return this.cache[cacheKey];
      }
      if (year === "all") {
        return await this.loadAndCombineAllYears(resolution);
      }
      this.showLoading();
      try {
        const globalVarName = getGlobalVarName(year, resolution);
        const win = this.getWindow();
        if (!win[globalVarName]) {
          console.log(
            "Loading " + resolution + " (" + year + ")... (this may take a moment for large datasets)"
          );
          const filename = this.dataDir + "/" + year + "/" + resolution + ".js";
          await this.scriptLoader(filename);
        }
        const data = win[globalVarName];
        this.cache[cacheKey] = data;
        console.log(
          "\u2713 Loaded " + resolution + " (" + year + "):",
          data.downsampled_points + " points"
        );
        return data;
      } catch (error) {
        console.error("Error loading data for year " + year + ":", error);
        return null;
      } finally {
        this.hideLoading();
      }
    }
    /**
     * Load and combine data from all available years
     * @param resolution - Resolution identifier
     * @returns Combined data object or null on error
     */
    async loadAndCombineAllYears(resolution) {
      const cacheKey = getCacheKey(resolution, "all");
      if (this.cache[cacheKey]) {
        return this.cache[cacheKey];
      }
      this.showLoading();
      try {
        const metadata = await this.loadMetadata();
        if (!metadata || !metadata.available_years) {
          console.error("No metadata or available years found");
          return null;
        }
        console.log(
          "Loading all years for " + resolution + ":",
          metadata.available_years
        );
        const promises = metadata.available_years.map(
          (year) => this.loadData(resolution, year.toString())
        );
        const yearDatasets = await Promise.all(promises);
        const combined = combineYearData(yearDatasets, resolution);
        this.cache[cacheKey] = combined;
        console.log(
          "Combined all years for " + resolution + ":",
          combined.downsampled_points + " points"
        );
        return combined;
      } catch (error) {
        console.error("Error loading and combining all years:", error);
        return null;
      } finally {
        this.hideLoading();
      }
    }
    /**
     * Load airports data
     * @returns Array of airport objects
     */
    async loadAirports() {
      try {
        const win = this.getWindow();
        if (!win.KML_AIRPORTS) {
          await this.scriptLoader(this.dataDir + "/airports.js");
        }
        return win.KML_AIRPORTS?.airports || [];
      } catch (error) {
        console.error("Error loading airports:", error);
        return [];
      }
    }
    /**
     * Load metadata
     * @returns Metadata object or null on error
     */
    async loadMetadata() {
      try {
        const win = this.getWindow();
        if (!win.KML_METADATA) {
          await this.scriptLoader(this.dataDir + "/metadata.js");
        }
        return win.KML_METADATA || null;
      } catch (error) {
        console.error("Error loading metadata:", error);
        return null;
      }
    }
    /**
     * Clear all cached data
     */
    clearCache() {
      this.cache = {};
    }
    /**
     * Check if data is cached
     * @param resolution - Resolution identifier
     * @param year - Year string
     * @returns True if cached
     */
    isCached(resolution, year) {
      const cacheKey = getCacheKey(resolution, year);
      return cacheKey in this.cache;
    }
  };

  // kml_heatmap/frontend/features/airports.ts
  function calculateAirportFlightCounts(pathInfo, year = "all", aircraft = "all") {
    if (!pathInfo) return {};
    const counts = {};
    const filteredPaths = pathInfo.filter(function(path) {
      if (year !== "all") {
        if (!path.year || path.year.toString() !== year) {
          return false;
        }
      }
      if (aircraft !== "all") {
        if (!path.aircraft_registration || path.aircraft_registration !== aircraft) {
          return false;
        }
      }
      return true;
    });
    filteredPaths.forEach(function(path) {
      const uniqueAirports = /* @__PURE__ */ new Set();
      if (path.start_airport) {
        uniqueAirports.add(path.start_airport);
      }
      if (path.end_airport) {
        uniqueAirports.add(path.end_airport);
      }
      uniqueAirports.forEach(function(airport) {
        counts[airport] = (counts[airport] || 0) + 1;
      });
    });
    return counts;
  }
  function findHomeBase(airportCounts) {
    let homeBaseName = null;
    let maxCount = 0;
    Object.keys(airportCounts).forEach(function(name) {
      if (airportCounts[name] > maxCount) {
        maxCount = airportCounts[name];
        homeBaseName = name;
      }
    });
    return homeBaseName;
  }
  function generateAirportPopup(airport, flightCount, isHomeBase) {
    const latDms = ddToDms(airport.lat, true);
    const lonDms = ddToDms(airport.lon, false);
    const googleMapsLink = `https://www.google.com/maps?q=${airport.lat},${airport.lon}`;
    return `
    <div style="
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
        min-width: 220px;
        padding: 8px 4px;
        background-color: #2b2b2b;
        color: #ffffff;
    ">
        <div style="
            font-size: 15px;
            font-weight: bold;
            color: #28a745;
            margin-bottom: 10px;
            padding-bottom: 8px;
            border-bottom: 2px solid #28a745;
            display: flex;
            align-items: center;
            gap: 6px;
        ">
            <span style="font-size: 18px;">\u{1F6EB}</span>
            <span>${airport.name || "Unknown"}</span>
            ${isHomeBase ? '<span style="font-size: 12px; background: #007bff; color: white; padding: 2px 6px; border-radius: 3px; margin-left: 4px;">HOME</span>' : ""}
        </div>
        <div style="margin-bottom: 8px;">
            <div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Coordinates</div>
            <a href="${googleMapsLink}"
               target="_blank"
               style="
                   color: #4facfe;
                   text-decoration: none;
                   font-size: 12px;
                   font-family: monospace;
                   display: flex;
                   align-items: center;
                   gap: 4px;
               "
               onmouseover="this.style.textDecoration='underline'"
               onmouseout="this.style.textDecoration='none'">
                <span>\u{1F4CD}</span>
                <span>${latDms}<br>${lonDms}</span>
            </a>
        </div>
        <div style="
            background: linear-gradient(135deg, rgba(79, 172, 254, 0.15) 0%, rgba(0, 242, 254, 0.15) 100%);
            padding: 8px 10px;
            border-radius: 6px;
            border-left: 3px solid #4facfe;
            display: flex;
            justify-content: space-between;
            align-items: center;
        ">
            <span style="font-size: 12px; color: #ccc; font-weight: 500;">Total Flights</span>
            <span style="font-size: 16px; font-weight: bold; color: #4facfe;">${flightCount}</span>
        </div>
    </div>`;
  }
  function calculateAirportOpacity(flightCount, maxCount) {
    if (maxCount === 0) return 1;
    const minOpacity = 0.3;
    const maxOpacity = 1;
    const normalized = flightCount / maxCount;
    return minOpacity + normalized * (maxOpacity - minOpacity);
  }
  function calculateAirportMarkerSize(flightCount, maxCount, options = {}) {
    const minSize = options.minSize || 3;
    const maxSize = options.maxSize || 8;
    if (maxCount === 0) return minSize;
    const normalized = flightCount / maxCount;
    return minSize + normalized * (maxSize - minSize);
  }
  function calculateAirportVisibility(options) {
    const {
      airportCounts,
      selectedYear = "all",
      selectedAircraft = "all",
      selectedPathIds = /* @__PURE__ */ new Set(),
      pathToAirports = {}
    } = options;
    const hasFilters = selectedYear !== "all" || selectedAircraft !== "all";
    const hasSelection = selectedPathIds.size > 0;
    const selectedAirports = /* @__PURE__ */ new Set();
    if (hasSelection) {
      selectedPathIds.forEach((pathId) => {
        const airports = pathToAirports[pathId];
        if (airports) {
          if (airports.start) selectedAirports.add(airports.start);
          if (airports.end) selectedAirports.add(airports.end);
        }
      });
    }
    const visibility = {};
    Object.keys(airportCounts).forEach((airportName) => {
      const flightCount = airportCounts[airportName] || 0;
      if (hasSelection) {
        visibility[airportName] = {
          show: true,
          opacity: selectedAirports.has(airportName) ? 1 : 0.2
        };
      } else if (hasFilters) {
        visibility[airportName] = {
          show: flightCount > 0,
          opacity: 1
        };
      } else {
        visibility[airportName] = {
          show: true,
          opacity: 1
        };
      }
    });
    return visibility;
  }

  // kml_heatmap/frontend/features/layers.ts
  function calculateAltitudeRange(segments, selectedPathIds = null) {
    let segmentsToUse = segments;
    if (selectedPathIds && selectedPathIds.size > 0) {
      segmentsToUse = segments.filter((seg) => selectedPathIds.has(seg.path_id));
    }
    if (segmentsToUse.length === 0) {
      return { min: 0, max: 1e4 };
    }
    const altitudes = segmentsToUse.map((s) => s.altitude_ft).filter((a) => a !== void 0);
    if (altitudes.length === 0) {
      return { min: 0, max: 1e4 };
    }
    let min = altitudes[0];
    let max = altitudes[0];
    for (let i = 1; i < altitudes.length; i++) {
      if (altitudes[i] < min) min = altitudes[i];
      if (altitudes[i] > max) max = altitudes[i];
    }
    return { min, max };
  }
  function calculateAirspeedRange(segments, selectedPathIds = null) {
    let segmentsToUse = segments;
    if (selectedPathIds && selectedPathIds.size > 0) {
      segmentsToUse = segments.filter((seg) => selectedPathIds.has(seg.path_id));
    }
    if (segmentsToUse.length === 0) {
      return { min: 0, max: 200 };
    }
    const speeds = segmentsToUse.map((s) => s.groundspeed_knots).filter((s) => s !== void 0 && s > 0);
    if (speeds.length === 0) {
      return { min: 0, max: 200 };
    }
    let min = speeds[0];
    let max = speeds[0];
    for (let i = 1; i < speeds.length; i++) {
      if (speeds[i] < min) min = speeds[i];
      if (speeds[i] > max) max = speeds[i];
    }
    return { min, max };
  }
  function shouldRenderSegment(_segment, pathInfo, filters = {}) {
    const { year = "all", aircraft = "all" } = filters;
    if (year !== "all") {
      if (!pathInfo || !pathInfo.year || pathInfo.year.toString() !== year) {
        return false;
      }
    }
    if (aircraft !== "all") {
      if (!pathInfo || pathInfo.aircraft_registration !== aircraft) {
        return false;
      }
    }
    return true;
  }
  function calculateSegmentProperties(_segment, options = { pathId: 0 }) {
    const {
      pathId,
      selectedPathIds = /* @__PURE__ */ new Set(),
      hasSelection = false,
      colorFunction,
      colorMin = 0,
      colorMax = 0,
      value = 0
    } = options;
    const isSelected = selectedPathIds.has(pathId);
    return {
      weight: isSelected ? 6 : 4,
      opacity: isSelected ? 1 : hasSelection ? 0.1 : 0.85,
      color: colorFunction ? colorFunction(value, colorMin, colorMax) : "#3388ff",
      isSelected
    };
  }
  function formatAltitudeLegendLabels(min, max) {
    return {
      min: Math.round(min).toLocaleString() + " ft",
      max: Math.round(max).toLocaleString() + " ft"
    };
  }
  function formatAirspeedLegendLabels(min, max) {
    return {
      min: Math.round(min) + " kt",
      max: Math.round(max) + " kt"
    };
  }
  function filterSegmentsForRendering(segments, pathInfo, filters = {}) {
    const pathInfoMap = new Map(pathInfo.map((p) => [p.id, p]));
    return segments.filter((segment) => {
      const info = pathInfoMap.get(segment.path_id);
      if (!info) return false;
      return shouldRenderSegment(segment, info, filters);
    });
  }
  function groupSegmentsByPath(segments) {
    const grouped = /* @__PURE__ */ new Map();
    segments.forEach((segment) => {
      const pathId = segment.path_id;
      if (!grouped.has(pathId)) {
        grouped.set(pathId, []);
      }
      grouped.get(pathId).push(segment);
    });
    return grouped;
  }
  function calculateLayerStats(segments) {
    return {
      totalSegments: segments.length,
      uniquePaths: new Set(segments.map((s) => s.path_id)).size,
      altitudeRange: calculateAltitudeRange(segments),
      speedRange: calculateAirspeedRange(segments)
    };
  }

  // kml_heatmap/frontend/features/replay.ts
  function prepareReplaySegments(segments, pathId) {
    const replaySegments = segments.filter(
      (seg) => seg.path_id === pathId && seg.time !== void 0 && seg.time !== null
    );
    return replaySegments.sort((a, b) => a.time - b.time);
  }
  function calculateTimeRange(segments) {
    if (segments.length === 0) {
      return { min: 0, max: 0 };
    }
    const times = segments.map((s) => s.time);
    let min = times[0];
    let max = times[0];
    for (let i = 1; i < times.length; i++) {
      if (times[i] < min) min = times[i];
      if (times[i] > max) max = times[i];
    }
    return { min, max };
  }
  function findSegmentsAtTime(segments, currentTime) {
    if (segments.length === 0) {
      return { current: null, next: null, index: -1 };
    }
    let currentIndex = 0;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].time <= currentTime) {
        currentIndex = i;
      } else {
        break;
      }
    }
    return {
      current: segments[currentIndex] || null,
      next: segments[currentIndex + 1] || null,
      index: currentIndex
    };
  }
  function interpolatePosition(seg1, seg2, currentTime) {
    if (!seg2 || !seg1.coords) {
      return {
        lat: seg1.coords[1][0],
        lon: seg1.coords[1][1],
        altitude: seg1.altitude_ft || 0,
        speed: seg1.groundspeed_knots || 0
      };
    }
    const t1 = seg1.time;
    const t2 = seg2.time;
    const progress = (currentTime - t1) / Math.max(t2 - t1, 1e-3);
    const startLat = seg1.coords[1][0];
    const startLon = seg1.coords[1][1];
    const endLat = seg2.coords[0][0];
    const endLon = seg2.coords[0][1];
    return {
      lat: startLat + (endLat - startLat) * progress,
      lon: startLon + (endLon - startLon) * progress,
      altitude: (seg1.altitude_ft || 0) + ((seg2.altitude_ft || 0) - (seg1.altitude_ft || 0)) * progress,
      speed: (seg1.groundspeed_knots || 0) + ((seg2.groundspeed_knots || 0) - (seg1.groundspeed_knots || 0)) * progress
    };
  }
  function calculateSmoothedBearing(segments, currentIdx, lookAhead = 5) {
    if (currentIdx < 0 || currentIdx >= segments.length) {
      return null;
    }
    const currentSeg = segments[currentIdx];
    const futureIdx = Math.min(currentIdx + lookAhead, segments.length - 1);
    const futureSeg = segments[futureIdx];
    if (currentIdx === futureIdx) {
      const coords = currentSeg.coords;
      if (coords && coords.length === 2) {
        return calculateBearing(
          coords[0][0],
          coords[0][1],
          coords[1][0],
          coords[1][1]
        );
      }
      return null;
    }
    if (!currentSeg.coords || !futureSeg.coords) {
      return null;
    }
    return calculateBearing(
      currentSeg.coords[1][0],
      currentSeg.coords[1][1],
      futureSeg.coords[0][0],
      futureSeg.coords[0][1]
    );
  }
  function calculateAutoZoom(altitude, speed, options = {}) {
    const {
      minZoom = 10,
      maxZoom = 16,
      cruiseAltitude = 5e3,
      cruiseSpeed = 100
    } = options;
    const altitudeFactor = Math.min(altitude / cruiseAltitude, 2);
    const speedFactor = Math.min(speed / cruiseSpeed, 2);
    const combinedFactor = (altitudeFactor + speedFactor) / 2;
    const zoomLevel = maxZoom - combinedFactor * (maxZoom - minZoom) / 2;
    return Math.max(minZoom, Math.min(maxZoom, Math.round(zoomLevel)));
  }
  function shouldRecenter(position, bounds, margin = 0.2) {
    const latRange = bounds.north - bounds.south;
    const lonRange = bounds.east - bounds.west;
    const latMargin = latRange * margin;
    const lonMargin = lonRange * margin;
    if (position.lat < bounds.south + latMargin) return true;
    if (position.lat > bounds.north - latMargin) return true;
    if (position.lon < bounds.west + lonMargin) return true;
    if (position.lon > bounds.east - lonMargin) return true;
    return false;
  }
  function calculateReplayProgress(currentTime, maxTime) {
    if (maxTime === 0) return 0;
    return Math.min(100, currentTime / maxTime * 100);
  }
  function validateReplayData(segments) {
    if (!segments || segments.length === 0) {
      return {
        valid: false,
        message: "No segments available for replay"
      };
    }
    const segmentsWithTime = segments.filter(
      (s) => s.time !== void 0 && s.time !== null
    );
    if (segmentsWithTime.length === 0) {
      return {
        valid: false,
        message: "No timestamp data available. The flight may not have timing information."
      };
    }
    return {
      valid: true,
      message: "Replay data is valid"
    };
  }

  // kml_heatmap/frontend/features/wrapped.ts
  function formatFlightTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return `${hours}h ${minutes}m`;
  }
  function calculateYearStats(pathInfo, segments, year, fullStats = null) {
    if (!pathInfo || pathInfo.length === 0) {
      return {
        total_flights: 0,
        total_distance_nm: 0,
        num_airports: 0,
        airport_names: [],
        flight_time: "0h 0m",
        aircraft_list: []
      };
    }
    const yearNum = year === "all" ? "all" : Number(year);
    const filteredPaths = yearNum === "all" ? pathInfo : pathInfo.filter((path) => path.year === yearNum);
    if (filteredPaths.length === 0) {
      return {
        total_flights: 0,
        total_distance_nm: 0,
        num_airports: 0,
        airport_names: [],
        flight_time: "0h 0m",
        aircraft_list: []
      };
    }
    const airports = collectAirports(filteredPaths);
    const airportNames = Array.from(airports);
    const filteredSegments = filterSegmentsByPaths(segments, filteredPaths);
    let totalDistanceKm = 0;
    filteredSegments.forEach((segment) => {
      if (segment.coords && segment.coords.length === 2) {
        const distance = calculateDistance(segment.coords[0], segment.coords[1]);
        totalDistanceKm += distance;
      }
    });
    const totalDistanceNm = totalDistanceKm * 0.539957;
    const totalSeconds = calculateFlightTime(filteredSegments, filteredPaths);
    const flightTime = formatFlightTime(totalSeconds);
    const aircraftMap = {};
    filteredPaths.forEach((path) => {
      if (path.aircraft_registration) {
        const reg = path.aircraft_registration;
        if (!aircraftMap[reg]) {
          aircraftMap[reg] = {
            registration: reg,
            type: path.aircraft_type,
            flights: 0,
            flight_time_seconds: 0
          };
        }
        aircraftMap[reg].flights += 1;
      }
    });
    Object.keys(aircraftMap).forEach((reg) => {
      const aircraftPaths = filteredPaths.filter(
        (p) => p.aircraft_registration === reg
      );
      const aircraftSegments = filterSegmentsByPaths(segments, aircraftPaths);
      const aircraftSeconds = calculateFlightTime(
        aircraftSegments,
        aircraftPaths
      );
      const aircraft = aircraftMap[reg];
      if (aircraft) {
        aircraft.flight_time_seconds = aircraftSeconds;
        aircraft.flight_time_str = formatFlightTime(aircraftSeconds);
      }
    });
    if (fullStats && fullStats.aircraft_list) {
      fullStats.aircraft_list.forEach((fullAircraft) => {
        const aircraft = aircraftMap[fullAircraft.registration];
        if (aircraft) {
          aircraft.model = fullAircraft.model;
        }
      });
    }
    const aircraftList = Object.values(aircraftMap).sort(
      (a, b) => b.flights - a.flights
    );
    return {
      total_flights: filteredPaths.length,
      total_distance_nm: totalDistanceNm,
      num_airports: airports.size,
      airport_names: airportNames,
      flight_time: flightTime,
      aircraft_list: aircraftList
    };
  }
  function generateFunFacts(yearStats, fullStats = null) {
    const facts = [];
    const distanceNm = yearStats.total_distance_nm;
    const earthCircumferenceNm = 21639;
    if (distanceNm > earthCircumferenceNm * 0.5) {
      const ratio = (distanceNm / earthCircumferenceNm).toFixed(1);
      facts.push({
        icon: "\u{1F30D}",
        text: `You flew <strong>${ratio}x</strong> around the Earth!`,
        category: "distance",
        priority: 10
      });
    } else if (distanceNm > 1e3) {
      facts.push({
        icon: "\u2708\uFE0F",
        text: `You covered <strong>${Math.round(distanceNm)} nautical miles</strong> this year!`,
        category: "distance",
        priority: 8
      });
    }
    const numAircraft = yearStats.aircraft_list.length;
    if (numAircraft === 1) {
      const aircraft = yearStats.aircraft_list[0];
      const model = aircraft?.model || aircraft?.type || aircraft?.registration || "Unknown";
      const flights = yearStats.total_flights;
      const registration = aircraft?.registration || "";
      if (registration) {
        facts.push({
          icon: "\u2708\uFE0F",
          text: `Loyal to <strong>${registration}</strong> - all ${flights} flight${flights !== 1 ? "s" : ""} in this ${model}!`,
          category: "aircraft",
          priority: 9
        });
      } else {
        facts.push({
          icon: "\u{1F499}",
          text: `Loyal to one aircraft: ${model}`,
          category: "aircraft",
          priority: 7
        });
      }
    } else if (numAircraft === 2) {
      facts.push({
        icon: "\u2708\uFE0F",
        text: `You flew <strong>${numAircraft} different aircraft</strong> this year.`,
        category: "aircraft",
        priority: 7
      });
    } else if (numAircraft >= 3) {
      facts.push({
        icon: "\u{1F6E9}\uFE0F",
        text: `Aircraft explorer! You flew <strong>${numAircraft} different aircraft</strong>.`,
        category: "aircraft",
        priority: 8
      });
    }
    if (yearStats.total_flights > 0 && distanceNm > 0) {
      const avgDistanceNm = Math.round(distanceNm / yearStats.total_flights);
      if (avgDistanceNm > 0) {
        facts.push({
          icon: "\u2708\uFE0F",
          text: `Cruising at <strong>${fullStats?.cruise_speed_knots ? Math.round(fullStats.cruise_speed_knots) : "?"} kt</strong>, averaging <strong>${avgDistanceNm} nm</strong> per adventure`,
          category: "distance",
          priority: 8
        });
      }
    }
    if (fullStats) {
      if (fullStats.longest_flight_nm && fullStats.longest_flight_nm > 0) {
        const longestNm = Math.round(fullStats.longest_flight_nm);
        facts.push({
          icon: "\u{1F6EB}",
          text: `Your longest journey: <strong>${longestNm} nm</strong> - that's Berlin to Munich distance!`,
          category: "distance",
          priority: 8
        });
      }
      if (fullStats.total_altitude_gain_ft) {
        const totalGainFt = Math.round(fullStats.total_altitude_gain_ft);
        facts.push({
          icon: "\u2B06\uFE0F",
          text: `Total elevation gain: <strong>${totalGainFt.toLocaleString()} ft</strong>`,
          category: "altitude",
          priority: 8
        });
        const everestFt = 29029;
        if (fullStats.total_altitude_gain_ft > everestFt) {
          const ratio = (fullStats.total_altitude_gain_ft / everestFt).toFixed(1);
          facts.push({
            icon: "\u{1F3D4}\uFE0F",
            text: `You climbed <strong>${ratio}x</strong> Mount Everest in altitude!`,
            category: "altitude",
            priority: 9
          });
        }
      }
      if (fullStats.most_common_cruise_altitude_ft && fullStats.most_common_cruise_altitude_m) {
        const cruiseAltFt = Math.round(fullStats.most_common_cruise_altitude_ft);
        const cruiseAltM = Math.round(fullStats.most_common_cruise_altitude_m);
        facts.push({
          icon: "\u2B06\uFE0F",
          text: `Most common cruise: <strong>${cruiseAltFt.toLocaleString()} ft</strong> AGL (<strong>${cruiseAltM.toLocaleString()} m</strong>)`,
          category: "altitude",
          priority: 7
        });
      }
      if (fullStats.total_flight_time_seconds) {
        const hours = Math.floor(fullStats.total_flight_time_seconds / 3600);
        facts.push({
          icon: "\u23F1\uFE0F",
          text: `Total flight time: <strong>${hours} hours</strong> in the air!`,
          category: "time",
          priority: 4
        });
      }
      if (fullStats.cruise_speed_knots) {
        facts.push({
          icon: "\u26A1",
          text: `Average cruise speed: <strong>${Math.round(fullStats.cruise_speed_knots)} knots</strong>`,
          category: "speed",
          priority: 3
        });
      }
      if (fullStats.max_altitude_ft && fullStats.max_altitude_ft > 4e4) {
        facts.push({
          icon: "\u{1F680}",
          text: `High altitude achievement: <strong>${Math.round(fullStats.max_altitude_ft)} feet</strong>!`,
          category: "achievement",
          priority: 9
        });
      }
    }
    return selectDiverseFacts(facts);
  }
  function selectDiverseFacts(allFacts) {
    if (allFacts.length === 0) {
      return [];
    }
    const sortedFacts = [...allFacts].sort((a, b) => b.priority - a.priority);
    const selected = [];
    const categoryCount = {};
    const maxPerCategory = 3;
    const minFacts = 4;
    const maxFacts = 6;
    for (const fact of sortedFacts) {
      const count = categoryCount[fact.category] || 0;
      if (count < maxPerCategory) {
        selected.push(fact);
        categoryCount[fact.category] = count + 1;
      }
      if (selected.length >= maxFacts) {
        break;
      }
    }
    if (selected.length < minFacts && allFacts.length >= minFacts) {
      for (const fact of sortedFacts) {
        if (!selected.includes(fact)) {
          selected.push(fact);
          if (selected.length >= minFacts) {
            break;
          }
        }
      }
    }
    return selected;
  }
  function calculateAircraftColorClass(flights, maxFlights, minFlights) {
    if (maxFlights === minFlights) {
      return "fleet-aircraft-high";
    }
    const normalized = (flights - minFlights) / (maxFlights - minFlights);
    if (normalized >= 0.75) {
      return "fleet-aircraft-high";
    } else if (normalized >= 0.5) {
      return "fleet-aircraft-medium-high";
    } else if (normalized >= 0.25) {
      return "fleet-aircraft-medium-low";
    } else {
      return "fleet-aircraft-low";
    }
  }
  function findHomeBase2(airportNames, airportCounts) {
    if (!airportNames || airportNames.length === 0) {
      return null;
    }
    let maxCount = 0;
    let homeBaseName = "";
    airportNames.forEach((name) => {
      const count = airportCounts[name] || 0;
      if (count > maxCount) {
        maxCount = count;
        homeBaseName = name;
      }
    });
    if (!homeBaseName) {
      return null;
    }
    return {
      name: homeBaseName,
      flight_count: maxCount
    };
  }
  function getDestinations(airportNames, homeBaseName) {
    if (!airportNames) {
      return [];
    }
    if (!homeBaseName) {
      return airportNames;
    }
    return airportNames.filter((name) => name !== homeBaseName);
  }

  // kml_heatmap/frontend/main.ts
  if (typeof window !== "undefined") {
    window.KMLHeatmap = {
      // Utilities
      calculateDistance,
      calculateBearing,
      ddToDms,
      formatTime,
      formatDistance,
      formatAltitude,
      formatSpeed,
      getResolutionForZoom,
      getColorForAltitude,
      getColorForAirspeed,
      // State management
      parseUrlParams,
      encodeStateToUrl,
      getDefaultState,
      mergeState,
      // Calculations
      filterPaths,
      collectAirports,
      aggregateAircraft,
      calculateTotalDistance,
      calculateAltitudeStats,
      calculateSpeedStats,
      calculateLongestFlight,
      calculateFlightTime,
      calculateFilteredStatistics,
      // Services
      DataLoader,
      // Airport features
      calculateAirportFlightCounts,
      findHomeBase,
      generateAirportPopup,
      calculateAirportOpacity,
      calculateAirportMarkerSize,
      calculateAirportVisibility,
      // Layer features
      calculateAltitudeRange,
      calculateAirspeedRange,
      shouldRenderSegment,
      calculateSegmentProperties,
      formatAltitudeLegendLabels,
      formatAirspeedLegendLabels,
      filterSegmentsForRendering,
      groupSegmentsByPath,
      calculateLayerStats,
      // Replay features
      prepareReplaySegments,
      calculateTimeRange,
      findSegmentsAtTime,
      interpolatePosition,
      calculateSmoothedBearing,
      replayCalculateBearing: calculateBearing,
      calculateAutoZoom,
      shouldRecenter,
      calculateReplayProgress,
      validateReplayData,
      // Wrapped features
      calculateYearStats,
      generateFunFacts,
      selectDiverseFacts,
      calculateAircraftColorClass,
      wrappedFindHomeBase: findHomeBase2,
      getDestinations
    };
  }
  return __toCommonJS(main_exports);
})();
//# sourceMappingURL=bundle.js.map
