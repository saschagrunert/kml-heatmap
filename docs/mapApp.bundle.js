"use strict";
var MapAppModule = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
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
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // leaflet-global:leaflet
  var require_leaflet = __commonJS({
    "leaflet-global:leaflet"(exports, module) {
      module.exports = window.L;
    }
  });

  // kml_heatmap/frontend/mapApp.ts
  var mapApp_exports = {};
  __export(mapApp_exports, {
    MapApp: () => MapApp
  });
  var L4 = __toESM(require_leaflet(), 1);

  // kml_heatmap/frontend/ui/dataManager.ts
  var DataManager = class {
    constructor(app) {
      this.app = app;
      this.dataLoader = new window.KMLHeatmap.DataLoader({
        dataDir: app.config.dataDir,
        showLoading: () => this.showLoading(),
        hideLoading: () => this.hideLoading()
      });
      this.loadedData = {};
      this.currentData = null;
    }
    showLoading() {
      const loadingEl = document.getElementById("loading");
      if (loadingEl) loadingEl.style.display = "block";
    }
    hideLoading() {
      const loadingEl = document.getElementById("loading");
      if (loadingEl) loadingEl.style.display = "none";
    }
    async loadData(resolution, year) {
      return await this.dataLoader.loadData(resolution, year);
    }
    async loadAirports() {
      return await this.dataLoader.loadAirports();
    }
    async loadMetadata() {
      return await this.dataLoader.loadMetadata();
    }
    async updateLayers() {
      if (!this.app.map) return;
      const zoom = this.app.map.getZoom();
      const resolution = window.KMLHeatmap.getResolutionForZoom(zoom);
      if (resolution === this.app.currentResolution) {
        return;
      }
      this.app.currentResolution = resolution;
      const data = await this.loadData(resolution, this.app.selectedYear);
      if (!data) return;
      this.currentData = data;
      this.app.currentData = data;
      let filteredCoordinates = data.coordinates;
      if ((this.app.selectedYear !== "all" || this.app.selectedAircraft !== "all") && data.path_segments) {
        const filteredPathIds = /* @__PURE__ */ new Set();
        if (data.path_info) {
          data.path_info.forEach((pathInfo) => {
            const matchesYear = this.app.selectedYear === "all" || pathInfo.year && pathInfo.year.toString() === this.app.selectedYear;
            const matchesAircraft = this.app.selectedAircraft === "all" || pathInfo.aircraft_registration === this.app.selectedAircraft;
            if (matchesYear && matchesAircraft) {
              filteredPathIds.add(pathInfo.id);
            }
          });
        }
        const coordSet = /* @__PURE__ */ new Set();
        data.path_segments.forEach((segment) => {
          if (filteredPathIds.has(segment.path_id)) {
            const coords = segment.coords;
            if (coords && coords.length === 2) {
              coordSet.add(JSON.stringify(coords[0]));
              coordSet.add(JSON.stringify(coords[1]));
            }
          }
        });
        filteredCoordinates = Array.from(coordSet).map((str) => {
          return JSON.parse(str);
        });
      }
      if (this.app.heatmapLayer) {
        this.app.map.removeLayer(this.app.heatmapLayer);
      }
      this.app.heatmapLayer = window.L.heatLayer(filteredCoordinates, {
        radius: 10,
        blur: 15,
        minOpacity: 0.25,
        maxOpacity: 0.6,
        max: 1,
        // Maximum point intensity for better performance
        gradient: {
          0: "blue",
          0.3: "cyan",
          0.5: "lime",
          0.7: "yellow",
          1: "red"
        }
      });
      if (this.app.heatmapLayer._canvas) {
        this.app.heatmapLayer._canvas.style.pointerEvents = "none";
      }
      if (this.app.heatmapVisible && !this.app.replayManager.replayActive) {
        this.app.heatmapLayer.addTo(this.app.map);
      }
      this.app.pathToAirports = {};
      this.app.airportToPaths = {};
      if (data.path_info) {
        data.path_info.forEach((pathInfo) => {
          const pathId = pathInfo.id;
          this.app.pathToAirports[pathId] = {
            start: pathInfo.start_airport,
            end: pathInfo.end_airport
          };
          if (pathInfo.start_airport) {
            if (!this.app.airportToPaths[pathInfo.start_airport]) {
              this.app.airportToPaths[pathInfo.start_airport] = /* @__PURE__ */ new Set();
            }
            this.app.airportToPaths[pathInfo.start_airport].add(pathId);
          }
          if (pathInfo.end_airport) {
            if (!this.app.airportToPaths[pathInfo.end_airport]) {
              this.app.airportToPaths[pathInfo.end_airport] = /* @__PURE__ */ new Set();
            }
            this.app.airportToPaths[pathInfo.end_airport].add(pathId);
          }
        });
      }
      if (data.path_segments && data.path_segments.length > 0) {
        const altitudes = data.path_segments.map((s) => s.altitude_ft || 0);
        let min = altitudes[0];
        let max = altitudes[0];
        for (let i = 1; i < altitudes.length; i++) {
          if (altitudes[i] < min) min = altitudes[i];
          if (altitudes[i] > max) max = altitudes[i];
        }
        this.app.altitudeRange.min = min;
        this.app.altitudeRange.max = max;
      }
      this.app.layerManager.redrawAltitudePaths();
      if (this.app.airspeedVisible) {
        this.app.layerManager.redrawAirspeedPaths();
      }
      console.log("Updated to " + resolution + " resolution");
    }
  };

  // kml_heatmap/frontend/ui/stateManager.ts
  var StateManager = class {
    constructor(app) {
      this.app = app;
    }
    saveMapState() {
      if (!this.app.map) return;
      const statsPanelEl = document.getElementById("stats-panel");
      const wrappedModalEl = document.getElementById("wrapped-modal");
      const state = {
        center: this.app.map.getCenter(),
        zoom: this.app.map.getZoom(),
        heatmapVisible: this.app.heatmapVisible,
        altitudeVisible: this.app.altitudeVisible,
        airspeedVisible: this.app.airspeedVisible,
        airportsVisible: this.app.airportsVisible,
        aviationVisible: this.app.aviationVisible,
        selectedYear: this.app.selectedYear,
        selectedAircraft: this.app.selectedAircraft,
        selectedPathIds: Array.from(this.app.selectedPathIds),
        statsPanelVisible: statsPanelEl ? statsPanelEl.classList.contains("visible") : false,
        wrappedVisible: wrappedModalEl ? wrappedModalEl.style.display === "flex" : false,
        buttonsHidden: this.app.buttonsHidden
        // Note: replay state is NOT persisted - too complex to restore reliably
      };
      try {
        localStorage.setItem("kml-heatmap-state", JSON.stringify(state));
      } catch (_e) {
      }
      this.updateUrl(state);
    }
    loadMapState() {
      try {
        const saved = localStorage.getItem("kml-heatmap-state");
        if (saved) {
          return JSON.parse(saved);
        }
      } catch (_e) {
      }
      return null;
    }
    /**
     * Update browser URL without reloading page
     * @param {Object} state - Current state object
     */
    updateUrl(state) {
      const urlParams = window.KMLHeatmap.encodeStateToUrl(state);
      const newUrl = urlParams ? "?" + urlParams : window.location.pathname;
      try {
        history.replaceState(null, "", newUrl);
      } catch (_e) {
      }
    }
    /**
     * Load state with priority: URL params > localStorage > defaults
     * @returns {Object|null} State object to restore
     */
    loadState() {
      const urlState = window.KMLHeatmap.parseUrlParams(
        new URLSearchParams(window.location.search)
      );
      if (urlState && Object.keys(urlState).length > 0) {
        return urlState;
      }
      return this.loadMapState();
    }
  };

  // kml_heatmap/frontend/ui/layerManager.ts
  var L = __toESM(require_leaflet(), 1);
  var LayerManager = class {
    constructor(app) {
      this.app = app;
    }
    redrawAltitudePaths() {
      if (!this.app.currentData) return;
      this.app.altitudeLayer.clearLayers();
      this.app.pathSegments = {};
      let colorMinAlt, colorMaxAlt;
      if (this.app.selectedPathIds.size > 0) {
        const selectedSegments = this.app.currentData.path_segments.filter(
          (segment) => {
            return this.app.selectedPathIds.has(segment.path_id);
          }
        );
        if (selectedSegments.length > 0) {
          const altitudes = selectedSegments.map((s) => s.altitude_ft || 0);
          let min = altitudes[0];
          let max = altitudes[0];
          for (let i = 1; i < altitudes.length; i++) {
            if (altitudes[i] < min) min = altitudes[i];
            if (altitudes[i] > max) max = altitudes[i];
          }
          colorMinAlt = min;
          colorMaxAlt = max;
        } else {
          colorMinAlt = this.app.altitudeRange.min;
          colorMaxAlt = this.app.altitudeRange.max;
        }
      } else {
        colorMinAlt = this.app.altitudeRange.min;
        colorMaxAlt = this.app.altitudeRange.max;
      }
      this.app.currentData.path_segments.forEach((segment) => {
        const pathId = segment.path_id;
        const pathInfo = this.app.currentData.path_info.find(
          (p) => p.id === pathId
        );
        if (this.app.selectedYear !== "all") {
          if (pathInfo && pathInfo.year && pathInfo.year.toString() !== this.app.selectedYear) {
            return;
          }
        }
        if (this.app.selectedAircraft !== "all") {
          if (pathInfo && pathInfo.aircraft_registration !== this.app.selectedAircraft) {
            return;
          }
        }
        const isSelected = this.app.selectedPathIds.has(pathId);
        if (this.app.selectedPathIds.size > 0 && !isSelected) {
          if (this.app.buttonsHidden) {
            return;
          }
        }
        const color = window.KMLHeatmap.getColorForAltitude(
          segment.altitude_ft,
          colorMinAlt,
          colorMaxAlt
        );
        const polyline4 = L.polyline(segment.coords || [], {
          color,
          weight: isSelected ? 6 : 4,
          opacity: isSelected ? 1 : this.app.selectedPathIds.size > 0 ? 0.1 : 0.85,
          renderer: this.app.altitudeRenderer,
          interactive: true
        }).bindPopup(
          "Altitude: " + segment.altitude_ft + " ft (" + segment.altitude_m + " m)"
        ).addTo(this.app.altitudeLayer);
        polyline4.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          this.app.pathSelection.togglePathSelection(pathId);
        });
        if (!this.app.pathSegments[pathId]) {
          this.app.pathSegments[pathId] = [];
        }
        this.app.pathSegments[pathId].push(segment);
      });
      this.updateAltitudeLegend(colorMinAlt, colorMaxAlt);
      this.app.airportManager.updateAirportOpacity();
      this.app.statsManager.updateStatsForSelection();
    }
    redrawAirspeedPaths() {
      if (!this.app.currentData) {
        console.warn("redrawAirspeedPaths: No current data available");
        return;
      }
      this.app.airspeedLayer.clearLayers();
      let colorMinSpeed, colorMaxSpeed;
      if (this.app.selectedPathIds.size > 0) {
        const selectedSegments = this.app.currentData.path_segments.filter(
          (segment) => {
            return this.app.selectedPathIds.has(segment.path_id) && (segment.groundspeed_knots || 0) > 0;
          }
        );
        if (selectedSegments.length > 0) {
          const groundspeeds = selectedSegments.map(
            (s) => s.groundspeed_knots || 0
          );
          let min = groundspeeds[0];
          let max = groundspeeds[0];
          for (let i = 1; i < groundspeeds.length; i++) {
            if (groundspeeds[i] < min) min = groundspeeds[i];
            if (groundspeeds[i] > max) max = groundspeeds[i];
          }
          colorMinSpeed = min;
          colorMaxSpeed = max;
        } else {
          colorMinSpeed = this.app.airspeedRange.min;
          colorMaxSpeed = this.app.airspeedRange.max;
        }
      } else {
        colorMinSpeed = this.app.airspeedRange.min;
        colorMaxSpeed = this.app.airspeedRange.max;
      }
      this.app.currentData.path_segments.forEach((segment) => {
        const pathId = segment.path_id;
        const pathInfo = this.app.currentData.path_info.find(
          (p) => p.id === pathId
        );
        if (this.app.selectedYear !== "all") {
          if (pathInfo && pathInfo.year && pathInfo.year.toString() !== this.app.selectedYear) {
            return;
          }
        }
        if (this.app.selectedAircraft !== "all") {
          if (pathInfo && pathInfo.aircraft_registration !== this.app.selectedAircraft) {
            return;
          }
        }
        if ((segment.groundspeed_knots || 0) > 0) {
          const isSelected = this.app.selectedPathIds.has(pathId);
          if (this.app.selectedPathIds.size > 0 && !isSelected) {
            if (this.app.buttonsHidden) {
              return;
            }
          }
          const color = window.KMLHeatmap.getColorForAirspeed(
            segment.groundspeed_knots,
            colorMinSpeed,
            colorMaxSpeed
          );
          const kmh = Math.round((segment.groundspeed_knots || 0) * 1.852);
          const polyline4 = L.polyline(segment.coords || [], {
            color,
            weight: isSelected ? 6 : 4,
            opacity: isSelected ? 1 : this.app.selectedPathIds.size > 0 ? 0.1 : 0.85,
            renderer: this.app.airspeedRenderer,
            interactive: true
          }).bindPopup(
            "Groundspeed: " + segment.groundspeed_knots + " kt (" + kmh + " km/h)"
          ).addTo(this.app.airspeedLayer);
          polyline4.on("click", (e) => {
            L.DomEvent.stopPropagation(e);
            this.app.pathSelection.togglePathSelection(pathId);
          });
        }
      });
      this.updateAirspeedLegend(colorMinSpeed, colorMaxSpeed);
      this.app.airportManager.updateAirportOpacity();
      this.app.statsManager.updateStatsForSelection();
    }
    updateAltitudeLegend(minAlt, maxAlt) {
      const minFt = Math.round(minAlt);
      const maxFt = Math.round(maxAlt);
      const minM = Math.round(minAlt * 0.3048);
      const maxM = Math.round(maxAlt * 0.3048);
      const minEl = document.getElementById("legend-min");
      const maxEl = document.getElementById("legend-max");
      if (minEl) {
        minEl.textContent = minFt.toLocaleString() + " ft (" + minM.toLocaleString() + " m)";
      }
      if (maxEl) {
        maxEl.textContent = maxFt.toLocaleString() + " ft (" + maxM.toLocaleString() + " m)";
      }
    }
    updateAirspeedLegend(minSpeed, maxSpeed) {
      const minKnots = Math.round(minSpeed);
      const maxKnots = Math.round(maxSpeed);
      const minKmh = Math.round(minSpeed * 1.852);
      const maxKmh = Math.round(maxSpeed * 1.852);
      const minEl = document.getElementById("airspeed-legend-min");
      const maxEl = document.getElementById("airspeed-legend-max");
      if (minEl) {
        minEl.textContent = minKnots.toLocaleString() + " kt (" + minKmh.toLocaleString() + " km/h)";
      }
      if (maxEl) {
        maxEl.textContent = maxKnots.toLocaleString() + " kt (" + maxKmh.toLocaleString() + " km/h)";
      }
    }
  };

  // kml_heatmap/frontend/ui/filterManager.ts
  var FilterManager = class {
    constructor(app) {
      this.app = app;
    }
    updateAircraftDropdown() {
      if (!this.app.fullPathInfo) return;
      const aircraftSelect = document.getElementById(
        "aircraft-select"
      );
      if (!aircraftSelect) return;
      const currentSelection = this.app.selectedAircraft;
      while (aircraftSelect.options.length > 1) {
        aircraftSelect.remove(1);
      }
      let yearFilteredPathInfo;
      if (this.app.selectedYear === "all") {
        yearFilteredPathInfo = this.app.fullPathInfo;
      } else {
        yearFilteredPathInfo = this.app.fullPathInfo.filter((pathInfo) => {
          return pathInfo.year && pathInfo.year.toString() === this.app.selectedYear;
        });
      }
      const aircraftMap = {};
      yearFilteredPathInfo.forEach((pathInfo) => {
        if (pathInfo.aircraft_registration) {
          const reg = pathInfo.aircraft_registration;
          if (!aircraftMap[reg]) {
            aircraftMap[reg] = {
              registration: reg,
              type: pathInfo.aircraft_type,
              flights: 0
            };
          }
          aircraftMap[reg].flights += 1;
        }
      });
      const aircraftList = Object.values(aircraftMap).sort((a, b) => {
        return b.flights - a.flights;
      });
      let selectedAircraftExists = false;
      aircraftList.forEach((aircraft) => {
        const option = document.createElement("option");
        option.value = aircraft.registration;
        const typeStr = aircraft.type ? " (" + aircraft.type + ")" : "";
        option.textContent = "\u2708\uFE0F " + aircraft.registration + typeStr;
        aircraftSelect.appendChild(option);
        if (aircraft.registration === currentSelection) {
          selectedAircraftExists = true;
        }
      });
      if (!selectedAircraftExists && currentSelection !== "all") {
        this.app.selectedAircraft = "all";
        aircraftSelect.value = "all";
      } else {
        aircraftSelect.value = currentSelection;
      }
    }
    async filterByYear() {
      const yearSelect = document.getElementById(
        "year-select"
      );
      if (!yearSelect) return;
      this.app.selectedYear = yearSelect.value;
      this.app.dataManager.loadedData = {};
      this.app.currentResolution = null;
      this.app.altitudeLayer.clearLayers();
      this.app.pathSegments = {};
      if (!this.app.isInitializing) {
        this.app.selectedPathIds.clear();
      }
      await this.app.dataManager.updateLayers();
      const fullResData = await this.app.dataManager.loadData(
        "z14_plus",
        this.app.selectedYear
      );
      if (fullResData) {
        this.app.fullPathInfo = fullResData.path_info || [];
        this.app.fullPathSegments = fullResData.path_segments || [];
      }
      this.updateAircraftDropdown();
      const filteredStats = window.KMLHeatmap.calculateFilteredStatistics({
        pathInfo: this.app.fullPathInfo,
        segments: this.app.fullPathSegments,
        year: this.app.selectedYear,
        aircraft: this.app.selectedAircraft
      });
      this.app.statsManager.updateStatsPanel(filteredStats, false);
      this.app.airportManager.updateAirportOpacity();
      this.app.airportManager.updateAirportPopups();
      if (!this.app.isInitializing) {
        this.app.stateManager.saveMapState();
      }
    }
    async filterByAircraft() {
      const aircraftSelect = document.getElementById(
        "aircraft-select"
      );
      if (!aircraftSelect) return;
      this.app.selectedAircraft = aircraftSelect.value;
      this.app.altitudeLayer.clearLayers();
      this.app.pathSegments = {};
      if (!this.app.isInitializing) {
        this.app.selectedPathIds.clear();
      }
      this.app.currentResolution = null;
      await this.app.dataManager.updateLayers();
      const filteredStats = window.KMLHeatmap.calculateFilteredStatistics({
        pathInfo: this.app.fullPathInfo,
        segments: this.app.fullPathSegments,
        year: this.app.selectedYear,
        aircraft: this.app.selectedAircraft
      });
      this.app.statsManager.updateStatsPanel(filteredStats, false);
      this.app.airportManager.updateAirportOpacity();
      this.app.airportManager.updateAirportPopups();
      if (!this.app.isInitializing) {
        this.app.stateManager.saveMapState();
      }
    }
  };

  // kml_heatmap/frontend/ui/statsManager.ts
  var StatsManager = class {
    constructor(app) {
      this.app = app;
    }
    updateStatsForSelection() {
      if (this.app.selectedPathIds.size === 0) {
        const statsToShow = window.KMLHeatmap.calculateFilteredStatistics({
          pathInfo: this.app.fullPathInfo,
          segments: this.app.fullPathSegments,
          year: this.app.selectedYear,
          aircraft: this.app.selectedAircraft
        });
        if (statsToShow) {
          this.updateStatsPanel(statsToShow, false);
        }
        return;
      }
      const selectedPathInfo = (this.app.fullPathInfo || []).filter((path) => {
        return this.app.selectedPathIds.has(path.id);
      });
      const selectedSegments = (this.app.fullPathSegments || []).filter(
        (segment) => {
          return this.app.selectedPathIds.has(segment.path_id);
        }
      );
      if (selectedSegments.length === 0) return;
      const selectedStats = window.KMLHeatmap.calculateFilteredStatistics({
        pathInfo: selectedPathInfo,
        segments: selectedSegments,
        year: "all",
        // Don't filter by year for selection
        aircraft: "all"
        // Don't filter by aircraft for selection
      });
      this.updateStatsPanel(selectedStats, true);
    }
    updateStatsPanel(stats, isSelection) {
      let html = "";
      if (isSelection) {
        html += '<p style="margin:0 0 10px 0; font-weight:bold; font-size:15px;">\u{1F4CA} Selected Paths Statistics</p>';
        html += '<div style="background-color: #3a5a7a; padding: 4px 8px; margin-bottom: 8px; border-radius: 3px; font-size: 11px; color: #a0c0e0;">Showing stats for ' + stats.num_paths + " selected path(s)</div>";
      } else {
        html += '<p style="margin:0 0 10px 0; font-weight:bold; font-size:15px;">\u{1F4CA} Flight Statistics</p>';
      }
      html += '<div style="margin-bottom: 8px;"><strong>Data Points:</strong> ' + stats.total_points.toLocaleString() + "</div>";
      html += '<div style="margin-bottom: 8px;"><strong>Flights:</strong> ' + stats.num_paths + "</div>";
      if (stats.airport_names && stats.airport_names.length > 0) {
        html += '<div style="margin-bottom: 8px; max-height: 150px; overflow-y: auto;"><strong>Airports (' + stats.num_airports + "):</strong><br>";
        stats.airport_names.forEach((name) => {
          html += '<span style="margin-left: 10px;">\u2022 ' + name + "</span><br>";
        });
        html += "</div>";
      }
      if (stats.num_aircraft && stats.num_aircraft > 0 && stats.aircraft_list && stats.aircraft_list.length > 0) {
        html += '<div style="margin-bottom: 8px; max-height: 150px; overflow-y: auto;"><strong>Aircrafts (' + stats.num_aircraft + "):</strong><br>";
        stats.aircraft_list.forEach((aircraft) => {
          const typeStr = aircraft.type ? " (" + aircraft.type + ")" : "";
          html += '<span style="margin-left: 10px;">\u2022 ' + aircraft.registration + typeStr + " - " + aircraft.flights + " flight(s)</span><br>";
        });
        html += "</div>";
      }
      if (stats.total_flight_time_str) {
        html += '<div style="margin-bottom: 8px;"><strong>Total Flight Time:</strong> ' + stats.total_flight_time_str + "</div>";
      }
      const distanceKm = (stats.total_distance_nm * 1.852).toFixed(1);
      html += '<div style="margin-bottom: 8px;"><strong>Distance:</strong> ' + stats.total_distance_nm.toFixed(1) + " nm (" + distanceKm + " km)</div>";
      if (stats.num_paths > 0) {
        const avgDistanceNm = (stats.total_distance_nm / stats.num_paths).toFixed(
          1
        );
        const avgDistanceKm = (parseFloat(avgDistanceNm) * 1.852).toFixed(1);
        html += '<div style="margin-bottom: 8px;"><strong>Average Distance per Trip:</strong> ' + avgDistanceNm + " nm (" + avgDistanceKm + " km)</div>";
      }
      if (stats.longest_flight_nm && stats.longest_flight_nm > 0) {
        const longestKm = (stats.longest_flight_km || 0).toFixed(1);
        html += '<div style="margin-bottom: 8px;"><strong>Longest Flight:</strong> ' + stats.longest_flight_nm.toFixed(1) + " nm (" + longestKm + " km)</div>";
      }
      if (stats.average_groundspeed_knots && stats.average_groundspeed_knots > 0) {
        const kmh = Math.round(stats.average_groundspeed_knots * 1.852);
        html += '<div style="margin-bottom: 8px;"><strong>Average Groundspeed:</strong> ' + Math.round(stats.average_groundspeed_knots) + " kt (" + kmh + " km/h)</div>";
      }
      if (stats.cruise_speed_knots && stats.cruise_speed_knots > 0) {
        const kmh_cruise = Math.round(stats.cruise_speed_knots * 1.852);
        html += '<div style="margin-bottom: 8px;"><strong>Cruise Speed (>1000ft AGL):</strong> ' + Math.round(stats.cruise_speed_knots) + " kt (" + kmh_cruise + " km/h)</div>";
      }
      if (stats.max_groundspeed_knots && stats.max_groundspeed_knots > 0) {
        const kmh_max = Math.round(stats.max_groundspeed_knots * 1.852);
        html += '<div style="margin-bottom: 8px;"><strong>Max Groundspeed:</strong> ' + Math.round(stats.max_groundspeed_knots) + " kt (" + kmh_max + " km/h)</div>";
      }
      if (stats.max_altitude_ft) {
        const maxAltitudeM = Math.round(stats.max_altitude_ft * 0.3048);
        html += '<div style="margin-bottom: 8px;"><strong>Max Altitude (MSL):</strong> ' + Math.round(stats.max_altitude_ft) + " ft (" + maxAltitudeM + " m)</div>";
        if (stats.total_altitude_gain_ft) {
          const elevationGainM = Math.round(
            stats.total_altitude_gain_ft * 0.3048
          );
          html += '<div style="margin-bottom: 8px;"><strong>Elevation Gain:</strong> ' + Math.round(stats.total_altitude_gain_ft) + " ft (" + elevationGainM + " m)</div>";
        }
      }
      if (stats.most_common_cruise_altitude_ft && stats.most_common_cruise_altitude_ft > 0) {
        const cruiseAltM = Math.round(
          stats.most_common_cruise_altitude_m
        );
        html += '<div style="margin-bottom: 8px;"><strong>Most Common Cruise Altitude (AGL):</strong> ' + stats.most_common_cruise_altitude_ft.toLocaleString() + " ft (" + cruiseAltM.toLocaleString() + " m)</div>";
      }
      const panel = document.getElementById("stats-panel");
      if (panel) panel.innerHTML = html;
    }
    toggleStats() {
      const panel = document.getElementById("stats-panel");
      if (!panel) return;
      if (panel.classList.contains("visible")) {
        panel.classList.remove("visible");
        setTimeout(() => {
          panel.style.display = "none";
          this.app.stateManager.saveMapState();
        }, 300);
      } else {
        panel.style.display = "block";
        panel.offsetHeight;
        panel.classList.add("visible");
        this.app.stateManager.saveMapState();
      }
    }
  };

  // kml_heatmap/frontend/ui/pathSelection.ts
  var PathSelection = class {
    constructor(app) {
      this.app = app;
    }
    togglePathSelection(pathId) {
      if (this.app.selectedPathIds.has(pathId)) {
        this.app.selectedPathIds.delete(pathId);
      } else {
        this.app.selectedPathIds.add(pathId);
      }
      if (this.app.altitudeVisible) {
        this.app.layerManager.redrawAltitudePaths();
        setTimeout(() => {
          this.app.map.invalidateSize();
        }, 50);
      }
      if (this.app.airspeedVisible) {
        this.app.layerManager.redrawAirspeedPaths();
        setTimeout(() => {
          this.app.map.invalidateSize();
        }, 50);
      }
      this.app.replayManager.updateReplayButtonState();
      this.app.stateManager.saveMapState();
    }
    selectPathsByAirport(airportName) {
      const pathIds = this.app.airportToPaths[airportName];
      if (pathIds) {
        pathIds.forEach((pathId) => {
          this.app.selectedPathIds.add(pathId);
        });
      }
      if (this.app.altitudeVisible) {
        this.app.layerManager.redrawAltitudePaths();
        setTimeout(() => {
          this.app.map.invalidateSize();
        }, 50);
      }
      if (this.app.airspeedVisible) {
        this.app.layerManager.redrawAirspeedPaths();
        setTimeout(() => {
          this.app.map.invalidateSize();
        }, 50);
      }
      this.app.replayManager.updateReplayButtonState();
      this.app.stateManager.saveMapState();
    }
    clearSelection() {
      this.app.selectedPathIds.clear();
      if (this.app.altitudeVisible) {
        this.app.layerManager.redrawAltitudePaths();
        setTimeout(() => {
          this.app.map.invalidateSize();
        }, 50);
      }
      if (this.app.airspeedVisible) {
        this.app.layerManager.redrawAirspeedPaths();
        setTimeout(() => {
          this.app.map.invalidateSize();
        }, 50);
      }
      this.app.replayManager.updateReplayButtonState();
      this.app.stateManager.saveMapState();
    }
  };

  // kml_heatmap/frontend/ui/airportManager.ts
  var AirportManager = class {
    constructor(app) {
      this.app = app;
    }
    // Calculate airport flight counts based on current filters
    calculateAirportFlightCounts() {
      return window.KMLHeatmap.calculateAirportFlightCounts(
        this.app.fullPathInfo,
        this.app.selectedYear,
        this.app.selectedAircraft
      );
    }
    // Update airport popup content with current filter-based counts
    updateAirportPopups() {
      if (!this.app.allAirportsData || !this.app.airportMarkers) return;
      const airportCounts = this.calculateAirportFlightCounts();
      let homeBaseName = null;
      let maxCount = 0;
      Object.keys(airportCounts).forEach((name) => {
        const count = airportCounts[name];
        if (count !== void 0 && count > maxCount) {
          maxCount = count;
          homeBaseName = name;
        }
      });
      this.app.allAirportsData.forEach((airport) => {
        const marker3 = this.app.airportMarkers[airport.name];
        if (!marker3) return;
        const flightCount = airportCounts[airport.name] || 0;
        const isHomeBase = airport.name === homeBaseName;
        const latDms = window.KMLHeatmap.ddToDms(airport.lat, true);
        const lonDms = window.KMLHeatmap.ddToDms(airport.lon, false);
        const googleMapsLink = `https://www.google.com/maps?q=${airport.lat},${airport.lon}`;
        const popup = `
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
        marker3.setPopupContent(popup);
      });
    }
    updateAirportOpacity() {
      const hasFilters = this.app.selectedYear !== "all" || this.app.selectedAircraft !== "all";
      const hasSelection = this.app.selectedPathIds.size > 0;
      if (!hasFilters && !hasSelection) {
        Object.keys(this.app.airportMarkers).forEach((airportName) => {
          const marker3 = this.app.airportMarkers[airportName];
          if (!marker3) return;
          marker3.setOpacity(1);
          if (!this.app.airportLayer.hasLayer(marker3)) {
            marker3.addTo(this.app.airportLayer);
          }
        });
        return;
      }
      const visibleAirports = /* @__PURE__ */ new Set();
      if (hasFilters && this.app.fullPathInfo) {
        this.app.fullPathInfo.forEach((pathInfo) => {
          const matchesYear = this.app.selectedYear === "all" || pathInfo.year && pathInfo.year.toString() === this.app.selectedYear;
          const matchesAircraft = this.app.selectedAircraft === "all" || pathInfo.aircraft_registration === this.app.selectedAircraft;
          if (matchesYear && matchesAircraft) {
            if (pathInfo.start_airport)
              visibleAirports.add(pathInfo.start_airport);
            if (pathInfo.end_airport) visibleAirports.add(pathInfo.end_airport);
          }
        });
      }
      if (hasSelection) {
        this.app.selectedPathIds.forEach((pathId) => {
          if (this.app.fullPathInfo) {
            const pathInfo = this.app.fullPathInfo.find((p) => p.id === pathId);
            if (pathInfo) {
              if (pathInfo.start_airport)
                visibleAirports.add(pathInfo.start_airport);
              if (pathInfo.end_airport) visibleAirports.add(pathInfo.end_airport);
            }
          } else {
            const airports = this.app.pathToAirports[pathId];
            if (airports) {
              if (airports.start) visibleAirports.add(airports.start);
              if (airports.end) visibleAirports.add(airports.end);
            }
          }
        });
      }
      Object.keys(this.app.airportMarkers).forEach((airportName) => {
        const marker3 = this.app.airportMarkers[airportName];
        if (!marker3) return;
        if (visibleAirports.has(airportName)) {
          marker3.setOpacity(1);
          if (!this.app.airportLayer.hasLayer(marker3)) {
            marker3.addTo(this.app.airportLayer);
          }
        } else {
          if (this.app.airportLayer.hasLayer(marker3)) {
            this.app.airportLayer.removeLayer(marker3);
          }
        }
      });
    }
    updateAirportMarkerSizes() {
      if (!this.app.map) return;
      const zoom = this.app.map.getZoom();
      let sizeClass = "";
      if (zoom >= 14) {
        sizeClass = "xlarge";
      } else if (zoom >= 12) {
        sizeClass = "large";
      } else if (zoom >= 10) {
        sizeClass = "medium";
      } else if (zoom >= 8) {
        sizeClass = "medium-small";
      } else if (zoom >= 6) {
        sizeClass = "small";
      }
      document.querySelectorAll(".airport-marker-container").forEach((container) => {
        const marker3 = container.querySelector(".airport-marker");
        const label = container.querySelector(".airport-label");
        if (!marker3 || !label) return;
        if (zoom < 5) {
          label.style.display = "none";
        } else {
          label.style.display = "";
        }
        container.classList.remove(
          "airport-marker-container-small",
          "airport-marker-container-medium-small",
          "airport-marker-container-medium",
          "airport-marker-container-large",
          "airport-marker-container-xlarge"
        );
        marker3.classList.remove(
          "airport-marker-small",
          "airport-marker-medium-small",
          "airport-marker-medium",
          "airport-marker-large",
          "airport-marker-xlarge"
        );
        label.classList.remove(
          "airport-label-small",
          "airport-label-medium-small",
          "airport-label-medium",
          "airport-label-large",
          "airport-label-xlarge"
        );
        if (sizeClass) {
          container.classList.add("airport-marker-container-" + sizeClass);
          marker3.classList.add("airport-marker-" + sizeClass);
          label.classList.add("airport-label-" + sizeClass);
        }
      });
    }
  };

  // kml_heatmap/frontend/ui/replayManager.ts
  var L2 = __toESM(require_leaflet(), 1);
  var ReplayManager = class {
    constructor(app) {
      this.app = app;
      this.replayActive = false;
      this.replayPlaying = false;
      this.replayCurrentTime = 0;
      this.replayMaxTime = 0;
      this.replaySpeed = 50;
      this.replayInterval = null;
      this.replayLayer = null;
      this.replaySegments = [];
      this.replayAirplaneMarker = null;
      this.replayLastDrawnIndex = -1;
      this.replayLastBearing = null;
      this.replayAnimationFrameId = null;
      this.replayLastFrameTime = null;
      this.replayColorMinAlt = 0;
      this.replayColorMaxAlt = 1e4;
      this.replayColorMinSpeed = 0;
      this.replayColorMaxSpeed = 200;
      this.replayAutoZoom = false;
      this.replayLastZoom = null;
      this.replayRecenterTimestamps = [];
    }
    toggleReplay() {
      const panel = document.getElementById("replay-controls");
      if (!panel) return;
      if (this.replayActive) {
        this.stopReplay();
        panel.style.display = "none";
        this.replayActive = false;
        const replayBtn = document.getElementById("replay-btn");
        if (replayBtn) replayBtn.textContent = "\u25B6\uFE0F Replay";
        document.body.classList.remove("replay-active");
        if (this.replayAirplaneMarker && this.app.map) {
          this.app.map.removeLayer(this.replayAirplaneMarker);
          this.replayAirplaneMarker = null;
        }
        if (this.replayLayer && this.app.map) {
          this.app.map.removeLayer(this.replayLayer);
        }
        this.restoreLayerVisibility();
        if (!this.app.altitudeVisible && !this.app.airspeedVisible && this.app.map) {
          this.app.altitudeVisible = true;
          const altBtn = document.getElementById("altitude-btn");
          if (altBtn) altBtn.style.opacity = "1.0";
          const altLegend = document.getElementById("altitude-legend");
          if (altLegend) altLegend.style.display = "block";
          this.app.map.addLayer(this.app.altitudeLayer);
        }
        setTimeout(() => {
          if (this.app.altitudeVisible) {
            this.app.layerManager.redrawAltitudePaths();
          } else if (this.app.airspeedVisible) {
            this.app.layerManager.redrawAirspeedPaths();
          }
          if (this.app.map) this.app.map.invalidateSize();
        }, 100);
        this.updateReplayButtonState();
        this.app.stateManager.saveMapState();
      } else {
        if (this.app.selectedPathIds.size !== 1) {
          return;
        }
        if (this.initializeReplay()) {
          panel.style.display = "block";
          this.replayActive = true;
          const replayBtn = document.getElementById("replay-btn");
          if (replayBtn) {
            replayBtn.textContent = "\u23F9\uFE0F Replay";
            replayBtn.style.opacity = "1.0";
          }
          const autoZoomBtn = document.getElementById(
            "replay-autozoom-btn"
          );
          if (autoZoomBtn) {
            autoZoomBtn.style.opacity = this.replayAutoZoom ? "1.0" : "0.5";
            autoZoomBtn.title = this.replayAutoZoom ? "Auto-zoom enabled" : "Auto-zoom disabled";
          }
          document.body.classList.add("replay-active");
          this.hideOtherLayersDuringReplay();
          this.app.stateManager.saveMapState();
        }
      }
    }
    updateReplayButtonState() {
      const btn = document.getElementById("replay-btn");
      if (!btn) return;
      if (this.app.selectedPathIds.size === 1) {
        btn.style.opacity = "1.0";
      } else {
        btn.style.opacity = "0.5";
      }
    }
    updateReplayAirplanePopup() {
      if (!this.replayAirplaneMarker || !this.replayActive) return;
      let currentSegment = null;
      for (let i = 0; i < this.replaySegments.length; i++) {
        const seg = this.replaySegments[i];
        if (seg && (seg.time || 0) <= this.replayCurrentTime) {
          currentSegment = seg;
        } else {
          break;
        }
      }
      if (!currentSegment && this.replaySegments.length > 0) {
        currentSegment = this.replaySegments[0];
      }
      if (!currentSegment) return;
      let popupContent = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; min-width: 180px; padding: 8px 4px; background-color: #2b2b2b; color: #ffffff;">`;
      popupContent += '<div style="font-size: 14px; font-weight: bold; color: #4facfe; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 2px solid #4facfe; display: flex; align-items: center; gap: 6px;">';
      popupContent += '<span style="font-size: 16px;">\u2708\uFE0F</span>';
      popupContent += "<span>Current Position</span>";
      popupContent += "</div>";
      const altFt = currentSegment.altitude_ft || 0;
      const altFtRounded = Math.round(altFt / 50) * 50;
      const altMRounded = Math.round(altFtRounded * 0.3048);
      const altColor = window.KMLHeatmap.getColorForAltitude(
        altFt,
        this.replayColorMinAlt,
        this.replayColorMaxAlt
      );
      const altColorBg = altColor.replace("rgb(", "rgba(").replace(")", ", 0.15)");
      popupContent += '<div style="margin-bottom: 8px;">';
      popupContent += '<div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Altitude (MSL)</div>';
      popupContent += '<div style="background: ' + altColorBg + "; padding: 6px 8px; border-radius: 6px; border-left: 3px solid " + altColor + ';">';
      popupContent += '<span style="font-size: 16px; font-weight: bold; color: ' + altColor + ';">' + altFtRounded.toLocaleString() + " ft</span>";
      popupContent += '<span style="font-size: 12px; color: #ccc; margin-left: 6px;">(' + altMRounded.toLocaleString() + " m)</span>";
      popupContent += "</div>";
      popupContent += "</div>";
      const speedKt = currentSegment.groundspeed_knots || 0;
      const speedKmh = speedKt * 1.852;
      const speedKtRounded = Math.round(speedKt);
      const speedKmhRounded = Math.round(speedKmh);
      const speedColor = window.KMLHeatmap.getColorForAirspeed(
        speedKt,
        this.replayColorMinSpeed,
        this.replayColorMaxSpeed
      );
      const speedColorBg = speedColor.replace("rgb(", "rgba(").replace(")", ", 0.15)");
      popupContent += '<div style="margin-bottom: 8px;">';
      popupContent += '<div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Groundspeed</div>';
      popupContent += '<div style="background: ' + speedColorBg + "; padding: 6px 8px; border-radius: 6px; border-left: 3px solid " + speedColor + ';">';
      popupContent += '<span style="font-size: 16px; font-weight: bold; color: ' + speedColor + ';">' + speedKtRounded.toLocaleString() + " kt</span>";
      popupContent += '<span style="font-size: 12px; color: #ccc; margin-left: 6px;">(' + speedKmhRounded.toLocaleString() + " km/h)</span>";
      popupContent += "</div>";
      popupContent += "</div>";
      popupContent += "</div>";
      if (!this.replayAirplaneMarker.getPopup()) {
        this.replayAirplaneMarker.bindPopup(popupContent, {
          autoPanPadding: [50, 50]
        });
      } else {
        this.replayAirplaneMarker.getPopup().setContent(popupContent);
      }
      this.replayAirplaneMarker.openPopup();
    }
    initializeReplay() {
      if (!this.app.fullPathSegments) {
        alert(
          "No flight data available for replay. Please wait for data to load or refresh the page."
        );
        return false;
      }
      const selectedPathId = Array.from(this.app.selectedPathIds)[0];
      this.replaySegments = this.app.fullPathSegments.filter((seg) => {
        return seg.path_id === selectedPathId && seg.time !== void 0 && seg.time !== null;
      });
      if (this.replaySegments.length === 0) {
        alert(
          "No timestamp data available for this path. The flight may not have timing information."
        );
        return false;
      }
      this.replaySegments.sort((a, b) => {
        return (a.time || 0) - (b.time || 0);
      });
      if (this.app.currentData && this.app.currentData.path_segments) {
        const currentResSegments = this.app.currentData.path_segments.filter(
          (seg) => {
            return seg.path_id === selectedPathId;
          }
        );
        if (currentResSegments.length > 0) {
          const altitudes = currentResSegments.map((s) => {
            return s.altitude_ft || 0;
          });
          let min = altitudes[0];
          let max = altitudes[0];
          for (let i = 1; i < altitudes.length; i++) {
            if (altitudes[i] < min) min = altitudes[i];
            if (altitudes[i] > max) max = altitudes[i];
          }
          this.replayColorMinAlt = min;
          this.replayColorMaxAlt = max;
          const groundspeeds = currentResSegments.map((s) => {
            return s.groundspeed_knots || 0;
          }).filter((s) => {
            return s > 0;
          });
          if (groundspeeds.length > 0) {
            let min2 = groundspeeds[0];
            let max2 = groundspeeds[0];
            for (let i = 1; i < groundspeeds.length; i++) {
              if (groundspeeds[i] < min2) min2 = groundspeeds[i];
              if (groundspeeds[i] > max2) max2 = groundspeeds[i];
            }
            this.replayColorMinSpeed = min2;
            this.replayColorMaxSpeed = max2;
          } else {
            this.replayColorMinSpeed = this.app.airspeedRange.min;
            this.replayColorMaxSpeed = this.app.airspeedRange.max;
          }
        } else {
          const altitudes = this.replaySegments.map((s) => {
            return s.altitude_ft || 0;
          });
          let min = altitudes[0];
          let max = altitudes[0];
          for (let i = 1; i < altitudes.length; i++) {
            if (altitudes[i] < min) min = altitudes[i];
            if (altitudes[i] > max) max = altitudes[i];
          }
          this.replayColorMinAlt = min;
          this.replayColorMaxAlt = max;
          const groundspeeds = this.replaySegments.map((s) => {
            return s.groundspeed_knots || 0;
          }).filter((s) => {
            return s > 0;
          });
          if (groundspeeds.length > 0) {
            let min2 = groundspeeds[0];
            let max2 = groundspeeds[0];
            for (let i = 1; i < groundspeeds.length; i++) {
              if (groundspeeds[i] < min2) min2 = groundspeeds[i];
              if (groundspeeds[i] > max2) max2 = groundspeeds[i];
            }
            this.replayColorMinSpeed = min2;
            this.replayColorMaxSpeed = max2;
          } else {
            this.replayColorMinSpeed = this.app.airspeedRange.min;
            this.replayColorMaxSpeed = this.app.airspeedRange.max;
          }
        }
      }
      const lastSegment = this.replaySegments[this.replaySegments.length - 1];
      this.replayMaxTime = lastSegment?.time || 0;
      const slider = document.getElementById(
        "replay-slider"
      );
      if (slider) {
        slider.max = this.replayMaxTime.toString();
      }
      const sliderEnd = document.getElementById("replay-slider-end");
      if (sliderEnd) {
        sliderEnd.textContent = window.KMLHeatmap.formatTime(
          this.replayMaxTime
        );
      }
      this.app.layerManager.updateAltitudeLegend(
        this.replayColorMinAlt,
        this.replayColorMaxAlt
      );
      this.app.layerManager.updateAirspeedLegend(
        this.replayColorMinSpeed,
        this.replayColorMaxSpeed
      );
      if (!this.replayLayer) {
        this.replayLayer = L2.layerGroup();
      }
      this.replayLayer.clearLayers();
      if (this.app.map) {
        this.replayLayer.addTo(this.app.map);
      }
      if (this.replayAirplaneMarker && this.app.map) {
        this.app.map.removeLayer(this.replayAirplaneMarker);
        this.replayAirplaneMarker = null;
      }
      const airplaneIcon = L2.divIcon({
        html: '<div class="replay-airplane-icon">\u2708\uFE0F</div>',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        className: ""
      });
      const firstSegment = this.replaySegments[0];
      const startCoords = firstSegment?.coords?.[0];
      if (!startCoords || !this.app.map) return false;
      this.replayAirplaneMarker = L2.marker([startCoords[0], startCoords[1]], {
        icon: airplaneIcon,
        zIndexOffset: 1e3
      });
      this.replayAirplaneMarker.addTo(this.app.map);
      const markerElement = this.replayAirplaneMarker.getElement();
      if (markerElement) {
        markerElement.style.transition = "transform 0.08s linear";
        markerElement.style.cursor = "pointer";
        markerElement.style.pointerEvents = "auto";
        markerElement.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.replayAirplaneMarker.isPopupOpen()) {
            this.replayAirplaneMarker.closePopup();
          } else {
            this.updateReplayAirplanePopup();
          }
        });
      }
      this.replayCurrentTime = 0;
      this.replayLastDrawnIndex = -1;
      this.replayLastBearing = null;
      if (this.replayAutoZoom && this.app.map) {
        this.app.map.setView([startCoords[0], startCoords[1]], 16, {
          animate: true,
          duration: 0.8
        });
        this.replayLastZoom = 16;
      } else if (this.app.map) {
        this.app.map.panTo([startCoords[0], startCoords[1]], {
          animate: true,
          duration: 0.8
        });
      }
      this.updateReplayDisplay();
      return true;
    }
    hideOtherLayersDuringReplay() {
      if (!this.app.map) return;
      if (this.app.heatmapLayer && this.app.heatmapVisible) {
        this.app.map.removeLayer(this.app.heatmapLayer);
      }
      if (this.app.altitudeVisible) {
        this.app.map.removeLayer(this.app.altitudeLayer);
      }
      if (this.app.airspeedVisible) {
        this.app.map.removeLayer(this.app.airspeedLayer);
      }
      const disableElements = [
        "heatmap-btn",
        "airports-btn",
        "aviation-btn",
        "year-select",
        "aircraft-select"
      ];
      disableElements.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = true;
      });
    }
    restoreLayerVisibility() {
      if (!this.app.map) return;
      if (this.app.heatmapLayer && this.app.heatmapVisible) {
        this.app.map.addLayer(this.app.heatmapLayer);
        if (this.app.heatmapLayer._canvas) {
          this.app.heatmapLayer._canvas.style.pointerEvents = "none";
        }
      }
      if (this.app.altitudeVisible) {
        this.app.map.addLayer(this.app.altitudeLayer);
        setTimeout(() => {
          this.app.layerManager.redrawAltitudePaths();
          if (this.app.map) this.app.map.invalidateSize();
        }, 50);
      }
      if (this.app.airspeedVisible) {
        this.app.map.addLayer(this.app.airspeedLayer);
        setTimeout(() => {
          this.app.layerManager.redrawAirspeedPaths();
          if (this.app.map) this.app.map.invalidateSize();
        }, 50);
      }
      const enableElements = [
        "heatmap-btn",
        "airports-btn",
        "aviation-btn",
        "year-select",
        "aircraft-select"
      ];
      enableElements.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = false;
      });
    }
    playReplay() {
      if (!this.replayActive || !this.app.map) return;
      if (this.replayCurrentTime >= this.replayMaxTime) {
        this.replayCurrentTime = 0;
        this.replayLastDrawnIndex = -1;
        if (this.replayLayer) this.replayLayer.clearLayers();
        if (this.replayAirplaneMarker && this.replaySegments.length > 0 && this.app.map) {
          const firstSeg = this.replaySegments[0];
          const startCoords = firstSeg?.coords?.[0];
          if (startCoords) {
            this.replayAirplaneMarker.setLatLng([startCoords[0], startCoords[1]]);
            if (this.replayAutoZoom) {
              this.app.map.setView([startCoords[0], startCoords[1]], 16, {
                animate: true,
                duration: 0.5
              });
              this.replayLastZoom = 16;
            }
          }
        }
        this.replayRecenterTimestamps = [];
        this.replayLastBearing = null;
      }
      this.replayPlaying = true;
      const playBtn = document.getElementById("replay-play-btn");
      const pauseBtn = document.getElementById("replay-pause-btn");
      if (playBtn) playBtn.style.display = "none";
      if (pauseBtn) pauseBtn.style.display = "inline-block";
      this.replayLastFrameTime = null;
      const animateReplay = (timestamp) => {
        if (!this.replayPlaying) return;
        if (this.replayLastFrameTime === null) {
          this.replayLastFrameTime = timestamp;
        }
        const deltaMs = timestamp - this.replayLastFrameTime;
        this.replayLastFrameTime = timestamp;
        const deltaTime = deltaMs / 1e3 * this.replaySpeed;
        this.replayCurrentTime += deltaTime;
        if (this.replayCurrentTime >= this.replayMaxTime) {
          this.replayCurrentTime = this.replayMaxTime;
          this.pauseReplay();
          if (this.replaySegments.length > 0 && this.app.map) {
            const allCoords = [];
            this.replaySegments.forEach((seg) => {
              if (seg.coords && seg.coords.length > 0) {
                seg.coords.forEach((coord) => {
                  allCoords.push(coord);
                });
              }
            });
            if (allCoords.length > 0) {
              const bounds = L2.latLngBounds(allCoords);
              this.app.map.fitBounds(bounds, {
                padding: [50, 50],
                animate: true,
                duration: 1
              });
            }
          }
        } else {
          this.replayAnimationFrameId = requestAnimationFrame(animateReplay);
        }
        this.updateReplayDisplay();
      };
      this.replayAnimationFrameId = requestAnimationFrame(animateReplay);
      this.app.stateManager.saveMapState();
    }
    pauseReplay() {
      this.replayPlaying = false;
      const playBtn = document.getElementById("replay-play-btn");
      const pauseBtn = document.getElementById("replay-pause-btn");
      if (playBtn) playBtn.style.display = "inline-block";
      if (pauseBtn) pauseBtn.style.display = "none";
      if (this.replayAnimationFrameId) {
        cancelAnimationFrame(this.replayAnimationFrameId);
        this.replayAnimationFrameId = null;
      }
      this.replayLastFrameTime = null;
      this.app.stateManager.saveMapState();
    }
    stopReplay() {
      this.pauseReplay();
      this.replayCurrentTime = 0;
      this.replayLastDrawnIndex = -1;
      this.replayLastBearing = null;
      this.replayRecenterTimestamps = [];
      if (this.replayLayer) {
        this.replayLayer.clearLayers();
      }
      if (this.replayAirplaneMarker && this.replaySegments.length > 0) {
        const firstSeg = this.replaySegments[0];
        const startCoords = firstSeg?.coords?.[0];
        if (startCoords) {
          this.replayAirplaneMarker.setLatLng([startCoords[0], startCoords[1]]);
        }
      }
      this.updateReplayDisplay();
    }
    seekReplay(value) {
      const newTime = parseFloat(value);
      if (newTime < this.replayCurrentTime) {
        if (this.replayLayer) this.replayLayer.clearLayers();
        this.replayLastDrawnIndex = -1;
      }
      this.replayCurrentTime = newTime;
      this.updateReplayDisplay(true);
      this.app.stateManager.saveMapState();
    }
    changeReplaySpeed() {
      const select = document.getElementById(
        "replay-speed"
      );
      if (!select) return;
      this.replaySpeed = parseFloat(select.value);
      this.app.stateManager.saveMapState();
    }
    toggleAutoZoom() {
      this.replayAutoZoom = !this.replayAutoZoom;
      const autoZoomBtn = document.getElementById("replay-autozoom-btn");
      if (autoZoomBtn) {
        autoZoomBtn.style.opacity = this.replayAutoZoom ? "1.0" : "0.5";
        autoZoomBtn.title = this.replayAutoZoom ? "Auto-zoom enabled" : "Auto-zoom disabled";
      }
      this.app.stateManager.saveMapState();
    }
    updateReplayDisplay(isManualSeek = false) {
      const timeDisplay = document.getElementById("replay-time-display");
      if (timeDisplay) {
        timeDisplay.textContent = window.KMLHeatmap.formatTime(this.replayCurrentTime) + " / " + window.KMLHeatmap.formatTime(this.replayMaxTime);
      }
      const slider = document.getElementById(
        "replay-slider"
      );
      if (slider) slider.value = this.replayCurrentTime.toString();
      const sliderStart = document.getElementById("replay-slider-start");
      if (sliderStart) {
        sliderStart.textContent = window.KMLHeatmap.formatTime(
          this.replayCurrentTime
        );
      }
      let lastSegment = null;
      let nextSegment = null;
      let currentIndex = -1;
      for (let i = 0; i < this.replaySegments.length; i++) {
        const seg = this.replaySegments[i];
        if (seg && (seg.time || 0) <= this.replayCurrentTime) {
          lastSegment = seg;
          currentIndex = i;
        } else if (seg) {
          nextSegment = seg;
          break;
        }
      }
      if (this.replayLayer) {
        const useAirspeedColors = this.app.airspeedVisible && !this.app.altitudeVisible;
        for (let i = 0; i < this.replaySegments.length; i++) {
          const seg = this.replaySegments[i];
          if (!seg) continue;
          if ((seg.time || 0) <= this.replayCurrentTime && this.replayCurrentTime > 0) {
            if (i > this.replayLastDrawnIndex) {
              let segmentColor;
              if (useAirspeedColors && (seg.groundspeed_knots || 0) > 0) {
                segmentColor = window.KMLHeatmap.getColorForAltitude(
                  seg.groundspeed_knots,
                  this.replayColorMinSpeed,
                  this.replayColorMaxSpeed
                );
              } else {
                segmentColor = window.KMLHeatmap.getColorForAltitude(
                  seg.altitude_ft,
                  this.replayColorMinAlt,
                  this.replayColorMaxAlt
                );
              }
              L2.polyline(seg.coords || [], {
                color: segmentColor,
                weight: 3,
                opacity: 0.8
              }).addTo(this.replayLayer);
              this.replayLastDrawnIndex = i;
            }
          } else {
            break;
          }
        }
      }
      if (this.replayAirplaneMarker && this.app.map && !this.app.map.hasLayer(this.replayAirplaneMarker)) {
        this.replayAirplaneMarker.addTo(this.app.map);
      }
      if (this.replayAirplaneMarker && this.app.map) {
        if (lastSegment) {
          let currentPos;
          let bearing = 0;
          if (nextSegment && (lastSegment.time || 0) < this.replayCurrentTime) {
            const timeFraction = (this.replayCurrentTime - (lastSegment.time || 0)) / ((nextSegment.time || 0) - (lastSegment.time || 0));
            const lat1 = lastSegment.coords?.[1]?.[0] || 0;
            const lon1 = lastSegment.coords?.[1]?.[1] || 0;
            const lat2 = nextSegment.coords?.[0]?.[0] || 0;
            const lon2 = nextSegment.coords?.[0]?.[1] || 0;
            currentPos = [
              lat1 + (lat2 - lat1) * timeFraction,
              lon1 + (lon2 - lon1) * timeFraction
            ];
            bearing = window.KMLHeatmap.calculateBearing(
              lat1,
              lon1,
              lat2,
              lon2
            );
          } else {
            currentPos = lastSegment.coords?.[1] || [0, 0];
            const lat1 = lastSegment.coords?.[0]?.[0] || 0;
            const lon1 = lastSegment.coords?.[0]?.[1] || 0;
            const lat2 = lastSegment.coords?.[1]?.[0] || 0;
            const lon2 = lastSegment.coords?.[1]?.[1] || 0;
            bearing = window.KMLHeatmap.calculateBearing(
              lat1,
              lon1,
              lat2,
              lon2
            );
          }
          const smoothedBearing = window.KMLHeatmap.calculateSmoothedBearing(
            this.replaySegments,
            currentIndex,
            5
          );
          if (smoothedBearing !== null) {
            bearing = smoothedBearing;
            this.replayLastBearing = bearing;
          } else if (this.replayLastBearing !== null) {
            bearing = this.replayLastBearing;
          }
          this.replayAirplaneMarker.setLatLng(currentPos);
          if (this.replayPlaying || isManualSeek) {
            const mapSize = this.app.map.getSize();
            const airplanePoint = this.app.map.latLngToContainerPoint(currentPos);
            const marginPercent = 0.1;
            const marginX = mapSize.x * marginPercent;
            const marginY = mapSize.y * marginPercent;
            let needsRecenter = false;
            if (airplanePoint.x < marginX || airplanePoint.x > mapSize.x - marginX || airplanePoint.y < marginY || airplanePoint.y > mapSize.y - marginY) {
              needsRecenter = true;
            }
            if (isManualSeek) {
              needsRecenter = true;
            }
            if (needsRecenter) {
              this.app.map.panTo(currentPos, {
                animate: true,
                duration: 0.5,
                easeLinearity: 0.25,
                noMoveStart: true
              });
              const now = Date.now();
              this.replayRecenterTimestamps.push(now);
              const cutoffTime = now - 3e4;
              this.replayRecenterTimestamps = this.replayRecenterTimestamps.filter((ts) => {
                return ts > cutoffTime;
              });
            }
            if (this.replayAutoZoom) {
              const now = Date.now();
              const cutoffTime = now - 3e4;
              this.replayRecenterTimestamps = this.replayRecenterTimestamps.filter((ts) => {
                return ts > cutoffTime;
              });
              const recenterCount = this.replayRecenterTimestamps.length;
              if (recenterCount > 2) {
                const now2 = Date.now();
                const fiveSecondsAgo = now2 - 5e3;
                const recentRecenters = this.replayRecenterTimestamps.filter(
                  (ts) => {
                    return ts >= fiveSecondsAgo;
                  }
                );
                if (recentRecenters.length > 2) {
                  const zoomOutStep = 1;
                  if (zoomOutStep > 0 && this.replayLastZoom !== null && this.replayLastZoom > 9) {
                    const newZoom = Math.max(
                      9,
                      this.replayLastZoom - zoomOutStep
                    );
                    this.app.map.setZoom(newZoom, {
                      animate: true,
                      duration: 0.5
                    });
                    this.replayLastZoom = newZoom;
                    this.replayRecenterTimestamps = [];
                  }
                }
              }
            }
          }
          const iconElement = this.replayAirplaneMarker.getElement();
          if (iconElement) {
            const iconDiv = iconElement.querySelector(".replay-airplane-icon");
            if (iconDiv) {
              const adjustedBearing = bearing - 45;
              iconDiv.style.transform = "translate3d(0,0,0) rotate(" + adjustedBearing + "deg)";
            }
          }
        } else if (this.replaySegments.length > 0) {
          const firstSeg = this.replaySegments[0];
          const startCoords = firstSeg?.coords?.[0];
          if (startCoords) {
            this.replayAirplaneMarker.setLatLng([startCoords[0], startCoords[1]]);
          }
        }
      }
      if (this.replayAirplaneMarker && this.replayAirplaneMarker.getPopup() && this.replayAirplaneMarker.isPopupOpen()) {
        this.updateReplayAirplanePopup();
      }
    }
  };

  // kml_heatmap/frontend/ui/wrappedManager.ts
  var WrappedManager = class {
    constructor(app) {
      this.app = app;
      this.originalMapParent = null;
      this.originalMapIndex = null;
    }
    async showWrapped() {
      if (!this.app.map) return;
      const year = this.app.selectedYear;
      const yearStats = window.KMLHeatmap.calculateYearStats(
        this.app.fullPathInfo,
        this.app.fullPathSegments,
        year,
        this.app.fullStats
      );
      const titleEl = document.getElementById("wrapped-title");
      const yearEl = document.getElementById("wrapped-year");
      if (year === "all") {
        if (titleEl) titleEl.textContent = "\u2728 Your Flight History";
        if (yearEl) yearEl.textContent = "All Years";
      } else {
        if (titleEl) titleEl.textContent = "\u2728 Your Year in Flight";
        if (yearEl) yearEl.textContent = year;
      }
      const statsHtml = `
            <div class="stat-card">
                <div class="stat-value">${yearStats.total_flights}</div>
                <div class="stat-label">Flights</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${yearStats.num_airports}</div>
                <div class="stat-label">Airports</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${yearStats.total_distance_nm.toFixed(0)}</div>
                <div class="stat-label">Nautical Miles</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${yearStats.flight_time}</div>
                <div class="stat-label">Flight Time</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${(this.app.fullStats?.max_groundspeed_knots || 0).toFixed(0)} kt</div>
                <div class="stat-label">Max Groundspeed</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${Math.round((this.app.fullStats?.max_altitude_m || 0) / 0.3048).toLocaleString()} ft</div>
                <div class="stat-label">Max Altitude (MSL)</div>
            </div>
        `;
      const statsEl = document.getElementById("wrapped-stats");
      if (statsEl) statsEl.innerHTML = statsHtml;
      const funFacts = window.KMLHeatmap.generateFunFacts(
        yearStats,
        this.app.fullStats
      );
      let funFactsHtml = '<div class="fun-facts-title">\u2728 Facts</div>';
      funFacts.forEach((fact) => {
        funFactsHtml += `<div class="fun-fact" data-category="${fact.category}"><span class="fun-fact-icon">${fact.icon}</span><span class="fun-fact-text">${fact.text}</span></div>`;
      });
      const funFactsEl = document.getElementById("wrapped-fun-facts");
      if (funFactsEl) funFactsEl.innerHTML = funFactsHtml;
      if (yearStats.aircraft_list && yearStats.aircraft_list.length > 0) {
        let fleetHtml = '<div class="aircraft-fleet-title">\u2708\uFE0F Fleet</div>';
        const maxFlights = yearStats.aircraft_list[0].flights;
        const minFlights = yearStats.aircraft_list[yearStats.aircraft_list.length - 1].flights;
        const flightRange = maxFlights - minFlights;
        yearStats.aircraft_list.forEach((aircraft) => {
          const modelStr = aircraft.model || aircraft.type || "";
          const normalized = flightRange > 0 ? (aircraft.flights - minFlights) / flightRange : 1;
          let colorClass;
          if (normalized >= 0.75) {
            colorClass = "fleet-aircraft-high";
          } else if (normalized >= 0.5) {
            colorClass = "fleet-aircraft-medium-high";
          } else if (normalized >= 0.25) {
            colorClass = "fleet-aircraft-medium-low";
          } else {
            colorClass = "fleet-aircraft-low";
          }
          const flightTimeStr = aircraft.flight_time_str || "---";
          fleetHtml += `
                    <div class="fleet-aircraft ${colorClass}">
                        <div class="fleet-aircraft-info">
                            <div class="fleet-aircraft-model">${modelStr}</div>
                            <div class="fleet-aircraft-registration">${aircraft.registration}</div>
                        </div>
                        <div class="fleet-aircraft-stats">
                            <div class="fleet-aircraft-flights">${aircraft.flights} flights</div>
                            <div class="fleet-aircraft-time">${flightTimeStr}</div>
                        </div>
                    </div>
                `;
        });
        const fleetEl = document.getElementById("wrapped-aircraft-fleet");
        if (fleetEl) fleetEl.innerHTML = fleetHtml;
      }
      if (yearStats.airport_names && yearStats.airport_names.length > 0) {
        let filteredPathInfo;
        if (year === "all") {
          filteredPathInfo = this.app.fullPathInfo || [];
        } else {
          const yearStr = year.toString();
          filteredPathInfo = (this.app.fullPathInfo || []).filter((pathInfo) => {
            return pathInfo.year && pathInfo.year.toString() === yearStr;
          });
        }
        const yearAirportCounts = {};
        filteredPathInfo.forEach((pathInfo) => {
          if (pathInfo.start_airport) {
            yearAirportCounts[pathInfo.start_airport] = (yearAirportCounts[pathInfo.start_airport] || 0) + 1;
          }
          if (pathInfo.end_airport) {
            yearAirportCounts[pathInfo.end_airport] = (yearAirportCounts[pathInfo.end_airport] || 0) + 1;
          }
        });
        const yearAirports = yearStats.airport_names.map((name) => {
          return {
            name,
            flight_count: yearAirportCounts[name] || 0
          };
        });
        yearAirports.sort((a, b) => b.flight_count - a.flight_count);
        const homeBase = yearAirports[0];
        let homeBaseHtml = '<div class="top-airports-title">\u{1F3E0} Home Base</div>';
        homeBaseHtml += `
                <div class="top-airport">
                    <div class="top-airport-name">${homeBase.name}</div>
                    <div class="top-airport-count">${homeBase.flight_count} flights</div>
                </div>
            `;
        const topAirportsEl = document.getElementById("wrapped-top-airports");
        if (topAirportsEl) topAirportsEl.innerHTML = homeBaseHtml;
        const destinations = yearStats.airport_names.filter(
          (name) => name !== homeBase.name
        );
        if (destinations.length > 0) {
          let airportBadgesHtml = '<div class="airports-grid-title">\u{1F5FA}\uFE0F Destinations</div><div class="airport-badges">';
          destinations.forEach((airportName) => {
            airportBadgesHtml += `<div class="airport-badge">${airportName}</div>`;
          });
          airportBadgesHtml += "</div>";
          const gridEl = document.getElementById("wrapped-airports-grid");
          if (gridEl) gridEl.innerHTML = airportBadgesHtml;
        } else {
          const gridEl = document.getElementById("wrapped-airports-grid");
          if (gridEl) gridEl.innerHTML = "";
        }
      }
      const mapContainer = document.getElementById("map");
      const wrappedMapContainer = document.getElementById(
        "wrapped-map-container"
      );
      if (!mapContainer || !wrappedMapContainer) return;
      if (!this.originalMapParent) {
        this.originalMapParent = mapContainer.parentNode;
        this.originalMapIndex = Array.from(
          this.originalMapParent.children
        ).indexOf(mapContainer);
      }
      this.app.map.fitBounds(this.app.config.bounds, { padding: [80, 80] });
      const controls = [
        document.querySelector(".leaflet-control-zoom"),
        document.getElementById("stats-btn"),
        document.getElementById("export-btn"),
        document.getElementById("wrapped-btn"),
        document.getElementById("heatmap-btn"),
        document.getElementById("airports-btn"),
        document.getElementById("altitude-btn"),
        document.getElementById("airspeed-btn"),
        document.getElementById("aviation-btn"),
        document.getElementById("year-filter"),
        document.getElementById("aircraft-filter"),
        document.getElementById("stats-panel"),
        document.getElementById("altitude-legend"),
        document.getElementById("airspeed-legend"),
        document.getElementById("loading")
      ];
      controls.forEach((el) => {
        if (el) el.style.display = "none";
      });
      const modal = document.getElementById("wrapped-modal");
      if (modal) modal.style.display = "flex";
      setTimeout(() => {
        wrappedMapContainer.appendChild(mapContainer);
        mapContainer.style.width = "100%";
        mapContainer.style.height = "100%";
        mapContainer.style.borderRadius = "12px";
        mapContainer.style.overflow = "hidden";
        wrappedMapContainer.offsetHeight;
        setTimeout(() => {
          this.app.map.invalidateSize();
          this.app.map.fitBounds(this.app.config.bounds, { padding: [80, 80] });
          if (this.app.stateManager) {
            this.app.stateManager.saveMapState();
          }
        }, 100);
      }, 50);
    }
    closeWrapped(event) {
      if (!event || event.target.id === "wrapped-modal") {
        const mapContainer = document.getElementById("map");
        if (!mapContainer) return;
        if (this.originalMapParent && this.originalMapIndex !== null) {
          const children = Array.from(this.originalMapParent.children);
          if (this.originalMapIndex >= children.length) {
            this.originalMapParent.appendChild(mapContainer);
          } else {
            const refChild = children[this.originalMapIndex];
            if (refChild) {
              this.originalMapParent.insertBefore(mapContainer, refChild);
            }
          }
          mapContainer.style.width = "";
          mapContainer.style.height = "";
          mapContainer.style.borderRadius = "";
          mapContainer.style.overflow = "";
          const controls = [
            document.querySelector(".leaflet-control-zoom"),
            document.getElementById("stats-btn"),
            document.getElementById("export-btn"),
            document.getElementById("wrapped-btn"),
            document.getElementById("heatmap-btn"),
            document.getElementById("airports-btn"),
            document.getElementById("altitude-btn"),
            document.getElementById("airspeed-btn"),
            document.getElementById("year-filter"),
            document.getElementById("aircraft-filter"),
            document.getElementById("stats-panel"),
            document.getElementById("altitude-legend"),
            document.getElementById("airspeed-legend"),
            document.getElementById("loading")
          ];
          controls.forEach((el) => {
            if (el) el.style.display = "";
          });
          if (this.app.config.openaipApiKey) {
            const aviationBtn = document.getElementById("aviation-btn");
            if (aviationBtn) aviationBtn.style.display = "";
          }
          setTimeout(() => {
            if (this.app.map) this.app.map.invalidateSize();
            if (this.app.stateManager) {
              this.app.stateManager.saveMapState();
            }
          }, 100);
        }
        const modal = document.getElementById("wrapped-modal");
        if (modal) modal.style.display = "none";
      }
    }
  };

  // kml_heatmap/frontend/ui/uiToggles.ts
  var L3 = __toESM(require_leaflet(), 1);
  var UIToggles = class {
    constructor(app) {
      this.app = app;
    }
    toggleHeatmap() {
      if (!this.app.map) return;
      if (this.app.heatmapVisible) {
        if (this.app.heatmapLayer) {
          this.app.map.removeLayer(this.app.heatmapLayer);
        }
        this.app.heatmapVisible = false;
        const btn = document.getElementById("heatmap-btn");
        if (btn) btn.style.opacity = "0.5";
      } else {
        if (this.app.heatmapLayer) {
          this.app.map.addLayer(this.app.heatmapLayer);
          if (this.app.heatmapLayer._canvas) {
            this.app.heatmapLayer._canvas.style.pointerEvents = "none";
          }
        }
        this.app.heatmapVisible = true;
        const btn = document.getElementById("heatmap-btn");
        if (btn) btn.style.opacity = "1.0";
      }
      this.app.stateManager.saveMapState();
    }
    toggleAltitude() {
      if (!this.app.map) return;
      if (this.app.altitudeVisible) {
        if (this.app.replayManager.replayActive && !this.app.airspeedVisible) {
          return;
        }
        this.app.map.removeLayer(this.app.altitudeLayer);
        this.app.altitudeVisible = false;
        const btn = document.getElementById("altitude-btn");
        if (btn) btn.style.opacity = "0.5";
        const legend = document.getElementById("altitude-legend");
        if (legend) legend.style.display = "none";
      } else {
        if (this.app.airspeedVisible) {
          if (!this.app.replayManager.replayActive) {
            this.app.map.removeLayer(this.app.airspeedLayer);
          }
          this.app.airspeedVisible = false;
          const airspeedBtn = document.getElementById("airspeed-btn");
          if (airspeedBtn) airspeedBtn.style.opacity = "0.5";
          const airspeedLegend = document.getElementById("airspeed-legend");
          if (airspeedLegend) airspeedLegend.style.display = "none";
        }
        if (!this.app.replayManager.replayActive) {
          this.app.map.addLayer(this.app.altitudeLayer);
          this.app.layerManager.redrawAltitudePaths();
        } else {
          const savedTime = this.app.replayManager.replayCurrentTime;
          const savedIndex = this.app.replayManager.replayLastDrawnIndex;
          if (this.app.replayManager.replayLayer) {
            this.app.replayManager.replayLayer.clearLayers();
          }
          this.app.replayManager.replayLastDrawnIndex = -1;
          for (let i = 0; i <= savedIndex && i < this.app.replayManager.replaySegments.length; i++) {
            const seg = this.app.replayManager.replaySegments[i];
            if (seg && (seg.time || 0) <= savedTime) {
              const segmentColor = window.KMLHeatmap.getColorForAltitude(
                seg.altitude_ft,
                this.app.replayManager.replayColorMinAlt,
                this.app.replayManager.replayColorMaxAlt
              );
              L3.polyline(seg.coords || [], {
                color: segmentColor,
                weight: 3,
                opacity: 0.8
              }).addTo(this.app.replayManager.replayLayer);
              this.app.replayManager.replayLastDrawnIndex = i;
            }
          }
        }
        this.app.altitudeVisible = true;
        const btn = document.getElementById("altitude-btn");
        if (btn) btn.style.opacity = "1.0";
        const legend = document.getElementById("altitude-legend");
        if (legend) legend.style.display = "block";
      }
      if (this.app.replayManager.replayActive && this.app.replayManager.replayAirplaneMarker && this.app.replayManager.replayAirplaneMarker.isPopupOpen()) {
        this.app.replayManager.updateReplayAirplanePopup();
      }
      this.app.stateManager.saveMapState();
    }
    toggleAirspeed() {
      if (!this.app.map) return;
      if (this.app.airspeedVisible) {
        if (this.app.replayManager.replayActive && !this.app.altitudeVisible) {
          return;
        }
        this.app.map.removeLayer(this.app.airspeedLayer);
        this.app.airspeedVisible = false;
        const btn = document.getElementById("airspeed-btn");
        if (btn) btn.style.opacity = "0.5";
        const legend = document.getElementById("airspeed-legend");
        if (legend) legend.style.display = "none";
      } else {
        if (this.app.altitudeVisible) {
          if (!this.app.replayManager.replayActive) {
            this.app.map.removeLayer(this.app.altitudeLayer);
          }
          this.app.altitudeVisible = false;
          const altBtn = document.getElementById("altitude-btn");
          if (altBtn) altBtn.style.opacity = "0.5";
          const altLegend = document.getElementById("altitude-legend");
          if (altLegend) altLegend.style.display = "none";
        }
        if (!this.app.replayManager.replayActive) {
          this.app.map.addLayer(this.app.airspeedLayer);
          this.app.layerManager.redrawAirspeedPaths();
        } else {
          const savedTime = this.app.replayManager.replayCurrentTime;
          const savedIndex = this.app.replayManager.replayLastDrawnIndex;
          if (this.app.replayManager.replayLayer) {
            this.app.replayManager.replayLayer.clearLayers();
          }
          this.app.replayManager.replayLastDrawnIndex = -1;
          for (let i = 0; i <= savedIndex && i < this.app.replayManager.replaySegments.length; i++) {
            const seg = this.app.replayManager.replaySegments[i];
            if (seg && (seg.time || 0) <= savedTime && (seg.groundspeed_knots || 0) > 0) {
              const segmentColor = window.KMLHeatmap.getColorForAltitude(
                seg.groundspeed_knots,
                this.app.replayManager.replayColorMinSpeed,
                this.app.replayManager.replayColorMaxSpeed
              );
              L3.polyline(seg.coords || [], {
                color: segmentColor,
                weight: 3,
                opacity: 0.8
              }).addTo(this.app.replayManager.replayLayer);
              this.app.replayManager.replayLastDrawnIndex = i;
            }
          }
        }
        this.app.airspeedVisible = true;
        const btn = document.getElementById("airspeed-btn");
        if (btn) btn.style.opacity = "1.0";
        const legend = document.getElementById("airspeed-legend");
        if (legend) legend.style.display = "block";
      }
      if (this.app.replayManager.replayActive && this.app.replayManager.replayAirplaneMarker && this.app.replayManager.replayAirplaneMarker.isPopupOpen()) {
        this.app.replayManager.updateReplayAirplanePopup();
      }
      this.app.stateManager.saveMapState();
    }
    toggleAirports() {
      if (!this.app.map) return;
      if (this.app.airportsVisible) {
        this.app.map.removeLayer(this.app.airportLayer);
        this.app.airportsVisible = false;
        const btn = document.getElementById("airports-btn");
        if (btn) btn.style.opacity = "0.5";
      } else {
        this.app.map.addLayer(this.app.airportLayer);
        this.app.airportsVisible = true;
        const btn = document.getElementById("airports-btn");
        if (btn) btn.style.opacity = "1.0";
      }
      this.app.stateManager.saveMapState();
    }
    toggleAviation() {
      if (!this.app.map) return;
      if (this.app.config.openaipApiKey && this.app.openaipLayers["Aviation Data"]) {
        if (this.app.aviationVisible) {
          this.app.map.removeLayer(this.app.openaipLayers["Aviation Data"]);
          this.app.aviationVisible = false;
          const btn = document.getElementById("aviation-btn");
          if (btn) btn.style.opacity = "0.5";
        } else {
          this.app.map.addLayer(this.app.openaipLayers["Aviation Data"]);
          this.app.aviationVisible = true;
          const btn = document.getElementById("aviation-btn");
          if (btn) btn.style.opacity = "1.0";
        }
        this.app.stateManager.saveMapState();
      }
    }
    toggleButtonsVisibility() {
      const toggleableButtons = document.querySelectorAll(".toggleable-btn");
      const hideButton = document.getElementById("hide-buttons-btn");
      if (this.app.buttonsHidden) {
        toggleableButtons.forEach((btn) => {
          btn.classList.remove("buttons-hidden");
        });
        if (hideButton) hideButton.textContent = "\u{1F53C}";
        this.app.buttonsHidden = false;
      } else {
        toggleableButtons.forEach((btn) => {
          btn.classList.add("buttons-hidden");
        });
        if (hideButton) hideButton.textContent = "\u{1F53D}";
        this.app.buttonsHidden = true;
      }
      if (this.app.altitudeVisible) {
        this.app.layerManager.redrawAltitudePaths();
      }
      if (this.app.airspeedVisible) {
        this.app.layerManager.redrawAirspeedPaths();
      }
      this.app.stateManager.saveMapState();
    }
    exportMap() {
      const btn = document.getElementById(
        "export-btn"
      );
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = "\u23F3 Exporting...";
      const mapContainer = document.getElementById("map");
      if (!mapContainer) return;
      const controls = [
        document.querySelector(".leaflet-control-zoom"),
        document.getElementById("stats-btn"),
        document.getElementById("export-btn"),
        document.getElementById("wrapped-btn"),
        document.getElementById("replay-btn"),
        document.getElementById("year-filter"),
        document.getElementById("aircraft-filter"),
        document.getElementById("heatmap-btn"),
        document.getElementById("altitude-btn"),
        document.getElementById("airspeed-btn"),
        document.getElementById("airports-btn"),
        document.getElementById("aviation-btn"),
        document.getElementById("stats-panel"),
        document.getElementById("altitude-legend"),
        document.getElementById("airspeed-legend"),
        document.getElementById("loading")
      ];
      const displayStates = controls.map(
        (el) => el ? el.style.display : null
      );
      controls.forEach((el) => {
        if (el) el.style.display = "none";
      });
      setTimeout(() => {
        window.domtoimage.toJpeg(mapContainer, {
          width: mapContainer.offsetWidth * 2,
          height: mapContainer.offsetHeight * 2,
          bgcolor: "#1a1a1a",
          quality: 0.95,
          style: {
            transform: "scale(2)",
            transformOrigin: "top left"
          }
        }).then((dataUrl) => {
          controls.forEach((el, i) => {
            if (el) el.style.display = displayStates[i] || "";
          });
          btn.disabled = false;
          btn.textContent = "\u{1F4F7} Export";
          const link = document.createElement("a");
          link.download = "heatmap_" + (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[:.]/g, "-") + ".jpg";
          link.href = dataUrl;
          link.click();
        }).catch((error) => {
          controls.forEach((el, i) => {
            if (el) el.style.display = displayStates[i] || "";
          });
          alert("Export failed: " + error.message);
          btn.disabled = false;
          btn.textContent = "\u{1F4F7} Export";
        });
      }, 200);
    }
  };

  // kml_heatmap/frontend/mapApp.ts
  var MapApp = class {
    constructor(config) {
      this.config = config;
      this.selectedYear = "all";
      this.selectedAircraft = "all";
      this.allAirportsData = [];
      this.isInitializing = true;
      this.map = null;
      this.heatmapLayer = null;
      this.altitudeLayer = L4.layerGroup();
      this.airspeedLayer = L4.layerGroup();
      this.airportLayer = L4.layerGroup();
      this.altitudeRenderer = L4.svg();
      this.airspeedRenderer = L4.svg();
      this.currentResolution = null;
      this.currentData = null;
      this.fullStats = null;
      this.fullPathInfo = null;
      this.fullPathSegments = null;
      this.altitudeRange = { min: 0, max: 1e4 };
      this.airspeedRange = { min: 0, max: 200 };
      this.heatmapVisible = true;
      this.altitudeVisible = false;
      this.airspeedVisible = false;
      this.airportsVisible = true;
      this.aviationVisible = false;
      this.buttonsHidden = false;
      this.selectedPathIds = /* @__PURE__ */ new Set();
      this.pathSegments = {};
      this.pathToAirports = {};
      this.airportToPaths = {};
      this.airportMarkers = {};
      this.openaipLayers = {};
      this.savedState = null;
      this.restoredYearFromState = false;
      this.stateManager = null;
      this.dataManager = null;
      this.layerManager = null;
      this.filterManager = null;
      this.statsManager = null;
      this.pathSelection = null;
      this.airportManager = null;
      this.replayManager = null;
      this.wrappedManager = null;
      this.uiToggles = null;
    }
    async initialize() {
      this.stateManager = new StateManager(this);
      this.savedState = this.stateManager.loadState();
      if (this.savedState) {
        if (this.savedState.selectedYear !== void 0) {
          this.selectedYear = this.savedState.selectedYear;
          this.restoredYearFromState = true;
        }
        if (this.savedState.selectedAircraft) {
          this.selectedAircraft = this.savedState.selectedAircraft;
        }
        if (this.savedState.selectedPathIds && this.savedState.selectedPathIds.length > 0) {
          this.savedState.selectedPathIds.forEach((pathId) => {
            const pathIdNum = typeof pathId === "string" ? parseInt(pathId, 10) : pathId;
            this.selectedPathIds.add(pathIdNum);
          });
        }
        if (this.savedState.heatmapVisible !== void 0) {
          this.heatmapVisible = this.savedState.heatmapVisible;
        }
        if (this.savedState.altitudeVisible !== void 0) {
          this.altitudeVisible = this.savedState.altitudeVisible;
        }
        if (this.savedState.airspeedVisible !== void 0) {
          this.airspeedVisible = this.savedState.airspeedVisible;
        }
        if (this.savedState.airportsVisible !== void 0) {
          this.airportsVisible = this.savedState.airportsVisible;
        }
        if (this.savedState.aviationVisible !== void 0) {
          this.aviationVisible = this.savedState.aviationVisible;
        }
        if (this.savedState.buttonsHidden !== void 0) {
          this.buttonsHidden = this.savedState.buttonsHidden;
        }
      }
      this.map = L4.map("map", {
        center: this.config.center,
        zoom: 10,
        zoomSnap: 0.25,
        zoomDelta: 0.25,
        wheelPxPerZoomLevel: 120,
        preferCanvas: true
      });
      if (this.config.stadiaApiKey) {
        L4.tileLayer(
          "https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=" + this.config.stadiaApiKey,
          {
            attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>'
          }
        ).addTo(this.map);
      } else {
        L4.tileLayer(
          "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
          {
            attribution: "&copy; OpenStreetMap contributors, &copy; CARTO"
          }
        ).addTo(this.map);
      }
      if (this.savedState && this.savedState.center && this.savedState.zoom) {
        this.map.setView(
          [this.savedState.center.lat, this.savedState.center.lng],
          this.savedState.zoom
        );
      } else {
        this.map.fitBounds(this.config.bounds, { padding: [30, 30] });
      }
      if (this.config.openaipApiKey) {
        this.openaipLayers["Aviation Data"] = L4.tileLayer(
          "https://{s}.api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.png?apiKey=" + this.config.openaipApiKey,
          {
            attribution: '&copy; <a href="https://www.openaip.net">OpenAIP</a>',
            maxZoom: 18,
            minZoom: 7,
            subdomains: ["a", "b", "c"]
          }
        );
      }
      if (this.airportsVisible) {
        this.airportLayer.addTo(this.map);
      }
      document.getElementById("heatmap-btn").style.opacity = this.heatmapVisible ? "1.0" : "0.5";
      document.getElementById("altitude-btn").style.opacity = this.altitudeVisible ? "1.0" : "0.5";
      document.getElementById("airspeed-btn").style.opacity = this.airspeedVisible ? "1.0" : "0.5";
      document.getElementById("airports-btn").style.opacity = this.airportsVisible ? "1.0" : "0.5";
      document.getElementById("aviation-btn").style.opacity = this.aviationVisible ? "1.0" : "0.5";
      if (this.config.openaipApiKey) {
        document.getElementById("aviation-btn").style.display = "block";
      }
      this.dataManager = new DataManager(this);
      this.layerManager = new LayerManager(this);
      this.filterManager = new FilterManager(this);
      this.statsManager = new StatsManager(this);
      this.pathSelection = new PathSelection(this);
      this.airportManager = new AirportManager(this);
      this.replayManager = new ReplayManager(this);
      this.wrappedManager = new WrappedManager(this);
      this.uiToggles = new UIToggles(this);
      await this.loadInitialData();
      this.setupEventHandlers();
      this.isInitializing = false;
      if (this.savedState && this.savedState.buttonsHidden) {
        const toggleableButtons = document.querySelectorAll(".toggleable-btn");
        const hideButton = document.getElementById("hide-buttons-btn");
        toggleableButtons.forEach((btn) => {
          btn.classList.add("buttons-hidden");
        });
        if (hideButton) hideButton.textContent = "\u{1F53D}";
      }
      if (this.savedState && this.savedState.wrappedVisible) {
        setTimeout(() => {
          if (this.wrappedManager) {
            this.wrappedManager.showWrapped();
          }
        }, 500);
      }
      this.stateManager.saveMapState();
    }
    async loadInitialData() {
      const airports = await this.dataManager.loadAirports();
      this.allAirportsData = airports;
      const metadata = await this.dataManager.loadMetadata();
      if (metadata && metadata.available_years) {
        const yearSelect = document.getElementById(
          "year-select"
        );
        metadata.available_years.forEach((year) => {
          const option = document.createElement("option");
          option.value = year.toString();
          option.textContent = "\u{1F4C5} " + year;
          yearSelect.appendChild(option);
        });
        if (this.selectedYear === "all" && !this.restoredYearFromState) {
          const currentYear = metadata.available_years[metadata.available_years.length - 1];
          if (currentYear !== void 0) {
            this.selectedYear = currentYear.toString();
          }
        }
        if (this.selectedYear && this.selectedYear !== "all") {
          yearSelect.value = this.selectedYear;
        }
      }
      this.createAirportMarkers(airports);
      if (metadata && metadata.stats) {
        this.fullStats = metadata.stats;
      }
      try {
        const fullResData = await this.dataManager.loadData(
          "z14_plus",
          this.selectedYear
        );
        if (fullResData && fullResData.path_info) {
          this.fullPathInfo = fullResData.path_info;
        }
        if (fullResData && fullResData.path_segments) {
          this.fullPathSegments = fullResData.path_segments;
        }
      } catch (error) {
        console.error("Failed to load full path data:", error);
      }
      this.filterManager.updateAircraftDropdown();
      this.airportManager.updateAirportPopups();
      if (this.fullStats) {
        const initialStats = window.KMLHeatmap.calculateFilteredStatistics({
          pathInfo: this.fullPathInfo,
          segments: this.fullPathSegments,
          year: this.selectedYear,
          aircraft: this.selectedAircraft
        });
        this.statsManager.updateStatsPanel(initialStats, false);
      }
      this.airportManager.updateAirportOpacity();
      if (metadata && metadata.min_groundspeed_knots !== void 0 && metadata.max_groundspeed_knots !== void 0) {
        this.airspeedRange.min = metadata.min_groundspeed_knots;
        this.airspeedRange.max = metadata.max_groundspeed_knots;
        this.layerManager.updateAirspeedLegend(
          this.airspeedRange.min,
          this.airspeedRange.max
        );
      }
      await this.dataManager.updateLayers();
      this.airportManager.updateAirportMarkerSizes();
      if (this.altitudeVisible) {
        this.map.addLayer(this.altitudeLayer);
        document.getElementById("altitude-legend").style.display = "block";
      }
      if (this.airspeedVisible) {
        this.map.addLayer(this.airspeedLayer);
        document.getElementById("airspeed-legend").style.display = "block";
      }
      if (this.aviationVisible && this.config.openaipApiKey && this.openaipLayers["Aviation Data"]) {
        this.map.addLayer(this.openaipLayers["Aviation Data"]);
      }
      if (this.selectedPathIds.size > 0) {
        this.replayManager.updateReplayButtonState();
      }
      if (this.savedState && this.savedState.statsPanelVisible) {
        const panel = document.getElementById("stats-panel");
        panel.style.display = "block";
        panel.offsetHeight;
        panel.classList.add("visible");
      }
    }
    createAirportMarkers(airports) {
      let homeBaseAirport = null;
      if (airports.length > 0) {
        homeBaseAirport = airports.reduce((max, airport) => {
          const airportCount = airport.flight_count ?? 0;
          const maxCount = max?.flight_count ?? 0;
          return airportCount > maxCount ? airport : max;
        });
      }
      airports.forEach((airport) => {
        const icaoMatch = airport.name ? airport.name.match(/\b([A-Z]{4})\b/) : null;
        const icao = icaoMatch ? icaoMatch[1] : "APT";
        const isHomeBase = homeBaseAirport && airport.name === homeBaseAirport.name;
        const homeClass = isHomeBase ? " airport-marker-home" : "";
        const homeLabelClass = isHomeBase ? " airport-label-home" : "";
        const markerHtml = '<div class="airport-marker-container"><div class="airport-marker' + homeClass + '"></div><div class="airport-label' + homeLabelClass + '">' + icao + "</div></div>";
        const latDms = window.KMLHeatmap.ddToDms(airport.lat, true);
        const lonDms = window.KMLHeatmap.ddToDms(airport.lon, false);
        const googleMapsLink = `https://www.google.com/maps?q=${airport.lat},${airport.lon}`;
        const popup = `
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
                    <span style="font-size: 16px; font-weight: bold; color: #4facfe;">${airport.flight_count || 0}</span>
                </div>
            </div>`;
        const marker3 = L4.marker([airport.lat, airport.lon], {
          icon: L4.divIcon({
            html: markerHtml,
            iconSize: [12, 12],
            iconAnchor: [6, 6],
            popupAnchor: [0, -6],
            className: ""
          })
        }).bindPopup(popup, { autoPanPadding: [50, 50] });
        marker3.on("click", (_e) => {
          if (!this.replayManager.replayActive) {
            this.pathSelection.selectPathsByAirport(airport.name);
          }
        });
        marker3.addTo(this.airportLayer);
        this.airportMarkers[airport.name] = marker3;
      });
    }
    setupEventHandlers() {
      this.map.on("moveend", () => this.stateManager.saveMapState());
      this.map.on("zoomend", () => {
        this.stateManager.saveMapState();
        this.dataManager.updateLayers();
        this.airportManager.updateAirportMarkerSizes();
      });
      this.map.on("click", (_e) => {
        if (this.replayManager.replayActive && this.replayManager.replayAirplaneMarker && this.replayManager.replayAirplaneMarker.isPopupOpen()) {
          this.replayManager.replayAirplaneMarker.closePopup();
        }
        if (!this.replayManager.replayActive && this.selectedPathIds.size > 0) {
          this.pathSelection.clearSelection();
        }
      });
    }
    // Expose methods for onclick handlers
    toggleHeatmap() {
      this.uiToggles.toggleHeatmap();
    }
    toggleStats() {
      this.statsManager.toggleStats();
    }
    toggleAltitude() {
      this.uiToggles.toggleAltitude();
    }
    toggleAirspeed() {
      this.uiToggles.toggleAirspeed();
    }
    toggleAirports() {
      this.uiToggles.toggleAirports();
    }
    toggleAviation() {
      this.uiToggles.toggleAviation();
    }
    toggleReplay() {
      this.replayManager.toggleReplay();
    }
    filterByYear() {
      this.filterManager.filterByYear();
    }
    filterByAircraft() {
      this.filterManager.filterByAircraft();
    }
    togglePathSelection(id) {
      this.pathSelection.togglePathSelection(id);
    }
    exportMap() {
      this.uiToggles.exportMap();
    }
    showWrapped() {
      this.wrappedManager.showWrapped();
    }
    closeWrapped(e) {
      this.wrappedManager.closeWrapped(e);
    }
    toggleButtonsVisibility() {
      this.uiToggles.toggleButtonsVisibility();
    }
    playReplay() {
      this.replayManager.playReplay();
    }
    pauseReplay() {
      this.replayManager.pauseReplay();
    }
    stopReplay() {
      this.replayManager.stopReplay();
    }
    seekReplay(v) {
      this.replayManager.seekReplay(v);
    }
    changeReplaySpeed() {
      this.replayManager.changeReplaySpeed();
    }
    toggleAutoZoom() {
      this.replayManager.toggleAutoZoom();
    }
  };
  if (typeof window !== "undefined") {
    window.initMapApp = async (config) => {
      const app = new MapApp(config);
      window.mapApp = app;
      await app.initialize();
      window.toggleHeatmap = () => app.toggleHeatmap();
      window.toggleStats = () => app.toggleStats();
      window.toggleAltitude = () => app.toggleAltitude();
      window.toggleAirspeed = () => app.toggleAirspeed();
      window.toggleAirports = () => app.toggleAirports();
      window.toggleAviation = () => app.toggleAviation();
      window.toggleReplay = () => app.toggleReplay();
      window.filterByYear = () => app.filterByYear();
      window.filterByAircraft = () => app.filterByAircraft();
      window.togglePathSelection = (id) => app.togglePathSelection(id);
      window.exportMap = () => app.exportMap();
      window.showWrapped = () => app.showWrapped();
      window.closeWrapped = (e) => app.closeWrapped(e);
      window.toggleButtonsVisibility = () => app.toggleButtonsVisibility();
      window.playReplay = () => app.playReplay();
      window.pauseReplay = () => app.pauseReplay();
      window.stopReplay = () => app.stopReplay();
      window.seekReplay = (v) => app.seekReplay(v);
      window.changeReplaySpeed = () => app.changeReplaySpeed();
      window.toggleAutoZoom = () => app.toggleAutoZoom();
    };
  }
  if (typeof window !== "undefined" && window.MAP_CONFIG && window.initMapApp) {
    window.initMapApp(window.MAP_CONFIG);
  }
  return __toCommonJS(mapApp_exports);
})();
//# sourceMappingURL=mapApp.bundle.js.map
