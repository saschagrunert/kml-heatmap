/**
 * The flight list of an airport popup: the keyboard's way to one flight.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Popup } from "maplibre-gl";
import { listFlights } from "../../../../kml_heatmap/frontend/ui/airportFlights";
import type { PathInfo } from "../../../../kml_heatmap/frontend/types";
import {
  asMapApp,
  createDataset,
  createMockApp,
  type MockApp,
} from "../../testHelpers";
import { Popup as MockPopup } from "../../../mocks/maplibre-gl";

const pathInfo: PathInfo[] = [
  {
    id: 11,
    year: 2025,
    aircraft_registration: "D-EAGJ",
    start_airport: "EDAQ Halle-Oppin",
    end_airport: "EDDP Leipzig",
  },
  {
    id: 12,
    year: 2024,
    aircraft_registration: "D-ESST",
    start_airport: "EDDP Leipzig",
    end_airport: "EDAQ Halle-Oppin",
  },
  {
    id: 13,
    year: 2025,
    start_airport: "EDDP Leipzig",
    end_airport: "Somewhere <b>odd</b>",
  },
];

interface OpenPopup {
  popup: Popup;
  mock: MockPopup;
  container: HTMLElement;
}

describe("listFlights", () => {
  let mockApp: MockApp;

  /** The popup as AirportManager leaves it once the content is written */
  function openPopup(): OpenPopup {
    const mock = new MockPopup({ focusAfterOpen: false });
    mock
      .setLngLat([12, 51])
      .setHTML(
        '<div class="popup-container kh-popup-airport" tabindex="-1"></div>',
      )
      .addTo(mockApp.map!);
    return {
      popup: mock as unknown as Popup,
      mock,
      container: mock.getElement(),
    };
  }

  function buttons(container: HTMLElement): HTMLButtonElement[] {
    return [
      ...container.querySelectorAll<HTMLButtonElement>(".kh-popup-flight"),
    ];
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="map"></div>';
    mockApp = createMockApp({
      currentData: createDataset(pathInfo),
      selectedYear: "all",
    });
  });

  it("names each flight by route, aircraft and year only", () => {
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig");

    expect(buttons(container).map((b) => b.textContent)).toEqual([
      "EDAQ → EDDP · D-EAGJ · 2025",
      "EDDP → EDAQ · D-ESST · 2024",
      // No code, no aircraft: the name stands in, escaped
      "EDDP → Somewhere <b>odd</b> · 2025",
    ]);
    expect(container.querySelector(".kh-popup-flight b")).toBeNull();
    const list = container.querySelector(".kh-popup-flights")!;
    expect(list.getAttribute("role")).toBe("group");
    expect(list.getAttribute("aria-label")).toBe("Select a flight");
  });

  it("lists only the flights the filter keeps", () => {
    mockApp.selectedYear = "2024";
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig");

    expect(buttons(container)).toHaveLength(1);
  });

  it("leaves the layout and the pan to its caller", () => {
    const { popup, mock } = openPopup();
    mock.setLngLat.mockClear();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig");

    expect(mock.setLngLat).not.toHaveBeenCalled();
    expect(mockApp.map!.panBy).not.toHaveBeenCalled();
  });

  it("adds nothing to a popup that closed while the bundle loaded", () => {
    const { popup, mock, container } = openPopup();
    mock.remove();
    // MapLibre drops the element of a closed popup; the mock keeps its own
    mock.getElement.mockReturnValue(undefined as unknown as HTMLDivElement);

    expect(() =>
      listFlights(asMapApp(mockApp), popup, "EDDP Leipzig"),
    ).not.toThrow();

    expect(buttons(container)).toHaveLength(0);
  });

  it("does not list twice for the same content", () => {
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig");
    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig");

    expect(buttons(container)).toHaveLength(3);
  });

  it("adds no list to an airport without flights", () => {
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "LOWW Vienna");

    expect(container.querySelector(".kh-popup-flights")).toBeNull();
  });

  it("selects just the flight, and nothing when it is the selection", () => {
    const { popup, container } = openPopup();
    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig");
    const selection = mockApp.pathSelection;

    buttons(container)[1]!.click();

    expect(selection.clearSelection).toHaveBeenCalledTimes(1);
    expect(selection.togglePathSelection).toHaveBeenCalledWith(12);

    mockApp.selectedPathIds = new Set([12]);
    selection.togglePathSelection.mockClear();
    buttons(container)[1]!.click();

    expect(selection.clearSelection).toHaveBeenCalledTimes(2);
    expect(selection.togglePathSelection).not.toHaveBeenCalled();
  });

  it("leaves the selection alone while replay runs", () => {
    const { popup, container } = openPopup();
    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig");
    mockApp.replayActive = true;

    buttons(container)[0]!.click();

    expect(mockApp.pathSelection.clearSelection).not.toHaveBeenCalled();
  });

  it("marks the selected flights and follows the selection", () => {
    mockApp.selectedPathIds = new Set([11, 12]);
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig");

    const pressed = (): (string | null)[] =>
      buttons(container).map((b) => b.getAttribute("aria-pressed"));
    expect(pressed()).toEqual(["true", "true", "false"]);

    mockApp.selectedPathIds = new Set([13]);

    expect(pressed()).toEqual(["false", "false", "true"]);
  });

  it("closes on Escape from anywhere inside the popup", () => {
    const { popup, mock, container } = openPopup();
    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig");
    const flight = buttons(container)[0]!;

    flight.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(mock.isOpen()).toBe(true);

    flight.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(mock.isOpen()).toBe(false);
    expect(mock.remove).toHaveBeenCalledTimes(1);
  });
});
