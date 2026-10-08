/**
 * What every unit test starts from (vitest.config.js, setupFiles)
 */
import { afterEach, beforeEach } from "vitest";

// A mouse. jsdom's window has `ontouchstart`, which makes the page take the
// device for a touch screen (utils/device.ts): the tooltips would not open,
// and a flight a test picks would bring on the tip of the 3D view, with its
// timer and listeners (ui/mapOrientation.ts). A test that wants a finger
// sets it, or mocks isTouchDevice.
//
// No stored settings either: one jsdom serves every file of a worker
// (vmThreads), so what a test stored (the tip of the 3D view offered, a
// panel left open) was there for whichever file the shuffle ran next.
beforeEach(() => {
  delete (window as { ontouchstart?: unknown }).ontouchstart;
  localStorage.clear();
  sessionStorage.clear();
});

// No toasts or live regions of the test before. The toasts stack in one
// container, so a test that read the first toast read an older one, and
// utils/toast.ts keeps the write still to come with each live region: a
// new region starts without one.
afterEach(() => {
  for (const id of ["toast-stack", "toast-status", "toast-alert"]) {
    document.getElementById(id)?.remove();
  }
});
