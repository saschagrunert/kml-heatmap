/**
 * MobileSheet: rendering, the three row kinds, dismissal and focus handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import {
  MobileSheet,
  type SheetRow,
} from "../../../../kml_heatmap/frontend/ui/mobileSheet";

function rows(sheet: MobileSheet): HTMLElement[] {
  return Array.from(sheet.root.querySelectorAll<HTMLElement>(".sheet-row"));
}

function row(sheet: MobileSheet, id: string): HTMLElement {
  const element = sheet.root.querySelector<HTMLElement>(`[data-row="${id}"]`);
  if (!element) throw new Error(`Missing sheet row ${id}`);
  return element;
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

describe("MobileSheet", () => {
  let sheet: MobileSheet;

  beforeEach(() => {
    sheet = new MobileSheet("test-sheet");
    sheet.mount(document.body);
  });

  afterEach(() => {
    sheet.destroy();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  describe("mounting", () => {
    it("adds a hidden scrim and sheet", () => {
      expect(document.getElementById("test-sheet")).toBe(sheet.root);
      expect(document.getElementById("test-sheet-scrim")).toBe(sheet.scrim);
      expect(sheet.root.hidden).toBe(true);
      expect(sheet.scrim.hidden).toBe(true);
      expect(sheet.isOpen()).toBe(false);
      expect(sheet.root.hasAttribute("inert")).toBe(true);
    });

    it("is a labelled modal dialog", () => {
      expect(sheet.root.getAttribute("role")).toBe("dialog");
      expect(sheet.root.getAttribute("aria-modal")).toBe("true");
      expect(sheet.root.getAttribute("aria-labelledby")).toBe(
        "test-sheet-title",
      );
      // The close control must stay outside the labelling element
      expect(
        document.getElementById("test-sheet-title")!.querySelector("button"),
      ).toBeNull();
    });
  });

  describe("openWith", () => {
    it("shows the title, the rows and the scrim", () => {
      sheet.openWith("Layers", [
        {
          kind: "switch",
          id: "heatmap",
          icon: "heatmap",
          label: "Heatmap",
          isOn: () => true,
          onToggle: vi.fn(),
        },
      ]);

      expect(sheet.isOpen()).toBe(true);
      expect(sheet.root.hidden).toBe(false);
      expect(sheet.scrim.hidden).toBe(false);
      // The stylesheet slides the sheet in on .is-open
      expect(sheet.root.classList.contains("is-open")).toBe(true);
      expect(sheet.scrim.classList.contains("is-open")).toBe(true);
      expect(sheet.root.querySelector(".sheet-title-text")!.textContent).toBe(
        "Layers",
      );
      expect(rows(sheet)).toHaveLength(1);
    });

    it("moves focus into the sheet and returns it on close", () => {
      const opener = document.createElement("button");
      document.body.append(opener);
      opener.focus();

      sheet.openWith("Layers", []);
      expect(document.activeElement).toBe(sheet.root);

      sheet.close();
      expect(document.activeElement).toBe(opener);
    });

    it("replaces the rows of a previous open", () => {
      const spec = (id: string): SheetRow => ({
        kind: "action",
        id,
        icon: "stats",
        label: id,
        onSelect: vi.fn(),
      });

      sheet.openWith("First", [spec("a"), spec("b")]);
      sheet.close();
      sheet.openWith("Second", [spec("c")]);

      expect(rows(sheet)).toHaveLength(1);
      expect(row(sheet, "c")).not.toBeNull();
    });

    it("runs the close callback once", () => {
      const onClose = vi.fn();
      sheet.openWith("Layers", [], onClose);

      sheet.close();
      sheet.close();

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("dismissal", () => {
    beforeEach(() => {
      sheet.openWith("Layers", []);
    });

    it("closes on a scrim tap", () => {
      sheet.scrim.click();

      expect(sheet.isOpen()).toBe(false);
      expect(sheet.root.hidden).toBe(true);
      expect(sheet.root.classList.contains("is-open")).toBe(false);
    });

    it("closes on the close control", () => {
      sheet.root.querySelector<HTMLButtonElement>(".sheet-close")!.click();

      expect(sheet.isOpen()).toBe(false);
    });

    it("closes on Escape", () => {
      pressEscape();

      expect(sheet.isOpen()).toBe(false);
    });

    it("stops taking taps the moment it closes", () => {
      // `hidden` alone leaves the sheet hit-testable: the stylesheet gives
      // `.mobile-sheet` a display of its own, and the slide-out delays
      // `visibility` by the whole transition, so a tap landing where a row
      // used to be still fired that row
      sheet.root.querySelector<HTMLButtonElement>(".sheet-close")!.click();

      expect(sheet.root.hasAttribute("inert")).toBe(true);
      expect(sheet.root.style.pointerEvents).toBe("none");
    });

    it("becomes interactive again on the next open", () => {
      sheet.close();
      expect(sheet.root.hasAttribute("inert")).toBe(true);

      sheet.openWith("Filter", []);

      expect(sheet.root.hasAttribute("inert")).toBe(false);
      expect(sheet.root.style.pointerEvents).toBe("");
    });

    it("ignores Escape once closed", () => {
      const onClose = vi.fn();
      sheet.openWith("Layers", [], onClose);
      sheet.close();
      onClose.mockClear();

      pressEscape();

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("switch rows", () => {
    let on: boolean;
    let toggle: Mock<() => void>;

    beforeEach(() => {
      on = false;
      toggle = vi.fn(() => {
        on = !on;
      });
      sheet.openWith("Layers", [
        {
          kind: "switch",
          id: "altitude",
          icon: "altitude",
          label: "Altitude",
          chip: "altitude",
          isOn: () => on,
          onToggle: toggle,
        },
      ]);
    });

    it("renders a switch with a 24px icon and a gradient chip", () => {
      const element = row(sheet, "altitude");

      expect(element.getAttribute("role")).toBe("switch");
      expect(element.getAttribute("aria-checked")).toBe("false");
      expect(
        element.querySelector(":scope > svg.icon")!.getAttribute("width"),
      ).toBe("24");
      expect(element.querySelector(".gradient-chip-altitude")).not.toBeNull();
      expect(element.querySelector(".sheet-switch")).not.toBeNull();
    });

    it("toggles and reflects the new state", () => {
      row(sheet, "altitude").click();

      expect(toggle).toHaveBeenCalledTimes(1);
      expect(row(sheet, "altitude").getAttribute("aria-checked")).toBe("true");
      expect(row(sheet, "altitude").classList.contains("active")).toBe(true);
    });

    it("disables a row whose control is unavailable", () => {
      sheet.openWith("Layers", [
        {
          kind: "switch",
          id: "speed",
          icon: "speed",
          label: "Speed",
          isOn: () => false,
          isDisabled: () => true,
          onToggle: vi.fn(),
        },
      ]);

      expect((row(sheet, "speed") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("select rows", () => {
    let source: HTMLSelectElement;

    beforeEach(() => {
      source = document.createElement("select");
      source.id = "year-select";
      // Matches what the app writes: appInitializer and filterManager
      // stopped prefixing option labels with an emoji
      for (const [value, label] of [
        ["all", "All years"],
        ["2024", "2024"],
        ["2025", "2025"],
      ]) {
        const option = document.createElement("option");
        option.value = value!;
        option.textContent = label!;
        source.append(option);
      }
      source.value = "2025";
      document.body.append(source);

      sheet.openWith("Filter", [
        {
          kind: "select",
          id: "year",
          icon: "calendar",
          label: "Year",
          sourceId: "year-select",
        },
      ]);
    });

    it("mirrors the options and shows the value", () => {
      const select = row(sheet, "year").querySelector("select")!;

      // The unfiltered option is relabelled: the row already says "Year"
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
        "All",
        "2024",
        "2025",
      ]);
      expect(select.value).toBe("2025");
      expect(
        row(sheet, "year").querySelector(".sheet-row-value")!.textContent,
      ).toBe("2025");
      expect(
        row(sheet, "year").querySelector(".sheet-row-chevron"),
      ).not.toBeNull();
    });

    it("writes the choice back to the page's own dropdown", () => {
      const changed = vi.fn();
      source.addEventListener("change", changed);
      const select = row(sheet, "year").querySelector("select")!;

      select.value = "2024";
      select.dispatchEvent(new Event("change"));

      expect(source.value).toBe("2024");
      expect(changed).toHaveBeenCalledTimes(1);
      expect(
        row(sheet, "year").querySelector(".sheet-row-value")!.textContent,
      ).toBe("2024");
    });

    it("follows the source when it is disabled during replay", () => {
      source.disabled = true;

      sheet.refresh();

      expect(row(sheet, "year").querySelector("select")!.disabled).toBe(true);
    });

    it("disables itself when the source is missing", () => {
      source.remove();

      sheet.refresh();

      expect(row(sheet, "year").querySelector("select")!.disabled).toBe(true);
    });
  });

  describe("action rows", () => {
    it("closes the sheet before running the action", () => {
      const order: string[] = [];
      sheet.openWith(
        "More",
        [
          {
            kind: "action",
            id: "export",
            icon: "export",
            label: "Export map",
            onSelect: () => order.push("action"),
          },
        ],
        () => order.push("close"),
      );

      row(sheet, "export").click();

      expect(order).toEqual(["close", "action"]);
      expect(sheet.isOpen()).toBe(false);
    });

    it("keeps the sheet open when the row asks for it", () => {
      const onSelect = vi.fn();
      sheet.openWith("More", [
        {
          kind: "action",
          id: "keep",
          icon: "stats",
          label: "Keep open",
          closeOnSelect: false,
          onSelect,
        },
      ]);

      row(sheet, "keep").click();

      expect(onSelect).toHaveBeenCalled();
      expect(sheet.isOpen()).toBe(true);
    });

    it("shows and hides the hint line", () => {
      let ready = false;
      sheet.openWith("More", [
        {
          kind: "action",
          id: "replay",
          icon: "play",
          label: "Replay flight",
          hint: () => (ready ? null : "Select one flight"),
          onSelect: vi.fn(),
        },
      ]);

      const hint = row(sheet, "replay").querySelector<HTMLElement>(
        ".sheet-row-hint",
      )!;
      expect(hint.hidden).toBe(false);
      expect(hint.textContent).toBe("Select one flight");

      ready = true;
      sheet.refresh();

      expect(hint.hidden).toBe(true);
    });
  });

  describe("focus trap", () => {
    beforeEach(() => {
      sheet.openWith("More", [
        {
          kind: "action",
          id: "one",
          icon: "stats",
          label: "One",
          onSelect: vi.fn(),
        },
      ]);
    });

    it("wraps from the last control to the first", () => {
      const focusable = sheet.root.querySelectorAll<HTMLElement>("button");
      const last = focusable[focusable.length - 1]!;
      last.focus();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));

      expect(document.activeElement).toBe(focusable[0]);
    });

    it("wraps backwards from the sheet itself to the last control", () => {
      const focusable = sheet.root.querySelectorAll<HTMLElement>("button");

      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }),
      );

      expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    });

    it("keeps focus on the sheet when it holds no controls", () => {
      sheet.close();
      sheet.root.querySelector(".sheet-close")!.remove();
      sheet.openWith("Empty", []);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));

      expect(document.activeElement).toBe(sheet.root);
    });
  });
});
