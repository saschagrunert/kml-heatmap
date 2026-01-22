function x(n, t) {
  let [r, e] = n,
    [a, o] = t,
    i = (r * Math.PI) / 180,
    s = (e * Math.PI) / 180,
    l = (a * Math.PI) / 180,
    c = (o * Math.PI) / 180,
    u = l - i,
    m = c - s,
    _ =
      Math.sin(u / 2) * Math.sin(u / 2) +
      Math.cos(i) * Math.cos(l) * Math.sin(m / 2) * Math.sin(m / 2);
  return 6371 * (2 * Math.atan2(Math.sqrt(_), Math.sqrt(1 - _)));
}
function y(n, t, r, e) {
  let a = (n * Math.PI) / 180,
    o = (r * Math.PI) / 180,
    i = ((e - t) * Math.PI) / 180,
    s = Math.sin(i) * Math.cos(o),
    l = Math.cos(a) * Math.sin(o) - Math.sin(a) * Math.cos(o) * Math.cos(i);
  return ((Math.atan2(s, l) * 180) / Math.PI + 360) % 360;
}
function w(n, t) {
  let r = n >= 0 ? (t ? "N" : "E") : t ? "S" : "W";
  n = Math.abs(n);
  let e = Math.floor(n),
    a = Math.floor((n - e) * 60),
    o = ((n - e) * 60 - a) * 60;
  return e + "\xB0" + a + "'" + o.toFixed(1) + '"' + r;
}
function W(n) {
  let t = Math.floor(n / 3600),
    r = Math.floor((n % 3600) / 60),
    e = Math.floor(n % 60);
  return t > 0
    ? t +
        ":" +
        r.toString().padStart(2, "0") +
        ":" +
        e.toString().padStart(2, "0")
    : r + ":" + e.toString().padStart(2, "0");
}
function Z(n, t = 0) {
  return (
    n.toLocaleString("en-US", {
      minimumFractionDigits: t,
      maximumFractionDigits: t,
    }) + " km"
  );
}
function q(n) {
  return Math.round(n * 3.28084).toLocaleString("en-US") + " ft";
}
function G(n) {
  return Math.round(n).toLocaleString("en-US") + " kt";
}
function J(n) {
  return n <= 4
    ? "z0_4"
    : n <= 7
      ? "z5_7"
      : n <= 10
        ? "z8_10"
        : n <= 13
          ? "z11_13"
          : "z14_plus";
}
function Q(n, t, r) {
  let e = (n - t) / Math.max(r - t, 1);
  e = Math.max(0, Math.min(1, e));
  let a, o, i;
  if (e < 0.2) {
    let s = e / 0.2;
    ((a = Math.round(80 * (1 - s))), (o = Math.round(160 + 95 * s)), (i = 255));
  } else if (e < 0.4) {
    let s = (e - 0.2) / 0.2;
    ((a = 0), (o = 255), (i = Math.round(255 * (1 - s))));
  } else if (e < 0.6) {
    let s = (e - 0.4) / 0.2;
    ((a = Math.round(255 * s)), (o = 255), (i = 0));
  } else if (e < 0.8) {
    let s = (e - 0.6) / 0.2;
    ((a = 255), (o = Math.round(255 * (1 - s * 0.35))), (i = 0));
  } else {
    let s = (e - 0.8) / 0.2;
    ((a = 255),
      (o = Math.round(165 * (1 - s * 0.6))),
      (i = Math.round(66 * s)));
  }
  return "rgb(" + a + "," + o + "," + i + ")";
}
function X(n, t, r) {
  let e = (n - t) / Math.max(r - t, 1);
  e = Math.max(0, Math.min(1, e));
  let a, o, i;
  if (e < 0.2) {
    let s = e / 0.2;
    ((a = 0), (o = Math.round(128 + 127 * s)), (i = 255));
  } else if (e < 0.4) {
    let s = (e - 0.2) / 0.2;
    ((a = 0), (o = 255), (i = Math.round(255 * (1 - s))));
  } else if (e < 0.6) {
    let s = (e - 0.4) / 0.2;
    ((a = Math.round(255 * s)), (o = 255), (i = 0));
  } else if (e < 0.8) {
    let s = (e - 0.6) / 0.2;
    ((a = 255), (o = Math.round(255 * (1 - s * 0.5))), (i = 0));
  } else {
    let s = (e - 0.8) / 0.2;
    ((a = 255), (o = Math.round(128 * (1 - s))), (i = 0));
  }
  return "rgb(" + a + "," + o + "," + i + ")";
}
function tt(n) {
  let t;
  if (
    (typeof n == "string" ? (t = new URLSearchParams(n)) : (t = n),
    t.toString() === "")
  )
    return null;
  let r = {};
  if (t.has("y")) {
    let e = t.get("y");
    e && (r.selectedYear = e);
  }
  if (t.has("a")) {
    let e = t.get("a");
    e && (r.selectedAircraft = e);
  }
  if (t.has("p")) {
    let e = t.get("p");
    e &&
      (r.selectedPathIds = e
        .split(",")
        .filter((a) => a.trim().length > 0)
        .map((a) => parseInt(a, 10))
        .filter((a) => !isNaN(a)));
  }
  if (t.has("v")) {
    let e = t.get("v");
    e &&
      (e.length === 6 || e.length === 7 || e.length === 8) &&
      ((r.heatmapVisible = e[0] === "1"),
      (r.altitudeVisible = e[1] === "1"),
      (r.airspeedVisible = e[2] === "1"),
      (r.airportsVisible = e[3] === "1"),
      (r.aviationVisible = e[4] === "1"),
      (r.statsPanelVisible = e[5] === "1"),
      e.length >= 7 && (r.wrappedVisible = e[6] === "1"),
      e.length === 8 && (r.buttonsHidden = e[7] === "1"));
  }
  if (t.has("lat") && t.has("lng")) {
    let e = t.get("lat"),
      a = t.get("lng");
    if (e && a) {
      let o = parseFloat(e),
        i = parseFloat(a);
      !isNaN(o) &&
        !isNaN(i) &&
        o >= -90 &&
        o <= 90 &&
        i >= -180 &&
        i <= 180 &&
        (r.center = { lat: o, lng: i });
    }
  }
  if (t.has("z")) {
    let e = t.get("z");
    if (e) {
      let a = parseFloat(e);
      isNaN(a) || (r.zoom = Math.max(1, Math.min(18, a)));
    }
  }
  return r;
}
function et(n) {
  let t = new URLSearchParams();
  if (
    (n.selectedYear && t.set("y", n.selectedYear),
    n.selectedAircraft &&
      n.selectedAircraft !== "all" &&
      t.set("a", n.selectedAircraft),
    n.selectedPathIds &&
      n.selectedPathIds.length > 0 &&
      t.set("p", n.selectedPathIds.join(",")),
    n.heatmapVisible !== void 0 ||
      n.altitudeVisible !== void 0 ||
      n.airspeedVisible !== void 0 ||
      n.airportsVisible !== void 0 ||
      n.aviationVisible !== void 0 ||
      n.statsPanelVisible !== void 0 ||
      n.wrappedVisible !== void 0 ||
      n.buttonsHidden !== void 0)
  ) {
    let e = [
      n.heatmapVisible ? "1" : "0",
      n.altitudeVisible ? "1" : "0",
      n.airspeedVisible ? "1" : "0",
      n.airportsVisible ? "1" : "0",
      n.aviationVisible ? "1" : "0",
      n.statsPanelVisible ? "1" : "0",
      n.wrappedVisible ? "1" : "0",
      n.buttonsHidden ? "1" : "0",
    ].join("");
    e !== "10010000" && t.set("v", e);
  }
  return (
    n.center &&
      (t.set("lat", n.center.lat.toFixed(6)),
      t.set("lng", n.center.lng.toFixed(6))),
    n.zoom !== void 0 && t.set("z", n.zoom.toFixed(2)),
    t.toString()
  );
}
function nt() {
  return {
    selectedYear: "all",
    selectedAircraft: "all",
    selectedPathIds: [],
    heatmapVisible: !0,
    altitudeVisible: !1,
    airspeedVisible: !1,
    airportsVisible: !0,
    aviationVisible: !1,
    statsPanelVisible: !1,
    wrappedVisible: !1,
    buttonsHidden: !1,
  };
}
function rt(n, t) {
  return t ? { ...n, ...t } : { ...n };
}
function I(n, t, r) {
  return n.filter(function (e) {
    return !(
      (t !== "all" && (!e.year || e.year.toString() !== t)) ||
      (r !== "all" &&
        (!e.aircraft_registration || e.aircraft_registration !== r))
    );
  });
}
function L(n) {
  let t = new Set();
  return (
    n.forEach(function (r) {
      (r.start_airport && t.add(r.start_airport),
        r.end_airport && t.add(r.end_airport));
    }),
    t
  );
}
function V(n) {
  let t = {};
  return (
    n.forEach(function (r) {
      if (r.aircraft_registration) {
        let e = r.aircraft_registration;
        (t[e] ||
          (t[e] = { registration: e, type: r.aircraft_type, flights: 0 }),
          (t[e].flights += 1));
      }
    }),
    Object.values(t).sort(function (r, e) {
      return e.flights - r.flights;
    })
  );
}
function D(n, t) {
  let r = new Set(t.map((e) => e.id));
  return n.filter(function (e) {
    return r.has(e.path_id);
  });
}
function z(n) {
  let t = 0;
  return (
    n.forEach(function (r) {
      let e = r.coords;
      if (e && e.length === 2) {
        let a = x(e[0], e[1]);
        t += a;
      }
    }),
    t
  );
}
function E(n) {
  let t = n.map((i) => i.altitude_m).filter((i) => i !== void 0);
  if (t.length === 0) return { min: 0, max: 0, gain: 0 };
  let r = t[0],
    e = t[0];
  for (let i = 1; i < t.length; i++)
    (t[i] < r && (r = t[i]), t[i] > e && (e = t[i]));
  let a = 0,
    o = null;
  return (
    n.forEach(function (i) {
      (i.altitude_m !== void 0 &&
        o !== null &&
        i.altitude_m > o &&
        (a += i.altitude_m - o),
        i.altitude_m !== void 0 && (o = i.altitude_m));
    }),
    { min: r, max: e, gain: a }
  );
}
function $(n) {
  let t = n
    .map((o) => o.groundspeed_knots)
    .filter((o) => o !== void 0 && o > 0);
  if (t.length === 0) return { max: 0, avg: 0 };
  let r = t[0],
    e = 0;
  for (let o = 0; o < t.length; o++) (t[o] > r && (r = t[o]), (e += t[o]));
  let a = e / t.length;
  return { max: r, avg: a };
}
function B(n) {
  let t = {};
  n.forEach(function (a) {
    let o = a.coords;
    if (o && o.length === 2) {
      let i = x(o[0], o[1]);
      (t[a.path_id] || (t[a.path_id] = 0), (t[a.path_id] += i));
    }
  });
  let r = Object.values(t);
  if (r.length === 0) return 0;
  let e = r[0];
  for (let a = 1; a < r.length; a++) r[a] > e && (e = r[a]);
  return e;
}
function M(n, t) {
  let r = 0;
  return (
    new Set(t.map((a) => a.id)).forEach(function (a) {
      let o = n.filter(
        (i) => i.path_id === a && i.time !== void 0 && i.time !== null
      );
      if (o.length > 0) {
        let i = o.map((c) => c.time),
          s = i[0],
          l = i[0];
        for (let c = 1; c < i.length; c++)
          (i[c] < s && (s = i[c]), i[c] > l && (l = i[c]));
        r += l - s;
      }
    }),
    r
  );
}
function it(n) {
  let { pathInfo: t, segments: r, year: e = "all", aircraft: a = "all" } = n;
  if (!t || !r)
    return {
      total_points: 0,
      num_paths: 0,
      num_airports: 0,
      airport_names: [],
      num_aircraft: 0,
      aircraft_list: [],
      total_distance_nm: 0,
      total_distance_km: 0,
    };
  let o = I(t, e, a);
  if (o.length === 0)
    return {
      total_points: 0,
      num_paths: 0,
      num_airports: 0,
      airport_names: [],
      num_aircraft: 0,
      aircraft_list: [],
      total_distance_nm: 0,
      total_distance_km: 0,
    };
  let i = L(o),
    s = V(o),
    l = D(r, o),
    c = z(l),
    u = E(l),
    m = $(l),
    _ = B(l),
    h = M(l, o),
    R = u.max !== void 0 ? u.max * 3.28084 : void 0,
    f = u.min !== void 0 ? u.min * 3.28084 : void 0,
    d = u.gain !== void 0 ? u.gain * 3.28084 : void 0,
    T = _ !== void 0 ? _ * 0.539957 : void 0,
    v = (g) => {
      let b = Math.floor(g / 3600),
        p = Math.floor((g % 3600) / 60);
      return `${b}h ${p}m`;
    },
    A = h > 0 ? v(h) : void 0,
    S = l.filter(
      (g) =>
        g.altitude_m &&
        g.altitude_m > 304.8 &&
        g.groundspeed_knots &&
        g.groundspeed_knots > 0
    ),
    O;
  if (S.length > 0) {
    let g = 0,
      b = 0;
    (S.forEach((p) => {
      if (
        p.coords &&
        p.coords.length === 2 &&
        p.groundspeed_knots &&
        p.groundspeed_knots > 0
      ) {
        let P = x(p.coords[0], p.coords[1]) * 0.539957,
          Tt = P / p.groundspeed_knots;
        ((g += P), (b += Tt));
      }
    }),
      (O = b > 0 ? g / b : void 0));
  }
  let C, j;
  if (S.length > 0) {
    let g = {};
    S.forEach((p) => {
      if (p.altitude_m) {
        let F = p.altitude_m * 3.28084,
          P = Math.round(F / 100) * 100;
        g[P] = (g[P] || 0) + 1;
      }
    });
    let b = Object.entries(g).sort((p, F) => F[1] - p[1])[0];
    b && ((C = Number(b[0])), (j = C / 3.28084));
  }
  return {
    total_points: l.length * 2,
    num_paths: o.length,
    num_airports: i.size,
    airport_names: Array.from(i),
    num_aircraft: s.length,
    aircraft_list: s,
    total_distance_km: c,
    total_distance_nm: c * 0.539957,
    max_altitude_m: u.max,
    min_altitude_m: u.min,
    total_altitude_gain_m: u.gain,
    max_altitude_ft: R,
    min_altitude_ft: f,
    total_altitude_gain_ft: d,
    max_groundspeed_knots: m.max,
    avg_groundspeed_knots: m.avg,
    average_groundspeed_knots: m.avg,
    cruise_speed_knots: O,
    longest_flight_km: _,
    longest_flight_nm: T,
    total_flight_time_seconds: h,
    total_flight_time_str: A,
    most_common_cruise_altitude_ft: C,
    most_common_cruise_altitude_m: j,
  };
}
function Ct(n) {
  return new Promise((t, r) => {
    let e = document.createElement("script");
    ((e.src = n),
      (e.onload = () => t()),
      (e.onerror = () => r(new Error("Failed to load script: " + n))),
      document.head.appendChild(e));
  });
}
function It(n, t) {
  let r = {
    coordinates: [],
    path_segments: [],
    path_info: [],
    resolution: t,
    original_points: 0,
    downsampled_points: 0,
    compression_ratio: 100,
  };
  return (
    n.forEach((e) => {
      e &&
        (e.coordinates && (r.coordinates = r.coordinates.concat(e.coordinates)),
        e.path_segments &&
          (r.path_segments = r.path_segments.concat(e.path_segments)),
        e.path_info && (r.path_info = r.path_info.concat(e.path_info)),
        (r.original_points += e.original_points || 0),
        (r.downsampled_points += e.downsampled_points || 0));
    }),
    (r.compression_ratio =
      r.original_points > 0
        ? (r.downsampled_points / r.original_points) * 100
        : 100),
    r
  );
}
function Vt(n, t) {
  return "KML_DATA_" + n + "_" + t.toUpperCase().replace(/-/g, "_");
}
function K(n, t) {
  return n + "_" + t;
}
var k = class {
  constructor(t = {}) {
    ((this.dataDir = t.dataDir || "data"),
      (this.cache = {}),
      (this.scriptLoader = t.scriptLoader || Ct),
      (this.showLoading = t.showLoading || (() => {})),
      (this.hideLoading = t.hideLoading || (() => {})),
      (this.getWindow = t.getWindow || (() => window)));
  }
  async loadData(t, r = "all") {
    let e = K(t, r);
    if (this.cache[e]) return this.cache[e];
    if (r === "all") return await this.loadAndCombineAllYears(t);
    this.showLoading();
    try {
      let a = Vt(r, t),
        o = this.getWindow();
      if (!o[a]) {
        console.log(
          "Loading " +
            t +
            " (" +
            r +
            ")... (this may take a moment for large datasets)"
        );
        let s = this.dataDir + "/" + r + "/" + t + ".js";
        await this.scriptLoader(s);
      }
      let i = o[a];
      return (
        (this.cache[e] = i),
        console.log(
          "\u2713 Loaded " + t + " (" + r + "):",
          i.downsampled_points + " points"
        ),
        i
      );
    } catch (a) {
      return (console.error("Error loading data for year " + r + ":", a), null);
    } finally {
      this.hideLoading();
    }
  }
  async loadAndCombineAllYears(t) {
    let r = K(t, "all");
    if (this.cache[r]) return this.cache[r];
    this.showLoading();
    try {
      let e = await this.loadMetadata();
      if (!e || !e.available_years)
        return (console.error("No metadata or available years found"), null);
      console.log("Loading all years for " + t + ":", e.available_years);
      let a = e.available_years.map((s) => this.loadData(t, s.toString())),
        o = await Promise.all(a),
        i = It(o, t);
      return (
        (this.cache[r] = i),
        console.log(
          "Combined all years for " + t + ":",
          i.downsampled_points + " points"
        ),
        i
      );
    } catch (e) {
      return (console.error("Error loading and combining all years:", e), null);
    } finally {
      this.hideLoading();
    }
  }
  async loadAirports() {
    try {
      let t = this.getWindow();
      return (
        t.KML_AIRPORTS ||
          (await this.scriptLoader(this.dataDir + "/airports.js")),
        t.KML_AIRPORTS?.airports || []
      );
    } catch (t) {
      return (console.error("Error loading airports:", t), []);
    }
  }
  async loadMetadata() {
    try {
      let t = this.getWindow();
      return (
        t.KML_METADATA ||
          (await this.scriptLoader(this.dataDir + "/metadata.js")),
        t.KML_METADATA || null
      );
    } catch (t) {
      return (console.error("Error loading metadata:", t), null);
    }
  }
  clearCache() {
    this.cache = {};
  }
  isCached(t, r) {
    return K(t, r) in this.cache;
  }
};
function ot(n, t = "all", r = "all") {
  if (!n) return {};
  let e = {};
  return (
    n
      .filter(function (o) {
        return !(
          (t !== "all" && (!o.year || o.year.toString() !== t)) ||
          (r !== "all" &&
            (!o.aircraft_registration || o.aircraft_registration !== r))
        );
      })
      .forEach(function (o) {
        let i = new Set();
        (o.start_airport && i.add(o.start_airport),
          o.end_airport && i.add(o.end_airport),
          i.forEach(function (s) {
            e[s] = (e[s] || 0) + 1;
          }));
      }),
    e
  );
}
function at(n) {
  let t = null,
    r = 0;
  return (
    Object.keys(n).forEach(function (e) {
      n[e] > r && ((r = n[e]), (t = e));
    }),
    t
  );
}
function st(n, t, r) {
  let e = w(n.lat, !0),
    a = w(n.lon, !1),
    o = `https://www.google.com/maps?q=${n.lat},${n.lon}`;
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
            <span>${n.name || "Unknown"}</span>
            ${r ? '<span style="font-size: 12px; background: #007bff; color: white; padding: 2px 6px; border-radius: 3px; margin-left: 4px;">HOME</span>' : ""}
        </div>
        <div style="margin-bottom: 8px;">
            <div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Coordinates</div>
            <a href="${o}"
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
                <span>${e}<br>${a}</span>
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
            <span style="font-size: 16px; font-weight: bold; color: #4facfe;">${t}</span>
        </div>
    </div>`;
}
function lt(n, t) {
  if (t === 0) return 1;
  let r = 0.3,
    e = 1,
    a = n / t;
  return r + a * (e - r);
}
function ct(n, t, r = {}) {
  let e = r.minSize || 3,
    a = r.maxSize || 8;
  if (t === 0) return e;
  let o = n / t;
  return e + o * (a - e);
}
function ut(n) {
  let {
      airportCounts: t,
      selectedYear: r = "all",
      selectedAircraft: e = "all",
      selectedPathIds: a = new Set(),
      pathToAirports: o = {},
    } = n,
    i = r !== "all" || e !== "all",
    s = a.size > 0,
    l = new Set();
  s &&
    a.forEach((u) => {
      let m = o[u];
      m && (m.start && l.add(m.start), m.end && l.add(m.end));
    });
  let c = {};
  return (
    Object.keys(t).forEach((u) => {
      let m = t[u] || 0;
      s
        ? (c[u] = { show: !0, opacity: l.has(u) ? 1 : 0.2 })
        : i
          ? (c[u] = { show: m > 0, opacity: 1 })
          : (c[u] = { show: !0, opacity: 1 });
    }),
    c
  );
}
function N(n, t = null) {
  let r = n;
  if (
    (t && t.size > 0 && (r = n.filter((i) => t.has(i.path_id))), r.length === 0)
  )
    return { min: 0, max: 1e4 };
  let e = r.map((i) => i.altitude_ft).filter((i) => i !== void 0);
  if (e.length === 0) return { min: 0, max: 1e4 };
  let a = e[0],
    o = e[0];
  for (let i = 1; i < e.length; i++)
    (e[i] < a && (a = e[i]), e[i] > o && (o = e[i]));
  return { min: a, max: o };
}
function Y(n, t = null) {
  let r = n;
  if (
    (t && t.size > 0 && (r = n.filter((i) => t.has(i.path_id))), r.length === 0)
  )
    return { min: 0, max: 200 };
  let e = r
    .map((i) => i.groundspeed_knots)
    .filter((i) => i !== void 0 && i > 0);
  if (e.length === 0) return { min: 0, max: 200 };
  let a = e[0],
    o = e[0];
  for (let i = 1; i < e.length; i++)
    (e[i] < a && (a = e[i]), e[i] > o && (o = e[i]));
  return { min: a, max: o };
}
function U(n, t, r = {}) {
  let { year: e = "all", aircraft: a = "all" } = r;
  return !(
    (e !== "all" && (!t || !t.year || t.year.toString() !== e)) ||
    (a !== "all" && (!t || t.aircraft_registration !== a))
  );
}
function ft(n, t = { pathId: 0 }) {
  let {
      pathId: r,
      selectedPathIds: e = new Set(),
      hasSelection: a = !1,
      colorFunction: o,
      colorMin: i = 0,
      colorMax: s = 0,
      value: l = 0,
    } = t,
    c = e.has(r);
  return {
    weight: c ? 6 : 4,
    opacity: c ? 1 : a ? 0.1 : 0.85,
    color: o ? o(l, i, s) : "#3388ff",
    isSelected: c,
  };
}
function mt(n, t) {
  return {
    min: Math.round(n).toLocaleString() + " ft",
    max: Math.round(t).toLocaleString() + " ft",
  };
}
function dt(n, t) {
  return { min: Math.round(n) + " kt", max: Math.round(t) + " kt" };
}
function gt(n, t, r = {}) {
  let e = new Map(t.map((a) => [a.id, a]));
  return n.filter((a) => {
    let o = e.get(a.path_id);
    return o ? U(a, o, r) : !1;
  });
}
function pt(n) {
  let t = new Map();
  return (
    n.forEach((r) => {
      let e = r.path_id;
      (t.has(e) || t.set(e, []), t.get(e).push(r));
    }),
    t
  );
}
function ht(n) {
  return {
    totalSegments: n.length,
    uniquePaths: new Set(n.map((t) => t.path_id)).size,
    altitudeRange: N(n),
    speedRange: Y(n),
  };
}
function _t(n, t) {
  return n
    .filter((e) => e.path_id === t && e.time !== void 0 && e.time !== null)
    .sort((e, a) => e.time - a.time);
}
function bt(n) {
  if (n.length === 0) return { min: 0, max: 0 };
  let t = n.map((a) => a.time),
    r = t[0],
    e = t[0];
  for (let a = 1; a < t.length; a++)
    (t[a] < r && (r = t[a]), t[a] > e && (e = t[a]));
  return { min: r, max: e };
}
function xt(n, t) {
  if (n.length === 0) return { current: null, next: null, index: -1 };
  let r = 0;
  for (let e = 0; e < n.length && n[e].time <= t; e++) r = e;
  return { current: n[r] || null, next: n[r + 1] || null, index: r };
}
function yt(n, t, r) {
  if (!t || !n.coords)
    return {
      lat: n.coords[1][0],
      lon: n.coords[1][1],
      altitude: n.altitude_ft || 0,
      speed: n.groundspeed_knots || 0,
    };
  let e = n.time,
    a = t.time,
    o = (r - e) / Math.max(a - e, 0.001),
    i = n.coords[1][0],
    s = n.coords[1][1],
    l = t.coords[0][0],
    c = t.coords[0][1];
  return {
    lat: i + (l - i) * o,
    lon: s + (c - s) * o,
    altitude:
      (n.altitude_ft || 0) + ((t.altitude_ft || 0) - (n.altitude_ft || 0)) * o,
    speed:
      (n.groundspeed_knots || 0) +
      ((t.groundspeed_knots || 0) - (n.groundspeed_knots || 0)) * o,
  };
}
function St(n, t, r = 5) {
  if (t < 0 || t >= n.length) return null;
  let e = n[t],
    a = Math.min(t + r, n.length - 1),
    o = n[a];
  if (t === a) {
    let i = e.coords;
    return i && i.length === 2 ? y(i[0][0], i[0][1], i[1][0], i[1][1]) : null;
  }
  return !e.coords || !o.coords
    ? null
    : y(e.coords[1][0], e.coords[1][1], o.coords[0][0], o.coords[0][1]);
}
function Mt(n, t, r = {}) {
  let {
      minZoom: e = 10,
      maxZoom: a = 16,
      cruiseAltitude: o = 5e3,
      cruiseSpeed: i = 100,
    } = r,
    s = Math.min(n / o, 2),
    l = Math.min(t / i, 2),
    c = (s + l) / 2,
    u = a - (c * (a - e)) / 2;
  return Math.max(e, Math.min(a, Math.round(u)));
}
function At(n, t, r = 0.2) {
  let e = t.north - t.south,
    a = t.east - t.west,
    o = e * r,
    i = a * r;
  return (
    n.lat < t.south + o ||
    n.lat > t.north - o ||
    n.lon < t.west + i ||
    n.lon > t.east - i
  );
}
function Pt(n, t) {
  return t === 0 ? 0 : Math.min(100, (n / t) * 100);
}
function wt(n) {
  return !n || n.length === 0
    ? { valid: !1, message: "No segments available for replay" }
    : n.filter((r) => r.time !== void 0 && r.time !== null).length === 0
      ? {
          valid: !1,
          message:
            "No timestamp data available. The flight may not have timing information.",
        }
      : { valid: !0, message: "Replay data is valid" };
}
function Lt(n) {
  let t = Math.floor(n / 3600),
    r = Math.floor((n % 3600) / 60);
  return `${t}h ${r}m`;
}
function vt(n, t, r, e = null) {
  if (!n || n.length === 0)
    return {
      total_flights: 0,
      total_distance_nm: 0,
      num_airports: 0,
      airport_names: [],
      flight_time: "0h 0m",
      aircraft_list: [],
    };
  let a = r === "all" ? "all" : Number(r),
    o = a === "all" ? n : n.filter((f) => f.year === a);
  if (o.length === 0)
    return {
      total_flights: 0,
      total_distance_nm: 0,
      num_airports: 0,
      airport_names: [],
      flight_time: "0h 0m",
      aircraft_list: [],
    };
  let i = L(o),
    s = Array.from(i),
    l = D(t, o),
    c = 0;
  l.forEach((f) => {
    if (f.coords && f.coords.length === 2) {
      let d = x(f.coords[0], f.coords[1]);
      c += d;
    }
  });
  let u = c * 0.539957,
    m = M(l, o),
    _ = Lt(m),
    h = {};
  (o.forEach((f) => {
    if (f.aircraft_registration) {
      let d = f.aircraft_registration;
      (h[d] ||
        (h[d] = {
          registration: d,
          type: f.aircraft_type,
          flights: 0,
          flight_time_seconds: 0,
        }),
        (h[d].flights += 1));
    }
  }),
    Object.keys(h).forEach((f) => {
      let d = o.filter((S) => S.aircraft_registration === f),
        T = D(t, d),
        v = M(T, d),
        A = h[f];
      A && ((A.flight_time_seconds = v), (A.flight_time_str = Lt(v)));
    }),
    e &&
      e.aircraft_list &&
      e.aircraft_list.forEach((f) => {
        let d = h[f.registration];
        d && (d.model = f.model);
      }));
  let R = Object.values(h).sort((f, d) => d.flights - f.flights);
  return {
    total_flights: o.length,
    total_distance_nm: u,
    num_airports: i.size,
    airport_names: s,
    flight_time: _,
    aircraft_list: R,
  };
}
function Ft(n, t = null) {
  let r = [],
    e = n.total_distance_nm,
    a = 21639;
  if (e > a * 0.5) {
    let i = (e / a).toFixed(1);
    r.push({
      icon: "\u{1F30D}",
      text: `You flew <strong>${i}x</strong> around the Earth!`,
      category: "distance",
      priority: 10,
    });
  } else
    e > 1e3 &&
      r.push({
        icon: "\u2708\uFE0F",
        text: `You covered <strong>${Math.round(e)} nautical miles</strong> this year!`,
        category: "distance",
        priority: 8,
      });
  let o = n.aircraft_list.length;
  if (o === 1) {
    let i = n.aircraft_list[0],
      s = i?.model || i?.type || i?.registration || "Unknown",
      l = n.total_flights,
      c = i?.registration || "";
    c
      ? r.push({
          icon: "\u2708\uFE0F",
          text: `Loyal to <strong>${c}</strong> - all ${l} flight${l !== 1 ? "s" : ""} in this ${s}!`,
          category: "aircraft",
          priority: 9,
        })
      : r.push({
          icon: "\u{1F499}",
          text: `Loyal to one aircraft: ${s}`,
          category: "aircraft",
          priority: 7,
        });
  } else
    o === 2
      ? r.push({
          icon: "\u2708\uFE0F",
          text: `You flew <strong>${o} different aircraft</strong> this year.`,
          category: "aircraft",
          priority: 7,
        })
      : o >= 3 &&
        r.push({
          icon: "\u{1F6E9}\uFE0F",
          text: `Aircraft explorer! You flew <strong>${o} different aircraft</strong>.`,
          category: "aircraft",
          priority: 8,
        });
  if (n.total_flights > 0 && e > 0) {
    let i = Math.round(e / n.total_flights);
    i > 0 &&
      r.push({
        icon: "\u2708\uFE0F",
        text: `Cruising at <strong>${t?.cruise_speed_knots ? Math.round(t.cruise_speed_knots) : "?"} kt</strong>, averaging <strong>${i} nm</strong> per adventure`,
        category: "distance",
        priority: 8,
      });
  }
  if (t) {
    if (t.longest_flight_nm && t.longest_flight_nm > 0) {
      let i = Math.round(t.longest_flight_nm);
      r.push({
        icon: "\u{1F6EB}",
        text: `Your longest journey: <strong>${i} nm</strong> - that's Berlin to Munich distance!`,
        category: "distance",
        priority: 8,
      });
    }
    if (t.total_altitude_gain_ft) {
      let i = Math.round(t.total_altitude_gain_ft);
      r.push({
        icon: "\u2B06\uFE0F",
        text: `Total elevation gain: <strong>${i.toLocaleString()} ft</strong>`,
        category: "altitude",
        priority: 8,
      });
      let s = 29029;
      if (t.total_altitude_gain_ft > s) {
        let l = (t.total_altitude_gain_ft / s).toFixed(1);
        r.push({
          icon: "\u{1F3D4}\uFE0F",
          text: `You climbed <strong>${l}x</strong> Mount Everest in altitude!`,
          category: "altitude",
          priority: 9,
        });
      }
    }
    if (t.most_common_cruise_altitude_ft && t.most_common_cruise_altitude_m) {
      let i = Math.round(t.most_common_cruise_altitude_ft),
        s = Math.round(t.most_common_cruise_altitude_m);
      r.push({
        icon: "\u2B06\uFE0F",
        text: `Most common cruise: <strong>${i.toLocaleString()} ft</strong> AGL (<strong>${s.toLocaleString()} m</strong>)`,
        category: "altitude",
        priority: 7,
      });
    }
    if (t.total_flight_time_seconds) {
      let i = Math.floor(t.total_flight_time_seconds / 3600);
      r.push({
        icon: "\u23F1\uFE0F",
        text: `Total flight time: <strong>${i} hours</strong> in the air!`,
        category: "time",
        priority: 4,
      });
    }
    (t.cruise_speed_knots &&
      r.push({
        icon: "\u26A1",
        text: `Average cruise speed: <strong>${Math.round(t.cruise_speed_knots)} knots</strong>`,
        category: "speed",
        priority: 3,
      }),
      t.max_altitude_ft &&
        t.max_altitude_ft > 4e4 &&
        r.push({
          icon: "\u{1F680}",
          text: `High altitude achievement: <strong>${Math.round(t.max_altitude_ft)} feet</strong>!`,
          category: "achievement",
          priority: 9,
        }));
  }
  return H(r);
}
function H(n) {
  if (n.length === 0) return [];
  let t = [...n].sort((s, l) => l.priority - s.priority),
    r = [],
    e = {},
    a = 3,
    o = 4,
    i = 6;
  for (let s of t) {
    let l = e[s.category] || 0;
    if ((l < a && (r.push(s), (e[s.category] = l + 1)), r.length >= i)) break;
  }
  if (r.length < o && n.length >= o) {
    for (let s of t) if (!r.includes(s) && (r.push(s), r.length >= o)) break;
  }
  return r;
}
function Dt(n, t, r) {
  if (t === r) return "fleet-aircraft-high";
  let e = (n - r) / (t - r);
  return e >= 0.75
    ? "fleet-aircraft-high"
    : e >= 0.5
      ? "fleet-aircraft-medium-high"
      : e >= 0.25
        ? "fleet-aircraft-medium-low"
        : "fleet-aircraft-low";
}
function kt(n, t) {
  if (!n || n.length === 0) return null;
  let r = 0,
    e = "";
  return (
    n.forEach((a) => {
      let o = t[a] || 0;
      o > r && ((r = o), (e = a));
    }),
    e ? { name: e, flight_count: r } : null
  );
}
function Rt(n, t) {
  return n ? (t ? n.filter((r) => r !== t) : n) : [];
}
typeof window < "u" &&
  (window.KMLHeatmap = {
    calculateDistance: x,
    calculateBearing: y,
    ddToDms: w,
    formatTime: W,
    formatDistance: Z,
    formatAltitude: q,
    formatSpeed: G,
    getResolutionForZoom: J,
    getColorForAltitude: Q,
    getColorForAirspeed: X,
    parseUrlParams: tt,
    encodeStateToUrl: et,
    getDefaultState: nt,
    mergeState: rt,
    filterPaths: I,
    collectAirports: L,
    aggregateAircraft: V,
    calculateTotalDistance: z,
    calculateAltitudeStats: E,
    calculateSpeedStats: $,
    calculateLongestFlight: B,
    calculateFlightTime: M,
    calculateFilteredStatistics: it,
    DataLoader: k,
    calculateAirportFlightCounts: ot,
    findHomeBase: at,
    generateAirportPopup: st,
    calculateAirportOpacity: lt,
    calculateAirportMarkerSize: ct,
    calculateAirportVisibility: ut,
    calculateAltitudeRange: N,
    calculateAirspeedRange: Y,
    shouldRenderSegment: U,
    calculateSegmentProperties: ft,
    formatAltitudeLegendLabels: mt,
    formatAirspeedLegendLabels: dt,
    filterSegmentsForRendering: gt,
    groupSegmentsByPath: pt,
    calculateLayerStats: ht,
    prepareReplaySegments: _t,
    calculateTimeRange: bt,
    findSegmentsAtTime: xt,
    interpolatePosition: yt,
    calculateSmoothedBearing: St,
    replayCalculateBearing: y,
    calculateAutoZoom: Mt,
    shouldRecenter: At,
    calculateReplayProgress: Pt,
    validateReplayData: wt,
    calculateYearStats: vt,
    generateFunFacts: Ft,
    selectDiverseFacts: H,
    calculateAircraftColorClass: Dt,
    wrappedFindHomeBase: kt,
    getDestinations: Rt,
  });
export {
  k as DataLoader,
  V as aggregateAircraft,
  Dt as calculateAircraftColorClass,
  ot as calculateAirportFlightCounts,
  ct as calculateAirportMarkerSize,
  lt as calculateAirportOpacity,
  ut as calculateAirportVisibility,
  Y as calculateAirspeedRange,
  N as calculateAltitudeRange,
  E as calculateAltitudeStats,
  Mt as calculateAutoZoom,
  y as calculateBearing,
  x as calculateDistance,
  it as calculateFilteredStatistics,
  M as calculateFlightTime,
  ht as calculateLayerStats,
  B as calculateLongestFlight,
  Pt as calculateReplayProgress,
  ft as calculateSegmentProperties,
  St as calculateSmoothedBearing,
  $ as calculateSpeedStats,
  bt as calculateTimeRange,
  z as calculateTotalDistance,
  vt as calculateYearStats,
  L as collectAirports,
  w as ddToDms,
  et as encodeStateToUrl,
  I as filterPaths,
  gt as filterSegmentsForRendering,
  at as findHomeBase,
  xt as findSegmentsAtTime,
  dt as formatAirspeedLegendLabels,
  q as formatAltitude,
  mt as formatAltitudeLegendLabels,
  Z as formatDistance,
  G as formatSpeed,
  W as formatTime,
  st as generateAirportPopup,
  Ft as generateFunFacts,
  X as getColorForAirspeed,
  Q as getColorForAltitude,
  nt as getDefaultState,
  Rt as getDestinations,
  J as getResolutionForZoom,
  pt as groupSegmentsByPath,
  yt as interpolatePosition,
  rt as mergeState,
  tt as parseUrlParams,
  _t as prepareReplaySegments,
  y as replayCalculateBearing,
  H as selectDiverseFacts,
  At as shouldRecenter,
  U as shouldRenderSegment,
  wt as validateReplayData,
  kt as wrappedFindHomeBase,
};
