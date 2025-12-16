/**
 * Data loading service
 */

import type {
  FlightData,
  Airport,
  Statistics,
  ResolutionLevel,
} from "../types";

export class DataLoader {
  private dataDir: string;
  private loadedData: Map<ResolutionLevel, FlightData> = new Map();
  private airports: Airport[] | null = null;
  private metadata: Statistics | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Load flight data for a specific resolution level
   */
  async loadData(resolution: ResolutionLevel): Promise<FlightData | null> {
    if (this.loadedData.has(resolution)) {
      return this.loadedData.get(resolution)!;
    }

    this.showLoading();
    try {
      const response = await fetch(`${this.dataDir}/data_${resolution}.json`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (!this.isValidFlightData(data)) {
        throw new Error("Invalid flight data structure");
      }

      this.loadedData.set(resolution, data);
      console.log(
        `Loaded ${resolution} resolution:`,
        data.downsampled_points,
        "points",
      );
      return data;
    } catch (error) {
      console.error(`Error loading data for ${resolution}:`, error);
      return null;
    } finally {
      this.hideLoading();
    }
  }

  /**
   * Validate flight data structure
   */
  private isValidFlightData(data: unknown): data is FlightData {
    return !!(
      data &&
      typeof data === "object" &&
      "coordinates" in data &&
      Array.isArray((data as FlightData).coordinates) &&
      "downsampled_points" in data &&
      typeof (data as FlightData).downsampled_points === "number"
    );
  }

  /**
   * Validate airport data structure
   */
  private isValidAirport(airport: unknown): airport is Airport {
    return !!(
      airport &&
      typeof airport === "object" &&
      "name" in airport &&
      typeof (airport as Airport).name === "string" &&
      "lat" in airport &&
      typeof (airport as Airport).lat === "number" &&
      !Number.isNaN((airport as Airport).lat) &&
      "lon" in airport &&
      typeof (airport as Airport).lon === "number" &&
      !Number.isNaN((airport as Airport).lon) &&
      "flight_count" in airport &&
      typeof (airport as Airport).flight_count === "number"
    );
  }

  /**
   * Load airport data
   */
  async loadAirports(): Promise<Airport[]> {
    if (this.airports !== null) {
      return this.airports;
    }

    try {
      const response = await fetch(`${this.dataDir}/airports.json`);
      const data = (await response.json()) as { airports: unknown[] };

      // Filter out invalid airports
      this.airports = data.airports.filter((airport) => {
        const isValid = this.isValidAirport(airport);
        if (!isValid) {
          console.warn("Invalid airport data:", airport);
        }
        return isValid;
      });

      return this.airports;
    } catch (error) {
      console.error("Error loading airports:", error);
      return [];
    }
  }

  /**
   * Load metadata and statistics
   */
  async loadMetadata(): Promise<Statistics | null> {
    if (this.metadata !== null) {
      return this.metadata;
    }

    try {
      const response = await fetch(`${this.dataDir}/metadata.json`);
      this.metadata = (await response.json()) as Statistics;
      return this.metadata;
    } catch (error) {
      console.error("Error loading metadata:", error);
      return null;
    }
  }

  /**
   * Get cached data for a resolution level
   */
  getCachedData(resolution: ResolutionLevel): FlightData | null {
    return this.loadedData.get(resolution) ?? null;
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.loadedData.clear();
    this.airports = null;
    this.metadata = null;
  }

  private showLoading(): void {
    const loadingEl = document.getElementById("loading");
    if (loadingEl) {
      loadingEl.style.display = "block";
    }
  }

  private hideLoading(): void {
    const loadingEl = document.getElementById("loading");
    if (loadingEl) {
      loadingEl.style.display = "none";
    }
  }
}
