/**
 * Mark a scroll container that has reached its end.
 *
 * Long panels are cut off wherever the container stops, which lands
 * mid-row as often as not and reads as content hidden behind whatever sits
 * below. The stylesheet fades the last few pixels of such a panel to say
 * there is more; the fade would then sit over the final row forever, so the
 * container carries `is-at-end` once it is scrolled to the bottom (or never
 * scrolls at all) and the stylesheet drops the fade again.
 */

/** Handle on a watched container */
export interface ScrollEndWatcher {
  /**
   * Re-read the scroll position. Scrolling and resizing are followed on
   * their own; a panel whose content was just rewritten has to say so, as
   * neither event fires for that.
   */
  update: () => void;
  /** Stop watching */
  stop: () => void;
}

/**
 * Watch `element` and keep its `is-at-end` class in step with its scroll
 * position.
 */
export function watchScrollEnd(element: HTMLElement): ScrollEndWatcher {
  const update = (): void => {
    const atEnd =
      element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
    element.classList.toggle("is-at-end", atEnd);
  };

  element.addEventListener("scroll", update, { passive: true });
  // A resize can make everything fit, and then the fade would sit over
  // nothing until the next scroll that can no longer happen
  window.addEventListener("resize", update, { passive: true });
  update();

  return {
    update,
    stop: () => {
      element.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    },
  };
}
