import { test, expect } from "@playwright/test";
import { activateReplay } from "./helpers";

test.describe("Replay", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
  });

  test("toggleReplay activates replay mode", async ({ page }) => {
    await activateReplay(page);

    await expect(page.locator("#replay-controls")).toBeVisible();
    const hasClass = await page.evaluate(() =>
      document.body.classList.contains("replay-active")
    );
    expect(hasClass).toBe(true);
  });

  test("replay controls are visible when active", async ({ page }) => {
    await activateReplay(page);

    await expect(page.locator("#replay-play-btn")).toBeVisible();
    await expect(page.locator("#replay-stop-btn")).toBeVisible();
    await expect(page.locator("#replay-time-display")).toBeVisible();
    await expect(page.locator("#replay-speed")).toBeVisible();
    await expect(page.locator("#replay-autozoom-btn")).toBeVisible();
    await expect(page.locator("#replay-slider")).toBeVisible();
    await expect(page.locator("#replay-slider")).toHaveValue("0");
  });

  test("playReplay starts animation and shows pause button", async ({
    page,
  }) => {
    await activateReplay(page);

    await page.locator("#replay-play-btn").click();
    await page.waitForTimeout(300);

    await expect(page.locator("#replay-play-btn")).toBeHidden();
    await expect(page.locator("#replay-pause-btn")).toBeVisible();

    const isPlaying = await page.evaluate(
      () => (window as any).mapApp.replayManager.replayPlaying
    );
    expect(isPlaying).toBe(true);
  });

  test("pauseReplay pauses animation and shows play button", async ({
    page,
  }) => {
    await activateReplay(page);

    await page.locator("#replay-play-btn").click();
    await page.waitForTimeout(300);
    await page.locator("#replay-pause-btn").click();

    await expect(page.locator("#replay-play-btn")).toBeVisible();
    await expect(page.locator("#replay-pause-btn")).toBeHidden();

    const isPlaying = await page.evaluate(
      () => (window as any).mapApp.replayManager.replayPlaying
    );
    expect(isPlaying).toBe(false);
  });

  test("stopReplay resets to beginning", async ({ page }) => {
    await activateReplay(page);

    // Play briefly, then stop
    await page.locator("#replay-play-btn").click();
    await page.waitForTimeout(500);
    await page.locator("#replay-stop-btn").click();

    const currentTime = await page.evaluate(
      () => (window as any).mapApp.replayManager.replayCurrentTime
    );
    expect(currentTime).toBe(0);
    await expect(page.locator("#replay-slider")).toHaveValue("0");
    await expect(page.locator("#replay-play-btn")).toBeVisible();
    await expect(page.locator("#replay-pause-btn")).toBeHidden();
  });

  test("seekReplay moves position", async ({ page }) => {
    await activateReplay(page);

    const maxTime = await page.evaluate(
      () => (window as any).mapApp.replayManager.replayMaxTime
    );
    const midpoint = Math.floor(maxTime / 2);

    await page.evaluate(
      (val) => (window as any).seekReplay(String(val)),
      midpoint
    );

    const currentTime = await page.evaluate(
      () => (window as any).mapApp.replayManager.replayCurrentTime
    );
    expect(currentTime).toBeGreaterThan(0);
  });

  test("changeReplaySpeed updates speed", async ({ page }) => {
    await activateReplay(page);

    const defaultSpeed = await page.evaluate(
      () => (window as any).mapApp.replayManager.replaySpeed
    );
    expect(defaultSpeed).toBe(50);

    await page.locator("#replay-speed").selectOption("100");
    await page.evaluate(() => (window as any).changeReplaySpeed());

    const newSpeed = await page.evaluate(
      () => (window as any).mapApp.replayManager.replaySpeed
    );
    expect(newSpeed).toBe(100);
  });

  test("toggleAutoZoom toggles auto-zoom state", async ({ page }) => {
    await activateReplay(page);

    const autoZoomBtn = page.locator("#replay-autozoom-btn");

    // Default: auto-zoom off (opacity 0.5)
    await expect(autoZoomBtn).toHaveCSS("opacity", "0.5");

    // Toggle on
    await autoZoomBtn.click();
    await expect(autoZoomBtn).toHaveCSS("opacity", "1");
    const isOn = await page.evaluate(
      () => (window as any).mapApp.replayManager.replayAutoZoom
    );
    expect(isOn).toBe(true);

    // Toggle off
    await autoZoomBtn.click();
    await expect(autoZoomBtn).toHaveCSS("opacity", "0.5");
    const isOff = await page.evaluate(
      () => (window as any).mapApp.replayManager.replayAutoZoom
    );
    expect(isOff).toBe(false);
  });

  test("airplane marker appears during replay", async ({ page }) => {
    await activateReplay(page);

    const airplaneIcon = page.locator(".replay-airplane-icon");
    await expect(airplaneIcon).toBeAttached();
    const text = await airplaneIcon.textContent();
    expect(text).toContain("✈️");
  });

  test("replay time display updates during playback", async ({ page }) => {
    await activateReplay(page);

    await page.locator("#replay-play-btn").click();
    await page.waitForTimeout(500);
    await page.locator("#replay-pause-btn").click();

    const currentTime = await page.evaluate(
      () => (window as any).mapApp.replayManager.replayCurrentTime
    );
    expect(currentTime).toBeGreaterThan(0);
  });

  test("stopping replay restores normal UI", async ({ page }) => {
    await activateReplay(page);

    // Toggle replay off
    await page.locator("#replay-btn").click();
    await expect(page.locator("#replay-controls")).toBeHidden();

    const hasClass = await page.evaluate(() =>
      document.body.classList.contains("replay-active")
    );
    expect(hasClass).toBe(false);

    // Controls should be re-enabled
    await expect(page.locator("#heatmap-btn")).toBeEnabled();
    await expect(page.locator("#year-select")).toBeEnabled();
  });

  test("replay disables heatmap and filter controls", async ({ page }) => {
    await activateReplay(page);

    await expect(page.locator("#heatmap-btn")).toBeDisabled();
    await expect(page.locator("#airports-btn")).toBeDisabled();
    await expect(page.locator("#year-select")).toBeDisabled();
    await expect(page.locator("#aircraft-select")).toBeDisabled();
  });

  test("replay button text changes when activated", async ({ page }) => {
    await activateReplay(page);

    const btnText = await page.locator("#replay-btn").textContent();
    expect(btnText).toContain("⏹️");

    // Deactivate
    await page.locator("#replay-btn").click();
    await expect(page.locator("#replay-controls")).toBeHidden();

    const restoredText = await page.locator("#replay-btn").textContent();
    expect(restoredText).toContain("▶️");
  });

  test("replay slider shows time labels", async ({ page }) => {
    await activateReplay(page);

    const startLabel = page.locator("#replay-slider-start");
    const endLabel = page.locator("#replay-slider-end");

    await expect(startLabel).toBeVisible();
    await expect(endLabel).toBeVisible();

    const endText = await endLabel.textContent();
    expect(endText).toBeTruthy();
    expect(endText).not.toBe("0:00");
  });

  test("replay speed dropdown has all options", async ({ page }) => {
    await activateReplay(page);

    const speedSelect = page.locator("#replay-speed");
    const options = speedSelect.locator("option");
    const values = await options.evaluateAll((els) =>
      els.map((el) => (el as HTMLOptionElement).value)
    );

    expect(values).toContain("10");
    expect(values).toContain("25");
    expect(values).toContain("50");
    expect(values).toContain("100");
    expect(values).toContain("200");
    expect(values).toContain("500");
  });

  test("airplane marker popup toggles on click", async ({ page }) => {
    await activateReplay(page);

    // Play briefly to get position data
    await page.locator("#replay-play-btn").click();
    await page.waitForTimeout(500);
    await page.locator("#replay-pause-btn").click();

    // Click the airplane marker to open popup
    const airplaneIcon = page.locator(".replay-airplane-icon");
    await airplaneIcon.click();
    await page.waitForTimeout(300);

    // Popup should appear with position info
    const popup = page.locator(".leaflet-popup-content");
    await expect(popup).toBeVisible({ timeout: 3000 });
    const popupText = await popup.textContent();
    expect(popupText).toContain("Current Position");

    // Close popup programmatically (Leaflet popup tip intercepts DOM clicks)
    await page.evaluate(() => {
      (window as any).mapApp.replayManager.replayAirplaneMarker.closePopup();
    });
    await page.waitForTimeout(300);
    await expect(popup).toBeHidden();
  });
});
