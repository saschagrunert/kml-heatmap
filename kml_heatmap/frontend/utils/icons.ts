/**
 * Inline SVG icon set.
 *
 * One family drawn on a 24px grid with round caps and joins. The stroke
 * weight lifts as the icon shrinks so that density reads evenly:
 * 24px at 1.7, 20px at 1.8, 16px at 1.9.
 *
 * Icons are inlined rather than drawn from an icon font: the content security
 * policy allows no external font (`font-src 'self' file:`), and the page has
 * to work straight off the filesystem. They use `currentColor` so a single
 * colour rule drives them.
 */
import { logError } from "./logger";

export type IconName =
  | "stats"
  | "export"
  | "share"
  | "wrapped"
  | "play"
  | "pause"
  | "stop"
  | "isolate"
  | "heatmap"
  | "airport"
  | "altitude"
  | "speed"
  | "aviation"
  | "layers"
  | "filter"
  | "chevronDown"
  | "chevronRight"
  | "collapse"
  | "autoZoom"
  | "close"
  | "aircraft"
  | "calendar"
  | "more";

/** Path geometry only; the wrapper supplies size, stroke and colour. */
const PATHS: Record<IconName, string> = {
  stats:
    '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5"/><path d="M13 16V8"/><path d="M18 16v-3"/>',
  export:
    '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7l1.2-1.8h6.2L15.8 6h2.7A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/><circle cx="12" cy="12" r="3.4"/>',
  share:
    '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
  wrapped:
    '<path d="M12 3.5l1.9 4.4 4.6.4-3.5 3.1 1.1 4.6L12 13.6l-4.1 2.4 1.1-4.6-3.5-3.1 4.6-.4z"/>',
  play: '<path d="M8 5.5l10 6.5-10 6.5z"/>',
  pause:
    '<rect x="7" y="6" width="3.4" height="12" rx="1"/><rect x="13.6" y="6" width="3.4" height="12" rx="1"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/>',
  isolate:
    '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.2" stroke-dasharray="2.6 3.4"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2"/>',
  heatmap:
    '<path d="M12 3.5c2.6 3 4 5.6 4 7.8a4 4 0 0 1-8 0c0-2.2 1.4-4.8 4-7.8z"/><path d="M6.5 14.5c-1.4 1.4-2.2 2.7-2.2 3.7a2.2 2.2 0 0 0 4.4 0"/><path d="M17.5 14.5c1.4 1.4 2.2 2.7 2.2 3.7a2.2 2.2 0 0 1-4.4 0"/>',
  airport:
    '<path d="M12 21s6.5-5.4 6.5-10.2A6.5 6.5 0 0 0 5.5 10.8C5.5 15.6 12 21 12 21z"/><circle cx="12" cy="10.6" r="2.4"/>',
  altitude: '<path d="M3 18l5.5-8 3.5 4.5 3-4 6 7.5z"/><path d="M3 18h18"/>',
  speed:
    '<path d="M3.5 8.5h9"/><path d="M3.5 12.5h13"/><path d="M3.5 16.5h7"/><path d="M17 6.6l3.4 5.9-3.4 5.9"/>',
  aviation:
    '<path d="M12 3.2l8.4 4.3-8.4 4.3-8.4-4.3z"/><path d="M3.6 12l8.4 4.3 8.4-4.3"/><path d="M3.6 16.4l8.4 4.3 8.4-4.3"/>',
  layers: '<path d="M4 9.5h16"/><path d="M4 14.5h16"/>',
  filter: '<path d="M4 6.5h16"/><path d="M7.5 12h9"/><path d="M10.5 17.5h3"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  collapse: '<path d="M14.5 6l-6 6 6 6"/>',
  autoZoom:
    '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/><path d="M8.5 11h5"/><path d="M11 8.5v5"/>',
  close: '<path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/>',
  aircraft:
    '<path d="M20.5 3.5L11 13"/><path d="M20.5 3.5l-6.2 17-3.3-7.5-7.5-3.3z"/>',
  calendar:
    '<rect x="3.8" y="5.2" width="16.4" height="15" rx="2.2"/><path d="M3.8 9.6h16.4"/><path d="M8.2 3.4v3.6"/><path d="M15.8 3.4v3.6"/>',
  more: '<circle cx="12" cy="12" r="1.7"/><circle cx="18.6" cy="12" r="1.7"/><circle cx="5.4" cy="12" r="1.7"/>',
};

/** Stroke weight paired with each size, so density reads evenly */
const STROKE_FOR_SIZE: Record<number, string> = {
  16: "1.9",
  20: "1.8",
  24: "1.7",
};

export const ICON_SIZES = [16, 20, 24] as const;
export type IconSize = (typeof ICON_SIZES)[number];

/** Icon size of the dense desktop control rows */
export const DEFAULT_ICON_SIZE: IconSize = 16;

/** Whether a string, typically a `data-icon` attribute, names a known icon */
export function isIconName(name: string | undefined): name is IconName {
  return (
    name !== undefined && Object.prototype.hasOwnProperty.call(PATHS, name)
  );
}

/**
 * Size a control is drawn at: the size last applied to it, recorded in
 * `data-icon-size`, falling back to the dense row size.
 */
export function iconSizeOf(el: HTMLElement): IconSize {
  const declared = Number(el.dataset["iconSize"]);
  return ICON_SIZES.includes(declared as IconSize)
    ? (declared as IconSize)
    : DEFAULT_ICON_SIZE;
}

/** Escape a caller string for use inside a double-quoted attribute */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Markup for one icon. Only `title` reaches the output from a caller, and it
 * is attribute-escaped, so the result is safe to insert with innerHTML
 * alongside escaped content.
 *
 * @param name - Icon to draw
 * @param size - One of the three sizes on the scale
 * @param title - Accessible name; omit for icons beside a text label
 */
export function icon(
  name: IconName,
  size: IconSize = 20,
  title?: string,
): string {
  const stroke = STROKE_FOR_SIZE[size] ?? "1.8";
  const label = title
    ? ' role="img" aria-label="' + escapeAttribute(title) + '"'
    : ' aria-hidden="true" focusable="false"';
  return (
    '<svg class="icon" width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
    stroke +
    '" stroke-linecap="round" stroke-linejoin="round"' +
    label +
    ">" +
    PATHS[name] +
    "</svg>"
  );
}

/**
 * Swap the icon of a control in place.
 *
 * Only the control's own leading `svg.icon` is replaced, so a sibling
 * `.control-label` survives; writing innerHTML here would destroy it. The
 * `data-icon` and `data-icon-size` attributes are updated too, so a later
 * `renderControlIcons()` redraws the state the control is actually in and the
 * swap keeps the size the surrounding chrome last asked for.
 *
 * @param button - Control to draw into
 * @param name - Icon to draw; an unknown name is logged and nothing is drawn
 * @param size - Size to draw at; the control's own size when omitted
 */
export function setControlIcon(
  button: HTMLElement,
  name: IconName,
  size?: IconSize,
): void {
  if (!isIconName(name)) {
    logError(`Unknown icon name: ${String(name)}`);
    return;
  }
  const drawn = size ?? iconSizeOf(button);
  button.dataset["icon"] = name;
  button.dataset["iconSize"] = String(drawn);
  button.querySelector(":scope > svg.icon")?.remove();
  button.insertAdjacentHTML("afterbegin", icon(name, drawn));
}
