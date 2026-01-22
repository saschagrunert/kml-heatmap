var G = Object.create;
var Z = Object.defineProperty;
var N = Object.getOwnPropertyDescriptor;
var W = Object.getOwnPropertyNames;
var q = Object.getPrototypeOf,
  U = Object.prototype.hasOwnProperty;
var j = (g, e) => () => (e || g((e = { exports: {} }).exports, e), e.exports);
var J = (g, e, t, a) => {
  if ((e && typeof e == "object") || typeof e == "function")
    for (let s of W(e))
      !U.call(g, s) &&
        s !== t &&
        Z(g, s, {
          get: () => e[s],
          enumerable: !(a = N(e, s)) || a.enumerable,
        });
  return g;
};
var I = (g, e, t) => (
  (t = g != null ? G(q(g)) : {}),
  J(
    e || !g || !g.__esModule
      ? Z(t, "default", { value: g, enumerable: !0 })
      : t,
    g
  )
);
var E = j((Q, $) => {
  $.exports = window.L;
});
var M = I(E(), 1);
var P = class {
  constructor(e) {
    ((this.app = e),
      (this.dataLoader = new window.KMLHeatmap.DataLoader({
        dataDir: e.config.dataDir,
        showLoading: () => this.showLoading(),
        hideLoading: () => this.hideLoading(),
      })),
      (this.loadedData = {}),
      (this.currentData = null));
  }
  showLoading() {
    let e = document.getElementById("loading");
    e && (e.style.display = "block");
  }
  hideLoading() {
    let e = document.getElementById("loading");
    e && (e.style.display = "none");
  }
  async loadData(e, t) {
    return await this.dataLoader.loadData(e, t);
  }
  async loadAirports() {
    return await this.dataLoader.loadAirports();
  }
  async loadMetadata() {
    return await this.dataLoader.loadMetadata();
  }
  async updateLayers() {
    if (!this.app.map) return;
    let e = this.app.map.getZoom(),
      t = window.KMLHeatmap.getResolutionForZoom(e);
    if (t === this.app.currentResolution) return;
    this.app.currentResolution = t;
    let a = await this.loadData(t, this.app.selectedYear);
    if (!a) return;
    ((this.currentData = a), (this.app.currentData = a));
    let s = a.coordinates;
    if (
      (this.app.selectedYear !== "all" ||
        this.app.selectedAircraft !== "all") &&
      a.path_segments
    ) {
      let i = new Set();
      a.path_info &&
        a.path_info.forEach((p) => {
          let n =
              this.app.selectedYear === "all" ||
              (p.year && p.year.toString() === this.app.selectedYear),
            o =
              this.app.selectedAircraft === "all" ||
              p.aircraft_registration === this.app.selectedAircraft;
          n && o && i.add(p.id);
        });
      let r = new Set();
      (a.path_segments.forEach((p) => {
        if (i.has(p.path_id)) {
          let n = p.coords;
          n &&
            n.length === 2 &&
            (r.add(JSON.stringify(n[0])), r.add(JSON.stringify(n[1])));
        }
      }),
        (s = Array.from(r).map((p) => JSON.parse(p))));
    }
    if (
      (this.app.heatmapLayer && this.app.map.removeLayer(this.app.heatmapLayer),
      (this.app.heatmapLayer = window.L.heatLayer(s, {
        radius: 10,
        blur: 15,
        minOpacity: 0.25,
        maxOpacity: 0.6,
        max: 1,
        gradient: {
          0: "blue",
          0.3: "cyan",
          0.5: "lime",
          0.7: "yellow",
          1: "red",
        },
      })),
      this.app.heatmapLayer._canvas &&
        (this.app.heatmapLayer._canvas.style.pointerEvents = "none"),
      this.app.heatmapVisible &&
        !this.app.replayManager.replayActive &&
        this.app.heatmapLayer.addTo(this.app.map),
      (this.app.pathToAirports = {}),
      (this.app.airportToPaths = {}),
      a.path_info &&
        a.path_info.forEach((i) => {
          let r = i.id;
          ((this.app.pathToAirports[r] = {
            start: i.start_airport,
            end: i.end_airport,
          }),
            i.start_airport &&
              (this.app.airportToPaths[i.start_airport] ||
                (this.app.airportToPaths[i.start_airport] = new Set()),
              this.app.airportToPaths[i.start_airport].add(r)),
            i.end_airport &&
              (this.app.airportToPaths[i.end_airport] ||
                (this.app.airportToPaths[i.end_airport] = new Set()),
              this.app.airportToPaths[i.end_airport].add(r)));
        }),
      a.path_segments && a.path_segments.length > 0)
    ) {
      let i = a.path_segments.map((n) => n.altitude_ft || 0),
        r = i[0],
        p = i[0];
      for (let n = 1; n < i.length; n++)
        (i[n] < r && (r = i[n]), i[n] > p && (p = i[n]));
      ((this.app.altitudeRange.min = r), (this.app.altitudeRange.max = p));
    }
    (this.app.layerManager.redrawAltitudePaths(),
      this.app.airspeedVisible && this.app.layerManager.redrawAirspeedPaths(),
      console.log("Updated to " + t + " resolution"));
  }
};
var B = class {
  constructor(e) {
    this.app = e;
  }
  saveMapState() {
    if (!this.app.map) return;
    let e = document.getElementById("stats-panel"),
      t = document.getElementById("wrapped-modal"),
      a = {
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
        statsPanelVisible: e ? e.classList.contains("visible") : !1,
        wrappedVisible: t ? t.style.display === "flex" : !1,
        buttonsHidden: this.app.buttonsHidden,
      };
    try {
      localStorage.setItem("kml-heatmap-state", JSON.stringify(a));
    } catch {}
    this.updateUrl(a);
  }
  loadMapState() {
    try {
      let e = localStorage.getItem("kml-heatmap-state");
      if (e) return JSON.parse(e);
    } catch {}
    return null;
  }
  updateUrl(e) {
    let t = window.KMLHeatmap.encodeStateToUrl(e),
      a = t ? "?" + t : window.location.pathname;
    try {
      history.replaceState(null, "", a);
    } catch {}
  }
  loadState() {
    let e = window.KMLHeatmap.parseUrlParams(
      new URLSearchParams(window.location.search)
    );
    return e && Object.keys(e).length > 0 ? e : this.loadMapState();
  }
};
var w = I(E(), 1),
  k = class {
    constructor(e) {
      this.app = e;
    }
    redrawAltitudePaths() {
      if (!this.app.currentData) return;
      (this.app.altitudeLayer.clearLayers(), (this.app.pathSegments = {}));
      let e, t;
      if (this.app.selectedPathIds.size > 0) {
        let a = this.app.currentData.path_segments.filter((s) =>
          this.app.selectedPathIds.has(s.path_id)
        );
        if (a.length > 0) {
          let s = a.map((p) => p.altitude_ft || 0),
            i = s[0],
            r = s[0];
          for (let p = 1; p < s.length; p++)
            (s[p] < i && (i = s[p]), s[p] > r && (r = s[p]));
          ((e = i), (t = r));
        } else
          ((e = this.app.altitudeRange.min), (t = this.app.altitudeRange.max));
      } else
        ((e = this.app.altitudeRange.min), (t = this.app.altitudeRange.max));
      (this.app.currentData.path_segments.forEach((a) => {
        let s = a.path_id,
          i = this.app.currentData.path_info.find((o) => o.id === s);
        if (
          (this.app.selectedYear !== "all" &&
            i &&
            i.year &&
            i.year.toString() !== this.app.selectedYear) ||
          (this.app.selectedAircraft !== "all" &&
            i &&
            i.aircraft_registration !== this.app.selectedAircraft)
        )
          return;
        let r = this.app.selectedPathIds.has(s);
        if (this.app.selectedPathIds.size > 0 && !r && this.app.buttonsHidden)
          return;
        let p = window.KMLHeatmap.getColorForAltitude(a.altitude_ft, e, t);
        (w
          .polyline(a.coords || [], {
            color: p,
            weight: r ? 6 : 4,
            opacity: r ? 1 : this.app.selectedPathIds.size > 0 ? 0.1 : 0.85,
            renderer: this.app.altitudeRenderer,
            interactive: !0,
          })
          .bindPopup(
            "Altitude: " + a.altitude_ft + " ft (" + a.altitude_m + " m)"
          )
          .addTo(this.app.altitudeLayer)
          .on("click", (o) => {
            (w.DomEvent.stopPropagation(o),
              this.app.pathSelection.togglePathSelection(s));
          }),
          this.app.pathSegments[s] || (this.app.pathSegments[s] = []),
          this.app.pathSegments[s].push(a));
      }),
        this.updateAltitudeLegend(e, t),
        this.app.airportManager.updateAirportOpacity(),
        this.app.statsManager.updateStatsForSelection());
    }
    redrawAirspeedPaths() {
      if (!this.app.currentData) {
        console.warn("redrawAirspeedPaths: No current data available");
        return;
      }
      this.app.airspeedLayer.clearLayers();
      let e, t;
      if (this.app.selectedPathIds.size > 0) {
        let a = this.app.currentData.path_segments.filter(
          (s) =>
            this.app.selectedPathIds.has(s.path_id) &&
            (s.groundspeed_knots || 0) > 0
        );
        if (a.length > 0) {
          let s = a.map((p) => p.groundspeed_knots || 0),
            i = s[0],
            r = s[0];
          for (let p = 1; p < s.length; p++)
            (s[p] < i && (i = s[p]), s[p] > r && (r = s[p]));
          ((e = i), (t = r));
        } else
          ((e = this.app.airspeedRange.min), (t = this.app.airspeedRange.max));
      } else
        ((e = this.app.airspeedRange.min), (t = this.app.airspeedRange.max));
      (this.app.currentData.path_segments.forEach((a) => {
        let s = a.path_id,
          i = this.app.currentData.path_info.find((r) => r.id === s);
        if (
          !(
            this.app.selectedYear !== "all" &&
            i &&
            i.year &&
            i.year.toString() !== this.app.selectedYear
          ) &&
          !(
            this.app.selectedAircraft !== "all" &&
            i &&
            i.aircraft_registration !== this.app.selectedAircraft
          ) &&
          (a.groundspeed_knots || 0) > 0
        ) {
          let r = this.app.selectedPathIds.has(s);
          if (this.app.selectedPathIds.size > 0 && !r && this.app.buttonsHidden)
            return;
          let p = window.KMLHeatmap.getColorForAirspeed(
              a.groundspeed_knots,
              e,
              t
            ),
            n = Math.round((a.groundspeed_knots || 0) * 1.852);
          w.polyline(a.coords || [], {
            color: p,
            weight: r ? 6 : 4,
            opacity: r ? 1 : this.app.selectedPathIds.size > 0 ? 0.1 : 0.85,
            renderer: this.app.airspeedRenderer,
            interactive: !0,
          })
            .bindPopup(
              "Groundspeed: " + a.groundspeed_knots + " kt (" + n + " km/h)"
            )
            .addTo(this.app.airspeedLayer)
            .on("click", (d) => {
              (w.DomEvent.stopPropagation(d),
                this.app.pathSelection.togglePathSelection(s));
            });
        }
      }),
        this.updateAirspeedLegend(e, t),
        this.app.airportManager.updateAirportOpacity(),
        this.app.statsManager.updateStatsForSelection());
    }
    updateAltitudeLegend(e, t) {
      let a = Math.round(e),
        s = Math.round(t),
        i = Math.round(e * 0.3048),
        r = Math.round(t * 0.3048),
        p = document.getElementById("legend-min"),
        n = document.getElementById("legend-max");
      (p &&
        (p.textContent =
          a.toLocaleString() + " ft (" + i.toLocaleString() + " m)"),
        n &&
          (n.textContent =
            s.toLocaleString() + " ft (" + r.toLocaleString() + " m)"));
    }
    updateAirspeedLegend(e, t) {
      let a = Math.round(e),
        s = Math.round(t),
        i = Math.round(e * 1.852),
        r = Math.round(t * 1.852),
        p = document.getElementById("airspeed-legend-min"),
        n = document.getElementById("airspeed-legend-max");
      (p &&
        (p.textContent =
          a.toLocaleString() + " kt (" + i.toLocaleString() + " km/h)"),
        n &&
          (n.textContent =
            s.toLocaleString() + " kt (" + r.toLocaleString() + " km/h)"));
    }
  };
var T = class {
  constructor(e) {
    this.app = e;
  }
  updateAircraftDropdown() {
    if (!this.app.fullPathInfo) return;
    let e = document.getElementById("aircraft-select");
    if (!e) return;
    let t = this.app.selectedAircraft;
    for (; e.options.length > 1; ) e.remove(1);
    let a;
    this.app.selectedYear === "all"
      ? (a = this.app.fullPathInfo)
      : (a = this.app.fullPathInfo.filter(
          (p) => p.year && p.year.toString() === this.app.selectedYear
        ));
    let s = {};
    a.forEach((p) => {
      if (p.aircraft_registration) {
        let n = p.aircraft_registration;
        (s[n] ||
          (s[n] = { registration: n, type: p.aircraft_type, flights: 0 }),
          (s[n].flights += 1));
      }
    });
    let i = Object.values(s).sort((p, n) => n.flights - p.flights),
      r = !1;
    (i.forEach((p) => {
      let n = document.createElement("option");
      n.value = p.registration;
      let o = p.type ? " (" + p.type + ")" : "";
      ((n.textContent = "\u2708\uFE0F " + p.registration + o),
        e.appendChild(n),
        p.registration === t && (r = !0));
    }),
      !r && t !== "all"
        ? ((this.app.selectedAircraft = "all"), (e.value = "all"))
        : (e.value = t));
  }
  async filterByYear() {
    let e = document.getElementById("year-select");
    if (!e) return;
    ((this.app.selectedYear = e.value),
      (this.app.dataManager.loadedData = {}),
      (this.app.currentResolution = null),
      this.app.altitudeLayer.clearLayers(),
      (this.app.pathSegments = {}),
      this.app.isInitializing || this.app.selectedPathIds.clear(),
      await this.app.dataManager.updateLayers());
    let t = await this.app.dataManager.loadData(
      "z14_plus",
      this.app.selectedYear
    );
    (t &&
      ((this.app.fullPathInfo = t.path_info || []),
      (this.app.fullPathSegments = t.path_segments || [])),
      this.updateAircraftDropdown());
    let a = window.KMLHeatmap.calculateFilteredStatistics({
      pathInfo: this.app.fullPathInfo,
      segments: this.app.fullPathSegments,
      year: this.app.selectedYear,
      aircraft: this.app.selectedAircraft,
    });
    (this.app.statsManager.updateStatsPanel(a, !1),
      this.app.airportManager.updateAirportOpacity(),
      this.app.airportManager.updateAirportPopups(),
      this.app.isInitializing || this.app.stateManager.saveMapState());
  }
  async filterByAircraft() {
    let e = document.getElementById("aircraft-select");
    if (!e) return;
    ((this.app.selectedAircraft = e.value),
      this.app.altitudeLayer.clearLayers(),
      (this.app.pathSegments = {}),
      this.app.isInitializing || this.app.selectedPathIds.clear(),
      (this.app.currentResolution = null),
      await this.app.dataManager.updateLayers());
    let t = window.KMLHeatmap.calculateFilteredStatistics({
      pathInfo: this.app.fullPathInfo,
      segments: this.app.fullPathSegments,
      year: this.app.selectedYear,
      aircraft: this.app.selectedAircraft,
    });
    (this.app.statsManager.updateStatsPanel(t, !1),
      this.app.airportManager.updateAirportOpacity(),
      this.app.airportManager.updateAirportPopups(),
      this.app.isInitializing || this.app.stateManager.saveMapState());
  }
};
var C = class {
  constructor(e) {
    this.app = e;
  }
  updateStatsForSelection() {
    if (this.app.selectedPathIds.size === 0) {
      let s = window.KMLHeatmap.calculateFilteredStatistics({
        pathInfo: this.app.fullPathInfo,
        segments: this.app.fullPathSegments,
        year: this.app.selectedYear,
        aircraft: this.app.selectedAircraft,
      });
      s && this.updateStatsPanel(s, !1);
      return;
    }
    let e = (this.app.fullPathInfo || []).filter((s) =>
        this.app.selectedPathIds.has(s.id)
      ),
      t = (this.app.fullPathSegments || []).filter((s) =>
        this.app.selectedPathIds.has(s.path_id)
      );
    if (t.length === 0) return;
    let a = window.KMLHeatmap.calculateFilteredStatistics({
      pathInfo: e,
      segments: t,
      year: "all",
      aircraft: "all",
    });
    this.updateStatsPanel(a, !0);
  }
  updateStatsPanel(e, t) {
    let a = "";
    (t
      ? ((a +=
          '<p style="margin:0 0 10px 0; font-weight:bold; font-size:15px;">\u{1F4CA} Selected Paths Statistics</p>'),
        (a +=
          '<div style="background-color: #3a5a7a; padding: 4px 8px; margin-bottom: 8px; border-radius: 3px; font-size: 11px; color: #a0c0e0;">Showing stats for ' +
          e.num_paths +
          " selected path(s)</div>"))
      : (a +=
          '<p style="margin:0 0 10px 0; font-weight:bold; font-size:15px;">\u{1F4CA} Flight Statistics</p>'),
      (a +=
        '<div style="margin-bottom: 8px;"><strong>Data Points:</strong> ' +
        e.total_points.toLocaleString() +
        "</div>"),
      (a +=
        '<div style="margin-bottom: 8px;"><strong>Flights:</strong> ' +
        e.num_paths +
        "</div>"),
      e.airport_names &&
        e.airport_names.length > 0 &&
        ((a +=
          '<div style="margin-bottom: 8px; max-height: 150px; overflow-y: auto;"><strong>Airports (' +
          e.num_airports +
          "):</strong><br>"),
        e.airport_names.forEach((r) => {
          a += '<span style="margin-left: 10px;">\u2022 ' + r + "</span><br>";
        }),
        (a += "</div>")),
      e.num_aircraft &&
        e.num_aircraft > 0 &&
        e.aircraft_list &&
        e.aircraft_list.length > 0 &&
        ((a +=
          '<div style="margin-bottom: 8px; max-height: 150px; overflow-y: auto;"><strong>Aircrafts (' +
          e.num_aircraft +
          "):</strong><br>"),
        e.aircraft_list.forEach((r) => {
          let p = r.type ? " (" + r.type + ")" : "";
          a +=
            '<span style="margin-left: 10px;">\u2022 ' +
            r.registration +
            p +
            " - " +
            r.flights +
            " flight(s)</span><br>";
        }),
        (a += "</div>")),
      e.total_flight_time_str &&
        (a +=
          '<div style="margin-bottom: 8px;"><strong>Total Flight Time:</strong> ' +
          e.total_flight_time_str +
          "</div>"));
    let s = (e.total_distance_nm * 1.852).toFixed(1);
    if (
      ((a +=
        '<div style="margin-bottom: 8px;"><strong>Distance:</strong> ' +
        e.total_distance_nm.toFixed(1) +
        " nm (" +
        s +
        " km)</div>"),
      e.num_paths > 0)
    ) {
      let r = (e.total_distance_nm / e.num_paths).toFixed(1),
        p = (parseFloat(r) * 1.852).toFixed(1);
      a +=
        '<div style="margin-bottom: 8px;"><strong>Average Distance per Trip:</strong> ' +
        r +
        " nm (" +
        p +
        " km)</div>";
    }
    if (e.longest_flight_nm && e.longest_flight_nm > 0) {
      let r = (e.longest_flight_km || 0).toFixed(1);
      a +=
        '<div style="margin-bottom: 8px;"><strong>Longest Flight:</strong> ' +
        e.longest_flight_nm.toFixed(1) +
        " nm (" +
        r +
        " km)</div>";
    }
    if (e.average_groundspeed_knots && e.average_groundspeed_knots > 0) {
      let r = Math.round(e.average_groundspeed_knots * 1.852);
      a +=
        '<div style="margin-bottom: 8px;"><strong>Average Groundspeed:</strong> ' +
        Math.round(e.average_groundspeed_knots) +
        " kt (" +
        r +
        " km/h)</div>";
    }
    if (e.cruise_speed_knots && e.cruise_speed_knots > 0) {
      let r = Math.round(e.cruise_speed_knots * 1.852);
      a +=
        '<div style="margin-bottom: 8px;"><strong>Cruise Speed (>1000ft AGL):</strong> ' +
        Math.round(e.cruise_speed_knots) +
        " kt (" +
        r +
        " km/h)</div>";
    }
    if (e.max_groundspeed_knots && e.max_groundspeed_knots > 0) {
      let r = Math.round(e.max_groundspeed_knots * 1.852);
      a +=
        '<div style="margin-bottom: 8px;"><strong>Max Groundspeed:</strong> ' +
        Math.round(e.max_groundspeed_knots) +
        " kt (" +
        r +
        " km/h)</div>";
    }
    if (e.max_altitude_ft) {
      let r = Math.round(e.max_altitude_ft * 0.3048);
      if (
        ((a +=
          '<div style="margin-bottom: 8px;"><strong>Max Altitude (MSL):</strong> ' +
          Math.round(e.max_altitude_ft) +
          " ft (" +
          r +
          " m)</div>"),
        e.total_altitude_gain_ft)
      ) {
        let p = Math.round(e.total_altitude_gain_ft * 0.3048);
        a +=
          '<div style="margin-bottom: 8px;"><strong>Elevation Gain:</strong> ' +
          Math.round(e.total_altitude_gain_ft) +
          " ft (" +
          p +
          " m)</div>";
      }
    }
    if (
      e.most_common_cruise_altitude_ft &&
      e.most_common_cruise_altitude_ft > 0
    ) {
      let r = Math.round(e.most_common_cruise_altitude_m);
      a +=
        '<div style="margin-bottom: 8px;"><strong>Most Common Cruise Altitude (AGL):</strong> ' +
        e.most_common_cruise_altitude_ft.toLocaleString() +
        " ft (" +
        r.toLocaleString() +
        " m)</div>";
    }
    let i = document.getElementById("stats-panel");
    i && (i.innerHTML = a);
  }
  toggleStats() {
    let e = document.getElementById("stats-panel");
    e &&
      (e.classList.contains("visible")
        ? (e.classList.remove("visible"),
          setTimeout(() => {
            ((e.style.display = "none"), this.app.stateManager.saveMapState());
          }, 300))
        : ((e.style.display = "block"),
          e.offsetHeight,
          e.classList.add("visible"),
          this.app.stateManager.saveMapState()));
  }
};
var R = class {
  constructor(e) {
    this.app = e;
  }
  togglePathSelection(e) {
    (this.app.selectedPathIds.has(e)
      ? this.app.selectedPathIds.delete(e)
      : this.app.selectedPathIds.add(e),
      this.app.altitudeVisible &&
        (this.app.layerManager.redrawAltitudePaths(),
        setTimeout(() => {
          this.app.map.invalidateSize();
        }, 50)),
      this.app.airspeedVisible &&
        (this.app.layerManager.redrawAirspeedPaths(),
        setTimeout(() => {
          this.app.map.invalidateSize();
        }, 50)),
      this.app.replayManager.updateReplayButtonState(),
      this.app.stateManager.saveMapState());
  }
  selectPathsByAirport(e) {
    let t = this.app.airportToPaths[e];
    (t &&
      t.forEach((a) => {
        this.app.selectedPathIds.add(a);
      }),
      this.app.altitudeVisible &&
        (this.app.layerManager.redrawAltitudePaths(),
        setTimeout(() => {
          this.app.map.invalidateSize();
        }, 50)),
      this.app.airspeedVisible &&
        (this.app.layerManager.redrawAirspeedPaths(),
        setTimeout(() => {
          this.app.map.invalidateSize();
        }, 50)),
      this.app.replayManager.updateReplayButtonState(),
      this.app.stateManager.saveMapState());
  }
  clearSelection() {
    (this.app.selectedPathIds.clear(),
      this.app.altitudeVisible &&
        (this.app.layerManager.redrawAltitudePaths(),
        setTimeout(() => {
          this.app.map.invalidateSize();
        }, 50)),
      this.app.airspeedVisible &&
        (this.app.layerManager.redrawAirspeedPaths(),
        setTimeout(() => {
          this.app.map.invalidateSize();
        }, 50)),
      this.app.replayManager.updateReplayButtonState(),
      this.app.stateManager.saveMapState());
  }
};
var V = class {
  constructor(e) {
    this.app = e;
  }
  calculateAirportFlightCounts() {
    return window.KMLHeatmap.calculateAirportFlightCounts(
      this.app.fullPathInfo,
      this.app.selectedYear,
      this.app.selectedAircraft
    );
  }
  updateAirportPopups() {
    if (!this.app.allAirportsData || !this.app.airportMarkers) return;
    let e = this.calculateAirportFlightCounts(),
      t = null,
      a = 0;
    (Object.keys(e).forEach((s) => {
      let i = e[s];
      i !== void 0 && i > a && ((a = i), (t = s));
    }),
      this.app.allAirportsData.forEach((s) => {
        let i = this.app.airportMarkers[s.name];
        if (!i) return;
        let r = e[s.name] || 0,
          p = s.name === t,
          n = window.KMLHeatmap.ddToDms(s.lat, !0),
          o = window.KMLHeatmap.ddToDms(s.lon, !1),
          d = `https://www.google.com/maps?q=${s.lat},${s.lon}`,
          f = `
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
                    <span>${s.name || "Unknown"}</span>
                    ${p ? '<span style="font-size: 12px; background: #007bff; color: white; padding: 2px 6px; border-radius: 3px; margin-left: 4px;">HOME</span>' : ""}
                </div>
                <div style="margin-bottom: 8px;">
                    <div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Coordinates</div>
                    <a href="${d}"
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
                        <span>${n}<br>${o}</span>
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
                    <span style="font-size: 16px; font-weight: bold; color: #4facfe;">${r}</span>
                </div>
            </div>`;
        i.setPopupContent(f);
      }));
  }
  updateAirportOpacity() {
    let e =
        this.app.selectedYear !== "all" || this.app.selectedAircraft !== "all",
      t = this.app.selectedPathIds.size > 0;
    if (!e && !t) {
      Object.keys(this.app.airportMarkers).forEach((s) => {
        let i = this.app.airportMarkers[s];
        i &&
          (i.setOpacity(1),
          this.app.airportLayer.hasLayer(i) || i.addTo(this.app.airportLayer));
      });
      return;
    }
    let a = new Set();
    (e &&
      this.app.fullPathInfo &&
      this.app.fullPathInfo.forEach((s) => {
        let i =
            this.app.selectedYear === "all" ||
            (s.year && s.year.toString() === this.app.selectedYear),
          r =
            this.app.selectedAircraft === "all" ||
            s.aircraft_registration === this.app.selectedAircraft;
        i &&
          r &&
          (s.start_airport && a.add(s.start_airport),
          s.end_airport && a.add(s.end_airport));
      }),
      t &&
        this.app.selectedPathIds.forEach((s) => {
          if (this.app.fullPathInfo) {
            let i = this.app.fullPathInfo.find((r) => r.id === s);
            i &&
              (i.start_airport && a.add(i.start_airport),
              i.end_airport && a.add(i.end_airport));
          } else {
            let i = this.app.pathToAirports[s];
            i && (i.start && a.add(i.start), i.end && a.add(i.end));
          }
        }),
      Object.keys(this.app.airportMarkers).forEach((s) => {
        let i = this.app.airportMarkers[s];
        i &&
          (a.has(s)
            ? (i.setOpacity(1),
              this.app.airportLayer.hasLayer(i) ||
                i.addTo(this.app.airportLayer))
            : this.app.airportLayer.hasLayer(i) &&
              this.app.airportLayer.removeLayer(i));
      }));
  }
  updateAirportMarkerSizes() {
    if (!this.app.map) return;
    let e = this.app.map.getZoom(),
      t = "";
    (e >= 14
      ? (t = "xlarge")
      : e >= 12
        ? (t = "large")
        : e >= 10
          ? (t = "medium")
          : e >= 8
            ? (t = "medium-small")
            : e >= 6 && (t = "small"),
      document.querySelectorAll(".airport-marker-container").forEach((a) => {
        let s = a.querySelector(".airport-marker"),
          i = a.querySelector(".airport-label");
        !s ||
          !i ||
          (e < 5 ? (i.style.display = "none") : (i.style.display = ""),
          a.classList.remove(
            "airport-marker-container-small",
            "airport-marker-container-medium-small",
            "airport-marker-container-medium",
            "airport-marker-container-large",
            "airport-marker-container-xlarge"
          ),
          s.classList.remove(
            "airport-marker-small",
            "airport-marker-medium-small",
            "airport-marker-medium",
            "airport-marker-large",
            "airport-marker-xlarge"
          ),
          i.classList.remove(
            "airport-label-small",
            "airport-label-medium-small",
            "airport-label-medium",
            "airport-label-large",
            "airport-label-xlarge"
          ),
          t &&
            (a.classList.add("airport-marker-container-" + t),
            s.classList.add("airport-marker-" + t),
            i.classList.add("airport-label-" + t)));
      }));
  }
};
var S = I(E(), 1),
  H = class {
    constructor(e) {
      ((this.app = e),
        (this.replayActive = !1),
        (this.replayPlaying = !1),
        (this.replayCurrentTime = 0),
        (this.replayMaxTime = 0),
        (this.replaySpeed = 50),
        (this.replayInterval = null),
        (this.replayLayer = null),
        (this.replaySegments = []),
        (this.replayAirplaneMarker = null),
        (this.replayLastDrawnIndex = -1),
        (this.replayLastBearing = null),
        (this.replayAnimationFrameId = null),
        (this.replayLastFrameTime = null),
        (this.replayColorMinAlt = 0),
        (this.replayColorMaxAlt = 1e4),
        (this.replayColorMinSpeed = 0),
        (this.replayColorMaxSpeed = 200),
        (this.replayAutoZoom = !1),
        (this.replayLastZoom = null),
        (this.replayRecenterTimestamps = []));
    }
    toggleReplay() {
      let e = document.getElementById("replay-controls");
      if (e)
        if (this.replayActive) {
          (this.stopReplay(),
            (e.style.display = "none"),
            (this.replayActive = !1));
          let t = document.getElementById("replay-btn");
          if (
            (t && (t.textContent = "\u25B6\uFE0F Replay"),
            document.body.classList.remove("replay-active"),
            this.replayAirplaneMarker &&
              this.app.map &&
              (this.app.map.removeLayer(this.replayAirplaneMarker),
              (this.replayAirplaneMarker = null)),
            this.replayLayer &&
              this.app.map &&
              this.app.map.removeLayer(this.replayLayer),
            this.restoreLayerVisibility(),
            !this.app.altitudeVisible &&
              !this.app.airspeedVisible &&
              this.app.map)
          ) {
            this.app.altitudeVisible = !0;
            let a = document.getElementById("altitude-btn");
            a && (a.style.opacity = "1.0");
            let s = document.getElementById("altitude-legend");
            (s && (s.style.display = "block"),
              this.app.map.addLayer(this.app.altitudeLayer));
          }
          (setTimeout(() => {
            (this.app.altitudeVisible
              ? this.app.layerManager.redrawAltitudePaths()
              : this.app.airspeedVisible &&
                this.app.layerManager.redrawAirspeedPaths(),
              this.app.map && this.app.map.invalidateSize());
          }, 100),
            this.updateReplayButtonState(),
            this.app.stateManager.saveMapState());
        } else {
          if (this.app.selectedPathIds.size !== 1) return;
          if (this.initializeReplay()) {
            ((e.style.display = "block"), (this.replayActive = !0));
            let t = document.getElementById("replay-btn");
            t &&
              ((t.textContent = "\u23F9\uFE0F Replay"),
              (t.style.opacity = "1.0"));
            let a = document.getElementById("replay-autozoom-btn");
            (a &&
              ((a.style.opacity = this.replayAutoZoom ? "1.0" : "0.5"),
              (a.title = this.replayAutoZoom
                ? "Auto-zoom enabled"
                : "Auto-zoom disabled")),
              document.body.classList.add("replay-active"),
              this.hideOtherLayersDuringReplay(),
              this.app.stateManager.saveMapState());
          }
        }
    }
    updateReplayButtonState() {
      let e = document.getElementById("replay-btn");
      e &&
        (this.app.selectedPathIds.size === 1
          ? (e.style.opacity = "1.0")
          : (e.style.opacity = "0.5"));
    }
    updateReplayAirplanePopup() {
      if (!this.replayAirplaneMarker || !this.replayActive) return;
      let e = null;
      for (let l = 0; l < this.replaySegments.length; l++) {
        let c = this.replaySegments[l];
        if (c && (c.time || 0) <= this.replayCurrentTime) e = c;
        else break;
      }
      if (
        (!e && this.replaySegments.length > 0 && (e = this.replaySegments[0]),
        !e)
      )
        return;
      let t = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; min-width: 180px; padding: 8px 4px; background-color: #2b2b2b; color: #ffffff;">`;
      ((t +=
        '<div style="font-size: 14px; font-weight: bold; color: #4facfe; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 2px solid #4facfe; display: flex; align-items: center; gap: 6px;">'),
        (t += '<span style="font-size: 16px;">\u2708\uFE0F</span>'),
        (t += "<span>Current Position</span>"),
        (t += "</div>"));
      let a = e.altitude_ft || 0,
        s = Math.round(a / 50) * 50,
        i = Math.round(s * 0.3048),
        r = window.KMLHeatmap.getColorForAltitude(
          a,
          this.replayColorMinAlt,
          this.replayColorMaxAlt
        ),
        p = r.replace("rgb(", "rgba(").replace(")", ", 0.15)");
      ((t += '<div style="margin-bottom: 8px;">'),
        (t +=
          '<div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Altitude (MSL)</div>'),
        (t +=
          '<div style="background: ' +
          p +
          "; padding: 6px 8px; border-radius: 6px; border-left: 3px solid " +
          r +
          ';">'),
        (t +=
          '<span style="font-size: 16px; font-weight: bold; color: ' +
          r +
          ';">' +
          s.toLocaleString() +
          " ft</span>"),
        (t +=
          '<span style="font-size: 12px; color: #ccc; margin-left: 6px;">(' +
          i.toLocaleString() +
          " m)</span>"),
        (t += "</div>"),
        (t += "</div>"));
      let n = e.groundspeed_knots || 0,
        o = n * 1.852,
        d = Math.round(n),
        f = Math.round(o),
        y = window.KMLHeatmap.getColorForAirspeed(
          n,
          this.replayColorMinSpeed,
          this.replayColorMaxSpeed
        ),
        h = y.replace("rgb(", "rgba(").replace(")", ", 0.15)");
      ((t += '<div style="margin-bottom: 8px;">'),
        (t +=
          '<div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Groundspeed</div>'),
        (t +=
          '<div style="background: ' +
          h +
          "; padding: 6px 8px; border-radius: 6px; border-left: 3px solid " +
          y +
          ';">'),
        (t +=
          '<span style="font-size: 16px; font-weight: bold; color: ' +
          y +
          ';">' +
          d.toLocaleString() +
          " kt</span>"),
        (t +=
          '<span style="font-size: 12px; color: #ccc; margin-left: 6px;">(' +
          f.toLocaleString() +
          " km/h)</span>"),
        (t += "</div>"),
        (t += "</div>"),
        (t += "</div>"),
        this.replayAirplaneMarker.getPopup()
          ? this.replayAirplaneMarker.getPopup().setContent(t)
          : this.replayAirplaneMarker.bindPopup(t, {
              autoPanPadding: [50, 50],
            }),
        this.replayAirplaneMarker.openPopup());
    }
    initializeReplay() {
      if (!this.app.fullPathSegments)
        return (
          alert(
            "No flight data available for replay. Please wait for data to load or refresh the page."
          ),
          !1
        );
      let e = Array.from(this.app.selectedPathIds)[0];
      if (
        ((this.replaySegments = this.app.fullPathSegments.filter(
          (o) => o.path_id === e && o.time !== void 0 && o.time !== null
        )),
        this.replaySegments.length === 0)
      )
        return (
          alert(
            "No timestamp data available for this path. The flight may not have timing information."
          ),
          !1
        );
      if (
        (this.replaySegments.sort((o, d) => (o.time || 0) - (d.time || 0)),
        this.app.currentData && this.app.currentData.path_segments)
      ) {
        let o = this.app.currentData.path_segments.filter(
          (d) => d.path_id === e
        );
        if (o.length > 0) {
          let d = o.map((l) => l.altitude_ft || 0),
            f = d[0],
            y = d[0];
          for (let l = 1; l < d.length; l++)
            (d[l] < f && (f = d[l]), d[l] > y && (y = d[l]));
          ((this.replayColorMinAlt = f), (this.replayColorMaxAlt = y));
          let h = o.map((l) => l.groundspeed_knots || 0).filter((l) => l > 0);
          if (h.length > 0) {
            let l = h[0],
              c = h[0];
            for (let u = 1; u < h.length; u++)
              (h[u] < l && (l = h[u]), h[u] > c && (c = h[u]));
            ((this.replayColorMinSpeed = l), (this.replayColorMaxSpeed = c));
          } else
            ((this.replayColorMinSpeed = this.app.airspeedRange.min),
              (this.replayColorMaxSpeed = this.app.airspeedRange.max));
        } else {
          let d = this.replaySegments.map((l) => l.altitude_ft || 0),
            f = d[0],
            y = d[0];
          for (let l = 1; l < d.length; l++)
            (d[l] < f && (f = d[l]), d[l] > y && (y = d[l]));
          ((this.replayColorMinAlt = f), (this.replayColorMaxAlt = y));
          let h = this.replaySegments
            .map((l) => l.groundspeed_knots || 0)
            .filter((l) => l > 0);
          if (h.length > 0) {
            let l = h[0],
              c = h[0];
            for (let u = 1; u < h.length; u++)
              (h[u] < l && (l = h[u]), h[u] > c && (c = h[u]));
            ((this.replayColorMinSpeed = l), (this.replayColorMaxSpeed = c));
          } else
            ((this.replayColorMinSpeed = this.app.airspeedRange.min),
              (this.replayColorMaxSpeed = this.app.airspeedRange.max));
        }
      }
      let t = this.replaySegments[this.replaySegments.length - 1];
      this.replayMaxTime = t?.time || 0;
      let a = document.getElementById("replay-slider");
      a && (a.max = this.replayMaxTime.toString());
      let s = document.getElementById("replay-slider-end");
      (s && (s.textContent = window.KMLHeatmap.formatTime(this.replayMaxTime)),
        this.app.layerManager.updateAltitudeLegend(
          this.replayColorMinAlt,
          this.replayColorMaxAlt
        ),
        this.app.layerManager.updateAirspeedLegend(
          this.replayColorMinSpeed,
          this.replayColorMaxSpeed
        ),
        this.replayLayer || (this.replayLayer = S.layerGroup()),
        this.replayLayer.clearLayers(),
        this.app.map && this.replayLayer.addTo(this.app.map),
        this.replayAirplaneMarker &&
          this.app.map &&
          (this.app.map.removeLayer(this.replayAirplaneMarker),
          (this.replayAirplaneMarker = null)));
      let i = S.divIcon({
          html: '<div class="replay-airplane-icon">\u2708\uFE0F</div>',
          iconSize: [32, 32],
          iconAnchor: [16, 16],
          className: "",
        }),
        p = this.replaySegments[0]?.coords?.[0];
      if (!p || !this.app.map) return !1;
      ((this.replayAirplaneMarker = S.marker([p[0], p[1]], {
        icon: i,
        zIndexOffset: 1e3,
      })),
        this.replayAirplaneMarker.addTo(this.app.map));
      let n = this.replayAirplaneMarker.getElement();
      return (
        n &&
          ((n.style.transition = "transform 0.08s linear"),
          (n.style.cursor = "pointer"),
          (n.style.pointerEvents = "auto"),
          n.addEventListener("click", (o) => {
            (o.stopPropagation(),
              this.replayAirplaneMarker.isPopupOpen()
                ? this.replayAirplaneMarker.closePopup()
                : this.updateReplayAirplanePopup());
          })),
        (this.replayCurrentTime = 0),
        (this.replayLastDrawnIndex = -1),
        (this.replayLastBearing = null),
        this.replayAutoZoom && this.app.map
          ? (this.app.map.setView([p[0], p[1]], 16, {
              animate: !0,
              duration: 0.8,
            }),
            (this.replayLastZoom = 16))
          : this.app.map &&
            this.app.map.panTo([p[0], p[1]], { animate: !0, duration: 0.8 }),
        this.updateReplayDisplay(),
        !0
      );
    }
    hideOtherLayersDuringReplay() {
      if (!this.app.map) return;
      (this.app.heatmapLayer &&
        this.app.heatmapVisible &&
        this.app.map.removeLayer(this.app.heatmapLayer),
        this.app.altitudeVisible &&
          this.app.map.removeLayer(this.app.altitudeLayer),
        this.app.airspeedVisible &&
          this.app.map.removeLayer(this.app.airspeedLayer),
        [
          "heatmap-btn",
          "airports-btn",
          "aviation-btn",
          "year-select",
          "aircraft-select",
        ].forEach((t) => {
          let a = document.getElementById(t);
          a && (a.disabled = !0);
        }));
    }
    restoreLayerVisibility() {
      if (!this.app.map) return;
      (this.app.heatmapLayer &&
        this.app.heatmapVisible &&
        (this.app.map.addLayer(this.app.heatmapLayer),
        this.app.heatmapLayer._canvas &&
          (this.app.heatmapLayer._canvas.style.pointerEvents = "none")),
        this.app.altitudeVisible &&
          (this.app.map.addLayer(this.app.altitudeLayer),
          setTimeout(() => {
            (this.app.layerManager.redrawAltitudePaths(),
              this.app.map && this.app.map.invalidateSize());
          }, 50)),
        this.app.airspeedVisible &&
          (this.app.map.addLayer(this.app.airspeedLayer),
          setTimeout(() => {
            (this.app.layerManager.redrawAirspeedPaths(),
              this.app.map && this.app.map.invalidateSize());
          }, 50)),
        [
          "heatmap-btn",
          "airports-btn",
          "aviation-btn",
          "year-select",
          "aircraft-select",
        ].forEach((t) => {
          let a = document.getElementById(t);
          a && (a.disabled = !1);
        }));
    }
    playReplay() {
      if (!this.replayActive || !this.app.map) return;
      if (this.replayCurrentTime >= this.replayMaxTime) {
        if (
          ((this.replayCurrentTime = 0),
          (this.replayLastDrawnIndex = -1),
          this.replayLayer && this.replayLayer.clearLayers(),
          this.replayAirplaneMarker &&
            this.replaySegments.length > 0 &&
            this.app.map)
        ) {
          let i = this.replaySegments[0]?.coords?.[0];
          i &&
            (this.replayAirplaneMarker.setLatLng([i[0], i[1]]),
            this.replayAutoZoom &&
              (this.app.map.setView([i[0], i[1]], 16, {
                animate: !0,
                duration: 0.5,
              }),
              (this.replayLastZoom = 16)));
        }
        ((this.replayRecenterTimestamps = []), (this.replayLastBearing = null));
      }
      this.replayPlaying = !0;
      let e = document.getElementById("replay-play-btn"),
        t = document.getElementById("replay-pause-btn");
      (e && (e.style.display = "none"),
        t && (t.style.display = "inline-block"),
        (this.replayLastFrameTime = null));
      let a = (s) => {
        if (!this.replayPlaying) return;
        this.replayLastFrameTime === null && (this.replayLastFrameTime = s);
        let i = s - this.replayLastFrameTime;
        this.replayLastFrameTime = s;
        let r = (i / 1e3) * this.replaySpeed;
        if (
          ((this.replayCurrentTime += r),
          this.replayCurrentTime >= this.replayMaxTime)
        ) {
          if (
            ((this.replayCurrentTime = this.replayMaxTime),
            this.pauseReplay(),
            this.replaySegments.length > 0 && this.app.map)
          ) {
            let p = [];
            if (
              (this.replaySegments.forEach((n) => {
                n.coords &&
                  n.coords.length > 0 &&
                  n.coords.forEach((o) => {
                    p.push(o);
                  });
              }),
              p.length > 0)
            ) {
              let n = S.latLngBounds(p);
              this.app.map.fitBounds(n, {
                padding: [50, 50],
                animate: !0,
                duration: 1,
              });
            }
          }
        } else this.replayAnimationFrameId = requestAnimationFrame(a);
        this.updateReplayDisplay();
      };
      ((this.replayAnimationFrameId = requestAnimationFrame(a)),
        this.app.stateManager.saveMapState());
    }
    pauseReplay() {
      this.replayPlaying = !1;
      let e = document.getElementById("replay-play-btn"),
        t = document.getElementById("replay-pause-btn");
      (e && (e.style.display = "inline-block"),
        t && (t.style.display = "none"),
        this.replayAnimationFrameId &&
          (cancelAnimationFrame(this.replayAnimationFrameId),
          (this.replayAnimationFrameId = null)),
        (this.replayLastFrameTime = null),
        this.app.stateManager.saveMapState());
    }
    stopReplay() {
      if (
        (this.pauseReplay(),
        (this.replayCurrentTime = 0),
        (this.replayLastDrawnIndex = -1),
        (this.replayLastBearing = null),
        (this.replayRecenterTimestamps = []),
        this.replayLayer && this.replayLayer.clearLayers(),
        this.replayAirplaneMarker && this.replaySegments.length > 0)
      ) {
        let t = this.replaySegments[0]?.coords?.[0];
        t && this.replayAirplaneMarker.setLatLng([t[0], t[1]]);
      }
      this.updateReplayDisplay();
    }
    seekReplay(e) {
      let t = parseFloat(e);
      (t < this.replayCurrentTime &&
        (this.replayLayer && this.replayLayer.clearLayers(),
        (this.replayLastDrawnIndex = -1)),
        (this.replayCurrentTime = t),
        this.updateReplayDisplay(!0),
        this.app.stateManager.saveMapState());
    }
    changeReplaySpeed() {
      let e = document.getElementById("replay-speed");
      e &&
        ((this.replaySpeed = parseFloat(e.value)),
        this.app.stateManager.saveMapState());
    }
    toggleAutoZoom() {
      this.replayAutoZoom = !this.replayAutoZoom;
      let e = document.getElementById("replay-autozoom-btn");
      (e &&
        ((e.style.opacity = this.replayAutoZoom ? "1.0" : "0.5"),
        (e.title = this.replayAutoZoom
          ? "Auto-zoom enabled"
          : "Auto-zoom disabled")),
        this.app.stateManager.saveMapState());
    }
    updateReplayDisplay(e = !1) {
      let t = document.getElementById("replay-time-display");
      t &&
        (t.textContent =
          window.KMLHeatmap.formatTime(this.replayCurrentTime) +
          " / " +
          window.KMLHeatmap.formatTime(this.replayMaxTime));
      let a = document.getElementById("replay-slider");
      a && (a.value = this.replayCurrentTime.toString());
      let s = document.getElementById("replay-slider-start");
      s &&
        (s.textContent = window.KMLHeatmap.formatTime(this.replayCurrentTime));
      let i = null,
        r = null,
        p = -1;
      for (let n = 0; n < this.replaySegments.length; n++) {
        let o = this.replaySegments[n];
        if (o && (o.time || 0) <= this.replayCurrentTime) ((i = o), (p = n));
        else if (o) {
          r = o;
          break;
        }
      }
      if (this.replayLayer) {
        let n = this.app.airspeedVisible && !this.app.altitudeVisible;
        for (let o = 0; o < this.replaySegments.length; o++) {
          let d = this.replaySegments[o];
          if (d)
            if (
              (d.time || 0) <= this.replayCurrentTime &&
              this.replayCurrentTime > 0
            ) {
              if (o > this.replayLastDrawnIndex) {
                let f;
                (n && (d.groundspeed_knots || 0) > 0
                  ? (f = window.KMLHeatmap.getColorForAltitude(
                      d.groundspeed_knots,
                      this.replayColorMinSpeed,
                      this.replayColorMaxSpeed
                    ))
                  : (f = window.KMLHeatmap.getColorForAltitude(
                      d.altitude_ft,
                      this.replayColorMinAlt,
                      this.replayColorMaxAlt
                    )),
                  S.polyline(d.coords || [], {
                    color: f,
                    weight: 3,
                    opacity: 0.8,
                  }).addTo(this.replayLayer),
                  (this.replayLastDrawnIndex = o));
              }
            } else break;
        }
      }
      if (
        (this.replayAirplaneMarker &&
          this.app.map &&
          !this.app.map.hasLayer(this.replayAirplaneMarker) &&
          this.replayAirplaneMarker.addTo(this.app.map),
        this.replayAirplaneMarker && this.app.map)
      ) {
        if (i) {
          let n,
            o = 0;
          if (r && (i.time || 0) < this.replayCurrentTime) {
            let y =
                (this.replayCurrentTime - (i.time || 0)) /
                ((r.time || 0) - (i.time || 0)),
              h = i.coords?.[1]?.[0] || 0,
              l = i.coords?.[1]?.[1] || 0,
              c = r.coords?.[0]?.[0] || 0,
              u = r.coords?.[0]?.[1] || 0;
            ((n = [h + (c - h) * y, l + (u - l) * y]),
              (o = window.KMLHeatmap.calculateBearing(h, l, c, u)));
          } else {
            n = i.coords?.[1] || [0, 0];
            let y = i.coords?.[0]?.[0] || 0,
              h = i.coords?.[0]?.[1] || 0,
              l = i.coords?.[1]?.[0] || 0,
              c = i.coords?.[1]?.[1] || 0;
            o = window.KMLHeatmap.calculateBearing(y, h, l, c);
          }
          let d = window.KMLHeatmap.calculateSmoothedBearing(
            this.replaySegments,
            p,
            5
          );
          if (
            (d !== null
              ? ((o = d), (this.replayLastBearing = o))
              : this.replayLastBearing !== null && (o = this.replayLastBearing),
            this.replayAirplaneMarker.setLatLng(n),
            this.replayPlaying || e)
          ) {
            let y = this.app.map.getSize(),
              h = this.app.map.latLngToContainerPoint(n),
              l = 0.1,
              c = y.x * l,
              u = y.y * l,
              L = !1;
            if (
              ((h.x < c || h.x > y.x - c || h.y < u || h.y > y.y - u) &&
                (L = !0),
              e && (L = !0),
              L)
            ) {
              this.app.map.panTo(n, {
                animate: !0,
                duration: 0.5,
                easeLinearity: 0.25,
                noMoveStart: !0,
              });
              let A = Date.now();
              this.replayRecenterTimestamps.push(A);
              let b = A - 3e4;
              this.replayRecenterTimestamps =
                this.replayRecenterTimestamps.filter((x) => x > b);
            }
            if (this.replayAutoZoom) {
              let b = Date.now() - 3e4;
              if (
                ((this.replayRecenterTimestamps =
                  this.replayRecenterTimestamps.filter((m) => m > b)),
                this.replayRecenterTimestamps.length > 2)
              ) {
                let v = Date.now() - 5e3;
                if (
                  this.replayRecenterTimestamps.filter((Y) => Y >= v).length >
                    2 &&
                  this.replayLastZoom !== null &&
                  this.replayLastZoom > 9
                ) {
                  let O = Math.max(9, this.replayLastZoom - 1);
                  (this.app.map.setZoom(O, { animate: !0, duration: 0.5 }),
                    (this.replayLastZoom = O),
                    (this.replayRecenterTimestamps = []));
                }
              }
            }
          }
          let f = this.replayAirplaneMarker.getElement();
          if (f) {
            let y = f.querySelector(".replay-airplane-icon");
            if (y) {
              let h = o - 45;
              y.style.transform = "translate3d(0,0,0) rotate(" + h + "deg)";
            }
          }
        } else if (this.replaySegments.length > 0) {
          let o = this.replaySegments[0]?.coords?.[0];
          o && this.replayAirplaneMarker.setLatLng([o[0], o[1]]);
        }
      }
      this.replayAirplaneMarker &&
        this.replayAirplaneMarker.getPopup() &&
        this.replayAirplaneMarker.isPopupOpen() &&
        this.updateReplayAirplanePopup();
    }
  };
var D = class {
  constructor(e) {
    ((this.app = e),
      (this.originalMapParent = null),
      (this.originalMapIndex = null));
  }
  async showWrapped() {
    if (!this.app.map) return;
    let e = this.app.selectedYear,
      t = window.KMLHeatmap.calculateYearStats(
        this.app.fullPathInfo,
        this.app.fullPathSegments,
        e,
        this.app.fullStats
      ),
      a = document.getElementById("wrapped-title"),
      s = document.getElementById("wrapped-year");
    e === "all"
      ? (a && (a.textContent = "\u2728 Your Flight History"),
        s && (s.textContent = "All Years"))
      : (a && (a.textContent = "\u2728 Your Year in Flight"),
        s && (s.textContent = e));
    let i = `
            <div class="stat-card">
                <div class="stat-value">${t.total_flights}</div>
                <div class="stat-label">Flights</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${t.num_airports}</div>
                <div class="stat-label">Airports</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${t.total_distance_nm.toFixed(0)}</div>
                <div class="stat-label">Nautical Miles</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${t.flight_time}</div>
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
        `,
      r = document.getElementById("wrapped-stats");
    r && (r.innerHTML = i);
    let p = window.KMLHeatmap.generateFunFacts(t, this.app.fullStats),
      n = '<div class="fun-facts-title">\u2728 Facts</div>';
    p.forEach((l) => {
      n += `<div class="fun-fact" data-category="${l.category}"><span class="fun-fact-icon">${l.icon}</span><span class="fun-fact-text">${l.text}</span></div>`;
    });
    let o = document.getElementById("wrapped-fun-facts");
    if (
      (o && (o.innerHTML = n), t.aircraft_list && t.aircraft_list.length > 0)
    ) {
      let l = '<div class="aircraft-fleet-title">\u2708\uFE0F Fleet</div>',
        c = t.aircraft_list[0].flights,
        u = t.aircraft_list[t.aircraft_list.length - 1].flights,
        L = c - u;
      t.aircraft_list.forEach((b) => {
        let x = b.model || b.type || "",
          m = L > 0 ? (b.flights - u) / L : 1,
          v;
        m >= 0.75
          ? (v = "fleet-aircraft-high")
          : m >= 0.5
            ? (v = "fleet-aircraft-medium-high")
            : m >= 0.25
              ? (v = "fleet-aircraft-medium-low")
              : (v = "fleet-aircraft-low");
        let _ = b.flight_time_str || "---";
        l += `
                    <div class="fleet-aircraft ${v}">
                        <div class="fleet-aircraft-info">
                            <div class="fleet-aircraft-model">${x}</div>
                            <div class="fleet-aircraft-registration">${b.registration}</div>
                        </div>
                        <div class="fleet-aircraft-stats">
                            <div class="fleet-aircraft-flights">${b.flights} flights</div>
                            <div class="fleet-aircraft-time">${_}</div>
                        </div>
                    </div>
                `;
      });
      let A = document.getElementById("wrapped-aircraft-fleet");
      A && (A.innerHTML = l);
    }
    if (t.airport_names && t.airport_names.length > 0) {
      let l;
      if (e === "all") l = this.app.fullPathInfo || [];
      else {
        let m = e.toString();
        l = (this.app.fullPathInfo || []).filter(
          (v) => v.year && v.year.toString() === m
        );
      }
      let c = {};
      l.forEach((m) => {
        (m.start_airport &&
          (c[m.start_airport] = (c[m.start_airport] || 0) + 1),
          m.end_airport && (c[m.end_airport] = (c[m.end_airport] || 0) + 1));
      });
      let u = t.airport_names.map((m) => ({
        name: m,
        flight_count: c[m] || 0,
      }));
      u.sort((m, v) => v.flight_count - m.flight_count);
      let L = u[0],
        A = '<div class="top-airports-title">\u{1F3E0} Home Base</div>';
      A += `
                <div class="top-airport">
                    <div class="top-airport-name">${L.name}</div>
                    <div class="top-airport-count">${L.flight_count} flights</div>
                </div>
            `;
      let b = document.getElementById("wrapped-top-airports");
      b && (b.innerHTML = A);
      let x = t.airport_names.filter((m) => m !== L.name);
      if (x.length > 0) {
        let m =
          '<div class="airports-grid-title">\u{1F5FA}\uFE0F Destinations</div><div class="airport-badges">';
        (x.forEach((_) => {
          m += `<div class="airport-badge">${_}</div>`;
        }),
          (m += "</div>"));
        let v = document.getElementById("wrapped-airports-grid");
        v && (v.innerHTML = m);
      } else {
        let m = document.getElementById("wrapped-airports-grid");
        m && (m.innerHTML = "");
      }
    }
    let d = document.getElementById("map"),
      f = document.getElementById("wrapped-map-container");
    if (!d || !f) return;
    (this.originalMapParent ||
      ((this.originalMapParent = d.parentNode),
      (this.originalMapIndex = Array.from(
        this.originalMapParent.children
      ).indexOf(d))),
      this.app.map.fitBounds(this.app.config.bounds, { padding: [80, 80] }),
      [
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
        document.getElementById("loading"),
      ].forEach((l) => {
        l && (l.style.display = "none");
      }));
    let h = document.getElementById("wrapped-modal");
    (h && (h.style.display = "flex"),
      setTimeout(() => {
        (f.appendChild(d),
          (d.style.width = "100%"),
          (d.style.height = "100%"),
          (d.style.borderRadius = "12px"),
          (d.style.overflow = "hidden"),
          f.offsetHeight,
          setTimeout(() => {
            (this.app.map.invalidateSize(),
              this.app.map.fitBounds(this.app.config.bounds, {
                padding: [80, 80],
              }),
              this.app.stateManager && this.app.stateManager.saveMapState());
          }, 100));
      }, 50));
  }
  closeWrapped(e) {
    if (!e || e.target.id === "wrapped-modal") {
      let t = document.getElementById("map");
      if (!t) return;
      if (this.originalMapParent && this.originalMapIndex !== null) {
        let s = Array.from(this.originalMapParent.children);
        if (this.originalMapIndex >= s.length)
          this.originalMapParent.appendChild(t);
        else {
          let r = s[this.originalMapIndex];
          r && this.originalMapParent.insertBefore(t, r);
        }
        if (
          ((t.style.width = ""),
          (t.style.height = ""),
          (t.style.borderRadius = ""),
          (t.style.overflow = ""),
          [
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
            document.getElementById("loading"),
          ].forEach((r) => {
            r && (r.style.display = "");
          }),
          this.app.config.openaipApiKey)
        ) {
          let r = document.getElementById("aviation-btn");
          r && (r.style.display = "");
        }
        setTimeout(() => {
          (this.app.map && this.app.map.invalidateSize(),
            this.app.stateManager && this.app.stateManager.saveMapState());
        }, 100);
      }
      let a = document.getElementById("wrapped-modal");
      a && (a.style.display = "none");
    }
  }
};
var F = I(E(), 1),
  z = class {
    constructor(e) {
      this.app = e;
    }
    toggleHeatmap() {
      if (this.app.map) {
        if (this.app.heatmapVisible) {
          (this.app.heatmapLayer &&
            this.app.map.removeLayer(this.app.heatmapLayer),
            (this.app.heatmapVisible = !1));
          let e = document.getElementById("heatmap-btn");
          e && (e.style.opacity = "0.5");
        } else {
          (this.app.heatmapLayer &&
            (this.app.map.addLayer(this.app.heatmapLayer),
            this.app.heatmapLayer._canvas &&
              (this.app.heatmapLayer._canvas.style.pointerEvents = "none")),
            (this.app.heatmapVisible = !0));
          let e = document.getElementById("heatmap-btn");
          e && (e.style.opacity = "1.0");
        }
        this.app.stateManager.saveMapState();
      }
    }
    toggleAltitude() {
      if (this.app.map) {
        if (this.app.altitudeVisible) {
          if (this.app.replayManager.replayActive && !this.app.airspeedVisible)
            return;
          (this.app.map.removeLayer(this.app.altitudeLayer),
            (this.app.altitudeVisible = !1));
          let e = document.getElementById("altitude-btn");
          e && (e.style.opacity = "0.5");
          let t = document.getElementById("altitude-legend");
          t && (t.style.display = "none");
        } else {
          if (this.app.airspeedVisible) {
            (this.app.replayManager.replayActive ||
              this.app.map.removeLayer(this.app.airspeedLayer),
              (this.app.airspeedVisible = !1));
            let a = document.getElementById("airspeed-btn");
            a && (a.style.opacity = "0.5");
            let s = document.getElementById("airspeed-legend");
            s && (s.style.display = "none");
          }
          if (!this.app.replayManager.replayActive)
            (this.app.map.addLayer(this.app.altitudeLayer),
              this.app.layerManager.redrawAltitudePaths());
          else {
            let a = this.app.replayManager.replayCurrentTime,
              s = this.app.replayManager.replayLastDrawnIndex;
            (this.app.replayManager.replayLayer &&
              this.app.replayManager.replayLayer.clearLayers(),
              (this.app.replayManager.replayLastDrawnIndex = -1));
            for (
              let i = 0;
              i <= s && i < this.app.replayManager.replaySegments.length;
              i++
            ) {
              let r = this.app.replayManager.replaySegments[i];
              if (r && (r.time || 0) <= a) {
                let p = window.KMLHeatmap.getColorForAltitude(
                  r.altitude_ft,
                  this.app.replayManager.replayColorMinAlt,
                  this.app.replayManager.replayColorMaxAlt
                );
                (F.polyline(r.coords || [], {
                  color: p,
                  weight: 3,
                  opacity: 0.8,
                }).addTo(this.app.replayManager.replayLayer),
                  (this.app.replayManager.replayLastDrawnIndex = i));
              }
            }
          }
          this.app.altitudeVisible = !0;
          let e = document.getElementById("altitude-btn");
          e && (e.style.opacity = "1.0");
          let t = document.getElementById("altitude-legend");
          t && (t.style.display = "block");
        }
        (this.app.replayManager.replayActive &&
          this.app.replayManager.replayAirplaneMarker &&
          this.app.replayManager.replayAirplaneMarker.isPopupOpen() &&
          this.app.replayManager.updateReplayAirplanePopup(),
          this.app.stateManager.saveMapState());
      }
    }
    toggleAirspeed() {
      if (this.app.map) {
        if (this.app.airspeedVisible) {
          if (this.app.replayManager.replayActive && !this.app.altitudeVisible)
            return;
          (this.app.map.removeLayer(this.app.airspeedLayer),
            (this.app.airspeedVisible = !1));
          let e = document.getElementById("airspeed-btn");
          e && (e.style.opacity = "0.5");
          let t = document.getElementById("airspeed-legend");
          t && (t.style.display = "none");
        } else {
          if (this.app.altitudeVisible) {
            (this.app.replayManager.replayActive ||
              this.app.map.removeLayer(this.app.altitudeLayer),
              (this.app.altitudeVisible = !1));
            let a = document.getElementById("altitude-btn");
            a && (a.style.opacity = "0.5");
            let s = document.getElementById("altitude-legend");
            s && (s.style.display = "none");
          }
          if (!this.app.replayManager.replayActive)
            (this.app.map.addLayer(this.app.airspeedLayer),
              this.app.layerManager.redrawAirspeedPaths());
          else {
            let a = this.app.replayManager.replayCurrentTime,
              s = this.app.replayManager.replayLastDrawnIndex;
            (this.app.replayManager.replayLayer &&
              this.app.replayManager.replayLayer.clearLayers(),
              (this.app.replayManager.replayLastDrawnIndex = -1));
            for (
              let i = 0;
              i <= s && i < this.app.replayManager.replaySegments.length;
              i++
            ) {
              let r = this.app.replayManager.replaySegments[i];
              if (r && (r.time || 0) <= a && (r.groundspeed_knots || 0) > 0) {
                let p = window.KMLHeatmap.getColorForAltitude(
                  r.groundspeed_knots,
                  this.app.replayManager.replayColorMinSpeed,
                  this.app.replayManager.replayColorMaxSpeed
                );
                (F.polyline(r.coords || [], {
                  color: p,
                  weight: 3,
                  opacity: 0.8,
                }).addTo(this.app.replayManager.replayLayer),
                  (this.app.replayManager.replayLastDrawnIndex = i));
              }
            }
          }
          this.app.airspeedVisible = !0;
          let e = document.getElementById("airspeed-btn");
          e && (e.style.opacity = "1.0");
          let t = document.getElementById("airspeed-legend");
          t && (t.style.display = "block");
        }
        (this.app.replayManager.replayActive &&
          this.app.replayManager.replayAirplaneMarker &&
          this.app.replayManager.replayAirplaneMarker.isPopupOpen() &&
          this.app.replayManager.updateReplayAirplanePopup(),
          this.app.stateManager.saveMapState());
      }
    }
    toggleAirports() {
      if (this.app.map) {
        if (this.app.airportsVisible) {
          (this.app.map.removeLayer(this.app.airportLayer),
            (this.app.airportsVisible = !1));
          let e = document.getElementById("airports-btn");
          e && (e.style.opacity = "0.5");
        } else {
          (this.app.map.addLayer(this.app.airportLayer),
            (this.app.airportsVisible = !0));
          let e = document.getElementById("airports-btn");
          e && (e.style.opacity = "1.0");
        }
        this.app.stateManager.saveMapState();
      }
    }
    toggleAviation() {
      if (
        this.app.map &&
        this.app.config.openaipApiKey &&
        this.app.openaipLayers["Aviation Data"]
      ) {
        if (this.app.aviationVisible) {
          (this.app.map.removeLayer(this.app.openaipLayers["Aviation Data"]),
            (this.app.aviationVisible = !1));
          let e = document.getElementById("aviation-btn");
          e && (e.style.opacity = "0.5");
        } else {
          (this.app.map.addLayer(this.app.openaipLayers["Aviation Data"]),
            (this.app.aviationVisible = !0));
          let e = document.getElementById("aviation-btn");
          e && (e.style.opacity = "1.0");
        }
        this.app.stateManager.saveMapState();
      }
    }
    toggleButtonsVisibility() {
      let e = document.querySelectorAll(".toggleable-btn"),
        t = document.getElementById("hide-buttons-btn");
      (this.app.buttonsHidden
        ? (e.forEach((a) => {
            a.classList.remove("buttons-hidden");
          }),
          t && (t.textContent = "\u{1F53C}"),
          (this.app.buttonsHidden = !1))
        : (e.forEach((a) => {
            a.classList.add("buttons-hidden");
          }),
          t && (t.textContent = "\u{1F53D}"),
          (this.app.buttonsHidden = !0)),
        this.app.altitudeVisible && this.app.layerManager.redrawAltitudePaths(),
        this.app.airspeedVisible && this.app.layerManager.redrawAirspeedPaths(),
        this.app.stateManager.saveMapState());
    }
    exportMap() {
      let e = document.getElementById("export-btn");
      if (!e) return;
      ((e.disabled = !0), (e.textContent = "\u23F3 Exporting..."));
      let t = document.getElementById("map");
      if (!t) return;
      let a = [
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
          document.getElementById("loading"),
        ],
        s = a.map((i) => (i ? i.style.display : null));
      (a.forEach((i) => {
        i && (i.style.display = "none");
      }),
        setTimeout(() => {
          window.domtoimage
            .toJpeg(t, {
              width: t.offsetWidth * 2,
              height: t.offsetHeight * 2,
              bgcolor: "#1a1a1a",
              quality: 0.95,
              style: { transform: "scale(2)", transformOrigin: "top left" },
            })
            .then((i) => {
              (a.forEach((p, n) => {
                p && (p.style.display = s[n] || "");
              }),
                (e.disabled = !1),
                (e.textContent = "\u{1F4F7} Export"));
              let r = document.createElement("a");
              ((r.download =
                "heatmap_" +
                new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-") +
                ".jpg"),
                (r.href = i),
                r.click());
            })
            .catch((i) => {
              (a.forEach((r, p) => {
                r && (r.style.display = s[p] || "");
              }),
                alert("Export failed: " + i.message),
                (e.disabled = !1),
                (e.textContent = "\u{1F4F7} Export"));
            });
        }, 200));
    }
  };
var K = class {
  constructor(e) {
    ((this.config = e),
      (this.selectedYear = "all"),
      (this.selectedAircraft = "all"),
      (this.allAirportsData = []),
      (this.isInitializing = !0),
      (this.map = null),
      (this.heatmapLayer = null),
      (this.altitudeLayer = M.layerGroup()),
      (this.airspeedLayer = M.layerGroup()),
      (this.airportLayer = M.layerGroup()),
      (this.altitudeRenderer = M.svg()),
      (this.airspeedRenderer = M.svg()),
      (this.currentResolution = null),
      (this.currentData = null),
      (this.fullStats = null),
      (this.fullPathInfo = null),
      (this.fullPathSegments = null),
      (this.altitudeRange = { min: 0, max: 1e4 }),
      (this.airspeedRange = { min: 0, max: 200 }),
      (this.heatmapVisible = !0),
      (this.altitudeVisible = !1),
      (this.airspeedVisible = !1),
      (this.airportsVisible = !0),
      (this.aviationVisible = !1),
      (this.buttonsHidden = !1),
      (this.selectedPathIds = new Set()),
      (this.pathSegments = {}),
      (this.pathToAirports = {}),
      (this.airportToPaths = {}),
      (this.airportMarkers = {}),
      (this.openaipLayers = {}),
      (this.savedState = null),
      (this.restoredYearFromState = !1),
      (this.stateManager = null),
      (this.dataManager = null),
      (this.layerManager = null),
      (this.filterManager = null),
      (this.statsManager = null),
      (this.pathSelection = null),
      (this.airportManager = null),
      (this.replayManager = null),
      (this.wrappedManager = null),
      (this.uiToggles = null));
  }
  async initialize() {
    if (
      ((this.stateManager = new B(this)),
      (this.savedState = this.stateManager.loadState()),
      this.savedState &&
        (this.savedState.selectedYear !== void 0 &&
          ((this.selectedYear = this.savedState.selectedYear),
          (this.restoredYearFromState = !0)),
        this.savedState.selectedAircraft &&
          (this.selectedAircraft = this.savedState.selectedAircraft),
        this.savedState.selectedPathIds &&
          this.savedState.selectedPathIds.length > 0 &&
          this.savedState.selectedPathIds.forEach((e) => {
            let t = typeof e == "string" ? parseInt(e, 10) : e;
            this.selectedPathIds.add(t);
          }),
        this.savedState.heatmapVisible !== void 0 &&
          (this.heatmapVisible = this.savedState.heatmapVisible),
        this.savedState.altitudeVisible !== void 0 &&
          (this.altitudeVisible = this.savedState.altitudeVisible),
        this.savedState.airspeedVisible !== void 0 &&
          (this.airspeedVisible = this.savedState.airspeedVisible),
        this.savedState.airportsVisible !== void 0 &&
          (this.airportsVisible = this.savedState.airportsVisible),
        this.savedState.aviationVisible !== void 0 &&
          (this.aviationVisible = this.savedState.aviationVisible),
        this.savedState.buttonsHidden !== void 0 &&
          (this.buttonsHidden = this.savedState.buttonsHidden)),
      (this.map = M.map("map", {
        center: this.config.center,
        zoom: 10,
        zoomSnap: 0.25,
        zoomDelta: 0.25,
        wheelPxPerZoomLevel: 120,
        preferCanvas: !0,
      })),
      this.config.stadiaApiKey
        ? M.tileLayer(
            "https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=" +
              this.config.stadiaApiKey,
            {
              attribution:
                '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>',
            }
          ).addTo(this.map)
        : M.tileLayer(
            "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
            { attribution: "&copy; OpenStreetMap contributors, &copy; CARTO" }
          ).addTo(this.map),
      this.savedState && this.savedState.center && this.savedState.zoom
        ? this.map.setView(
            [this.savedState.center.lat, this.savedState.center.lng],
            this.savedState.zoom
          )
        : this.map.fitBounds(this.config.bounds, { padding: [30, 30] }),
      this.config.openaipApiKey &&
        (this.openaipLayers["Aviation Data"] = M.tileLayer(
          "https://{s}.api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.png?apiKey=" +
            this.config.openaipApiKey,
          {
            attribution: '&copy; <a href="https://www.openaip.net">OpenAIP</a>',
            maxZoom: 18,
            minZoom: 7,
            subdomains: ["a", "b", "c"],
          }
        )),
      this.airportsVisible && this.airportLayer.addTo(this.map),
      (document.getElementById("heatmap-btn").style.opacity = this
        .heatmapVisible
        ? "1.0"
        : "0.5"),
      (document.getElementById("altitude-btn").style.opacity = this
        .altitudeVisible
        ? "1.0"
        : "0.5"),
      (document.getElementById("airspeed-btn").style.opacity = this
        .airspeedVisible
        ? "1.0"
        : "0.5"),
      (document.getElementById("airports-btn").style.opacity = this
        .airportsVisible
        ? "1.0"
        : "0.5"),
      (document.getElementById("aviation-btn").style.opacity = this
        .aviationVisible
        ? "1.0"
        : "0.5"),
      this.config.openaipApiKey &&
        (document.getElementById("aviation-btn").style.display = "block"),
      (this.dataManager = new P(this)),
      (this.layerManager = new k(this)),
      (this.filterManager = new T(this)),
      (this.statsManager = new C(this)),
      (this.pathSelection = new R(this)),
      (this.airportManager = new V(this)),
      (this.replayManager = new H(this)),
      (this.wrappedManager = new D(this)),
      (this.uiToggles = new z(this)),
      await this.loadInitialData(),
      this.setupEventHandlers(),
      (this.isInitializing = !1),
      this.savedState && this.savedState.buttonsHidden)
    ) {
      let e = document.querySelectorAll(".toggleable-btn"),
        t = document.getElementById("hide-buttons-btn");
      (e.forEach((a) => {
        a.classList.add("buttons-hidden");
      }),
        t && (t.textContent = "\u{1F53D}"));
    }
    (this.savedState &&
      this.savedState.wrappedVisible &&
      setTimeout(() => {
        this.wrappedManager && this.wrappedManager.showWrapped();
      }, 500),
      this.stateManager.saveMapState());
  }
  async loadInitialData() {
    let e = await this.dataManager.loadAirports();
    this.allAirportsData = e;
    let t = await this.dataManager.loadMetadata();
    if (t && t.available_years) {
      let a = document.getElementById("year-select");
      if (
        (t.available_years.forEach((s) => {
          let i = document.createElement("option");
          ((i.value = s.toString()),
            (i.textContent = "\u{1F4C5} " + s),
            a.appendChild(i));
        }),
        this.selectedYear === "all" && !this.restoredYearFromState)
      ) {
        let s = t.available_years[t.available_years.length - 1];
        s !== void 0 && (this.selectedYear = s.toString());
      }
      this.selectedYear &&
        this.selectedYear !== "all" &&
        (a.value = this.selectedYear);
    }
    (this.createAirportMarkers(e), t && t.stats && (this.fullStats = t.stats));
    try {
      let a = await this.dataManager.loadData("z14_plus", this.selectedYear);
      (a && a.path_info && (this.fullPathInfo = a.path_info),
        a && a.path_segments && (this.fullPathSegments = a.path_segments));
    } catch (a) {
      console.error("Failed to load full path data:", a);
    }
    if (
      (this.filterManager.updateAircraftDropdown(),
      this.airportManager.updateAirportPopups(),
      this.fullStats)
    ) {
      let a = window.KMLHeatmap.calculateFilteredStatistics({
        pathInfo: this.fullPathInfo,
        segments: this.fullPathSegments,
        year: this.selectedYear,
        aircraft: this.selectedAircraft,
      });
      this.statsManager.updateStatsPanel(a, !1);
    }
    if (
      (this.airportManager.updateAirportOpacity(),
      t &&
        t.min_groundspeed_knots !== void 0 &&
        t.max_groundspeed_knots !== void 0 &&
        ((this.airspeedRange.min = t.min_groundspeed_knots),
        (this.airspeedRange.max = t.max_groundspeed_knots),
        this.layerManager.updateAirspeedLegend(
          this.airspeedRange.min,
          this.airspeedRange.max
        )),
      await this.dataManager.updateLayers(),
      this.airportManager.updateAirportMarkerSizes(),
      this.altitudeVisible &&
        (this.map.addLayer(this.altitudeLayer),
        (document.getElementById("altitude-legend").style.display = "block")),
      this.airspeedVisible &&
        (this.map.addLayer(this.airspeedLayer),
        (document.getElementById("airspeed-legend").style.display = "block")),
      this.aviationVisible &&
        this.config.openaipApiKey &&
        this.openaipLayers["Aviation Data"] &&
        this.map.addLayer(this.openaipLayers["Aviation Data"]),
      this.selectedPathIds.size > 0 &&
        this.replayManager.updateReplayButtonState(),
      this.savedState && this.savedState.statsPanelVisible)
    ) {
      let a = document.getElementById("stats-panel");
      ((a.style.display = "block"), a.offsetHeight, a.classList.add("visible"));
    }
  }
  createAirportMarkers(e) {
    let t = null;
    (e.length > 0 &&
      (t = e.reduce((a, s) => {
        let i = s.flight_count ?? 0,
          r = a?.flight_count ?? 0;
        return i > r ? s : a;
      })),
      e.forEach((a) => {
        let s = a.name ? a.name.match(/\b([A-Z]{4})\b/) : null,
          i = s ? s[1] : "APT",
          r = t && a.name === t.name,
          p = r ? " airport-marker-home" : "",
          n = r ? " airport-label-home" : "",
          o =
            '<div class="airport-marker-container"><div class="airport-marker' +
            p +
            '"></div><div class="airport-label' +
            n +
            '">' +
            i +
            "</div></div>",
          d = window.KMLHeatmap.ddToDms(a.lat, !0),
          f = window.KMLHeatmap.ddToDms(a.lon, !1),
          y = `https://www.google.com/maps?q=${a.lat},${a.lon}`,
          h = `
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
                    <span>${a.name || "Unknown"}</span>
                    ${r ? '<span style="font-size: 12px; background: #007bff; color: white; padding: 2px 6px; border-radius: 3px; margin-left: 4px;">HOME</span>' : ""}
                </div>
                <div style="margin-bottom: 8px;">
                    <div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Coordinates</div>
                    <a href="${y}"
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
                        <span>${d}<br>${f}</span>
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
                    <span style="font-size: 16px; font-weight: bold; color: #4facfe;">${a.flight_count || 0}</span>
                </div>
            </div>`,
          l = M.marker([a.lat, a.lon], {
            icon: M.divIcon({
              html: o,
              iconSize: [12, 12],
              iconAnchor: [6, 6],
              popupAnchor: [0, -6],
              className: "",
            }),
          }).bindPopup(h, { autoPanPadding: [50, 50] });
        (l.on("click", (c) => {
          this.replayManager.replayActive ||
            this.pathSelection.selectPathsByAirport(a.name);
        }),
          l.addTo(this.airportLayer),
          (this.airportMarkers[a.name] = l));
      }));
  }
  setupEventHandlers() {
    (this.map.on("moveend", () => this.stateManager.saveMapState()),
      this.map.on("zoomend", () => {
        (this.stateManager.saveMapState(),
          this.dataManager.updateLayers(),
          this.airportManager.updateAirportMarkerSizes());
      }),
      this.map.on("click", (e) => {
        (this.replayManager.replayActive &&
          this.replayManager.replayAirplaneMarker &&
          this.replayManager.replayAirplaneMarker.isPopupOpen() &&
          this.replayManager.replayAirplaneMarker.closePopup(),
          !this.replayManager.replayActive &&
            this.selectedPathIds.size > 0 &&
            this.pathSelection.clearSelection());
      }));
  }
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
  togglePathSelection(e) {
    this.pathSelection.togglePathSelection(e);
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
  seekReplay(e) {
    this.replayManager.seekReplay(e);
  }
  changeReplaySpeed() {
    this.replayManager.changeReplaySpeed();
  }
  toggleAutoZoom() {
    this.replayManager.toggleAutoZoom();
  }
};
typeof window < "u" &&
  (window.initMapApp = async (g) => {
    let e = new K(g);
    ((window.mapApp = e),
      await e.initialize(),
      (window.toggleHeatmap = () => e.toggleHeatmap()),
      (window.toggleStats = () => e.toggleStats()),
      (window.toggleAltitude = () => e.toggleAltitude()),
      (window.toggleAirspeed = () => e.toggleAirspeed()),
      (window.toggleAirports = () => e.toggleAirports()),
      (window.toggleAviation = () => e.toggleAviation()),
      (window.toggleReplay = () => e.toggleReplay()),
      (window.filterByYear = () => e.filterByYear()),
      (window.filterByAircraft = () => e.filterByAircraft()),
      (window.togglePathSelection = (t) => e.togglePathSelection(t)),
      (window.exportMap = () => e.exportMap()),
      (window.showWrapped = () => e.showWrapped()),
      (window.closeWrapped = (t) => e.closeWrapped(t)),
      (window.toggleButtonsVisibility = () => e.toggleButtonsVisibility()),
      (window.playReplay = () => e.playReplay()),
      (window.pauseReplay = () => e.pauseReplay()),
      (window.stopReplay = () => e.stopReplay()),
      (window.seekReplay = (t) => e.seekReplay(t)),
      (window.changeReplaySpeed = () => e.changeReplaySpeed()),
      (window.toggleAutoZoom = () => e.toggleAutoZoom()));
  });
typeof window < "u" &&
  window.MAP_CONFIG &&
  window.initMapApp &&
  window.initMapApp(window.MAP_CONFIG);
export { K as MapApp };
