/**
 * App chrome - the controls around the map that follow the store
 *
 * MapApp sets these up once as it starts, and from then on they follow the
 * store on their own: the toggle buttons and the colour legends
 * (`setupButtonSync`), the statistics rail and its two triggers
 * (`setupStatsRail`), and the replay control, which has to say whether a
 * replay is available from the first paint, long before the feature bundle
 * that plays it is fetched (`followReplayAvailability`). The height of the
 * map's credit, which the legends and toasts stand on, is kept in a CSS
 * variable here as well (`followAttributionHeight`). What they follow is
 * the app's public state alone; their store subscriptions end with the
 * app's (MapApp.destroy unsubscribes them all).
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { TOGGLES } from "../state/toggles";
import { syncLegend, syncToggleButton } from "../utils/buttonState";
import { domCache } from "../utils/domCache";
import { slideMapBesideRail } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { updateReplayButtonState } from "./replayButton";

/**
 * The store drives the toggle buttons and the colour legends: initial
 * state and every change are reflected in aria-pressed, the active class
 * and the legend visibility, for the buttons that show their key alone
 * (`pressed` in state/toggles.ts). The heatmap's toggle and the altitude
 * scale also depend on whether a replay runs, so they follow the layers
 * (see ui/layerVisibility.ts).
 */
export function setupButtonSync(app: MapApp): void {
  for (const toggle of TOGGLES) {
    if ("pressed" in toggle) {
      syncToggleButton(app.store, toggle.key, toggle.button);
    }
  }
  syncLegend(app.store, "airspeedVisible", "airspeed-legend");
}

/**
 * Open and close the statistics rail. The rail turns the left column into
 * a single row of icon-only buttons and takes the space beside the map,
 * which slides aside for it (see slideMapBesideRail).
 */
export function setupStatsRail(app: MapApp): void {
  const apply = (visible: boolean): void => {
    const rail = domCache.get("stats-rail");
    if (rail) {
      // The collapse button hides itself, so focus has to leave the rail
      // before it does; otherwise it falls back to <body>
      if (!visible) restoreFocusFromRail(rail, app.map);
      rail.hidden = !visible;
    }

    // Both triggers are a disclosure for the rail, not a pressed toggle;
    // only the one that stays on screen carries the active treatment
    for (const id of ["stats-btn", "stats-collapse-btn"]) {
      domCache.get(id)?.setAttribute("aria-expanded", String(visible));
    }
    domCache.get("stats-btn")?.classList.toggle("active", visible);

    slideMapBesideRail(
      document.getElementById("map"),
      visible,
      animate && !prefersReducedMotion(),
    );
  };

  // Opened with the page, the rail is simply there
  let animate = false;
  apply(app.statsPanelVisible);
  animate = true;
  app.store.subscribe("statsPanelVisible", apply);
}

/**
 * Keep the replay control showing whether replay is available. It has to
 * say so from the first paint, so the app owns it rather than the replay
 * manager, which is only fetched once someone opens replay.
 */
export function followReplayAvailability(app: MapApp): void {
  // A running replay owns the button (it is pressed); it is back in step
  // with the selection as the replay closes
  const refresh = (): void => {
    const hint = app.replayHint();
    if (!app.replayActive) updateReplayButtonState(hint);
    // The phone's Replay beside the selection (styles.css)
    const chipReplay = domCache.get("selection-replay-btn");
    if (chipReplay) chipReplay.hidden = hint !== null || app.replayActive;
  };
  app.store.subscribeKeys(
    ["selectedPathIds", "hasTimingData", "currentData", "replayActive"],
    refresh,
  );
  refresh();
  // A press of the Replay control itself, so that a mode which holds it
  // (heldControls.ts) says why rather than a replay starting under it
  domCache
    .get("selection-replay-btn")
    ?.addEventListener("click", () => domCache.get("replay-btn")?.click(), {
      signal: app.signal,
    });
}

/**
 * Hand the keyboard's focus to the open rail: to its selected tab, or to
 * the panel while the tabs wait for their code (ui/flightList.ts).
 */
export function focusStatsRail(): void {
  const tabs = domCache.get("stats-rail-tabs");
  const target =
    tabs && !tabs.hidden
      ? tabs.querySelector<HTMLElement>('[aria-selected="true"]')
      : domCache.get("stats-panel");
  target?.focus();
}

/**
 * Hand focus to the first reachable statistics trigger when the rail that
 * holds it is about to be hidden. Without this the browser drops focus to
 * `<body>` and the next Tab restarts at the top of the document, ahead of
 * every focusable marker on the map.
 */
function restoreFocusFromRail(
  rail: HTMLElement,
  map: MapLibreMap | null,
): void {
  if (!rail.contains(document.activeElement)) return;
  // The mobile tab replaces the desktop button on small viewports
  for (const id of ["stats-btn", "mobile-tab-stats"]) {
    const trigger = domCache.get(id);
    if (!trigger || rail.contains(trigger)) continue;
    trigger.focus();
    if (document.activeElement === trigger) return;
  }
  // The map is the last resort: next to the controls in order. It is the
  // canvas that takes focus, the container around it does not.
  map?.getCanvas().focus();
}

/**
 * Keep --attribution-h at the height of the map's credit. The credit wraps
 * once a layer adds one of its own (see styles.css), and the legends, the
 * toasts and the phone's replay panel stand on top of it. A phone shows two
 * of its lines, and a tap on it beside its links all of them. It stops
 * with `signal`.
 */
export function followAttributionHeight(
  map: MapLibreMap,
  signal: AbortSignal,
): void {
  const credit = map
    .getContainer()
    .querySelector<HTMLElement>(".maplibregl-ctrl-attrib");
  if (!credit) return;
  credit.addEventListener(
    "click",
    (event) => {
      if (!(event.target as Element).closest("a")) {
        credit.classList.toggle("is-expanded");
      }
    },
    { signal },
  );
  if (typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(() => {
    const height = credit.getBoundingClientRect().height;
    // Hidden while a sheet covers its corner: the chrome keeps its place
    if (height > 0) {
      document.documentElement.style.setProperty(
        "--attribution-h",
        `${height}px`,
      );
    }
  });
  observer.observe(credit);
  signal.addEventListener("abort", () => observer.disconnect());
}
