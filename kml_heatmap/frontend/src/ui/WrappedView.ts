/**
 * Year-end wrapped view (fun facts and summary)
 */

import type { Statistics } from "../types";
import { formatTime } from "../utils/formatting";
import { UNIT_CONVERSIONS, Z_INDEX } from "../constants";

interface FunFact {
  category: string;
  icon: string;
  text: string;
  priority: number;
}

export class WrappedView {
  private modal: HTMLElement | null = null;

  /**
   * Show wrapped view for a specific year
   */
  show(
    year: number,
    yearStats: Statistics,
    _fullStats: Statistics,
    _map: any,
  ): void {
    // L.Map - using any to avoid Leaflet type resolution issues
    const funFacts = this.generateFunFacts(yearStats, _fullStats);
    const html = this.generateHTML(year, yearStats, funFacts);

    // Create or update modal
    if (!this.modal) {
      this.modal = document.createElement("div");
      this.modal.id = "wrapped-modal";
      this.modal.style.cssText = `
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.95);
        z-index: ${Z_INDEX.MODAL};
        overflow: auto;
      `;
      document.body.appendChild(this.modal);

      // Close on background click
      this.modal.addEventListener("click", (e) => {
        if (e.target === this.modal) {
          this.close();
        }
      });
    }

    this.modal.innerHTML = html;
    this.modal.style.display = "flex";

    // Add close button handler
    const closeBtn = this.modal.querySelector(".wrapped-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.close());
    }
  }

  /**
   * Close wrapped view
   */
  close(): void {
    if (this.modal) {
      this.modal.style.display = "none";
    }
  }

  /**
   * Generate fun facts based on statistics
   */
  private generateFunFacts(
    yearStats: Statistics,
    _fullStats: Statistics,
  ): FunFact[] {
    const facts: FunFact[] = [];

    const totalDistanceKm = yearStats.total_distance_km;
    const timesAroundEarth =
      totalDistanceKm / UNIT_CONVERSIONS.EARTH_CIRCUMFERENCE_KM;

    // Distance facts
    if (timesAroundEarth >= 0.5) {
      facts.push({
        category: "distance",
        icon: "🌍",
        text: `You flew <strong>${timesAroundEarth.toFixed(1)}x</strong> around the Earth`,
        priority: 10,
      });
    }

    // Flight time facts
    if (yearStats.total_flight_time_seconds) {
      const totalHours = yearStats.total_flight_time_seconds / 3600;
      const totalDays = totalHours / 24;

      if (totalDays >= 1) {
        facts.push({
          category: "time",
          icon: "⏱️",
          text: `You spent <strong>${totalDays.toFixed(1)} days</strong> in the air`,
          priority: 8,
        });
      }
    }

    // Airport facts
    if (yearStats.airports_visited > 0) {
      facts.push({
        category: "airports",
        icon: "🛫",
        text: `Visited <strong>${yearStats.airports_visited}</strong> different airports`,
        priority: 7,
      });
    }

    return facts.sort((a, b) => b.priority - a.priority).slice(0, 5);
  }

  /**
   * Generate wrapped view HTML
   */
  private generateHTML(
    year: number,
    stats: Statistics,
    funFacts: FunFact[],
  ): string {
    return `
      <div style="
        max-width: 800px;
        margin: auto;
        padding: 40px 20px;
        color: white;
        font-family: system-ui, -apple-system, sans-serif;
      ">
        <button class="wrapped-close" style="
          position: absolute;
          top: 20px;
          right: 20px;
          background: rgba(255,255,255,0.2);
          border: none;
          color: white;
          font-size: 24px;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          cursor: pointer;
        ">×</button>

        <h1 style="font-size: 48px; text-align: center; margin-bottom: 40px;">
          ${year} Wrapped
        </h1>

        <div style="background: rgba(255,255,255,0.1); padding: 30px; border-radius: 12px; margin-bottom: 30px;">
          <h2 style="font-size: 32px; margin-bottom: 20px;">By the Numbers</h2>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px;">
            <div>
              <div style="font-size: 36px; font-weight: bold; color: #4CAF50;">
                ${stats.total_distance_nm.toFixed(0)}
              </div>
              <div style="color: #aaa;">nautical miles</div>
            </div>
            <div>
              <div style="font-size: 36px; font-weight: bold; color: #2196F3;">
                ${formatTime(stats.total_flight_time_seconds)}
              </div>
              <div style="color: #aaa;">flight time</div>
            </div>
            <div>
              <div style="font-size: 36px; font-weight: bold; color: #FF9800;">
                ${stats.airports_visited}
              </div>
              <div style="color: #aaa;">airports</div>
            </div>
            <div>
              <div style="font-size: 36px; font-weight: bold; color: #E91E63;">
                ${Math.round(stats.max_altitude_ft).toLocaleString()}
              </div>
              <div style="color: #aaa;">feet (max alt)</div>
            </div>
          </div>
        </div>

        ${funFacts
          .map(
            (fact) => `
          <div style="
            background: rgba(255,255,255,0.1);
            padding: 20px;
            border-radius: 12px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 15px;
          ">
            <div style="font-size: 48px;">${fact.icon}</div>
            <div style="font-size: 18px;">${fact.text}</div>
          </div>
        `,
          )
          .join("")}

        <div style="text-align: center; margin-top: 40px;">
          <button class="wrapped-close" style="
            background: #4CAF50;
            color: white;
            border: none;
            padding: 15px 30px;
            border-radius: 8px;
            font-size: 18px;
            cursor: pointer;
          ">Close</button>
        </div>
      </div>
    `;
  }
}
