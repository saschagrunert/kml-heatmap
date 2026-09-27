/**
 * The control of the heat cloud's band of heights (calculations/heightBand.ts)
 *
 * While the 3D view draws the heat as a cloud, a slider with two thumbs
 * sets the heights above ground whose heat it shows: the bottom and the
 * top of the band, at the stops of HEIGHT_BAND_STOPS_FT, the top past the
 * last for none. Each thumb is a range input of its own, so the keyboard
 * moves it as any slider (the arrows, Home and End, Page Up and Page Down)
 * and a screen reader reads its height; the two are laid over one track,
 * which only their thumbs take the pointer on. The band is in the store
 * (heightBand), so a session keeps it, a link carries it and Reset view
 * puts every height back.
 *
 * On a wide screen it is a row of the Map group, under the 3D switch; on
 * a phone, where the mobile bar stands in for the control columns and its
 * sheets would cover the map it changes, it floats over the top of the
 * map, beside the compass. It comes with the heat cloud, in the feature
 * bundle. A closure rather than a class: the bundle carries a class's
 * member names as they are written.
 */
import type { MapApp } from "../mapApp";
import {
  heightBandLabel,
  heightBandText,
  heightStopLabel,
  OPEN_TOP,
  parseHeightBand,
} from "../calculations/heightBand";
import { isPhoneLayout, PHONE_LAYOUT_QUERY } from "../utils/device";
import { icon } from "../utils/icons";

/**
 * Show the control of the heat cloud's band of heights in the 3D view from
 * now on, for as long as the app lives. Returns it.
 */
export function followHeightBand(app: MapApp): HTMLElement {
  const root = document.createElement("div");
  root.id = "height-band";
  root.setAttribute("role", "group");
  root.setAttribute("aria-labelledby", "height-band-title");
  root.hidden = true;
  /** A thumb of the slider, for the end `end` of the band */
  const thumb = (end: string, name: string): string =>
    `<input type="range" id="height-band-${end}" min="0" max="${OPEN_TOP}"` +
    ` step="1" aria-label="${name} height above ground">`;
  root.innerHTML =
    `<div class="height-band-head"><span id="height-band-title">` +
    `${icon("ruler", 16)}Height AGL</span>` +
    '<span class="height-band-value"></span></div>' +
    `<div class="height-band-track">${thumb("low", "Lowest")}` +
    `${thumb("high", "Highest")}</div>`;
  const value = root.querySelector<HTMLElement>(".height-band-value")!;
  const [low, high] = root.querySelectorAll("input") as unknown as [
    HTMLInputElement,
    HTMLInputElement,
  ];

  /**
   * Beside the 3D switch, or over the map in the phone layout, where the
   * control columns are hidden: there just before the floating compass it
   * is drawn beside, so the keyboard reaches the two one after the other
   * rather than the band last of the page
   */
  const place = (): void => {
    const row = document.getElementById("three-d-btn")?.closest(".control-row");
    const floating = !row || isPhoneLayout();
    const compass = document.getElementById("compass-float-btn");
    if (!floating) row.after(root);
    else if (compass?.parentElement === document.body) compass.before(root);
    else document.body.append(root);
    root.classList.toggle("control-group", floating);
  };

  /** Show the band of the store, and the control where the cloud is */
  const sync = (): void => {
    const band = parseHeightBand(app.heightBand);
    // Other heights, as a link edited by hand may have, are every height
    const text = heightBandText(band);
    if (text !== app.heightBand) {
      app.heightBand = text;
      return;
    }
    low.value = String(band.low);
    high.value = String(band.high);
    low.setAttribute("aria-valuetext", heightStopLabel(band.low));
    high.setAttribute("aria-valuetext", heightStopLabel(band.high));
    // The bottom thumb over the top one once it is in the right half,
    // where the top one can move no further right
    low.classList.toggle("is-above", band.low > OPEN_TOP / 2);
    root.style.setProperty("--band-low", String(band.low / OPEN_TOP));
    root.style.setProperty("--band-high", String(band.high / OPEN_TOP));
    value.textContent = heightBandLabel(band);
    root.hidden = !(app.threeDVisible && app.heatCloud && app.heatmapVisible);
  };

  /** A thumb moved: the band, with the other thumb a stop away at least */
  const moved = (event: Event): void => {
    let bottom = Number(low.value);
    let top = Number(high.value);
    if (bottom >= top) {
      if (event.target === low) bottom = top - 1;
      else top = bottom + 1;
    }
    app.heightBand = heightBandText({ low: bottom, high: top });
    // The store changed nothing where a thumb was held back at the other
    sync();
  };
  const lifetime = { signal: app.signal };
  root.addEventListener("input", moved, lifetime);
  window
    .matchMedia?.(PHONE_LAYOUT_QUERY)
    .addEventListener("change", place, lifetime);
  const unsubscribe = app.store.subscribeKeys(
    ["heightBand", "threeDVisible", "heatCloud", "heatmapVisible"],
    sync,
  );
  app.signal.addEventListener("abort", () => {
    unsubscribe();
    root.remove();
  });
  place();
  sync();
  return root;
}
