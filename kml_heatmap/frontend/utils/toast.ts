/** Delay between clearing a live region and writing its new message (ms) */
export const LIVE_REGION_DELAY_MS = 100;

/** Persistent regions that speak the toasts; see map_template.html */
export const TOAST_STATUS_ID = "toast-status";
export const TOAST_ALERT_ID = "toast-alert";

/** Container the visible toasts stack in */
export const TOAST_STACK_ID = "toast-stack";

const pendingWrites = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/**
 * Write a message to a live region that stays in the document.
 *
 * Screen readers announce a change to a region they already track. A
 * region inserted with its text is often skipped, and so is a message
 * written in the same task the region was cleared in, so the region is
 * cleared now and filled a moment later. A newer message replaces one that
 * has not been written yet.
 */
export function announceInRegion(region: HTMLElement, message: string): void {
  const pending = pendingWrites.get(region);
  if (pending !== undefined) clearTimeout(pending);
  region.textContent = "";
  pendingWrites.set(
    region,
    setTimeout(() => {
      pendingWrites.delete(region);
      region.textContent = message;
    }, LIVE_REGION_DELAY_MS),
  );
}

/** The element with this id, created on the body when the page lacks it */
function ensureElement(
  id: string,
  build: (element: HTMLElement) => void,
): HTMLElement {
  const existing = document.getElementById(id);
  if (existing) return existing;
  const element = document.createElement("div");
  element.id = id;
  build(element);
  document.body.appendChild(element);
  return element;
}

function toastRegion(type: "error" | "info"): HTMLElement {
  const alert = type === "error";
  return ensureElement(alert ? TOAST_ALERT_ID : TOAST_STATUS_ID, (region) => {
    region.className = "visually-hidden";
    region.setAttribute("role", alert ? "alert" : "status");
    region.setAttribute("aria-live", alert ? "assertive" : "polite");
    region.setAttribute("aria-atomic", "true");
  });
}

/** Speak a message through the page's status region, without a toast */
export function announceStatus(message: string): void {
  announceInRegion(toastRegion("info"), message);
}

export function showToast(
  message: string,
  type: "error" | "info" = "info",
): void {
  // Several toasts in a row stack in one container instead of being drawn
  // on top of each other at the same fixed position
  const stack = ensureElement(TOAST_STACK_ID, (container) => {
    container.className = "toast-stack";
    // The live regions speak the message; this is only its picture
    container.setAttribute("aria-hidden", "true");
  });

  const toast = document.createElement("div");
  toast.className = `toast-notification toast-${type}`;
  toast.textContent = message;
  stack.appendChild(toast);
  announceInRegion(toastRegion(type), message);

  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    toast.addEventListener("transitionend", () => toast.remove());
    setTimeout(() => toast.remove(), 1000);
  }, 4000);
}
