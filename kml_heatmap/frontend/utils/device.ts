/**
 * What kind of screen and pointer the page is on. Every question the app
 * asks about the device goes through here, so the phone layout means the
 * same to the mobile bar, the labels and the export.
 */
import { MOBILE_BREAKPOINT_PX } from "./constants";

/**
 * The phone layout: the mobile bar in place of the control columns. Just
 * under the breakpoint, like the stylesheet, so the two agree on a
 * fractional width such as 767.5px.
 */
export const PHONE_LAYOUT_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 0.02}px)`;

/** Whether the page matches a media query; false where there are none */
export function matchesMedia(query: string): boolean {
  return (
    typeof window.matchMedia === "function" && window.matchMedia(query).matches
  );
}

/**
 * Whether the page has the phone layout. Without media queries (jsdom), by
 * the width of the window.
 */
export function isPhoneLayout(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(PHONE_LAYOUT_QUERY).matches
    : window.innerWidth < MOBILE_BREAKPOINT_PX;
}

/**
 * Whether the pointer cannot hover, so tooltips need a tap instead. Touch
 * support alone does not say: a laptop with a touchscreen is driven by its
 * mouse most of the time, and lost the hover tooltips for having one.
 */
export function isTouchDevice(): boolean {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(hover: none)").matches;
  }
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

/**
 * Whether a link goes to the native share sheet rather than the clipboard:
 * in the phone layout alone. A tablet or a touch laptop has the control
 * columns, whose control says "Copy link".
 */
export function canShareLink(): boolean {
  return isPhoneLayout() && typeof navigator.share === "function";
}

/**
 * A phone or a tablet: the phone layout, or a finger for a pointer. These
 * get the share sheet where a desktop copies a link or downloads a file.
 */
export function isSmallDevice(): boolean {
  return isPhoneLayout() || matchesMedia("(pointer: coarse)");
}
