// Configuration - will be injected by template
const CENTER = [{{center_lat}}, {{center_lon}}];
const BOUNDS = [[{{min_lat}}, {{min_lon}}], [{{max_lat}}, {{max_lon}}]];
const STADIA_API_KEY = '{{STADIA_API_KEY}}';
const OPENAIP_API_KEY = '{{OPENAIP_API_KEY}}';
const DATA_DIR = '{{data_dir_name}}';

// Filter state - must be declared before restoration code
var selectedYear = 'all';
var selectedAircraft = 'all';
var allAirportsData = [];

// Convert decimal degrees to degrees, minutes, seconds
function ddToDms(dd, isLat) {
    const direction = dd >= 0 ? (isLat ? 'N' : 'E') : (isLat ? 'S' : 'W');
    dd = Math.abs(dd);
    const degrees = Math.floor(dd);
    const minutes = Math.floor((dd - degrees) * 60);
    const seconds = ((dd - degrees) * 60 - minutes) * 60;
    return degrees + "°" + minutes + "'" + seconds.toFixed(1) + '"' + direction;
}

// State persistence functions
function saveMapState() {
    const state = {
        center: map.getCenter(),
        zoom: map.getZoom(),
        heatmapVisible: heatmapVisible,
        altitudeVisible: altitudeVisible,
        airspeedVisible: airspeedVisible,
        airportsVisible: airportsVisible,
        aviationVisible: aviationVisible,
        selectedYear: selectedYear,
        selectedAircraft: selectedAircraft,
        selectedPathIds: Array.from(selectedPathIds),
        statsPanelVisible: document.getElementById('stats-panel').classList.contains('visible')
        // Note: replay state is NOT persisted - too complex to restore reliably
    };
    try {
        localStorage.setItem('kml-heatmap-state', JSON.stringify(state));
    } catch (e) {
        // Silently fail if localStorage is not available
    }
}

function loadMapState() {
    try {
        const saved = localStorage.getItem('kml-heatmap-state');
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        // Silently fail if localStorage is not available or data is corrupt
    }
    return null;
}

// Initialize map
var map = L.map('map', {
    center: CENTER,
    zoom: 10,
    zoomSnap: 0.25,
    zoomDelta: 0.25,
    wheelPxPerZoomLevel: 120,  // 2 scrolls = 1 zoom level (matches button steps)
    preferCanvas: true  // Use canvas for better performance
});

// Add tile layer
if (STADIA_API_KEY) {
    L.tileLayer(
        'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=' + STADIA_API_KEY,
        {
            attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>'
        }
    ).addTo(map);
} else {
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors, &copy; CARTO'
    }).addTo(map);
}

// Restore saved state or fit bounds
const savedState = loadMapState();

// Track if we restored year from saved state (to distinguish from default 'all')
var restoredYearFromState = false;

// Restore filter state immediately to prevent it being overwritten by map events
if (savedState) {
    if (savedState.selectedYear !== undefined) {
        selectedYear = savedState.selectedYear;
        restoredYearFromState = true;
    }
    if (savedState.selectedAircraft) {
        selectedAircraft = savedState.selectedAircraft;
    }
}

if (savedState && savedState.center && savedState.zoom) {
    map.setView([savedState.center.lat, savedState.center.lng], savedState.zoom);
} else {
    map.fitBounds(BOUNDS, { padding: [30, 30] });
}

// NOTE: Map event handlers registered after async initialization completes
// to prevent premature state saving before filters are fully restored

// Use SVG renderer for better click detection reliability
// Canvas has known issues with event handling after layer updates
var altitudeRenderer = L.svg();
var airspeedRenderer = L.svg();

// Data layers
var heatmapLayer = null;
var altitudeLayer = L.layerGroup();
var airspeedLayer = L.layerGroup();
var airportLayer = L.layerGroup();
var currentResolution = null;
var loadedData = {};
var currentData = null;  // Store current loaded data for redrawing
var fullStats = null;  // Store original full statistics
var fullPathInfo = null;  // Store full resolution path_info for filtering
var fullPathSegments = null;  // Store full resolution path_segments for filtering
var altitudeRange = { min: 0, max: 10000 };  // Store altitude range for legend
var airspeedRange = { min: 0, max: 200 };  // Store airspeed range for legend

// Layer visibility state - restore from saved state or use defaults
var heatmapVisible = savedState && savedState.heatmapVisible !== undefined ? savedState.heatmapVisible : true;
var altitudeVisible = savedState && savedState.altitudeVisible !== undefined ? savedState.altitudeVisible : false;
var airspeedVisible = savedState && savedState.airspeedVisible !== undefined ? savedState.airspeedVisible : false;
var airportsVisible = savedState && savedState.airportsVisible !== undefined ? savedState.airportsVisible : true;
var aviationVisible = savedState && savedState.aviationVisible !== undefined ? savedState.aviationVisible : false;

// Track selection state
var selectedPathIds = new Set();  // Set of selected path IDs
var pathSegments = {};  // Map of path_id to array of polyline objects
var pathToAirports = {};  // Map of path_id to {start: name, end: name}
var airportToPaths = {};  // Map of airport name to array of path IDs
var airportMarkers = {};  // Map of airport name to marker object

// Replay state
var replayActive = false;
var replayPlaying = false;
var replayCurrentTime = 0;  // Current replay time in seconds
var replayMaxTime = 0;  // Maximum time in seconds
var replaySpeed = 50.0;  // Playback speed multiplier (default 50x)
var replayInterval = null;  // Interval for updating replay
var replayLayer = null;  // Layer for showing replay paths
var replaySegments = [];  // All segments sorted by time
var replayAirplaneMarker = null;  // Airplane icon marker
var replayLastDrawnIndex = -1;  // Track last drawn segment for incremental rendering
var replayLastBearing = null;  // Track last applied bearing to keep rotation stable when stationary
var replayAnimationFrameId = null;  // Track requestAnimationFrame ID for smooth 60fps updates
var replayLastFrameTime = null;  // Track last frame timestamp for accurate time progression
var replayColorMinAlt = 0;  // Min altitude for replay color scaling (selected path only)
var replayColorMaxAlt = 10000;  // Max altitude for replay color scaling (selected path only)
var replayColorMinSpeed = 0;  // Min groundspeed for replay color scaling (selected path only)
var replayColorMaxSpeed = 200;  // Max groundspeed for replay color scaling (selected path only)
var replayAutoZoom = false;  // Auto-zoom based on speed/altitude
var replayLastZoom = null;  // Track last zoom level to avoid redundant changes
var replayRecenterTimestamps = [];  // Track timestamps of recent recenters (sliding window)

// Button visibility state
var buttonsHidden = false;

// OpenAIP layer (if API key is provided)
// Note: As of May 2023, OpenAIP consolidated all layers into one "openaip" layer
var openaipLayers = {};
if (OPENAIP_API_KEY) {
    openaipLayers['Aviation Data'] = L.tileLayer(
        'https://{s}.api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.png?apiKey=' + OPENAIP_API_KEY,
        {
            attribution: '&copy; <a href="https://www.openaip.net">OpenAIP</a>',
            maxZoom: 18,
            minZoom: 7,
            subdomains: ['a', 'b', 'c']
        }
    );
}

// Add airports layer based on saved state
if (airportsVisible) {
    airportLayer.addTo(map);
}

// Set initial button states based on restored visibility
document.getElementById('heatmap-btn').style.opacity = heatmapVisible ? '1.0' : '0.5';
document.getElementById('altitude-btn').style.opacity = altitudeVisible ? '1.0' : '0.5';
document.getElementById('airspeed-btn').style.opacity = airspeedVisible ? '1.0' : '0.5';
document.getElementById('airports-btn').style.opacity = airportsVisible ? '1.0' : '0.5';
document.getElementById('aviation-btn').style.opacity = aviationVisible ? '1.0' : '0.5';

// Show aviation button if API key is available
if (OPENAIP_API_KEY) {
    document.getElementById('aviation-btn').style.display = 'block';
}

// Load data based on zoom level (5 resolution levels for smoother transitions)
function getResolutionForZoom(zoom) {
    if (zoom <= 4) return 'z0_4';
    if (zoom <= 7) return 'z5_7';
    if (zoom <= 10) return 'z8_10';
    if (zoom <= 13) return 'z11_13';
    return 'z14_plus';
}

function showLoading() {
    document.getElementById('loading').style.display = 'block';
}

function hideLoading() {
    document.getElementById('loading').style.display = 'none';
}

async function loadData(resolution, year) {
    // Use 'all' as default if year not specified
    if (!year) {
        year = selectedYear || 'all';
    }

    const cacheKey = resolution + '_' + year;
    if (loadedData[cacheKey]) {
        return loadedData[cacheKey];
    }

    // Handle 'all' years by combining all year files
    if (year === 'all') {
        return await loadAndCombineAllYears(resolution);
    }

    showLoading();
    try {
        const filename = DATA_DIR + '/' + year + '/' + resolution + '.json';
        const response = await fetch(filename);
        const data = await response.json();
        loadedData[cacheKey] = data;
        console.log('Loaded ' + resolution + ' (' + year + '):', data.downsampled_points + ' points');
        return data;
    } catch (error) {
        console.error('Error loading data for year ' + year + ':', error);
        return null;
    } finally {
        hideLoading();
    }
}

async function loadAndCombineAllYears(resolution) {
    const cacheKey = resolution + '_all';
    if (loadedData[cacheKey]) {
        return loadedData[cacheKey];
    }

    showLoading();
    try {
        // Get available years from metadata
        const metadata = await loadMetadata();
        if (!metadata || !metadata.available_years) {
            console.error('No metadata or available years found');
            return null;
        }

        console.log('Loading all years for ' + resolution + ':', metadata.available_years);

        // Load all year files in parallel
        const promises = metadata.available_years.map(year =>
            loadData(resolution, year.toString())
        );
        const yearDatasets = await Promise.all(promises);

        // Combine datasets
        const combined = {
            coordinates: [],
            path_segments: [],
            path_info: [],
            resolution: resolution,
            original_points: 0,
            downsampled_points: 0
        };

        yearDatasets.forEach(data => {
            if (!data) return;
            combined.coordinates.push(...data.coordinates);
            combined.path_segments.push(...data.path_segments);
            combined.path_info.push(...data.path_info);
            combined.original_points += data.original_points || 0;
            combined.downsampled_points += data.downsampled_points || 0;
        });

        combined.compression_ratio = combined.original_points > 0
            ? (combined.downsampled_points / combined.original_points * 100)
            : 100;

        loadedData[cacheKey] = combined;
        console.log('Combined all years for ' + resolution + ':', combined.downsampled_points + ' points');
        return combined;
    } catch (error) {
        console.error('Error loading and combining all years:', error);
        return null;
    } finally {
        hideLoading();
    }
}

async function loadAirports() {
    try {
        const response = await fetch(DATA_DIR + '/airports.json');
        const data = await response.json();
        return data.airports;
    } catch (error) {
        console.error('Error loading airports:', error);
        return [];
    }
}

// Calculate airport flight counts based on current filters
function calculateAirportFlightCounts() {
    if (!fullPathInfo) return {};

    var counts = {};
    var filteredPaths = fullPathInfo.filter(function(pathInfo) {
        // Apply year filter
        if (selectedYear !== 'all') {
            if (!pathInfo.year || pathInfo.year.toString() !== selectedYear) {
                return false;
            }
        }

        // Apply aircraft filter
        if (selectedAircraft !== 'all') {
            if (!pathInfo.aircraft_registration || pathInfo.aircraft_registration !== selectedAircraft) {
                return false;
            }
        }

        return true;
    });

    // Count unique airports per flight (avoid double-counting round trips)
    filteredPaths.forEach(function(pathInfo) {
        var uniqueAirports = new Set();
        if (pathInfo.start_airport) {
            uniqueAirports.add(pathInfo.start_airport);
        }
        if (pathInfo.end_airport) {
            uniqueAirports.add(pathInfo.end_airport);
        }
        // Increment count for each unique airport in this flight
        uniqueAirports.forEach(function(airport) {
            counts[airport] = (counts[airport] || 0) + 1;
        });
    });

    return counts;
}

// Update airport popup content with current filter-based counts
function updateAirportPopups() {
    if (!allAirportsData || !airportMarkers) return;

    var airportCounts = calculateAirportFlightCounts();

    // Find home base (airport with most flights in current filter)
    var homeBaseName = null;
    var maxCount = 0;
    Object.keys(airportCounts).forEach(function(name) {
        if (airportCounts[name] > maxCount) {
            maxCount = airportCounts[name];
            homeBaseName = name;
        }
    });

    // Update each airport marker's popup
    allAirportsData.forEach(function(airport) {
        var marker = airportMarkers[airport.name];
        if (!marker) return;

        var flightCount = airportCounts[airport.name] || 0;
        var isHomeBase = airport.name === homeBaseName;

        const icaoMatch = airport.name ? airport.name.match(/\b([A-Z]{4})\b/) : null;
        const icao = icaoMatch ? icaoMatch[1] : 'APT';
        const latDms = ddToDms(airport.lat, true);
        const lonDms = ddToDms(airport.lon, false);
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
                <span style="font-size: 18px;">🛫</span>
                <span>${airport.name || 'Unknown'}</span>
                ${isHomeBase ? '<span style="font-size: 12px; background: #007bff; color: white; padding: 2px 6px; border-radius: 3px; margin-left: 4px;">HOME</span>' : ''}
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
                    <span>📍</span>
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

        marker.setPopupContent(popup);
    });
}

async function loadMetadata() {
    try {
        const response = await fetch(DATA_DIR + '/metadata.json');
        return await response.json();
    } catch (error) {
        console.error('Error loading metadata:', error);
        return null;
    }
}

async function updateLayers() {
    const zoom = map.getZoom();
    const resolution = getResolutionForZoom(zoom);

    if (resolution === currentResolution) {
        return;
    }

    currentResolution = resolution;
    const data = await loadData(resolution, selectedYear);

    if (!data) return;

    currentData = data;  // Store for redrawing

    // Filter coordinates based on active filters
    var filteredCoordinates = data.coordinates;
    if ((selectedYear !== 'all' || selectedAircraft !== 'all') && data.path_segments) {
        // Get filtered path IDs
        var filteredPathIds = new Set();
        if (data.path_info) {
            data.path_info.forEach(function(pathInfo) {
                var matchesYear = selectedYear === 'all' || (pathInfo.year && pathInfo.year.toString() === selectedYear);
                var matchesAircraft = selectedAircraft === 'all' || (pathInfo.aircraft_registration === selectedAircraft);
                if (matchesYear && matchesAircraft) {
                    filteredPathIds.add(pathInfo.id);
                }
            });
        }

        // Extract coordinates from filtered segments
        var coordSet = new Set();
        data.path_segments.forEach(function(segment) {
            if (filteredPathIds.has(segment.path_id)) {
                var coords = segment.coords;
                if (coords && coords.length === 2) {
                    coordSet.add(JSON.stringify(coords[0]));
                    coordSet.add(JSON.stringify(coords[1]));
                }
            }
        });

        filteredCoordinates = Array.from(coordSet).map(function(str) {
            return JSON.parse(str);
        });
    }

    // Update heatmap - only add if visible
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
    }

    heatmapLayer = L.heatLayer(filteredCoordinates, {
        radius: 10,
        blur: 15,
        minOpacity: 0.25,
        maxOpacity: 0.6,
        max: 1.0,  // Maximum point intensity for better performance
        gradient: {
            0.0: 'blue',
            0.3: 'cyan',
            0.5: 'lime',
            0.7: 'yellow',
            1.0: 'red'
        }
    });

    // Make heatmap non-interactive so clicks pass through to paths
    if (heatmapLayer._canvas) {
        heatmapLayer._canvas.style.pointerEvents = 'none';
    }

    // Only add to map if heatmap is visible AND not in replay mode
    if (heatmapVisible && !replayActive) {
        heatmapLayer.addTo(map);
    }

    // Build path-to-airport relationships from path_info
    pathToAirports = {};
    airportToPaths = {};

    if (data.path_info) {
        data.path_info.forEach(function(pathInfo) {
            var pathId = pathInfo.id;

            // Store path-to-airport mapping
            pathToAirports[pathId] = {
                start: pathInfo.start_airport,
                end: pathInfo.end_airport
            };

            // Build reverse mapping: airport to paths
            if (pathInfo.start_airport) {
                if (!airportToPaths[pathInfo.start_airport]) {
                    airportToPaths[pathInfo.start_airport] = [];
                }
                airportToPaths[pathInfo.start_airport].push(pathId);
            }
            if (pathInfo.end_airport) {
                if (!airportToPaths[pathInfo.end_airport]) {
                    airportToPaths[pathInfo.end_airport] = [];
                }
                airportToPaths[pathInfo.end_airport].push(pathId);
            }
        });
    }

    // Calculate altitude range from all segments
    if (data.path_segments && data.path_segments.length > 0) {
        var altitudes = data.path_segments.map(function(s) { return s.altitude_ft; });
        altitudeRange.min = Math.min(...altitudes);
        altitudeRange.max = Math.max(...altitudes);
    }

    // Create altitude layer paths (this will also update the legend)
    redrawAltitudePaths();

    // Redraw airspeed paths if airspeed is visible
    if (airspeedVisible) {
        redrawAirspeedPaths();
    }

    console.log('Updated to ' + resolution + ' resolution');
}

function redrawAltitudePaths() {
    if (!currentData) return;

    // Clear altitude layer and path references
    altitudeLayer.clearLayers();
    pathSegments = {};

    // Calculate altitude range for color scaling
    var colorMinAlt, colorMaxAlt;
    if (selectedPathIds.size > 0) {
        // Use selected paths' altitude range
        var selectedSegments = currentData.path_segments.filter(function(segment) {
            return selectedPathIds.has(segment.path_id);
        });
        if (selectedSegments.length > 0) {
            var altitudes = selectedSegments.map(function(s) { return s.altitude_ft; });
            colorMinAlt = Math.min(...altitudes);
            colorMaxAlt = Math.max(...altitudes);
        } else {
            colorMinAlt = altitudeRange.min;
            colorMaxAlt = altitudeRange.max;
        }
    } else {
        // Use full altitude range
        colorMinAlt = altitudeRange.min;
        colorMaxAlt = altitudeRange.max;
    }

    // Create path segments with interactivity and rescaled colors
    currentData.path_segments.forEach(function(segment) {
        var pathId = segment.path_id;

        var pathInfo = currentData.path_info.find(function(p) { return p.id === pathId; });

        // Filter by year if selected
        if (selectedYear !== 'all') {
            if (pathInfo && pathInfo.year && pathInfo.year.toString() !== selectedYear) {
                return;  // Skip this segment
            }
        }

        // Filter by aircraft if selected
        if (selectedAircraft !== 'all') {
            if (pathInfo && pathInfo.aircraft_registration !== selectedAircraft) {
                return;  // Skip this segment
            }
        }

        var isSelected = selectedPathIds.has(pathId);

        // Recalculate color based on current altitude range
        var color = getColorForAltitude(segment.altitude_ft, colorMinAlt, colorMaxAlt);

        var polyline = L.polyline(segment.coords, {
            color: color,
            weight: isSelected ? 6 : 4,
            opacity: isSelected ? 1.0 : (selectedPathIds.size > 0 ? 0.1 : 0.85),
            renderer: altitudeRenderer,
            interactive: true
        }).bindPopup('Altitude: ' + segment.altitude_ft + ' ft (' + segment.altitude_m + ' m)')
          .addTo(altitudeLayer);

        // Make path clickable
        polyline.on('click', function(e) {
            L.DomEvent.stopPropagation(e);
            togglePathSelection(pathId);
        });

        // Store reference to polyline by path_id
        if (!pathSegments[pathId]) {
            pathSegments[pathId] = [];
        }
        pathSegments[pathId].push(polyline);
    });

    // Update legend to show current altitude range
    updateAltitudeLegend(colorMinAlt, colorMaxAlt);

    // Update airport marker opacity based on selection
    updateAirportOpacity();

    // Update statistics panel based on selection
    updateStatsForSelection();
}

function getColorForAltitude(altitude, minAlt, maxAlt) {
    // Normalize altitude to 0-1 range
    var normalized = (altitude - minAlt) / Math.max(maxAlt - minAlt, 1);
    normalized = Math.max(0, Math.min(1, normalized)); // Clamp to 0-1

    // Color gradient: light blue → cyan → green → yellow → orange → light red
    // Lighter terminal colors for better visibility on dark background
    var r, g, b;

    if (normalized < 0.2) {
        // Light Blue to Cyan (0.0 - 0.2)
        var t = normalized / 0.2;
        r = Math.round(80 * (1 - t)); // Start at 80, go to 0
        g = Math.round(160 + 95 * t); // 160 to 255
        b = 255;
    } else if (normalized < 0.4) {
        // Cyan to Green (0.2 - 0.4)
        var t = (normalized - 0.2) / 0.2;
        r = 0;
        g = 255;
        b = Math.round(255 * (1 - t));
    } else if (normalized < 0.6) {
        // Green to Yellow (0.4 - 0.6)
        var t = (normalized - 0.4) / 0.2;
        r = Math.round(255 * t);
        g = 255;
        b = 0;
    } else if (normalized < 0.8) {
        // Yellow to Orange (0.6 - 0.8)
        var t = (normalized - 0.6) / 0.2;
        r = 255;
        g = Math.round(255 * (1 - t * 0.35)); // ~165 at t=1
        b = 0;
    } else {
        // Orange to Light Red (0.8 - 1.0)
        var t = (normalized - 0.8) / 0.2;
        r = 255;
        g = Math.round(165 * (1 - t * 0.6)); // End at ~66 instead of 0
        b = Math.round(66 * t); // Add some blue component for lighter red
    }

    return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function updateAirportOpacity() {
    // Check if filters are active
    var hasFilters = selectedYear !== 'all' || selectedAircraft !== 'all';
    var hasSelection = selectedPathIds.size > 0;

    if (!hasFilters && !hasSelection) {
        // No filters or selection - show all airports
        Object.keys(airportMarkers).forEach(function(airportName) {
            var marker = airportMarkers[airportName];
            marker.setOpacity(1.0);
        });
        return;
    }

    var visibleAirports = new Set();

    // If filters are active, collect airports from filtered paths
    if (hasFilters && fullPathInfo) {
        fullPathInfo.forEach(function(pathInfo) {
            // Check if path matches filters
            var matchesYear = selectedYear === 'all' || (pathInfo.year && pathInfo.year.toString() === selectedYear);
            var matchesAircraft = selectedAircraft === 'all' || (pathInfo.aircraft_registration === selectedAircraft);

            if (matchesYear && matchesAircraft) {
                if (pathInfo.start_airport) visibleAirports.add(pathInfo.start_airport);
                if (pathInfo.end_airport) visibleAirports.add(pathInfo.end_airport);
            }
        });

    }

    // If paths are selected, collect airports from selected paths (overrides filter)
    if (hasSelection) {
        selectedPathIds.forEach(function(pathId) {
            // Use fullPathInfo for reliable path-to-airport mapping (not affected by zoom level)
            if (fullPathInfo) {
                var pathInfo = fullPathInfo.find(function(p) { return p.id === pathId; });
                if (pathInfo) {
                    if (pathInfo.start_airport) visibleAirports.add(pathInfo.start_airport);
                    if (pathInfo.end_airport) visibleAirports.add(pathInfo.end_airport);
                }
            } else {
                // Fallback to pathToAirports if fullPathInfo not loaded yet
                var airports = pathToAirports[pathId];
                if (airports) {
                    if (airports.start) visibleAirports.add(airports.start);
                    if (airports.end) visibleAirports.add(airports.end);
                }
            }
        });
    }

    // Update opacity for all airport markers
    Object.keys(airportMarkers).forEach(function(airportName) {
        var marker = airportMarkers[airportName];
        if (visibleAirports.has(airportName)) {
            marker.setOpacity(1.0);  // Full opacity for visited airports
        } else {
            marker.setOpacity(0.0);  // Hide non-visited airports
        }
    });
}

// Function to calculate filtered statistics
function calculateFilteredStats() {
    if (!fullPathInfo || !fullPathSegments) {
        return fullStats;
    }

    // Calculate from actual GPS segments
    var filteredPathInfo = fullPathInfo.filter(function(pathInfo) {
        // Apply year filter
        if (selectedYear !== 'all') {
            if (!pathInfo.year || pathInfo.year.toString() !== selectedYear) {
                return false;
            }
        }

        // Apply aircraft filter
        if (selectedAircraft !== 'all') {
            if (!pathInfo.aircraft_registration || pathInfo.aircraft_registration !== selectedAircraft) {
                return false;
            }
        }

        return true;
    });

    // If no paths match filters, return empty stats
    if (filteredPathInfo.length === 0) {
        return {
            total_points: 0,
            num_paths: 0,
            num_airports: 0,
            airport_names: [],
            num_aircraft: 0,
            aircraft_list: [],
            total_distance_nm: 0
        };
    }

    // Collect airports
    var airports = new Set();
    filteredPathInfo.forEach(function(pathInfo) {
        if (pathInfo.start_airport) airports.add(pathInfo.start_airport);
        if (pathInfo.end_airport) airports.add(pathInfo.end_airport);
    });

    // Collect aircraft
    var aircraftMap = {};
    filteredPathInfo.forEach(function(pathInfo) {
        if (pathInfo.aircraft_registration) {
            var reg = pathInfo.aircraft_registration;
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

    // Use actual GPS data
    // When filtering by year, only actual recorded flights are counted

    // Use pre-calculated flight counts from fullStats ONLY when filtering by aircraft alone
    // (not when both year and aircraft filters are active)
    if (selectedAircraft !== 'all' && selectedYear === 'all' && fullStats && fullStats.aircraft_list) {
        var fullAircraft = fullStats.aircraft_list.find(function(a) {
            return a.registration === selectedAircraft;
        });
        if (fullAircraft && aircraftMap[selectedAircraft]) {
            aircraftMap[selectedAircraft].flights = fullAircraft.flights;
        }
    }

    var aircraftList = Object.values(aircraftMap).sort(function(a, b) {
        return b.flights - a.flights;
    });

    // Calculate filtered stats from FULL RESOLUTION segments
    var filteredSegments = fullPathSegments.filter(function(segment) {
        var pathInfo = filteredPathInfo.find(function(p) { return p.id === segment.path_id; });
        return pathInfo !== undefined;
    });

    var totalDistanceKm = 0;

    // Use pre-calculated distance from fullStats ONLY when filtering by aircraft alone
    // (not when both year and aircraft filters are active)
    if (selectedAircraft !== 'all' && selectedYear === 'all' && fullStats && fullStats.aircraft_list) {
        var fullAircraft = fullStats.aircraft_list.find(function(a) {
            return a.registration === selectedAircraft;
        });
        if (fullAircraft && fullAircraft.flight_distance_km) {
            totalDistanceKm = fullAircraft.flight_distance_km;
        }
    } else {
        // Calculate from segments when filtering by year, both filters, or when fullStats not available
        filteredSegments.forEach(function(segment) {
            var coords = segment.coords;
            if (coords && coords.length === 2) {
                var lat1 = coords[0][0] * Math.PI / 180;
                var lon1 = coords[0][1] * Math.PI / 180;
                var lat2 = coords[1][0] * Math.PI / 180;
                var lon2 = coords[1][1] * Math.PI / 180;
                var dlat = lat2 - lat1;
                var dlon = lon2 - lon1;
                var a = Math.sin(dlat/2) * Math.sin(dlat/2) +
                        Math.cos(lat1) * Math.cos(lat2) *
                        Math.sin(dlon/2) * Math.sin(dlon/2);
                var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                totalDistanceKm += 6371 * c;
            }
        });
    }

    // Get altitude range
    var altitudes = filteredSegments.map(function(s) { return s.altitude_m; });
    var maxAltitudeM = altitudes.length > 0 ? Math.max(...altitudes) : 0;
    var minAltitudeM = altitudes.length > 0 ? Math.min(...altitudes) : 0;

    // Get groundspeed
    var groundspeeds = filteredSegments
        .map(function(s) { return s.groundspeed_knots; })
        .filter(function(s) { return s > 0; });
    var maxGroundspeedKnots = groundspeeds.length > 0 ? Math.max(...groundspeeds) : 0;
    var avgGroundspeedKnots = 0;
    if (groundspeeds.length > 0) {
        avgGroundspeedKnots = groundspeeds.reduce(function(a, b) { return a + b; }, 0) / groundspeeds.length;
    }

    // Calculate total altitude gain
    var totalAltitudeGainM = 0;
    var prevAltM = null;
    filteredSegments.forEach(function(segment) {
        if (prevAltM !== null && segment.altitude_m > prevAltM) {
            totalAltitudeGainM += segment.altitude_m - prevAltM;
        }
        prevAltM = segment.altitude_m;
    });

    // Calculate longest flight (max distance per path)
    var longestFlightKm = 0;
    var pathDistances = {};
    filteredSegments.forEach(function(segment) {
        var coords = segment.coords;
        if (coords && coords.length === 2) {
            var lat1 = coords[0][0] * Math.PI / 180;
            var lon1 = coords[0][1] * Math.PI / 180;
            var lat2 = coords[1][0] * Math.PI / 180;
            var lon2 = coords[1][1] * Math.PI / 180;
            var dlat = lat2 - lat1;
            var dlon = lon2 - lon1;
            var a = Math.sin(dlat/2) * Math.sin(dlat/2) +
                    Math.cos(lat1) * Math.cos(lat2) *
                    Math.sin(dlon/2) * Math.sin(dlon/2);
            var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            var dist = 6371 * c;

            if (!pathDistances[segment.path_id]) {
                pathDistances[segment.path_id] = 0;
            }
            pathDistances[segment.path_id] += dist;
        }
    });
    Object.values(pathDistances).forEach(function(dist) {
        if (dist > longestFlightKm) longestFlightKm = dist;
    });

    // Calculate total flight time from filtered paths
    var totalFlightTimeSeconds = 0;

    // Always calculate from actual GPS segment data
    if (filteredSegments.length > 0 && filteredSegments[0].time !== undefined) {
        var segmentsByPath = {};
        filteredSegments.forEach(function(seg) {
            if (!segmentsByPath[seg.path_id]) {
                segmentsByPath[seg.path_id] = [];
            }
            segmentsByPath[seg.path_id].push(seg);
        });
        Object.keys(segmentsByPath).forEach(function(pathId) {
            var pathSegments = segmentsByPath[pathId];
            pathSegments.sort(function(a, b) { return a.time - b.time; });
            if (pathSegments.length > 0) {
                var pathDuration = pathSegments[pathSegments.length - 1].time - pathSegments[0].time;
                totalFlightTimeSeconds += pathDuration;
            }
        });
    }

    var hours = Math.floor(totalFlightTimeSeconds / 3600);
    var minutes = Math.floor((totalFlightTimeSeconds % 3600) / 60);
    var totalFlightTimeStr = hours + 'h ' + minutes + 'm';

    // Calculate cruise speed and most common cruise altitude
    // Filter segments above 1000ft AGL (we approximate AGL as altitude - min_altitude)
    var cruiseSegments = filteredSegments.filter(function(seg) {
        return seg.altitude_ft > (minAltitudeM * 3.28084 + 1000);
    });

    var cruiseSpeedKnots = 0;
    if (cruiseSegments.length > 0) {
        var cruiseSpeeds = cruiseSegments
            .map(function(s) { return s.groundspeed_knots; })
            .filter(function(s) { return s > 0; });
        if (cruiseSpeeds.length > 0) {
            cruiseSpeedKnots = cruiseSpeeds.reduce(function(a, b) { return a + b; }, 0) / cruiseSpeeds.length;
        }
    }

    // Most common cruise altitude (500ft bins)
    // Weight by time spent at each altitude for accurate results
    var altitudeBins = {};

    // Group segments by path_id and calculate time weights per path
    if (cruiseSegments.length > 0 && cruiseSegments[0].time !== undefined && cruiseSegments[0].path_id !== undefined) {
        // Group cruise segments by path_id
        var segmentsByPath = {};
        cruiseSegments.forEach(function(seg) {
            if (!segmentsByPath[seg.path_id]) {
                segmentsByPath[seg.path_id] = [];
            }
            segmentsByPath[seg.path_id].push(seg);
        });

        // Process each path separately
        Object.keys(segmentsByPath).forEach(function(pathId) {
            var pathSegments = segmentsByPath[pathId];

            // Sort segments within this path by time
            pathSegments.sort(function(a, b) {
                return a.time - b.time;
            });

            // Calculate time spent at each altitude within this path
            for (var i = 0; i < pathSegments.length; i++) {
                var seg = pathSegments[i];
                var bin = Math.round(seg.altitude_ft / 100) * 100;

                // Calculate time duration for this segment
                var duration = 0;
                if (i < pathSegments.length - 1) {
                    // Time until next segment in same path
                    duration = pathSegments[i + 1].time - seg.time;
                } else if (i > 0) {
                    // For last segment in path, use same duration as previous segment
                    duration = seg.time - pathSegments[i - 1].time;
                } else {
                    // Single segment in path, give it unit weight
                    duration = 1;
                }

                altitudeBins[bin] = (altitudeBins[bin] || 0) + duration;
            }
        });
    } else {
        // Fallback to counting segments if no time data
        cruiseSegments.forEach(function(seg) {
            var bin = Math.round(seg.altitude_ft / 100) * 100;
            altitudeBins[bin] = (altitudeBins[bin] || 0) + 1;
        });
    }

    var mostCommonCruiseAltFt = 0;
    var maxCount = 0;
    Object.keys(altitudeBins).forEach(function(bin) {
        if (altitudeBins[bin] > maxCount) {
            maxCount = altitudeBins[bin];
            mostCommonCruiseAltFt = parseInt(bin);
        }
    });

    // Calculate total flights - use sum of aircraft flights instead of path count
    var totalFlights = aircraftList.reduce(function(sum, aircraft) {
        return sum + aircraft.flights;
    }, 0);

    return {
        total_points: filteredSegments.length * 2,
        num_paths: totalFlights,
        num_airports: airports.size,
        airport_names: Array.from(airports).sort(),
        num_aircraft: aircraftList.length,
        aircraft_list: aircraftList,
        total_distance_nm: totalDistanceKm * 0.539957,
        total_distance_km: totalDistanceKm,
        longest_flight_nm: longestFlightKm * 0.539957,
        longest_flight_km: longestFlightKm,
        max_altitude_ft: maxAltitudeM * 3.28084,
        max_altitude_m: maxAltitudeM,
        min_altitude_ft: minAltitudeM * 3.28084,
        min_altitude_m: minAltitudeM,
        total_altitude_gain_ft: totalAltitudeGainM * 3.28084,
        total_altitude_gain_m: totalAltitudeGainM,
        max_groundspeed_knots: maxGroundspeedKnots,
        average_groundspeed_knots: avgGroundspeedKnots,
        cruise_speed_knots: cruiseSpeedKnots,
        most_common_cruise_altitude_ft: mostCommonCruiseAltFt,
        most_common_cruise_altitude_m: Math.round(mostCommonCruiseAltFt * 0.3048),
        total_flight_time_seconds: totalFlightTimeSeconds,
        total_flight_time_str: totalFlightTimeStr
    };
}

// Function to update aircraft dropdown based on current year filter
function updateAircraftDropdown() {
    if (!fullPathInfo) return;

    const aircraftSelect = document.getElementById('aircraft-select');
    const currentSelection = selectedAircraft;

    // Clear existing options except "All"
    while (aircraftSelect.options.length > 1) {
        aircraftSelect.remove(1);
    }

    // Get aircraft for the current year filter
    var yearFilteredPathInfo;
    if (selectedYear === 'all') {
        yearFilteredPathInfo = fullPathInfo;
    } else {
        yearFilteredPathInfo = fullPathInfo.filter(function(pathInfo) {
            return pathInfo.year && pathInfo.year.toString() === selectedYear;
        });
    }

    // Collect aircraft from filtered paths
    var aircraftMap = {};
    yearFilteredPathInfo.forEach(function(pathInfo) {
        if (pathInfo.aircraft_registration) {
            var reg = pathInfo.aircraft_registration;
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

    // Convert to sorted list
    var aircraftList = Object.values(aircraftMap).sort(function(a, b) {
        return b.flights - a.flights;
    });

    // Populate dropdown
    var selectedAircraftExists = false;
    aircraftList.forEach(function(aircraft) {
        const option = document.createElement('option');
        option.value = aircraft.registration;
        var typeStr = aircraft.type ? ' (' + aircraft.type + ')' : '';
        option.textContent = '✈️ ' + aircraft.registration + typeStr;
        aircraftSelect.appendChild(option);

        if (aircraft.registration === currentSelection) {
            selectedAircraftExists = true;
        }
    });

    // If current selection doesn't exist in filtered list, reset to 'all'
    if (!selectedAircraftExists && currentSelection !== 'all') {
        selectedAircraft = 'all';
        aircraftSelect.value = 'all';
    } else {
        aircraftSelect.value = currentSelection;
    }
}

// Function to filter data by year
function filterByYear() {
    const yearSelect = document.getElementById('year-select');
    selectedYear = yearSelect.value;

    // Clear data cache to force reload for new year
    loadedData = {};
    currentResolution = null;

    // Clear current paths
    altitudeLayer.clearLayers();
    pathSegments = {};
    selectedPathIds.clear();

    // Reload current resolution data for new year
    updateLayers();

    // Reload full resolution data for filtering/stats
    loadData('z14_plus', selectedYear).then(function(fullResData) {
        if (fullResData) {
            fullPathInfo = fullResData.path_info || [];
            fullPathSegments = fullResData.path_segments || [];
        }

        // Update aircraft dropdown to show only aircraft with flights in selected year
        updateAircraftDropdown();

        // Update stats based on filter
        var filteredStats = calculateFilteredStats();
        updateStatsPanel(filteredStats, false);

        // Update airport visibility based on filter
        updateAirportOpacity();

        // Update airport popups with current filter counts
        updateAirportPopups();
    });

    saveMapState();
}

// Function to filter data by aircraft
function filterByAircraft() {
    const aircraftSelect = document.getElementById('aircraft-select');
    selectedAircraft = aircraftSelect.value;

    // Clear current paths and reload
    altitudeLayer.clearLayers();
    pathSegments = {};
    selectedPathIds.clear();

    // Reload current resolution data to apply filter
    currentResolution = null;  // Force reload
    updateLayers();

    // Update stats based on filter
    var filteredStats = calculateFilteredStats();
    updateStatsPanel(filteredStats, false);

    // Update airport visibility based on filter
    updateAirportOpacity();

    // Update airport popups with current filter counts
    updateAirportPopups();

    saveMapState();
}

// Load airports once
(async function() {
    const airports = await loadAirports();
    allAirportsData = airports;  // Store globally for filtering
    const metadata = await loadMetadata();

    // Populate year filter dropdown
    if (metadata && metadata.available_years) {
        const yearSelect = document.getElementById('year-select');
        metadata.available_years.forEach(function(year) {
            const option = document.createElement('option');
            option.value = year;
            option.textContent = '📅 ' + year;
            yearSelect.appendChild(option);
        });

        // Default to current year only if no saved state exists
        // If user explicitly selected "All", keep it as "All"
        if (selectedYear === 'all' && !restoredYearFromState) {
            // Get the latest year (assumed to be the current year)
            const currentYear = metadata.available_years[metadata.available_years.length - 1];
            selectedYear = currentYear.toString();
        }

        // Sync dropdown with the selected year (either restored, defaulted, or "all")
        if (selectedYear && selectedYear !== 'all') {
            yearSelect.value = selectedYear;
        }
    }

    // Aircraft dropdown will be populated after loading full path data

    // Find the airport with the most flights (home base)
    let homeBaseAirport = null;
    if (airports.length > 0) {
        homeBaseAirport = airports.reduce((max, airport) =>
            airport.flight_count > max.flight_count ? airport : max
        , airports[0]);
    }

    // Add airport markers
    airports.forEach(function(airport) {
        const icaoMatch = airport.name ? airport.name.match(/\b([A-Z]{4})\b/) : null;
        const icao = icaoMatch ? icaoMatch[1] : 'APT';

        // Check if this is the home base
        const isHomeBase = homeBaseAirport && airport.name === homeBaseAirport.name;
        const homeClass = isHomeBase ? ' airport-marker-home' : '';
        const homeLabelClass = isHomeBase ? ' airport-label-home' : '';

        const markerHtml = '<div class="airport-marker-container"><div class="airport-marker' + homeClass + '"></div><div class="airport-label' + homeLabelClass + '">' + icao + '</div></div>';

        const latDms = ddToDms(airport.lat, true);
        const lonDms = ddToDms(airport.lon, false);
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
                <span style="font-size: 18px;">🛫</span>
                <span>${airport.name || 'Unknown'}</span>
                ${isHomeBase ? '<span style="font-size: 12px; background: #007bff; color: white; padding: 2px 6px; border-radius: 3px; margin-left: 4px;">HOME</span>' : ''}
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
                    <span>📍</span>
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
                <span style="font-size: 16px; font-weight: bold; color: #4facfe;">${airport.flight_count}</span>
            </div>
        </div>`;

        var marker = L.marker([airport.lat, airport.lon], {
            icon: L.divIcon({
                html: markerHtml,
                iconSize: [12, 12],
                iconAnchor: [6, 6],
                popupAnchor: [0, -6],
                className: ''
            }),
            icao: icao  // Store ICAO for cluster icon function
        })
        .bindPopup(popup, { autoPanPadding: [50, 50] });

        // Add click handler to select paths connected to this airport
        marker.on('click', function(e) {
            // Don't allow selecting paths during replay mode
            if (!replayActive) {
                selectPathsByAirport(airport.name);
            }
        });

        marker.addTo(airportLayer);

        // Store marker reference for opacity control
        airportMarkers[airport.name] = marker;
    });

    // Load and store full statistics
    if (metadata && metadata.stats) {
        fullStats = metadata.stats;
    }

    // Load full resolution path_info and path_segments for accurate filtering and replay
    try {
        const fullResData = await loadData('z14_plus', selectedYear);
        if (fullResData && fullResData.path_info) {
            fullPathInfo = fullResData.path_info;
        }
        if (fullResData && fullResData.path_segments) {
            fullPathSegments = fullResData.path_segments;
        }
    } catch (error) {
        console.error('Failed to load full path data:', error);
    }

    // Populate aircraft dropdown based on year filter
    updateAircraftDropdown();

    // Update airport popups with initial filter counts
    updateAirportPopups();

    // Initialize stats panel with filter-aware data
    if (fullStats) {
        const initialStats = calculateFilteredStats();
        updateStatsPanel(initialStats, false);
    }

    // Update airport opacity based on restored filters
    updateAirportOpacity();

    // Save state to ensure filter restoration is persisted correctly
    saveMapState();

    // Load groundspeed range from metadata (from full resolution data)
    if (metadata && metadata.min_groundspeed_knots !== undefined && metadata.max_groundspeed_knots !== undefined) {
        airspeedRange.min = metadata.min_groundspeed_knots;
        airspeedRange.max = metadata.max_groundspeed_knots;
        // Update airspeed legend with the correct range
        updateAirspeedLegend(airspeedRange.min, airspeedRange.max);
    }

    // Initial data load
    updateLayers();

    // Set initial airport marker sizes based on current zoom
    updateAirportMarkerSizes();

    // Restore layer visibility based on saved state
    // This must happen after updateLayers() creates the layers
    if (altitudeVisible) {
        map.addLayer(altitudeLayer);
        document.getElementById('altitude-legend').style.display = 'block';
    }
    if (airspeedVisible) {
        map.addLayer(airspeedLayer);
        document.getElementById('airspeed-legend').style.display = 'block';
    }
    if (aviationVisible && OPENAIP_API_KEY && openaipLayers['Aviation Data']) {
        map.addLayer(openaipLayers['Aviation Data']);
    }

    // Restore selected paths from saved state
    if (savedState && savedState.selectedPathIds && savedState.selectedPathIds.length > 0) {
        savedState.selectedPathIds.forEach(function(pathId) {
            selectedPathIds.add(pathId);
        });
        if (altitudeVisible) {
            redrawAltitudePaths();
        }
        if (airspeedVisible) {
            redrawAirspeedPaths();
        }
        updateReplayButtonState();
    }

    // Restore stats panel visibility
    if (savedState && savedState.statsPanelVisible) {
        const panel = document.getElementById('stats-panel');
        panel.style.display = 'block';
        // Trigger reflow to ensure transition works
        panel.offsetHeight;
        panel.classList.add('visible');
    }

    // Register map event handlers for state persistence AFTER initialization is complete
    // This prevents premature state saving before filters are fully restored
    map.on('moveend', saveMapState);
    map.on('zoomend', saveMapState);

    // Don't restore replay mode - it's too complex with layer state management
    // User can manually restart replay after page refresh
})();

// Update layers on zoom change only
map.on('zoomend', function() {
    updateLayers();
    updateAirportMarkerSizes();
});

// Clear selection when clicking on the map background
map.on('click', function(e) {
    // Close replay airplane popup if open
    if (replayActive && replayAirplaneMarker && replayAirplaneMarker.isPopupOpen()) {
        replayAirplaneMarker.closePopup();
    }
    // Don't clear selection during replay mode
    if (!replayActive && selectedPathIds.size > 0) {
        clearSelection();
    }
});

// Path and airport selection functions
function togglePathSelection(pathId) {
    if (selectedPathIds.has(pathId)) {
        selectedPathIds.delete(pathId);
    } else {
        selectedPathIds.add(pathId);
    }

    // Redraw paths with delay for mobile Safari
    if (altitudeVisible) {
        redrawAltitudePaths();
        setTimeout(function() {
            map.invalidateSize();
        }, 50);
    }
    if (airspeedVisible) {
        redrawAirspeedPaths();
        setTimeout(function() {
            map.invalidateSize();
        }, 50);
    }

    updateReplayButtonState();
    saveMapState();
}

function selectPathsByAirport(airportName) {
    var pathIds = airportToPaths[airportName] || [];
    pathIds.forEach(function(pathId) {
        selectedPathIds.add(pathId);
    });

    // Redraw paths with delay for mobile Safari
    if (altitudeVisible) {
        redrawAltitudePaths();
        setTimeout(function() {
            map.invalidateSize();
        }, 50);
    }
    if (airspeedVisible) {
        redrawAirspeedPaths();
        setTimeout(function() {
            map.invalidateSize();
        }, 50);
    }

    updateReplayButtonState();
    saveMapState();
}

function clearSelection() {
    selectedPathIds.clear();

    // Redraw paths with a small delay for mobile Safari touch event handling
    if (altitudeVisible) {
        redrawAltitudePaths();
        // Force map to recognize new interactive elements on mobile Safari
        setTimeout(function() {
            map.invalidateSize();
        }, 50);
    }
    if (airspeedVisible) {
        redrawAirspeedPaths();
        // Force map to recognize new interactive elements on mobile Safari
        setTimeout(function() {
            map.invalidateSize();
        }, 50);
    }

    updateReplayButtonState();
    saveMapState();
}

function updateAirportMarkerSizes() {
    const zoom = map.getZoom();
    let sizeClass = '';

    if (zoom >= 14) {
        sizeClass = 'xlarge';
    } else if (zoom >= 12) {
        sizeClass = 'large';
    } else if (zoom >= 10) {
        sizeClass = 'medium';
    } else if (zoom >= 8) {
        sizeClass = 'medium-small';
    } else if (zoom >= 6) {
        sizeClass = 'small';
    }

    // Update all airport markers
    document.querySelectorAll('.airport-marker-container').forEach(function(container) {
        const marker = container.querySelector('.airport-marker');
        const label = container.querySelector('.airport-label');

        // Hide labels when zoomed out below level 5, but keep dots visible
        if (zoom < 5) {
            label.style.display = 'none';
        } else {
            label.style.display = '';
        }

        // Remove all size classes
        container.classList.remove('airport-marker-container-small', 'airport-marker-container-medium-small', 'airport-marker-container-medium', 'airport-marker-container-large', 'airport-marker-container-xlarge');
        marker.classList.remove('airport-marker-small', 'airport-marker-medium-small', 'airport-marker-medium', 'airport-marker-large', 'airport-marker-xlarge');
        label.classList.remove('airport-label-small', 'airport-label-medium-small', 'airport-label-medium', 'airport-label-large', 'airport-label-xlarge');

        // Add appropriate size class
        if (sizeClass) {
            container.classList.add('airport-marker-container-' + sizeClass);
            marker.classList.add('airport-marker-' + sizeClass);
            label.classList.add('airport-label-' + sizeClass);
        }
    });
}

function updateAltitudeLegend(minAlt, maxAlt) {
    var minFt = Math.round(minAlt);
    var maxFt = Math.round(maxAlt);
    var minM = Math.round(minAlt * 0.3048);
    var maxM = Math.round(maxAlt * 0.3048);

    document.getElementById('legend-min').textContent = minFt.toLocaleString() + ' ft (' + minM.toLocaleString() + ' m)';
    document.getElementById('legend-max').textContent = maxFt.toLocaleString() + ' ft (' + maxM.toLocaleString() + ' m)';
}

function redrawAirspeedPaths() {
    if (!currentData) {
        console.warn('redrawAirspeedPaths: No current data available');
        return;
    }

    // Clear airspeed layer
    airspeedLayer.clearLayers();

    // Calculate groundspeed range for color scaling
    var colorMinSpeed, colorMaxSpeed;
    if (selectedPathIds.size > 0) {
        // Use selected paths' groundspeed range
        var selectedSegments = currentData.path_segments.filter(function(segment) {
            return selectedPathIds.has(segment.path_id) && segment.groundspeed_knots > 0;
        });
        if (selectedSegments.length > 0) {
            var groundspeeds = selectedSegments.map(function(s) { return s.groundspeed_knots; });
            colorMinSpeed = Math.min(...groundspeeds);
            colorMaxSpeed = Math.max(...groundspeeds);
        } else {
            colorMinSpeed = airspeedRange.min;
            colorMaxSpeed = airspeedRange.max;
        }
    } else {
        // Use full groundspeed range from metadata (not from current resolution)
        colorMinSpeed = airspeedRange.min;
        colorMaxSpeed = airspeedRange.max;
    }

    // Create path segments with groundspeed colors and rescaled colors
    currentData.path_segments.forEach(function(segment) {
        var pathId = segment.path_id;

        var pathInfo = currentData.path_info.find(function(p) { return p.id === pathId; });

        // Filter by year if selected
        if (selectedYear !== 'all') {
            if (pathInfo && pathInfo.year && pathInfo.year.toString() !== selectedYear) {
                return;  // Skip this segment
            }
        }

        // Filter by aircraft if selected
        if (selectedAircraft !== 'all') {
            if (pathInfo && pathInfo.aircraft_registration !== selectedAircraft) {
                return;  // Skip this segment
            }
        }

        if (segment.groundspeed_knots > 0) {
            var isSelected = selectedPathIds.has(pathId);

            // Recalculate color based on current groundspeed range
            var color = getColorForAltitude(segment.groundspeed_knots, colorMinSpeed, colorMaxSpeed);

            var kmh = Math.round(segment.groundspeed_knots * 1.852);
            var polyline = L.polyline(segment.coords, {
                color: color,
                weight: isSelected ? 6 : 4,
                opacity: isSelected ? 1.0 : (selectedPathIds.size > 0 ? 0.1 : 0.85),
                renderer: airspeedRenderer,
                interactive: true
            }).bindPopup('Groundspeed: ' + segment.groundspeed_knots + ' kt (' + kmh + ' km/h)')
              .addTo(airspeedLayer);

            // Make path clickable
            polyline.on('click', function(e) {
                L.DomEvent.stopPropagation(e);
                togglePathSelection(pathId);
            });
        }
    });

    // Update legend
    updateAirspeedLegend(colorMinSpeed, colorMaxSpeed);

    // Update airport marker opacity based on selection
    updateAirportOpacity();

    // Update statistics panel based on selection
    updateStatsForSelection();
}

function updateAirspeedLegend(minSpeed, maxSpeed) {
    var minKnots = Math.round(minSpeed);
    var maxKnots = Math.round(maxSpeed);
    var minKmh = Math.round(minSpeed * 1.852);
    var maxKmh = Math.round(maxSpeed * 1.852);

    document.getElementById('airspeed-legend-min').textContent = minKnots.toLocaleString() + ' kt (' + minKmh.toLocaleString() + ' km/h)';
    document.getElementById('airspeed-legend-max').textContent = maxKnots.toLocaleString() + ' kt (' + maxKmh.toLocaleString() + ' km/h)';
}

function updateStatsForSelection() {
    if (selectedPathIds.size === 0) {
        var statsToShow = calculateFilteredStats();
        if (statsToShow) {
            updateStatsPanel(statsToShow, false);
        }
        return;
    }

    // Calculate stats for selected paths only
    var selectedSegments = currentData.path_segments.filter(function(segment) {
        return selectedPathIds.has(segment.path_id);
    });

    if (selectedSegments.length === 0) return;

    // Calculate statistics from selected segments
    var selectedPathInfos = currentData.path_info.filter(function(pathInfo) {
        return selectedPathIds.has(pathInfo.id);
    });

    // Collect unique airports from selected paths
    var selectedAirports = new Set();
    selectedPathInfos.forEach(function(pathInfo) {
        if (pathInfo.start_airport) selectedAirports.add(pathInfo.start_airport);
        if (pathInfo.end_airport) selectedAirports.add(pathInfo.end_airport);
    });

    // Collect unique aircraft from selected paths
    var selectedAircraftMap = {};
    selectedPathInfos.forEach(function(pathInfo) {
        if (pathInfo.aircraft_registration) {
            var reg = pathInfo.aircraft_registration;
            if (!selectedAircraftMap[reg]) {
                selectedAircraftMap[reg] = {
                    registration: reg,
                    type: pathInfo.aircraft_type,
                    flights: 0
                };
            }
            selectedAircraftMap[reg].flights += 1;
        }
    });

    // Convert aircraft map to sorted array
    var selectedAircraftList = Object.values(selectedAircraftMap).sort(function(a, b) {
        return b.flights - a.flights;
    });

    // Calculate distance (approximate using segment coordinates)
    var totalDistanceKm = 0;
    selectedSegments.forEach(function(segment) {
        var coords = segment.coords;
        if (coords && coords.length === 2) {
            var lat1 = coords[0][0] * Math.PI / 180;
            var lon1 = coords[0][1] * Math.PI / 180;
            var lat2 = coords[1][0] * Math.PI / 180;
            var lon2 = coords[1][1] * Math.PI / 180;

            var dlat = lat2 - lat1;
            var dlon = lon2 - lon1;
            var a = Math.sin(dlat/2) * Math.sin(dlat/2) +
                    Math.cos(lat1) * Math.cos(lat2) *
                    Math.sin(dlon/2) * Math.sin(dlon/2);
            var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            totalDistanceKm += 6371 * c;  // Earth radius in km
        }
    });

    // Calculate cruise speed and most common cruise altitude for selected paths
    // Use full resolution segments for accurate cruise altitude detection
    var fullSelectedSegments = selectedSegments;
    if (fullPathSegments) {
        fullSelectedSegments = fullPathSegments.filter(function(seg) {
            return selectedPathIds.has(seg.path_id);
        });
    }

    // Get altitude range from full resolution selected segments
    var altitudes = fullSelectedSegments.map(function(s) { return s.altitude_m; });
    var minAltitudeM = Math.min(...altitudes);
    var maxAltitudeM = Math.max(...altitudes);

    // Calculate altitude gain for selected paths
    var totalAltitudeGainM = 0;
    var prevAltitudeM = null;
    selectedSegments.forEach(function(segment) {
        if (prevAltitudeM !== null) {
            var gain = segment.altitude_m - prevAltitudeM;
            if (gain > 0) {
                totalAltitudeGainM += gain;
            }
        }
        prevAltitudeM = segment.altitude_m;
    });

    // Get groundspeed range from selected segments
    var groundspeeds = selectedSegments
        .map(function(s) { return s.groundspeed_knots; })
        .filter(function(s) { return s > 0; });
    var maxGroundspeedKnots = groundspeeds.length > 0 ? Math.max(...groundspeeds) : 0;

    // Calculate average groundspeed
    var avgGroundspeedKnots = 0;
    if (groundspeeds.length > 0) {
        var sumSpeed = groundspeeds.reduce(function(a, b) { return a + b; }, 0);
        avgGroundspeedKnots = sumSpeed / groundspeeds.length;
    }

    // Calculate longest flight (max distance per selected path)
    var longestFlightKm = 0;
    var pathDistances = {};
    selectedSegments.forEach(function(segment) {
        var coords = segment.coords;
        if (coords && coords.length === 2) {
            var lat1 = coords[0][0] * Math.PI / 180;
            var lon1 = coords[0][1] * Math.PI / 180;
            var lat2 = coords[1][0] * Math.PI / 180;
            var lon2 = coords[1][1] * Math.PI / 180;
            var dlat = lat2 - lat1;
            var dlon = lon2 - lon1;
            var a = Math.sin(dlat/2) * Math.sin(dlat/2) +
                    Math.cos(lat1) * Math.cos(lat2) *
                    Math.sin(dlon/2) * Math.sin(dlon/2);
            var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            var dist = 6371 * c;

            if (!pathDistances[segment.path_id]) {
                pathDistances[segment.path_id] = 0;
            }
            pathDistances[segment.path_id] += dist;
        }
    });
    Object.values(pathDistances).forEach(function(dist) {
        if (dist > longestFlightKm) longestFlightKm = dist;
    });

    // Calculate actual total flight time for selected paths using segment timestamps
    var totalFlightTimeSeconds = 0;
    if (fullPathSegments) {
        // For each selected path, find min and max timestamps
        selectedPathIds.forEach(function(pathId) {
            var pathSegments = fullPathSegments.filter(function(seg) {
                return seg.path_id === pathId && seg.time !== undefined && seg.time !== null;
            });

            if (pathSegments.length > 0) {
                var times = pathSegments.map(function(seg) { return seg.time; });
                var minTime = Math.min(...times);
                var maxTime = Math.max(...times);
                totalFlightTimeSeconds += (maxTime - minTime);
            }
        });
    } else {
        // Fallback to estimation if fullPathSegments not available
        selectedPathInfos.forEach(function(pathInfo) {
            if (fullStats && fullStats.total_flight_time_seconds && fullStats.num_paths > 0) {
                totalFlightTimeSeconds += fullStats.total_flight_time_seconds / fullStats.num_paths;
            }
        });
    }
    var hours = Math.floor(totalFlightTimeSeconds / 3600);
    var minutes = Math.floor((totalFlightTimeSeconds % 3600) / 60);
    var totalFlightTimeStr = hours + 'h ' + minutes + 'm';

    // Filter for cruise segments (already using fullSelectedSegments from above)
    var cruiseSegments = fullSelectedSegments.filter(function(seg) {
        return seg.altitude_ft > (minAltitudeM * 3.28084 + 1000);
    });

    var cruiseSpeedKnots = 0;
    if (cruiseSegments.length > 0) {
        var cruiseSpeeds = cruiseSegments
            .map(function(s) { return s.groundspeed_knots; })
            .filter(function(s) { return s > 0; });
        if (cruiseSpeeds.length > 0) {
            cruiseSpeedKnots = cruiseSpeeds.reduce(function(a, b) { return a + b; }, 0) / cruiseSpeeds.length;
        }
    }

    // Most common cruise altitude (500ft bins)
    // Weight by time spent at each altitude for accurate results
    var altitudeBins = {};

    // Group segments by path_id and calculate time weights per path
    if (cruiseSegments.length > 0 && cruiseSegments[0].time !== undefined && cruiseSegments[0].path_id !== undefined) {
        // Group cruise segments by path_id
        var segmentsByPath = {};
        cruiseSegments.forEach(function(seg) {
            if (!segmentsByPath[seg.path_id]) {
                segmentsByPath[seg.path_id] = [];
            }
            segmentsByPath[seg.path_id].push(seg);
        });

        // Process each path separately
        Object.keys(segmentsByPath).forEach(function(pathId) {
            var pathSegments = segmentsByPath[pathId];

            // Sort segments within this path by time
            pathSegments.sort(function(a, b) {
                return a.time - b.time;
            });

            // Calculate time spent at each altitude within this path
            for (var i = 0; i < pathSegments.length; i++) {
                var seg = pathSegments[i];
                var bin = Math.round(seg.altitude_ft / 100) * 100;

                // Calculate time duration for this segment
                var duration = 0;
                if (i < pathSegments.length - 1) {
                    // Time until next segment in same path
                    duration = pathSegments[i + 1].time - seg.time;
                } else if (i > 0) {
                    // For last segment in path, use same duration as previous segment
                    duration = seg.time - pathSegments[i - 1].time;
                } else {
                    // Single segment in path, give it unit weight
                    duration = 1;
                }

                altitudeBins[bin] = (altitudeBins[bin] || 0) + duration;
            }
        });
    } else {
        // Fallback to counting segments if no time data
        cruiseSegments.forEach(function(seg) {
            var bin = Math.round(seg.altitude_ft / 100) * 100;
            altitudeBins[bin] = (altitudeBins[bin] || 0) + 1;
        });
    }

    var mostCommonCruiseAltFt = 0;
    var maxCount = 0;
    Object.keys(altitudeBins).forEach(function(bin) {
        if (altitudeBins[bin] > maxCount) {
            maxCount = altitudeBins[bin];
            mostCommonCruiseAltFt = parseInt(bin);
        }
    });

    // Build selected stats object
    var selectedStats = {
        total_points: selectedSegments.length * 2,
        num_paths: selectedPathIds.size,
        num_airports: selectedAirports.size,
        airport_names: Array.from(selectedAirports).sort(),
        num_aircraft: selectedAircraftList.length,
        aircraft_list: selectedAircraftList,
        total_distance_nm: totalDistanceKm * 0.539957,
        total_distance_km: totalDistanceKm,
        longest_flight_nm: longestFlightKm * 0.539957,
        longest_flight_km: longestFlightKm,
        max_altitude_ft: maxAltitudeM * 3.28084,
        max_altitude_m: maxAltitudeM,
        min_altitude_ft: minAltitudeM * 3.28084,
        min_altitude_m: minAltitudeM,
        total_altitude_gain_ft: totalAltitudeGainM * 3.28084,
        total_altitude_gain_m: totalAltitudeGainM,
        average_groundspeed_knots: avgGroundspeedKnots,
        max_groundspeed_knots: maxGroundspeedKnots,
        cruise_speed_knots: cruiseSpeedKnots,
        most_common_cruise_altitude_ft: mostCommonCruiseAltFt,
        most_common_cruise_altitude_m: Math.round(mostCommonCruiseAltFt * 0.3048),
        total_flight_time_seconds: totalFlightTimeSeconds,
        total_flight_time_str: totalFlightTimeStr
    };

    updateStatsPanel(selectedStats, true);
}

// Statistics panel
function updateStatsPanel(stats, isSelection) {
    let html = '';

    // Add indicator if showing selected paths only
    if (isSelection) {
        html += '<p style="margin:0 0 10px 0; font-weight:bold; font-size:15px;">📊 Selected Paths Statistics</p>';
        html += '<div style="background-color: #3a5a7a; padding: 4px 8px; margin-bottom: 8px; border-radius: 3px; font-size: 11px; color: #a0c0e0;">Showing stats for ' + stats.num_paths + ' selected path(s)</div>';
    } else {
        html += '<p style="margin:0 0 10px 0; font-weight:bold; font-size:15px;">📊 Flight Statistics</p>';
    }

    html += '<div style="margin-bottom: 8px;"><strong>Data Points:</strong> ' + stats.total_points.toLocaleString() + '</div>';
    html += '<div style="margin-bottom: 8px;"><strong>Flights:</strong> ' + stats.num_paths + '</div>';

    if (stats.airport_names && stats.airport_names.length > 0) {
        html += '<div style="margin-bottom: 8px; max-height: 150px; overflow-y: auto;"><strong>Airports (' + stats.num_airports + '):</strong><br>';
        stats.airport_names.forEach(function(name) {
            html += '<span style="margin-left: 10px;">• ' + name + '</span><br>';
        });
        html += '</div>';
    }

    // Aircraft information (below airports)
    if (stats.num_aircraft && stats.num_aircraft > 0 && stats.aircraft_list && stats.aircraft_list.length > 0) {
        html += '<div style="margin-bottom: 8px; max-height: 150px; overflow-y: auto;"><strong>Aircrafts (' + stats.num_aircraft + '):</strong><br>';
        stats.aircraft_list.forEach(function(aircraft) {
            var typeStr = aircraft.type ? ' (' + aircraft.type + ')' : '';
            html += '<span style="margin-left: 10px;">• ' + aircraft.registration + typeStr + ' - ' + aircraft.flights + ' flight(s)</span><br>';
        });
        html += '</div>';
    }

    if (stats.total_flight_time_str) {
        html += '<div style="margin-bottom: 8px;"><strong>Total Flight Time:</strong> ' + stats.total_flight_time_str + '</div>';
    }

    // Distance with km conversion
    var distanceKm = (stats.total_distance_nm * 1.852).toFixed(1);
    html += '<div style="margin-bottom: 8px;"><strong>Distance:</strong> ' + stats.total_distance_nm.toFixed(1) + ' nm (' + distanceKm + ' km)</div>';

    // Average distance per trip
    if (stats.num_paths > 0) {
        var avgDistanceNm = (stats.total_distance_nm / stats.num_paths).toFixed(1);
        var avgDistanceKm = (avgDistanceNm * 1.852).toFixed(1);
        html += '<div style="margin-bottom: 8px;"><strong>Average Distance per Trip:</strong> ' + avgDistanceNm + ' nm (' + avgDistanceKm + ' km)</div>';
    }

    // Longest single flight distance
    if (stats.longest_flight_nm && stats.longest_flight_nm > 0) {
        var longestKm = stats.longest_flight_km.toFixed(1);
        html += '<div style="margin-bottom: 8px;"><strong>Longest Flight:</strong> ' + stats.longest_flight_nm.toFixed(1) + ' nm (' + longestKm + ' km)</div>';
    }

    if (stats.average_groundspeed_knots && stats.average_groundspeed_knots > 0) {
        var kmh = Math.round(stats.average_groundspeed_knots * 1.852);
        html += '<div style="margin-bottom: 8px;"><strong>Average Groundspeed:</strong> ' + Math.round(stats.average_groundspeed_knots) + ' kt (' + kmh + ' km/h)</div>';
    }

    if (stats.cruise_speed_knots && stats.cruise_speed_knots > 0) {
        var kmh_cruise = Math.round(stats.cruise_speed_knots * 1.852);
        html += '<div style="margin-bottom: 8px;"><strong>Cruise Speed (>1000ft AGL):</strong> ' + Math.round(stats.cruise_speed_knots) + ' kt (' + kmh_cruise + ' km/h)</div>';
    }

    if (stats.max_groundspeed_knots && stats.max_groundspeed_knots > 0) {
        var kmh_max = Math.round(stats.max_groundspeed_knots * 1.852);
        html += '<div style="margin-bottom: 8px;"><strong>Max Groundspeed:</strong> ' + Math.round(stats.max_groundspeed_knots) + ' kt (' + kmh_max + ' km/h)</div>';
    }

    if (stats.max_altitude_ft) {
        // Altitude with meter conversion
        var maxAltitudeM = Math.round(stats.max_altitude_ft * 0.3048);
        html += '<div style="margin-bottom: 8px;"><strong>Max Altitude (MSL):</strong> ' + Math.round(stats.max_altitude_ft) + ' ft (' + maxAltitudeM + ' m)</div>';

        // Elevation gain with meter conversion
        if (stats.total_altitude_gain_ft) {
            var elevationGainM = Math.round(stats.total_altitude_gain_ft * 0.3048);
            html += '<div style="margin-bottom: 8px;"><strong>Elevation Gain:</strong> ' + Math.round(stats.total_altitude_gain_ft) + ' ft (' + elevationGainM + ' m)</div>';
        }
    }

    // Most common cruise altitude
    if (stats.most_common_cruise_altitude_ft && stats.most_common_cruise_altitude_ft > 0) {
        var cruiseAltM = Math.round(stats.most_common_cruise_altitude_m);
        html += '<div style="margin-bottom: 8px;"><strong>Most Common Cruise Altitude (AGL):</strong> ' + stats.most_common_cruise_altitude_ft.toLocaleString() + ' ft (' + cruiseAltM.toLocaleString() + ' m)</div>';
    }

    document.getElementById('stats-panel').innerHTML = html;
}

function toggleStats() {
    const panel = document.getElementById('stats-panel');

    if (panel.classList.contains('visible')) {
        // Hide with animation
        panel.classList.remove('visible');
        // Wait for animation to complete before hiding
        setTimeout(() => {
            panel.style.display = 'none';
            saveMapState();
        }, 300);
    } else {
        // Show with animation
        panel.style.display = 'block';
        // Trigger reflow to ensure transition works
        panel.offsetHeight;
        panel.classList.add('visible');
        saveMapState();
    }
}

function toggleHeatmap() {
    if (heatmapVisible) {
        if (heatmapLayer) {
            map.removeLayer(heatmapLayer);
        }
        heatmapVisible = false;
        document.getElementById('heatmap-btn').style.opacity = '0.5';
    } else {
        if (heatmapLayer) {
            map.addLayer(heatmapLayer);
            // Ensure heatmap is non-interactive after adding to map
            if (heatmapLayer._canvas) {
                heatmapLayer._canvas.style.pointerEvents = 'none';
            }
        }
        heatmapVisible = true;
        document.getElementById('heatmap-btn').style.opacity = '1.0';
    }
    saveMapState();
}

function toggleAltitude() {
    if (altitudeVisible) {
        // Don't allow hiding altitude during replay if airspeed is also hidden
        if (replayActive && !airspeedVisible) {
            return;
        }
        map.removeLayer(altitudeLayer);
        altitudeVisible = false;
        document.getElementById('altitude-btn').style.opacity = '0.5';
        document.getElementById('altitude-legend').style.display = 'none';
    } else {
        // Hide airspeed if it's visible
        if (airspeedVisible) {
            if (!replayActive) {
                map.removeLayer(airspeedLayer);
            }
            airspeedVisible = false;
            document.getElementById('airspeed-btn').style.opacity = '0.5';
            document.getElementById('airspeed-legend').style.display = 'none';
        }

        // During replay, don't add layer to map - just update state and legend
        if (!replayActive) {
            map.addLayer(altitudeLayer);
            redrawAltitudePaths();  // Draw altitude paths when enabled
        } else {
            // During replay: redraw the replay path with new altitude colors
            var savedTime = replayCurrentTime;
            var savedIndex = replayLastDrawnIndex;
            replayLayer.clearLayers();
            replayLastDrawnIndex = -1;

            // Redraw all segments up to current position with altitude colors
            for (var i = 0; i <= savedIndex && i < replaySegments.length; i++) {
                var seg = replaySegments[i];
                if (seg.time <= savedTime) {
                    var segmentColor = getColorForAltitude(
                        seg.altitude_ft,
                        replayColorMinAlt,
                        replayColorMaxAlt
                    );

                    L.polyline(seg.coords, {
                        color: segmentColor,
                        weight: 3,
                        opacity: 0.8
                    }).addTo(replayLayer);

                    replayLastDrawnIndex = i;
                }
            }
        }

        altitudeVisible = true;
        document.getElementById('altitude-btn').style.opacity = '1.0';
        document.getElementById('altitude-legend').style.display = 'block';
    }

    // Update airplane popup if it's open during replay
    if (replayActive && replayAirplaneMarker && replayAirplaneMarker.isPopupOpen()) {
        updateReplayAirplanePopup();
    }

    saveMapState();
}

function toggleAirspeed() {
    if (airspeedVisible) {
        // Don't allow hiding airspeed during replay if altitude is also hidden
        if (replayActive && !altitudeVisible) {
            return;
        }
        map.removeLayer(airspeedLayer);
        airspeedVisible = false;
        document.getElementById('airspeed-btn').style.opacity = '0.5';
        document.getElementById('airspeed-legend').style.display = 'none';
    } else {
        // Hide altitude if it's visible
        if (altitudeVisible) {
            if (!replayActive) {
                map.removeLayer(altitudeLayer);
            }
            altitudeVisible = false;
            document.getElementById('altitude-btn').style.opacity = '0.5';
            document.getElementById('altitude-legend').style.display = 'none';
        }

        // During replay, don't add layer to map - just update state and legend
        if (!replayActive) {
            map.addLayer(airspeedLayer);
            redrawAirspeedPaths();  // Draw airspeed paths when enabled
        } else {
            // During replay: redraw the replay path with new airspeed colors
            var savedTime = replayCurrentTime;
            var savedIndex = replayLastDrawnIndex;
            replayLayer.clearLayers();
            replayLastDrawnIndex = -1;

            // Redraw all segments up to current position with airspeed colors
            for (var i = 0; i <= savedIndex && i < replaySegments.length; i++) {
                var seg = replaySegments[i];
                if (seg.time <= savedTime && seg.groundspeed_knots > 0) {
                    var segmentColor = getColorForAltitude(
                        seg.groundspeed_knots,
                        replayColorMinSpeed,
                        replayColorMaxSpeed
                    );

                    L.polyline(seg.coords, {
                        color: segmentColor,
                        weight: 3,
                        opacity: 0.8
                    }).addTo(replayLayer);

                    replayLastDrawnIndex = i;
                }
            }
        }

        airspeedVisible = true;
        document.getElementById('airspeed-btn').style.opacity = '1.0';
        document.getElementById('airspeed-legend').style.display = 'block';
    }

    // Update airplane popup if it's open during replay
    if (replayActive && replayAirplaneMarker && replayAirplaneMarker.isPopupOpen()) {
        updateReplayAirplanePopup();
    }

    saveMapState();
}

function toggleAirports() {
    if (airportsVisible) {
        map.removeLayer(airportLayer);
        airportsVisible = false;
        document.getElementById('airports-btn').style.opacity = '0.5';
    } else {
        map.addLayer(airportLayer);
        airportsVisible = true;
        document.getElementById('airports-btn').style.opacity = '1.0';
    }
    saveMapState();
}

function toggleAviation() {
    if (OPENAIP_API_KEY && openaipLayers['Aviation Data']) {
        if (aviationVisible) {
            map.removeLayer(openaipLayers['Aviation Data']);
            aviationVisible = false;
            document.getElementById('aviation-btn').style.opacity = '0.5';
        } else {
            map.addLayer(openaipLayers['Aviation Data']);
            aviationVisible = true;
            document.getElementById('aviation-btn').style.opacity = '1.0';
        }
        saveMapState();
    }
}

// Replay functions
function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hours > 0) {
        return hours + ':' + minutes.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
    }
    return minutes + ':' + secs.toString().padStart(2, '0');
}

function toggleReplay() {
    const panel = document.getElementById('replay-controls');
    if (replayActive) {
        // Stop replay and hide panel
        stopReplay();
        panel.style.display = 'none';
        replayActive = false;
        document.getElementById('replay-btn').textContent = '▶️ Replay';

        // Remove replay-active class from body
        document.body.classList.remove('replay-active');

        // Remove airplane marker when closing replay completely
        if (replayAirplaneMarker) {
            map.removeLayer(replayAirplaneMarker);
            replayAirplaneMarker = null;
        }

        // Remove replay layer from map (important for mobile Safari touch events)
        if (replayLayer) {
            map.removeLayer(replayLayer);
        }

        // Restore visibility of other layers
        restoreLayerVisibility();

        // Ensure altitude layer is visible for path selection after replay
        // (paths are only clickable when altitude or airspeed layer is shown)
        if (!altitudeVisible && !airspeedVisible) {
            altitudeVisible = true;
            document.getElementById('altitude-btn').style.opacity = '1.0';
            document.getElementById('altitude-legend').style.display = 'block';
            // Add layer first, then redraw with a small delay for mobile Safari
            map.addLayer(altitudeLayer);
        }

        // Always force a redraw on mobile Safari to ensure click handlers work
        // This is necessary even if the layer was already visible before replay
        setTimeout(function() {
            if (altitudeVisible) {
                redrawAltitudePaths();
            } else if (airspeedVisible) {
                redrawAirspeedPaths();
            }
            // Force map to recognize the interactive elements
            map.invalidateSize();
        }, 100);

        // Update button opacity based on selection
        updateReplayButtonState();
        saveMapState();
    } else {
        // Check if exactly one path is selected
        if (selectedPathIds.size !== 1) {
            return;  // Do nothing if wrong number of paths selected
        }

        // Initialize and show replay
        if (initializeReplay()) {
            panel.style.display = 'block';
            replayActive = true;
            document.getElementById('replay-btn').textContent = '⏹️ Replay';
            document.getElementById('replay-btn').style.opacity = '1.0';

            // Initialize auto-zoom button style
            const autoZoomBtn = document.getElementById('replay-autozoom-btn');
            if (autoZoomBtn) {
                autoZoomBtn.style.opacity = replayAutoZoom ? '1.0' : '0.5';
                autoZoomBtn.title = replayAutoZoom ? 'Auto-zoom enabled' : 'Auto-zoom disabled';
            }

            // Add replay-active class to body for mobile legend hiding
            document.body.classList.add('replay-active');

            // Hide other layers during replay
            hideOtherLayersDuringReplay();
            saveMapState();
        }
    }
}

function updateReplayButtonState() {
    // Enable replay button only when exactly one path is selected
    const btn = document.getElementById('replay-btn');
    if (selectedPathIds.size === 1) {
        btn.style.opacity = '1.0';
    } else {
        btn.style.opacity = '0.5';
    }
}

function updateReplayAirplanePopup() {
    if (!replayAirplaneMarker || !replayActive) return;

    // Find the current segment for data
    var currentSegment = null;
    for (var i = 0; i < replaySegments.length; i++) {
        var seg = replaySegments[i];
        if (seg.time <= replayCurrentTime) {
            currentSegment = seg;
        } else {
            break;
        }
    }

    if (!currentSegment) {
        currentSegment = replaySegments[0];
    }

    // Build popup content
    var popupContent = '<div style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Arial, sans-serif; min-width: 180px; padding: 8px 4px; background-color: #2b2b2b; color: #ffffff;">';

    popupContent += '<div style="font-size: 14px; font-weight: bold; color: #4facfe; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 2px solid #4facfe; display: flex; align-items: center; gap: 6px;">';
    popupContent += '<span style="font-size: 16px;">✈️</span>';
    popupContent += '<span>Current Position</span>';
    popupContent += '</div>';

    // Altitude
    var altFt = currentSegment.altitude_ft;
    var altM = currentSegment.altitude_m;
    // Round altitude to nearest 50ft
    var altFtRounded = Math.round(altFt / 50) * 50;
    var altMRounded = Math.round(altFtRounded * 0.3048);
    // Get color based on current altitude using the same scale as the path
    var altColor = getColorForAltitude(altFt, replayColorMinAlt, replayColorMaxAlt);
    // Convert rgb color to rgba with transparency for background
    var altColorBg = altColor.replace('rgb(', 'rgba(').replace(')', ', 0.15)');
    popupContent += '<div style="margin-bottom: 8px;">';
    popupContent += '<div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Altitude (MSL)</div>';
    popupContent += '<div style="background: ' + altColorBg + '; padding: 6px 8px; border-radius: 6px; border-left: 3px solid ' + altColor + ';">';
    popupContent += '<span style="font-size: 16px; font-weight: bold; color: ' + altColor + ';">' + altFtRounded.toLocaleString() + ' ft</span>';
    popupContent += '<span style="font-size: 12px; color: #ccc; margin-left: 6px;">(' + altMRounded.toLocaleString() + ' m)</span>';
    popupContent += '</div>';
    popupContent += '</div>';

    // Groundspeed
    var speedKt = currentSegment.groundspeed_knots || 0;
    var speedKmh = speedKt * 1.852;
    // Round groundspeed to whole numbers
    var speedKtRounded = Math.round(speedKt);
    var speedKmhRounded = Math.round(speedKmh);
    // Get color based on current groundspeed using the same scale as the path
    var speedColor = getColorForAltitude(speedKt, replayColorMinSpeed, replayColorMaxSpeed);
    // Convert rgb color to rgba with transparency for background
    var speedColorBg = speedColor.replace('rgb(', 'rgba(').replace(')', ', 0.15)');
    popupContent += '<div style="margin-bottom: 8px;">';
    popupContent += '<div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Groundspeed</div>';
    popupContent += '<div style="background: ' + speedColorBg + '; padding: 6px 8px; border-radius: 6px; border-left: 3px solid ' + speedColor + ';">';
    popupContent += '<span style="font-size: 16px; font-weight: bold; color: ' + speedColor + ';">' + speedKtRounded.toLocaleString() + ' kt</span>';
    popupContent += '<span style="font-size: 12px; color: #ccc; margin-left: 6px;">(' + speedKmhRounded.toLocaleString() + ' km/h)</span>';
    popupContent += '</div>';
    popupContent += '</div>';

    popupContent += '</div>';

    // Update or create popup
    if (!replayAirplaneMarker.getPopup()) {
        replayAirplaneMarker.bindPopup(popupContent, {
            autoPanPadding: [50, 50]
        });
    } else {
        replayAirplaneMarker.getPopup().setContent(popupContent);
    }

    // Open the popup
    replayAirplaneMarker.openPopup();
}

function initializeReplay() {
    // Get all segments with time data from full resolution
    if (!fullPathSegments) {
        alert('No flight data available for replay. Please wait for data to load or refresh the page.');
        return false;
    }

    // Get the single selected path ID
    const selectedPathId = Array.from(selectedPathIds)[0];

    // Filter segments that belong to selected path and have time data
    replaySegments = fullPathSegments.filter(function(seg) {
        return seg.path_id === selectedPathId &&
               seg.time !== undefined &&
               seg.time !== null;
    });

    if (replaySegments.length === 0) {
        alert('No timestamp data available for this path. The flight may not have timing information.');
        return false;
    }

    // Sort by time
    replaySegments.sort(function(a, b) {
        return a.time - b.time;
    });

    // Calculate color ranges from CURRENT RESOLUTION data (not full resolution)
    // This ensures replay colors match the selected path colors on screen
    if (currentData && currentData.path_segments) {
        var currentResSegments = currentData.path_segments.filter(function(seg) {
            return seg.path_id === selectedPathId;
        });

        if (currentResSegments.length > 0) {
            // Use current resolution altitude range
            var altitudes = currentResSegments.map(function(s) { return s.altitude_ft; });
            replayColorMinAlt = Math.min(...altitudes);
            replayColorMaxAlt = Math.max(...altitudes);

            // Use current resolution groundspeed range
            var groundspeeds = currentResSegments
                .map(function(s) { return s.groundspeed_knots; })
                .filter(function(s) { return s > 0; });
            if (groundspeeds.length > 0) {
                replayColorMinSpeed = Math.min(...groundspeeds);
                replayColorMaxSpeed = Math.max(...groundspeeds);
            } else {
                replayColorMinSpeed = airspeedRange.min;
                replayColorMaxSpeed = airspeedRange.max;
            }
        } else {
            // Fallback to full resolution if current resolution not available
            var altitudes = replaySegments.map(function(s) { return s.altitude_ft; });
            replayColorMinAlt = Math.min(...altitudes);
            replayColorMaxAlt = Math.max(...altitudes);

            var groundspeeds = replaySegments
                .map(function(s) { return s.groundspeed_knots; })
                .filter(function(s) { return s > 0; });
            if (groundspeeds.length > 0) {
                replayColorMinSpeed = Math.min(...groundspeeds);
                replayColorMaxSpeed = Math.max(...groundspeeds);
            } else {
                replayColorMinSpeed = airspeedRange.min;
                replayColorMaxSpeed = airspeedRange.max;
            }
        }
    }

    // Find max time
    replayMaxTime = replaySegments[replaySegments.length - 1].time;

    // Update UI
    document.getElementById('replay-slider').max = replayMaxTime;
    document.getElementById('replay-slider-end').textContent = formatTime(replayMaxTime);

    // Update legends to show selected path's color ranges
    updateAltitudeLegend(replayColorMinAlt, replayColorMaxAlt);
    updateAirspeedLegend(replayColorMinSpeed, replayColorMaxSpeed);

    // Create replay layer
    if (!replayLayer) {
        replayLayer = L.layerGroup();
    }
    replayLayer.clearLayers();
    replayLayer.addTo(map);

    // Remove old airplane marker if it exists
    if (replayAirplaneMarker) {
        map.removeLayer(replayAirplaneMarker);
        replayAirplaneMarker = null;
    }

    // Create airplane marker
    var airplaneIcon = L.divIcon({
        html: '<div class="replay-airplane-icon">✈️</div>',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        className: ''
    });

    // Position at start of path
    var startCoords = replaySegments[0].coords[0];
    replayAirplaneMarker = L.marker([startCoords[0], startCoords[1]], {
        icon: airplaneIcon,
        zIndexOffset: 1000
    });
    replayAirplaneMarker.addTo(map);

    // Add smooth CSS transition to the marker element for fluid movement
    // Using a shorter transition time (80ms) to keep up with high speed playback (100x, 200x)
    var markerElement = replayAirplaneMarker.getElement();
    if (markerElement) {
        markerElement.style.transition = 'transform 0.08s linear';
        markerElement.style.cursor = 'pointer';
        markerElement.style.pointerEvents = 'auto';

        // Add click handler directly to the DOM element for better reliability
        markerElement.addEventListener('click', function(e) {
            e.stopPropagation();
            if (replayAirplaneMarker.isPopupOpen()) {
                replayAirplaneMarker.closePopup();
            } else {
                updateReplayAirplanePopup();
            }
        });
    }

    // Reset time and drawing state
    replayCurrentTime = 0;
    replayLastDrawnIndex = -1;
    replayLastBearing = null;

    // Set initial zoom level to show takeoff details at airport
    // Only do this if auto-zoom is enabled, otherwise respect user's current zoom
    if (replayAutoZoom) {
        map.setView([startCoords[0], startCoords[1]], 16, { animate: true, duration: 0.8 });
        replayLastZoom = 16;
    } else {
        // Just center on start position without changing zoom
        map.panTo([startCoords[0], startCoords[1]], { animate: true, duration: 0.8 });
    }

    updateReplayDisplay();

    return true;
}

function hideOtherLayersDuringReplay() {
    // Hide heatmap
    if (heatmapLayer && heatmapVisible) {
        map.removeLayer(heatmapLayer);
    }

    // Hide altitude layer but keep legend visible if it was visible
    if (altitudeVisible) {
        map.removeLayer(altitudeLayer);
        // Keep altitude legend visible during replay
    }

    // Hide airspeed layer but keep legend visible if it was visible
    if (airspeedVisible) {
        map.removeLayer(airspeedLayer);
        // Keep airspeed legend visible during replay
    }

    // Disable layer toggle buttons and filters during replay
    // BUT keep altitude and airspeed buttons enabled for profile switching
    document.getElementById('heatmap-btn').disabled = true;
    document.getElementById('airports-btn').disabled = true;
    document.getElementById('aviation-btn').disabled = true;
    document.getElementById('year-select').disabled = true;
    document.getElementById('aircraft-select').disabled = true;
}

function restoreLayerVisibility() {
    // Restore heatmap
    if (heatmapLayer && heatmapVisible) {
        map.addLayer(heatmapLayer);
        if (heatmapLayer._canvas) {
            heatmapLayer._canvas.style.pointerEvents = 'none';
        }
    }

    // Restore altitude layer (legend was kept visible during replay)
    if (altitudeVisible) {
        // Add layer first, then redraw with delay for mobile Safari
        map.addLayer(altitudeLayer);
        setTimeout(function() {
            // Redraw altitude paths to ensure click handlers work on mobile Safari
            redrawAltitudePaths();
            map.invalidateSize();
        }, 50);
        // Legend stays visible, no need to re-show
    }

    // Restore airspeed layer (legend was kept visible during replay)
    if (airspeedVisible) {
        // Add layer first, then redraw with delay for mobile Safari
        map.addLayer(airspeedLayer);
        setTimeout(function() {
            // Redraw airspeed paths to ensure click handlers work on mobile Safari
            redrawAirspeedPaths();
            map.invalidateSize();
        }, 50);
        // Legend stays visible, no need to re-show
    }

    // Re-enable layer toggle buttons and filters
    // (altitude and airspeed were never disabled during replay)
    document.getElementById('heatmap-btn').disabled = false;
    document.getElementById('airports-btn').disabled = false;
    document.getElementById('aviation-btn').disabled = false;
    document.getElementById('year-select').disabled = false;
    document.getElementById('aircraft-select').disabled = false;
}

function playReplay() {
    if (!replayActive) return;

    // If at the end, restart from beginning
    if (replayCurrentTime >= replayMaxTime) {
        replayCurrentTime = 0;
        replayLastDrawnIndex = -1;
        replayLayer.clearLayers();

        // Reset airplane to start position
        if (replayAirplaneMarker && replaySegments.length > 0) {
            var startCoords = replaySegments[0].coords[0];
            replayAirplaneMarker.setLatLng([startCoords[0], startCoords[1]]);

            // Reset to initial zoom if auto-zoom is enabled
            if (replayAutoZoom) {
                map.setView([startCoords[0], startCoords[1]], 16, { animate: true, duration: 0.5 });
                replayLastZoom = 16;
            }
        }

        // Reset recenter tracking
        replayRecenterTimestamps = [];
        replayLastBearing = null;
    }

    replayPlaying = true;
    document.getElementById('replay-play-btn').style.display = 'none';
    document.getElementById('replay-pause-btn').style.display = 'inline-block';

    // Reset frame time for smooth animation start
    replayLastFrameTime = null;

    // Start animation loop using requestAnimationFrame for browser-synchronized updates
    function animateReplay(timestamp) {
        if (!replayPlaying) return;

        // Calculate delta time based on actual elapsed time
        if (replayLastFrameTime === null) {
            replayLastFrameTime = timestamp;
        }
        const deltaMs = timestamp - replayLastFrameTime;
        replayLastFrameTime = timestamp;

        // Update replay time based on actual elapsed time and speed multiplier
        const deltaTime = (deltaMs / 1000) * replaySpeed;
        replayCurrentTime += deltaTime;

        if (replayCurrentTime >= replayMaxTime) {
            replayCurrentTime = replayMaxTime;
            pauseReplay();

            // Zoom out to show the full path when replay ends
            if (replaySegments.length > 0) {
                // Collect all coordinates from the path
                var allCoords = [];
                replaySegments.forEach(function(seg) {
                    if (seg.coords && seg.coords.length > 0) {
                        seg.coords.forEach(function(coord) {
                            allCoords.push(coord);
                        });
                    }
                });

                // Fit the map to show all coordinates
                if (allCoords.length > 0) {
                    var bounds = L.latLngBounds(allCoords);
                    map.fitBounds(bounds, {
                        padding: [50, 50],
                        animate: true,
                        duration: 1.0
                    });
                }
            }
        } else {
            // Continue animation loop
            replayAnimationFrameId = requestAnimationFrame(animateReplay);
        }

        updateReplayDisplay();
    }

    // Start the animation
    replayAnimationFrameId = requestAnimationFrame(animateReplay);
    saveMapState();
}

function pauseReplay() {
    replayPlaying = false;
    document.getElementById('replay-play-btn').style.display = 'inline-block';
    document.getElementById('replay-pause-btn').style.display = 'none';

    // Cancel animation frame
    if (replayAnimationFrameId) {
        cancelAnimationFrame(replayAnimationFrameId);
        replayAnimationFrameId = null;
    }

    // Reset frame time
    replayLastFrameTime = null;
    saveMapState();
}

function stopReplay() {
    pauseReplay();
    replayCurrentTime = 0;
    replayLastDrawnIndex = -1;
    replayLastBearing = null;  // Reset bearing
    replayRecenterTimestamps = [];  // Reset recenter tracking
    if (replayLayer) {
        replayLayer.clearLayers();
    }
    // Reset airplane to start position instead of removing it
    if (replayAirplaneMarker && replaySegments.length > 0) {
        var startCoords = replaySegments[0].coords[0];
        replayAirplaneMarker.setLatLng([startCoords[0], startCoords[1]]);
    }
    updateReplayDisplay();
}

function seekReplay(value) {
    var newTime = parseFloat(value);

    // If seeking backward, need to clear and redraw
    if (newTime < replayCurrentTime) {
        replayLayer.clearLayers();
        replayLastDrawnIndex = -1;
    }

    replayCurrentTime = newTime;
    updateReplayDisplay(true); // Pass true to indicate this is a manual seek
    saveMapState();
}

function changeReplaySpeed() {
    const select = document.getElementById('replay-speed');
    replaySpeed = parseFloat(select.value);
    saveMapState();
}

function updateReplayDisplay(isManualSeek) {
    // Update time display
    document.getElementById('replay-time-display').textContent =
        formatTime(replayCurrentTime) + ' / ' + formatTime(replayMaxTime);

    // Update slider position
    document.getElementById('replay-slider').value = replayCurrentTime;
    document.getElementById('replay-slider-start').textContent = formatTime(replayCurrentTime);

    // Find current position in replay timeline (for airplane positioning)
    var lastSegment = null;
    var nextSegment = null;
    var currentIndex = -1;

    // Search through ALL segments to find airplane position
    for (var i = 0; i < replaySegments.length; i++) {
        var seg = replaySegments[i];
        if (seg.time <= replayCurrentTime) {
            lastSegment = seg;
            currentIndex = i;
        } else {
            // Found the next segment beyond current time
            nextSegment = seg;
            break;
        }
    }

    // Draw path segments (separate loop for incremental rendering)
    if (replayLayer) {
        // Determine which color scheme to use based on visible layer
        var useAirspeedColors = airspeedVisible && !altitudeVisible;

        for (var i = 0; i < replaySegments.length; i++) {
            var seg = replaySegments[i];
            // Don't draw any segments when at time 0 (stopped/reset state)
            if (seg.time <= replayCurrentTime && replayCurrentTime > 0) {
                // Only draw if we haven't drawn this segment yet (incremental rendering)
                if (i > replayLastDrawnIndex) {
                    // Calculate color based on selected profile using replay-specific ranges
                    var segmentColor;
                    if (useAirspeedColors && seg.groundspeed_knots > 0) {
                        // Use airspeed colors with selected path's groundspeed range
                        segmentColor = getColorForAltitude(
                            seg.groundspeed_knots,
                            replayColorMinSpeed,
                            replayColorMaxSpeed
                        );
                    } else {
                        // Use altitude colors with selected path's altitude range (default)
                        segmentColor = getColorForAltitude(
                            seg.altitude_ft,
                            replayColorMinAlt,
                            replayColorMaxAlt
                        );
                    }

                    L.polyline(seg.coords, {
                        color: segmentColor,
                        weight: 3,
                        opacity: 0.8
                    }).addTo(replayLayer);

                    // Update last drawn index incrementally during the loop
                    replayLastDrawnIndex = i;
                }
            } else {
                break;
            }
        }
    }

    // Update airplane marker position and rotation
    // Ensure marker is on the map (in case it was removed during seeking/zooming)
    if (replayAirplaneMarker && !map.hasLayer(replayAirplaneMarker)) {
        replayAirplaneMarker.addTo(map);
    }

    if (replayAirplaneMarker) {
        // If we have a lastSegment, use it for positioning
        if (lastSegment) {
        var currentPos;
        var bearing = 0;

        if (nextSegment && lastSegment.time < replayCurrentTime) {
            // Interpolate between last and next segment
            var timeFraction = (replayCurrentTime - lastSegment.time) / (nextSegment.time - lastSegment.time);
            var lat1 = lastSegment.coords[1][0];
            var lon1 = lastSegment.coords[1][1];
            var lat2 = nextSegment.coords[0][0];
            var lon2 = nextSegment.coords[0][1];

            currentPos = [
                lat1 + (lat2 - lat1) * timeFraction,
                lon1 + (lon2 - lon1) * timeFraction
            ];

            // Calculate bearing for rotation
            bearing = calculateBearing(lat1, lon1, lat2, lon2);
        } else {
            // Use end of last segment
            currentPos = lastSegment.coords[1];

            // Calculate bearing from this segment
            var lat1 = lastSegment.coords[0][0];
            var lon1 = lastSegment.coords[0][1];
            var lat2 = lastSegment.coords[1][0];
            var lon2 = lastSegment.coords[1][1];
            bearing = calculateBearing(lat1, lon1, lat2, lon2);
        }

        // Calculate smoothed bearing by looking ahead several segments
        var smoothedBearing = calculateSmoothedBearing(currentIndex, 5);
        if (smoothedBearing !== null) {
            bearing = smoothedBearing;
            replayLastBearing = bearing;  // Store for use when stationary
        } else if (replayLastBearing !== null) {
            // Plane is stationary - use last known bearing to avoid rotation jitter
            bearing = replayLastBearing;
        }

        // Update marker position
        // The CSS transition on the marker element provides smooth movement
        replayAirplaneMarker.setLatLng(currentPos);

        // Auto-pan map if airplane is near viewport edge (when playing or manually seeking)
        if (replayPlaying || isManualSeek) {
            var mapSize = map.getSize();
            var airplanePoint = map.latLngToContainerPoint(currentPos);

            // Define margin from edge (in pixels) before triggering pan
            // Smaller margin allows airplane to get closer to edges before recentering
            var marginPercent = 0.10; // 10% margin from each edge
            var marginX = mapSize.x * marginPercent;
            var marginY = mapSize.y * marginPercent;

            // Check if airplane is approaching edges - if so, center on airplane
            var needsRecenter = false;
            if (airplanePoint.x < marginX || airplanePoint.x > mapSize.x - marginX ||
                airplanePoint.y < marginY || airplanePoint.y > mapSize.y - marginY) {
                needsRecenter = true;
            }

            // For manual seek, always center on airplane position
            if (isManualSeek) {
                needsRecenter = true;
            }

            // Center map on airplane instead of incremental panning
            if (needsRecenter) {
                map.panTo(currentPos, { animate: true, duration: 0.5, easeLinearity: 0.25, noMoveStart: true });

                // Track recenter events for auto-zoom using sliding window
                var now = Date.now();
                replayRecenterTimestamps.push(now);

                // Remove timestamps older than 30 seconds (sliding window)
                var cutoffTime = now - 30000; // 30 seconds ago
                replayRecenterTimestamps = replayRecenterTimestamps.filter(function(ts) {
                    return ts > cutoffTime;
                });
            }

            // Auto-zoom based on map recenter frequency
            if (replayAutoZoom) {
                // Clean up old timestamps from sliding window
                var now = Date.now();
                var cutoffTime = now - 30000;
                replayRecenterTimestamps = replayRecenterTimestamps.filter(function(ts) {
                    return ts > cutoffTime;
                });

                var recenterCount = replayRecenterTimestamps.length;

                // Trigger zoom-out when more than 2 recenters happen within 5 seconds
                if (recenterCount > 2) {
                    // Check if we have more than 2 recenters within the last 5 seconds
                    var now = Date.now();
                    var fiveSecondsAgo = now - 5000;
                    var recentRecenters = replayRecenterTimestamps.filter(function(ts) {
                        return ts >= fiveSecondsAgo;
                    });

                    if (recentRecenters.length > 2) {
                        // More than 2 recenters in 5 seconds - zoom out aggressively
                        var zoomOutStep = 0;

                        // Calculate how fast the recenters are happening
                        var oldestRecent = Math.min(...recentRecenters);
                        var newestRecent = Math.max(...recentRecenters);
                        var recentWindow = (newestRecent - oldestRecent) / 1000;
                        var avgInterval = recentWindow / (recentRecenters.length - 1);

                        // Always zoom out 1 level for fine-granular control
                        var zoomOutStep = 1;

                        // Only zoom out, never zoom in
                        // Zoom out by 1 level, but don't go below level 9
                        if (zoomOutStep > 0 && replayLastZoom !== null && replayLastZoom > 9) {
                            var newZoom = Math.max(9, replayLastZoom - zoomOutStep);

                            // Zoom out without recentering
                            map.setZoom(newZoom, { animate: true, duration: 0.5 });
                            replayLastZoom = newZoom;

                            // Clear ALL recenter timestamps after zoom-out to allow fresh evaluation
                            // This prevents immediate re-triggering with the same old timestamps
                            replayRecenterTimestamps = [];
                        }
                    }
                }
            }
        }

        // Update rotation using hardware-accelerated transforms
        // Airplane emoji typically points right/northeast, adjust to match bearing
        // The offset may vary by system - adjust if airplane orientation looks wrong
        var iconElement = replayAirplaneMarker.getElement();
        if (iconElement) {
            var iconDiv = iconElement.querySelector('.replay-airplane-icon');
            if (iconDiv) {
                // Most systems: emoji points at ~45° (northeast), so adjust by -45°
                var adjustedBearing = bearing - 45;
                // Use translate3d(0,0,0) to force hardware acceleration
                iconDiv.style.transform = 'translate3d(0,0,0) rotate(' + adjustedBearing + 'deg)';
            }
        }
        } else if (replaySegments.length > 0) {
            // No segment yet (at start of replay) - position at first coordinate
            var startCoords = replaySegments[0].coords[0];
            replayAirplaneMarker.setLatLng([startCoords[0], startCoords[1]]);
        }
    }

    // Update popup content if it's open
    if (replayAirplaneMarker && replayAirplaneMarker.getPopup() && replayAirplaneMarker.isPopupOpen()) {
        updateReplayAirplanePopup();
    }
}

function calculateSmoothedBearing(currentIdx, lookAhead) {
    // Calculate bearing by looking ahead several segments to smooth out GPS noise
    if (currentIdx < 0 || currentIdx >= replaySegments.length) {
        return null;
    }

    var startSeg = replaySegments[currentIdx];
    var endIdx = Math.min(currentIdx + lookAhead, replaySegments.length - 1);
    var endSeg = replaySegments[endIdx];

    var lat1 = startSeg.coords[1][0];
    var lon1 = startSeg.coords[1][1];
    var lat2 = endSeg.coords[1][0];
    var lon2 = endSeg.coords[1][1];

    // Calculate distance to check if plane is moving
    // Using Haversine formula
    var φ1 = lat1 * Math.PI / 180;
    var φ2 = lat2 * Math.PI / 180;
    var Δφ = (lat2 - lat1) * Math.PI / 180;
    var Δλ = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    var distanceKm = 6371 * c;

    // Only return bearing if plane has moved at least 50 meters
    // This prevents rotation jitter when stationary on the ground
    if (distanceKm < 0.05) {
        return null;
    }

    return calculateBearing(lat1, lon1, lat2, lon2);
}

function calculateBearing(lat1, lon1, lat2, lon2) {
    // Convert to radians
    var φ1 = lat1 * Math.PI / 180;
    var φ2 = lat2 * Math.PI / 180;
    var Δλ = (lon2 - lon1) * Math.PI / 180;

    // Calculate bearing
    var y = Math.sin(Δλ) * Math.cos(φ2);
    var x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    var θ = Math.atan2(y, x);

    // Convert to degrees
    return (θ * 180 / Math.PI + 360) % 360;
}

function exportMap() {
    const btn = document.getElementById('export-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Exporting...';

    const mapContainer = document.getElementById('map');
    const controls = [
        document.querySelector('.leaflet-control-zoom'),
        document.getElementById('stats-btn'),
        document.getElementById('export-btn'),
        document.getElementById('wrapped-btn'),
        document.getElementById('replay-btn'),
        document.getElementById('year-filter'),
        document.getElementById('aircraft-filter'),
        document.getElementById('heatmap-btn'),
        document.getElementById('altitude-btn'),
        document.getElementById('airspeed-btn'),
        document.getElementById('airports-btn'),
        document.getElementById('aviation-btn'),
        document.getElementById('stats-panel'),
        document.getElementById('altitude-legend'),
        document.getElementById('airspeed-legend'),
        document.getElementById('loading')
    ];

    const displayStates = controls.map(el => el ? el.style.display : null);
    controls.forEach(el => { if (el) el.style.display = 'none'; });

    setTimeout(function() {
        domtoimage.toJpeg(mapContainer, {
            width: mapContainer.offsetWidth * 2,
            height: mapContainer.offsetHeight * 2,
            bgcolor: '#1a1a1a',
            quality: 0.95,
            style: {
                transform: 'scale(2)',
                transformOrigin: 'top left'
            }
        }).then(function(dataUrl) {
            controls.forEach((el, i) => { if (el) el.style.display = displayStates[i] || ''; });
            btn.disabled = false;
            btn.textContent = '📷 Export';

            const link = document.createElement('a');
            link.download = 'heatmap_' + new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-') + '.jpg';
            link.href = dataUrl;
            link.click();
        }).catch(function(error) {
            controls.forEach((el, i) => { if (el) el.style.display = displayStates[i] || ''; });
            alert('Export failed: ' + error.message);
            btn.disabled = false;
            btn.textContent = '📷 Export';
        });
    }, 200);
}

// Generate dynamic fun facts based on data
function generateFunFacts(yearStats) {
    const allFacts = [];

    // Distance comparisons
    const earthCircumferenceKm = 40075;
    const everestHeightFt = 29032;
    const everestHeightM = 8849;
    const commercialCruiseAltFt = 35000;

    // Famous flight routes (approximate great circle distances)
    const newYorkToLondonKm = 5585;
    const newYorkToLAKm = 3944;
    const parisToTokyoKm = 9715;
    const londonToSydneyKm = 17015;
    const berlinToNewYorkKm = 6385;

    const totalDistanceKm = yearStats.total_distance_nm * 1.852;
    const timesAroundEarth = totalDistanceKm / earthCircumferenceKm;

    // Distance facts
    if (timesAroundEarth >= 0.5) {
        allFacts.push({
            category: 'distance',
            icon: '🌍',
            text: `You flew <strong>${timesAroundEarth.toFixed(1)}x</strong> around the Earth`,
            priority: timesAroundEarth >= 1 ? 10 : 7
        });
    }

    // Compare to famous routes
    if (totalDistanceKm >= londonToSydneyKm) {
        const timesLondonSydney = (totalDistanceKm / londonToSydneyKm).toFixed(1);
        allFacts.push({
            category: 'distance',
            icon: '✈️',
            text: `Your <strong>${yearStats.total_distance_nm.toFixed(0)} nm</strong> could fly you London to Sydney <strong>${timesLondonSydney}x</strong>`,
            priority: 9
        });
    } else if (totalDistanceKm >= parisToTokyoKm) {
        const timesParisToTokyo = (totalDistanceKm / parisToTokyoKm).toFixed(1);
        allFacts.push({
            category: 'distance',
            icon: '🗼',
            text: `Your <strong>${yearStats.total_distance_nm.toFixed(0)} nm</strong> could fly you Paris to Tokyo <strong>${timesParisToTokyo}x</strong>`,
            priority: 8
        });
    } else if (totalDistanceKm >= berlinToNewYorkKm) {
        const timesBerlinNY = (totalDistanceKm / berlinToNewYorkKm).toFixed(1);
        allFacts.push({
            category: 'distance',
            icon: '🗽',
            text: `Your <strong>${yearStats.total_distance_nm.toFixed(0)} nm</strong> could fly you Berlin to New York <strong>${timesBerlinNY}x</strong>`,
            priority: 7
        });
    } else if (totalDistanceKm >= newYorkToLAKm) {
        const timesNYToLA = (totalDistanceKm / newYorkToLAKm).toFixed(1);
        allFacts.push({
            category: 'distance',
            icon: '🌉',
            text: `Your <strong>${yearStats.total_distance_nm.toFixed(0)} nm</strong> could fly you New York to LA <strong>${timesNYToLA}x</strong>`,
            priority: 6
        });
    }


    // Altitude facts (from fullStats) - only elevation gain, not max altitude
    if (fullStats && fullStats.total_altitude_gain_ft) {
        const gainFt = Math.round(fullStats.total_altitude_gain_ft);
        const timesEverest = gainFt / everestHeightFt;

        if (timesEverest >= 1) {
            allFacts.push({
                category: 'altitude',
                icon: '⬆️',
                text: `You climbed <strong>${gainFt.toLocaleString()} ft</strong> - that's scaling Everest <strong>${timesEverest.toFixed(1)}x</strong>!`,
                priority: 9
            });
        } else if (gainFt > 10000) {
            allFacts.push({
                category: 'altitude',
                icon: '⬆️',
                text: `Total elevation gain: <strong>${gainFt.toLocaleString()} ft</strong>`,
                priority: 5
            });
        }
    }

    // Time-based facts
    if (fullStats && fullStats.total_flight_time_seconds) {
        const totalHours = fullStats.total_flight_time_seconds / 3600;
        const totalDays = totalHours / 24;
        const hoursPerYear = 8760;
        const percentOfYear = (totalHours / hoursPerYear * 100).toFixed(2);

        if (totalDays >= 1) {
            allFacts.push({
                category: 'time',
                icon: '⏱️',
                text: `You spent <strong>${totalDays.toFixed(1)} days</strong> in the air - that's <strong>${percentOfYear}%</strong> of the year!`,
                priority: 8
            });
        } else if (totalHours >= 10) {
            allFacts.push({
                category: 'time',
                icon: '⏰',
                text: `Total airtime: <strong>${totalHours.toFixed(1)} hours</strong>`,
                priority: 5
            });
        }
    }

    // Cruise speed fun fact (with average distance per trip)
    if (fullStats && fullStats.cruise_speed_knots && fullStats.cruise_speed_knots > 0 && yearStats.total_flights > 0) {
        const cruiseSpeedKt = Math.round(fullStats.cruise_speed_knots);
        const avgDistanceNm = Math.round(yearStats.total_distance_nm / yearStats.total_flights);
        allFacts.push({
            category: 'speed',
            icon: '✈️',
            text: `Cruising at <strong>${cruiseSpeedKt} kt</strong>, averaging <strong>${avgDistanceNm} nm</strong> per adventure`,
            priority: 8
        });
    }

    // Longest flight fun facts
    if (fullStats && fullStats.longest_flight_nm && fullStats.longest_flight_nm > 0) {
        const longestFlightNm = fullStats.longest_flight_nm;
        const longestFlightKm = fullStats.longest_flight_km;

        // Famous distances for comparison
        const munichToHamburgKm = 612;  // Similar to longest flight!
        const berlinToMunichKm = 504;
        const frankfurtToViennaKm = 516;
        const parisToBarcelonaKm = 831;
        const londonToEdinburghKm = 534;

        if (longestFlightKm >= munichToHamburgKm * 0.9 && longestFlightKm <= munichToHamburgKm * 1.1) {
            allFacts.push({
                category: 'distance',
                icon: '🛫',
                text: `Your longest adventure was <strong>${longestFlightNm.toFixed(0)} nm</strong> - like flying Munich to Hamburg!`,
                priority: 8
            });
        } else if (longestFlightKm >= berlinToMunichKm * 0.9) {
            allFacts.push({
                category: 'distance',
                icon: '🛫',
                text: `Your longest journey: <strong>${longestFlightNm.toFixed(0)} nm</strong> - that's Berlin to Munich distance!`,
                priority: 8
            });
        } else if (longestFlightKm >= 200) {
            allFacts.push({
                category: 'distance',
                icon: '🛫',
                text: `Your longest single flight covered <strong>${longestFlightNm.toFixed(0)} nm</strong> (<strong>${longestFlightKm.toFixed(0)} km</strong>)`,
                priority: 7
            });
        }
    }

    // Most common cruise altitude fun facts
    if (fullStats && fullStats.most_common_cruise_altitude_ft && fullStats.most_common_cruise_altitude_ft > 0) {
        const cruiseAltFt = fullStats.most_common_cruise_altitude_ft;
        const cruiseAltM = Math.round(fullStats.most_common_cruise_altitude_m);

        // Famous heights for comparison
        const eiffelTowerM = 330;
        const empireStateBuildingM = 381;
        const berlinTVTowerM = 368;
        const cologneMonM = 157;

        if (cruiseAltM >= empireStateBuildingM * 0.9 && cruiseAltM <= empireStateBuildingM * 1.3) {
            allFacts.push({
                category: 'altitude',
                icon: '🏔️',
                text: `Your sweet spot: <strong>${cruiseAltFt.toLocaleString()} ft</strong> AGL - about the height of the Empire State Building!`,
                priority: 8
            });
        } else if (cruiseAltM >= eiffelTowerM * 0.9 && cruiseAltM <= eiffelTowerM * 1.5) {
            allFacts.push({
                category: 'altitude',
                icon: '🗼',
                text: `Preferred cruise altitude: <strong>${cruiseAltFt.toLocaleString()} ft</strong> AGL - like flying over the Eiffel Tower!`,
                priority: 8
            });
        } else if (cruiseAltFt >= 1000 && cruiseAltFt <= 3000) {
            allFacts.push({
                category: 'altitude',
                icon: '✈️',
                text: `You love the low-level views at <strong>${cruiseAltFt.toLocaleString()} ft</strong> AGL - classic VFR territory!`,
                priority: 7
            });
        } else if (cruiseAltFt > 3000) {
            allFacts.push({
                category: 'altitude',
                icon: '⬆️',
                text: `Most common cruise: <strong>${cruiseAltFt.toLocaleString()} ft</strong> AGL (<strong>${cruiseAltM.toLocaleString()} m</strong>)`,
                priority: 7
            });
        }
    }

    // Aircraft fun facts
    if (fullStats && fullStats.aircraft_list && fullStats.aircraft_list.length > 0) {
        const primaryAircraft = fullStats.aircraft_list[0];
        const totalAircraft = fullStats.aircraft_list.length;

        const primaryModel = primaryAircraft.model || primaryAircraft.type || 'aircraft';

        if (totalAircraft === 1) {
            allFacts.push({
                category: 'aircraft',
                icon: '✈️',
                text: `Loyal to <strong>${primaryAircraft.registration}</strong> - all ${primaryAircraft.flights} flights in this ${primaryModel}!`,
                priority: 9
            });
        } else if (totalAircraft >= 4) {
            allFacts.push({
                category: 'aircraft',
                icon: '🛩️',
                text: `You explored <strong>${totalAircraft} different aircraft</strong> - a true aviator!`,
                priority: 9
            });
        } else {
            allFacts.push({
                category: 'aircraft',
                icon: '✈️',
                text: `Your go-to: <strong>${primaryAircraft.registration}</strong> (${primaryModel}) with <strong>${primaryAircraft.flights} flights</strong>`,
                priority: 9
            });
        }
    }

    // Special achievements
    if (fullStats && fullStats.max_altitude_ft > 40000) {
        allFacts.push({
            category: 'achievement',
            icon: '🚀',
            text: `You're practically an astronaut at <strong>${Math.round(fullStats.max_altitude_ft).toLocaleString()} ft</strong>!`,
            priority: 10
        });
    }

    // Sort by priority (highest first) and select top facts
    allFacts.sort((a, b) => b.priority - a.priority);

    // Select diverse facts - aim for 4-6 facts from different categories
    const selectedFacts = [];
    const usedCategories = new Set();
    const maxFactsPerCategory = 2;
    const categoryCount = {};

    for (const fact of allFacts) {
        const catCount = categoryCount[fact.category] || 0;

        // Add fact if we haven't maxed out this category yet
        if (catCount < maxFactsPerCategory) {
            selectedFacts.push(fact);
            categoryCount[fact.category] = catCount + 1;
            usedCategories.add(fact.category);

            // Stop when we have enough facts
            if (selectedFacts.length >= 6) break;
        }
    }

    // If we still need more facts, add remaining high-priority ones
    if (selectedFacts.length < 4) {
        for (const fact of allFacts) {
            if (!selectedFacts.includes(fact)) {
                selectedFacts.push(fact);
                if (selectedFacts.length >= 4) break;
            }
        }
    }

    return selectedFacts;
}

// Store original map parent for restoring later
let originalMapParent = null;
let originalMapIndex = 0;

// Wrapped card functionality
function showWrapped() {
    // Use the currently selected year (including 'all')
    const year = selectedYear;

    // Calculate stats for selected year
    const yearStats = calculateYearStats(year);

    // Update title and year display based on selection
    if (year === 'all') {
        document.getElementById('wrapped-title').textContent = '✨ Your Flight History';
        document.getElementById('wrapped-year').textContent = 'All Years';
    } else {
        document.getElementById('wrapped-title').textContent = '✨ Your Year in Flight';
        document.getElementById('wrapped-year').textContent = year;
    }

    // Build stats grid (6 cards: changed Max Speed to Max Groundspeed, added Max Altitude)
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
            <div class="stat-value">${(fullStats.max_groundspeed_knots || 0).toFixed(0)} kt</div>
            <div class="stat-label">Max Groundspeed</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${Math.round(fullStats.max_altitude_ft || 0).toLocaleString()} ft</div>
            <div class="stat-label">Max Altitude (MSL)</div>
        </div>
    `;

    document.getElementById('wrapped-stats').innerHTML = statsHtml;

    // Build fun facts section with dynamic, varied facts
    const funFacts = generateFunFacts(yearStats);

    let funFactsHtml = '<div class="fun-facts-title">✨ Facts</div>';
    funFacts.forEach(function(fact) {
        funFactsHtml += `<div class="fun-fact" data-category="${fact.category}"><span class="fun-fact-icon">${fact.icon}</span><span class="fun-fact-text">${fact.text}</span></div>`;
    });

    document.getElementById('wrapped-fun-facts').innerHTML = funFactsHtml;

    // Build aircraft fleet section using year-filtered data
    if (yearStats.aircraft_list && yearStats.aircraft_list.length > 0) {
        let fleetHtml = '<div class="aircraft-fleet-title">✈️ Fleet</div>';

        // Show all aircraft sorted by flight count with color coding based on flights
        const maxFlights = yearStats.aircraft_list[0].flights;
        const minFlights = yearStats.aircraft_list[yearStats.aircraft_list.length - 1].flights;
        const flightRange = maxFlights - minFlights;

        yearStats.aircraft_list.forEach(function(aircraft, index) {
            // Use full model if available, otherwise fall back to type
            const modelStr = aircraft.model || aircraft.type || '';

            // Calculate color based on flight count (normalized 0-1)
            const normalized = flightRange > 0 ? (aircraft.flights - minFlights) / flightRange : 1;

            // Determine color class based on normalized value
            let colorClass;
            if (normalized >= 0.75) {
                colorClass = 'fleet-aircraft-high';  // Most flights - warm color
            } else if (normalized >= 0.5) {
                colorClass = 'fleet-aircraft-medium-high';
            } else if (normalized >= 0.25) {
                colorClass = 'fleet-aircraft-medium-low';
            } else {
                colorClass = 'fleet-aircraft-low';  // Least flights - cool color
            }

            const flightTimeStr = aircraft.flight_time_str || '---';
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

        document.getElementById('wrapped-aircraft-fleet').innerHTML = fleetHtml;
    }

    // Build home base section using year-filtered airport data
    if (yearStats.airport_names && yearStats.airport_names.length > 0) {
        // Filter path info by selected year to count airport visits
        var filteredPathInfo;
        if (year === 'all') {
            filteredPathInfo = fullPathInfo;
        } else {
            const yearStr = year.toString();
            filteredPathInfo = fullPathInfo.filter(function(pathInfo) {
                return pathInfo.year && pathInfo.year.toString() === yearStr;
            });
        }

        // Load all airport data to get flight counts
        loadAirports().then(function(allAirports) {
            // Filter airports to only those in this year and count flights
            var yearAirportCounts = {};

            // Count how many times each airport appears in filtered paths
            filteredPathInfo.forEach(function(pathInfo) {
                if (pathInfo.start_airport) {
                    yearAirportCounts[pathInfo.start_airport] = (yearAirportCounts[pathInfo.start_airport] || 0) + 1;
                }
                if (pathInfo.end_airport) {
                    yearAirportCounts[pathInfo.end_airport] = (yearAirportCounts[pathInfo.end_airport] || 0) + 1;
                }
            });

            // Create airport objects with year-specific counts
            var yearAirports = yearStats.airport_names.map(function(name) {
                return {
                    name: name,
                    flight_count: yearAirportCounts[name] || 0
                };
            });

            // Sort by flight count to find home base
            yearAirports.sort((a, b) => b.flight_count - a.flight_count);
            const homeBase = yearAirports[0];

            let homeBaseHtml = '<div class="top-airports-title">🏠 Home Base</div>';
            homeBaseHtml += `
                <div class="top-airport">
                    <div class="top-airport-name">${homeBase.name}</div>
                    <div class="top-airport-count">${homeBase.flight_count} flights</div>
                </div>
            `;
            document.getElementById('wrapped-top-airports').innerHTML = homeBaseHtml;

            // Build all destinations badge grid (excluding home base)
            const destinations = yearStats.airport_names.filter(name => name !== homeBase.name);
            let airportBadgesHtml = '<div class="airports-grid-title">🗺️ Destinations</div><div class="airport-badges">';
            destinations.forEach(function(airportName) {
                airportBadgesHtml += `<div class="airport-badge">${airportName}</div>`;
            });
            airportBadgesHtml += '</div>';
            document.getElementById('wrapped-airports-grid').innerHTML = airportBadgesHtml;
        });
    }

    // Move the map into the wrapped container
    const mapContainer = document.getElementById('map');
    const wrappedMapContainer = document.getElementById('wrapped-map-container');

    // Store original position if not already stored
    if (!originalMapParent) {
        originalMapParent = mapContainer.parentNode;
        originalMapIndex = Array.from(originalMapParent.children).indexOf(mapContainer);
    }

    // Zoom to fit all data with extra padding
    map.fitBounds(BOUNDS, { padding: [80, 80] });

    // Hide controls in wrapped view FIRST
    const controls = [
        document.querySelector('.leaflet-control-zoom'),
        document.getElementById('stats-btn'),
        document.getElementById('export-btn'),
        document.getElementById('wrapped-btn'),
        document.getElementById('heatmap-btn'),
        document.getElementById('airports-btn'),
        document.getElementById('altitude-btn'),
        document.getElementById('airspeed-btn'),
        document.getElementById('aviation-btn'),
        document.getElementById('year-filter'),
        document.getElementById('aircraft-filter'),
        document.getElementById('stats-panel'),
        document.getElementById('altitude-legend'),
        document.getElementById('airspeed-legend'),
        document.getElementById('loading')
    ];
    controls.forEach(el => { if (el) el.style.display = 'none'; });

    // Show modal first to ensure wrapped-map-container has dimensions
    document.getElementById('wrapped-modal').style.display = 'flex';

    // Wait for modal to render and have dimensions
    setTimeout(function() {
        // Now move map into wrapped container (which now has dimensions)
        wrappedMapContainer.appendChild(mapContainer);

        // Make sure the map container fills the wrapped container
        mapContainer.style.width = '100%';
        mapContainer.style.height = '100%';
        mapContainer.style.borderRadius = '12px';
        mapContainer.style.overflow = 'hidden';

        // Force a layout recalculation
        wrappedMapContainer.offsetHeight;

        // Now that container has dimensions, invalidate map size
        setTimeout(function() {
            map.invalidateSize();
            map.fitBounds(BOUNDS, { padding: [80, 80] });
        }, 100);
    }, 50);
}

function closeWrapped(event) {
    if (!event || event.target.id === 'wrapped-modal') {
        // Move map back to original position
        const mapContainer = document.getElementById('map');
        if (originalMapParent) {
            const children = Array.from(originalMapParent.children);
            if (originalMapIndex >= children.length) {
                originalMapParent.appendChild(mapContainer);
            } else {
                originalMapParent.insertBefore(mapContainer, children[originalMapIndex]);
            }

            // Restore map styling
            mapContainer.style.width = '';
            mapContainer.style.height = '';
            mapContainer.style.borderRadius = '';
            mapContainer.style.overflow = '';

            // Show controls again
            const controls = [
                document.querySelector('.leaflet-control-zoom'),
                document.getElementById('stats-btn'),
                document.getElementById('export-btn'),
                document.getElementById('wrapped-btn'),
                document.getElementById('heatmap-btn'),
                document.getElementById('airports-btn'),
                document.getElementById('altitude-btn'),
                document.getElementById('airspeed-btn'),
                document.getElementById('year-filter'),
                document.getElementById('aircraft-filter'),
                document.getElementById('stats-panel'),
                document.getElementById('altitude-legend'),
                document.getElementById('airspeed-legend'),
                document.getElementById('loading')
            ];
            controls.forEach(el => { if (el) el.style.display = ''; });

            // Only show aviation button if API key is available
            if (OPENAIP_API_KEY) {
                const aviationBtn = document.getElementById('aviation-btn');
                if (aviationBtn) aviationBtn.style.display = '';
            }

            // Force map to recalculate size
            setTimeout(function() {
                map.invalidateSize();
            }, 100);
        }

        document.getElementById('wrapped-modal').style.display = 'none';
    }
}

function calculateYearStats(year) {
    // If we don't have path info or segments, return empty stats
    if (!fullPathInfo || !fullPathSegments) {
        return {
            total_flights: 0,
            total_distance_nm: 0,
            num_airports: 0,
            flight_time: '0h 0m',
            aircraft_list: [],
            airport_names: []
        };
    }

    // Filter path info by year
    var filteredPathInfo;
    if (year === 'all') {
        // Include all years
        filteredPathInfo = fullPathInfo;
    } else {
        // Filter to specific year
        const yearStr = year.toString();
        filteredPathInfo = fullPathInfo.filter(function(pathInfo) {
            return pathInfo.year && pathInfo.year.toString() === yearStr;
        });
    }

    // If no paths for this year, return empty stats
    if (filteredPathInfo.length === 0) {
        return {
            total_flights: 0,
            total_distance_nm: 0,
            num_airports: 0,
            flight_time: '0h 0m',
            aircraft_list: [],
            airport_names: []
        };
    }

    // Collect unique airports for this year
    var airports = new Set();
    var airportNames = [];
    filteredPathInfo.forEach(function(pathInfo) {
        if (pathInfo.start_airport) {
            airports.add(pathInfo.start_airport);
            if (!airportNames.includes(pathInfo.start_airport)) {
                airportNames.push(pathInfo.start_airport);
            }
        }
        if (pathInfo.end_airport) {
            airports.add(pathInfo.end_airport);
            if (!airportNames.includes(pathInfo.end_airport)) {
                airportNames.push(pathInfo.end_airport);
            }
        }
    });

    // Collect aircraft with flight counts and times
    var aircraftMap = {};
    filteredPathInfo.forEach(function(pathInfo) {
        if (pathInfo.aircraft_registration) {
            var reg = pathInfo.aircraft_registration;
            if (!aircraftMap[reg]) {
                aircraftMap[reg] = {
                    registration: reg,
                    type: pathInfo.aircraft_type,
                    flights: 0,
                    flight_time_seconds: 0
                };
            }
            aircraftMap[reg].flights += 1;
        }
    });

    // Get segments for this year's paths
    var pathIds = new Set(filteredPathInfo.map(function(p) { return p.id; }));
    var filteredSegments = fullPathSegments.filter(function(segment) {
        return pathIds.has(segment.path_id);
    });

    // Calculate distance from segments using Haversine formula
    var totalDistanceKm = 0;
    filteredSegments.forEach(function(segment) {
        if (segment.coords && segment.coords.length === 2) {
            var lat1 = segment.coords[0][0] * Math.PI / 180;
            var lon1 = segment.coords[0][1] * Math.PI / 180;
            var lat2 = segment.coords[1][0] * Math.PI / 180;
            var lon2 = segment.coords[1][1] * Math.PI / 180;
            var dlat = lat2 - lat1;
            var dlon = lon2 - lon1;
            var a = Math.sin(dlat/2) * Math.sin(dlat/2) +
                    Math.cos(lat1) * Math.cos(lat2) *
                    Math.sin(dlon/2) * Math.sin(dlon/2);
            var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            totalDistanceKm += 6371 * c;  // Earth radius in km
        }
    });

    // Calculate flight time from actual GPS segment data
    var totalFlightTimeSeconds = 0;
    var pathDurations = {};
    filteredSegments.forEach(function(segment) {
        if (segment.time !== undefined && segment.path_id !== undefined) {
            var pathId = segment.path_id;
            if (!pathDurations[pathId]) {
                pathDurations[pathId] = { min: Infinity, max: -Infinity };
            }
            pathDurations[pathId].min = Math.min(pathDurations[pathId].min, segment.time);
            pathDurations[pathId].max = Math.max(pathDurations[pathId].max, segment.time);
        }
    });

    // Sum up path durations and assign to aircraft
    Object.keys(pathDurations).forEach(function(pathId) {
        var duration = pathDurations[pathId];
        if (duration.min !== Infinity && duration.max !== -Infinity) {
            var durationSeconds = duration.max - duration.min;
            totalFlightTimeSeconds += durationSeconds;

            // Find which aircraft this path belongs to
            var pathInfo = filteredPathInfo.find(function(p) { return p.id === parseInt(pathId); });
            if (pathInfo && pathInfo.aircraft_registration && aircraftMap[pathInfo.aircraft_registration]) {
                aircraftMap[pathInfo.aircraft_registration].flight_time_seconds += durationSeconds;
            }
        }
    });

    // Format flight time
    var flightTimeStr = '0h 0m';
    if (totalFlightTimeSeconds > 0) {
        var hours = Math.floor(totalFlightTimeSeconds / 3600);
        var minutes = Math.floor((totalFlightTimeSeconds % 3600) / 60);
        flightTimeStr = hours + 'h ' + minutes + 'm';
    }

    // Convert aircraft map to sorted list with formatted times and models
    var aircraftList = Object.values(aircraftMap).map(function(aircraft) {
        var hours = Math.floor(aircraft.flight_time_seconds / 3600);
        var minutes = Math.floor((aircraft.flight_time_seconds % 3600) / 60);
        var result = {
            registration: aircraft.registration,
            type: aircraft.type,
            flights: aircraft.flights,
            flight_time_str: hours + 'h ' + minutes + 'm'
        };

        // Try to get full model name from fullStats if available
        if (fullStats && fullStats.aircraft_list) {
            var fullAircraft = fullStats.aircraft_list.find(function(a) {
                return a.registration === aircraft.registration;
            });
            if (fullAircraft && fullAircraft.model) {
                result.model = fullAircraft.model;
            }
        }

        return result;
    }).sort(function(a, b) {
        return b.flights - a.flights;
    });

    return {
        total_flights: filteredPathInfo.length,
        total_distance_nm: totalDistanceKm * 0.539957,  // Convert km to nautical miles
        num_airports: airports.size,
        flight_time: flightTimeStr,
        aircraft_list: aircraftList,
        airport_names: airportNames
    };
}

// Toggle button visibility
function toggleButtonsVisibility() {
    const toggleableButtons = document.querySelectorAll('.toggleable-btn');
    const hideButton = document.getElementById('hide-buttons-btn');

    if (buttonsHidden) {
        // Show buttons
        toggleableButtons.forEach(function(btn) {
            btn.classList.remove('buttons-hidden');
        });
        hideButton.textContent = '🔼';
        buttonsHidden = false;
    } else {
        // Hide buttons
        toggleableButtons.forEach(function(btn) {
            btn.classList.add('buttons-hidden');
        });
        hideButton.textContent = '🔽';
        buttonsHidden = true;
    }
}

// Toggle auto-zoom for replay
function toggleAutoZoom() {
    replayAutoZoom = !replayAutoZoom;
    const autoZoomBtn = document.getElementById('replay-autozoom-btn');

    if (replayAutoZoom) {
        autoZoomBtn.style.opacity = '1.0';
        autoZoomBtn.title = 'Auto-zoom enabled';

        // If replay is active, immediately zoom to current airplane position
        if (replayActive && replayAirplaneMarker) {
            var currentPos = replayAirplaneMarker.getLatLng();
            map.setView(currentPos, 16, { animate: true, duration: 0.5 });
            replayLastZoom = 16;
        }
    } else {
        autoZoomBtn.style.opacity = '0.5';
        autoZoomBtn.title = 'Auto-zoom disabled';
        replayLastZoom = null;  // Reset last zoom
    }
    saveMapState();
}
