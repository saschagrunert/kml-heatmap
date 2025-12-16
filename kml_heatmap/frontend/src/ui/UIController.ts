/**
 * UI Controller for handling DOM interactions
 */

export class UIController {
  /**
   * Update button opacity based on visibility state
   */
  updateButtonState(buttonId: string, visible: boolean): void {
    const button = document.getElementById(buttonId);
    if (button) {
      button.style.opacity = visible ? "1.0" : "0.5";
    }
  }

  /**
   * Show aviation button if API key is available
   */
  showAviationButton(hasApiKey: boolean): void {
    const button = document.getElementById("aviation-btn");
    if (button) {
      button.style.display = hasApiKey ? "block" : "none";
    }
  }

  /**
   * Toggle stats panel visibility
   */
  toggleStatsPanel(): boolean {
    const panel = document.getElementById("stats-panel");
    if (panel) {
      const isVisible = panel.classList.contains("visible");
      if (isVisible) {
        panel.classList.remove("visible");
      } else {
        panel.classList.add("visible");
      }
      return !isVisible;
    }
    return false;
  }

  /**
   * Update stats panel content
   */
  updateStatsPanel(html: string): void {
    const panel = document.getElementById("stats-panel");
    if (panel) {
      panel.innerHTML = html;
    }
  }

  /**
   * Update altitude legend
   */
  updateAltitudeLegend(minAlt: number, maxAlt: number): void {
    const legend = document.getElementById("altitude-legend");
    if (legend) {
      legend.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 4px;">Altitude (ft)</div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 20px; height: 100px; background: linear-gradient(to top,
            rgb(0,0,255), rgb(0,100,200), rgb(0,255,0), rgb(255,255,0), rgb(255,0,0));
            border: 1px solid rgba(255,255,255,0.3); border-radius: 3px;"></div>
          <div style="display: flex; flex-direction: column; justify-content: space-between; height: 100px;">
            <div>${Math.round(maxAlt).toLocaleString()}</div>
            <div>${Math.round((minAlt + maxAlt) / 2).toLocaleString()}</div>
            <div>${Math.round(minAlt).toLocaleString()}</div>
          </div>
        </div>
      `;
    }
  }

  /**
   * Update airspeed legend
   */
  updateAirspeedLegend(minSpeed: number, maxSpeed: number): void {
    const legend = document.getElementById("airspeed-legend");
    if (legend) {
      legend.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 4px;">Airspeed (kts)</div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 20px; height: 100px; background: linear-gradient(to top,
            rgb(128,0,128), rgb(255,0,0), rgb(255,255,0));
            border: 1px solid rgba(255,255,255,0.3); border-radius: 3px;"></div>
          <div style="display: flex; flex-direction: column; justify-content: space-between; height: 100px;">
            <div>${Math.round(maxSpeed)}</div>
            <div>${Math.round((minSpeed + maxSpeed) / 2)}</div>
            <div>${Math.round(minSpeed)}</div>
          </div>
        </div>
      `;
    }
  }

  /**
   * Show/hide legend
   */
  toggleLegend(legendId: string, visible: boolean): void {
    const legend = document.getElementById(legendId);
    if (legend) {
      legend.style.display = visible ? "block" : "none";
    }
  }

  /**
   * Toggle buttons visibility
   */
  toggleButtonsVisibility(): boolean {
    const buttons = [
      "stats-btn",
      "export-btn",
      "wrapped-btn",
      "heatmap-btn",
      "altitude-btn",
      "airspeed-btn",
      "airports-btn",
      "aviation-btn",
      "year-filter",
      "aircraft-filter",
    ];

    const firstButton = document.getElementById(buttons[0]);
    const isHidden = firstButton?.style.display === "none";

    buttons.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.style.display = isHidden ? "block" : "none";
      }
    });

    return !isHidden;
  }

  /**
   * Update filter dropdowns
   */
  updateYearFilter(years: number[]): void {
    this.updateFilterDropdown(
      "year-filter",
      "All Years",
      years
        .sort((a, b) => b - a)
        .map((year) => ({
          value: year.toString(),
          text: year.toString(),
        })),
    );
  }

  /**
   * Update aircraft filter dropdown
   */
  updateAircraftFilter(aircraftList: string[]): void {
    this.updateFilterDropdown(
      "aircraft-filter",
      "All Aircraft",
      aircraftList.sort().map((aircraft) => ({
        value: aircraft,
        text: aircraft,
      })),
    );
  }

  /**
   * Generic method to update filter dropdowns
   */
  private updateFilterDropdown(
    selectId: string,
    allOptionText: string,
    options: Array<{ value: string; text: string }>,
  ): void {
    const select = document.getElementById(selectId) as HTMLSelectElement;
    if (!select) return;

    const currentValue = select.value;

    select.innerHTML = `<option value="all">${allOptionText}</option>`;
    options.forEach(({ value, text }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    });

    if (Array.from(select.options).some((opt) => opt.value === currentValue)) {
      select.value = currentValue;
    }
  }
}
