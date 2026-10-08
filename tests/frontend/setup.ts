/**
 * What every unit test starts from (vitest.config.js, setupFiles)
 */
import { beforeEach } from "vitest";

// A mouse. jsdom's window has `ontouchstart`, which makes the page take the
// device for a touch screen (utils/device.ts): the tooltips would not open,
// and a flight a test picks would bring on the tip of the 3D view, with its
// timer and listeners (ui/mapOrientation.ts). A test that wants a finger
// sets it, or mocks isTouchDevice.
beforeEach(() => {
  delete (window as { ontouchstart?: unknown }).ontouchstart;
});
