/**
 * The flights of an airport, listed in its popup.
 *
 * A click on a path is the only other way to select a single flight, and a
 * keyboard cannot click a path, so without this list replay, which needs
 * exactly one flight, was out of a keyboard's reach. Each flight is named by
 * its route, aircraft and year only: a date or a time of day would say when
 * somebody flew.
 *
 * AirportManager adds it whenever the popup is open with new content (see
 * listPopupFlights), and lays the popup out again afterwards. It is part of
 * the app rather than of the feature bundle: fetching that bundle, and its
 * stylesheet, for the first popup cost far more than the list itself.
 */
import type { Popup } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { datasetIndex } from "../calculations/datasetIndex";
import { escapeHtml } from "../utils/htmlGenerators";
import { airportCode } from "../features/airports";
import { watchScrollEnd, type ScrollEndWatcher } from "../utils/scrollFade";

/** Apps whose selection the open list already follows */
const following = new WeakSet<MapApp>();

/** Keeps the fade of the list that is shown; one popup, so one list */
let listEnd: ScrollEndWatcher | null = null;

/** An airport as the list names it: its code where it has one */
function routeEnd(label = "?"): string {
  return airportCode(label) ?? label;
}

/**
 * Add the flight list to an airport popup whose content was just written.
 * @param app - The app whose flights and selection are listed
 * @param popup - The airports' popup, open on the map for this airport
 * @param name - The airport the popup is open for
 */
export function listFlights(app: MapApp, popup: Popup, name: string): void {
  // A closed popup has no element at all
  const container = popup.isOpen() ? popup.getElement() : undefined;
  const host = container?.querySelector(".kh-popup-airport");
  const data = app.currentData;
  if (!container || !host || !data) return;
  if (host.querySelector(".kh-popup-flights")) return;

  // MapLibre closes a popup on a click, never on a key
  container.onkeydown = (event) => {
    if (event.key === "Escape") popup.remove();
  };

  const byId = datasetIndex(data).pathInfoById;
  let html = "";
  for (const id of app.airportToPaths[name] ?? []) {
    const path = byId.get(id);
    if (!path) continue;
    const label = [
      routeEnd(path.start_airport) + " → " + routeEnd(path.end_airport),
      path.aircraft_registration,
      path.year,
    ]
      .filter(Boolean)
      .join(" · ");
    html +=
      '<button type="button" class="kh-popup-flight" data-path-id="' +
      id +
      '">' +
      escapeHtml(label) +
      "</button>";
  }
  if (!html) return;

  const title = document.createElement("div");
  title.className = "popup-section-label kh-popup-flights-label";
  title.textContent = "Select a flight";
  const list = document.createElement("div");
  list.className = "kh-popup-flights";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "Select a flight");
  list.innerHTML = html;
  host.append(title, list);
  // A long list stops mid-row; the bottom fades while there is more
  listEnd?.stop();
  const watcher = watchScrollEnd(list);
  listEnd = watcher;
  popup.once("close", () => watcher.stop());

  list.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLElement>(
      "[data-path-id]",
    );
    if (button && !app.replayActive) {
      selectFlight(app, Number(button.dataset["pathId"]));
    }
  });

  markSelected(app);
  if (!following.has(app)) {
    following.add(app);
    app.store.subscribe("selectedPathIds", () => markSelected(app));
  }
}

/**
 * Select just this flight, or nothing when it already is the whole
 * selection. Opening the popup with a click or Enter selected every flight
 * of the airport, so a plain toggle would leave the others selected.
 */
function selectFlight(app: MapApp, pathId: number): void {
  const selected = app.selectedPathIds;
  const alone = selected.size === 1 && selected.has(pathId);
  app.pathSelection.clearSelection();
  if (!alone) app.pathSelection.togglePathSelection(pathId);
}

/** Mark the listed flights that are part of the selection */
function markSelected(app: MapApp): void {
  for (const button of document.querySelectorAll<HTMLElement>(
    ".kh-popup-flight",
  )) {
    const selected = app.selectedPathIds.has(Number(button.dataset["pathId"]));
    button.setAttribute("aria-pressed", String(selected));
  }
}
