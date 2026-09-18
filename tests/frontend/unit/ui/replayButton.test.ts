/**
 * The replay control's resting state.
 *
 * It has to explain itself from the first paint, before anyone opens replay
 * and the feature bundle is fetched, so the app drives it and not the replay
 * manager. These tests cover the part that stays in the main bundle.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  REPLAY_BUTTON_LABEL,
  REPLAY_PRECONDITION_MESSAGE,
  updateReplayButtonState,
} from "../../../../kml_heatmap/frontend/ui/replayButton";
import { domCache } from "../../../../kml_heatmap/frontend/utils/domCache";

function button(): HTMLButtonElement {
  return document.getElementById("replay-btn") as HTMLButtonElement;
}

describe("updateReplayButtonState", () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="replay-btn"></button>';
    domCache.clear();
  });

  it("dims the button and says what is missing when replay is not possible", () => {
    updateReplayButtonState(false);

    expect(button().style.opacity).toBe("0.5");
    expect(button().title).toBe(REPLAY_PRECONDITION_MESSAGE);
  });

  it("brings it to full strength once replay is possible", () => {
    updateReplayButtonState(true);

    expect(button().style.opacity).toBe("1");
    expect(button().title).toBe(REPLAY_BUTTON_LABEL);
  });

  it("leaves the button clickable either way", () => {
    // Clicking it is how the user learns why replay is unavailable, so it
    // must not be disabled or hidden from assistive tech
    updateReplayButtonState(false);

    expect(button().disabled).toBe(false);
    expect(button().hasAttribute("aria-disabled")).toBe(false);
  });

  it("does nothing when the control is not on the page", () => {
    document.body.innerHTML = "";
    domCache.clear();

    expect(() => updateReplayButtonState(true)).not.toThrow();
  });
});
