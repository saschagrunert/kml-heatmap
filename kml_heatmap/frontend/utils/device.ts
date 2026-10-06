/**
 * What kind of screen and pointer the page is on. Every question the app
 * asks about the device goes through here, so the phone layout means the
 * same to the mobile bar, the labels and the export.
 */
import { MOBILE_BREAKPOINT_PX, PHONE_MAX_HEIGHT_PX } from "./constants";

/**
 * The phone layout: the mobile bar in place of the control columns, below
 * the breakpoint's width or at a phone's height held sideways. Just under
 * the breakpoint, like the stylesheet, so the two agree on a fractional
 * width such as 767.5px.
 */
export const PHONE_LAYOUT_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 0.02}px), (max-height: ${PHONE_MAX_HEIGHT_PX}px)`;

/** The lists of the queries asked, and the matchMedia they came from */
let lists = new Map<string, MediaQueryList>();
let listsOf: unknown = null;

/**
 * The list of a media query, null where there are none (jsdom). One per
 * query: a MediaQueryList follows the page by itself, and the hover of the
 * pointer asks on every frame.
 */
function mediaList(query: string): MediaQueryList | null {
  if (typeof window.matchMedia !== "function") return null;
  // Compared, never called unbound: a page given another matchMedia (a
  // test's) asks it anew
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const matchMedia = window.matchMedia;
  if (listsOf !== matchMedia) {
    lists = new Map();
    listsOf = matchMedia;
  }
  let list = lists.get(query);
  if (!list) {
    list = window.matchMedia(query);
    lists.set(query, list);
  }
  return list;
}

/** Whether the page matches a media query; false where there are none */
export function matchesMedia(query: string): boolean {
  return mediaList(query)?.matches ?? false;
}

/**
 * Whether the page has the phone layout. Without media queries (jsdom), by
 * the size of the window.
 */
export function isPhoneLayout(): boolean {
  return (
    mediaList(PHONE_LAYOUT_QUERY)?.matches ??
    (window.innerWidth < MOBILE_BREAKPOINT_PX ||
      window.innerHeight <= PHONE_MAX_HEIGHT_PX)
  );
}

/**
 * Whether the pointer cannot hover, so tooltips need a tap instead. Touch
 * support alone does not say: a laptop with a touchscreen is driven by its
 * mouse most of the time, and lost the hover tooltips for having one.
 */
export function isTouchDevice(): boolean {
  return (
    mediaList("(hover: none)")?.matches ??
    ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  );
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
