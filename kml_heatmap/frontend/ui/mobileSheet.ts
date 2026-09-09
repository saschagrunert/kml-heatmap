/**
 * Bottom sheet used by the mobile control bar.
 *
 * The sheet is built at runtime rather than shipped in the template: it
 * exists only below the mobile breakpoint, so the desktop document never
 * pays for it. One instance is reused for every tab; `openWith()` swaps the
 * title and the rows.
 *
 * Rows follow one shape: a 24 px icon, the label and a right-aligned
 * control. Layers get a switch, filters mirror one of the page's own
 * `<select>` elements so the existing filter pipeline stays the single
 * source of truth, and actions get a chevron.
 */
import { icon, type IconName } from "../utils/icons";

/** Elements that can hold focus inside the sheet */
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "select:not([disabled])",
  "input:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** Gradient chips a layer row can carry */
export type SheetChip = "altitude" | "speed";

/**
 * Shown for the unfiltered option. The dropdowns name the filter in that
 * option ("All aircraft"), which reads as "Aircraft: All aircraft" beside a
 * row that already says "Aircraft".
 */
const ALL_OPTION_LABEL = "All";

interface SheetRowBase {
  /** Stable id, unique within one sheet */
  id: string;
  icon: IconName;
  label: string;
  /** Colour scale chip drawn next to the label */
  chip?: SheetChip;
  /** Secondary line, re-read on every refresh; null hides it */
  hint?: () => string | null;
}

/** A layer toggle: the control is a switch */
export interface SheetSwitchRow extends SheetRowBase {
  kind: "switch";
  isOn: () => boolean;
  isDisabled?: () => boolean;
  onToggle: () => void;
}

/**
 * A filter: the control shows the current value and a chevron. The row
 * mirrors the `<select>` with id `sourceId`, writing back to it and
 * dispatching `change` so the existing handlers run.
 */
export interface SheetSelectRow extends SheetRowBase {
  kind: "select";
  sourceId: string;
}

/** A one-shot command: the control is a chevron */
export interface SheetActionRow extends SheetRowBase {
  kind: "action";
  onSelect: () => void;
  /** Close the sheet before running the action (default true) */
  closeOnSelect?: boolean;
}

export type SheetRow = SheetSwitchRow | SheetSelectRow | SheetActionRow;

/** Controls of one rendered row, kept so refresh() can update them */
interface RenderedRow {
  spec: SheetRow;
  element: HTMLElement;
  value: HTMLElement | null;
  select: HTMLSelectElement | null;
  hint: HTMLElement | null;
}

export class MobileSheet {
  /** Backdrop; a tap on it dismisses the sheet */
  readonly scrim: HTMLElement;
  /** The sheet itself */
  readonly root: HTMLElement;

  private readonly id: string;
  private readonly titleEl: HTMLElement;
  private readonly rowsHost: HTMLElement;
  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private rendered: RenderedRow[] = [];
  private returnFocusTo: HTMLElement | null = null;
  private closeCallback: (() => void) | null = null;
  private open = false;

  constructor(id: string = "mobile-sheet") {
    this.id = id;

    this.scrim = document.createElement("div");
    this.scrim.className = "sheet-scrim";
    this.scrim.id = id + "-scrim";
    this.scrim.hidden = true;
    this.scrim.addEventListener("click", () => this.close());

    this.root = document.createElement("div");
    this.root.className = "mobile-sheet";
    this.root.id = id;
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", id + "-title");
    this.root.tabIndex = -1;
    setInteractive(this.root, false);

    const handle = document.createElement("div");
    handle.className = "sheet-handle";
    handle.setAttribute("aria-hidden", "true");

    const titleRow = document.createElement("div");
    titleRow.className = "sheet-title";

    // The close control sits in the title row but outside the name the
    // dialog is labelled by, so the sheet is not announced as "Layers Close"
    this.titleEl = document.createElement("span");
    this.titleEl.className = "sheet-title-text";
    this.titleEl.id = id + "-title";
    this.titleEl.setAttribute("role", "heading");
    this.titleEl.setAttribute("aria-level", "2");

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "sheet-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = icon("close", 20);
    closeBtn.addEventListener("click", () => this.close());

    titleRow.append(this.titleEl, closeBtn);

    this.rowsHost = document.createElement("div");
    this.rowsHost.className = "sheet-body";

    this.root.append(handle, titleRow, this.rowsHost);

    this.onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event);
  }

  /** Add the scrim and the sheet to the document */
  mount(parent: HTMLElement): void {
    parent.append(this.scrim, this.root);
  }

  /** Remove both elements and drop the document listener */
  destroy(): void {
    this.close();
    this.scrim.remove();
    this.root.remove();
  }

  isOpen(): boolean {
    return this.open;
  }

  /**
   * Show the sheet with a title and a set of rows. Focus moves into the
   * sheet and returns to the opener when it closes.
   */
  openWith(title: string, rows: SheetRow[], onClose?: () => void): void {
    this.titleEl.textContent = title;
    this.renderRows(rows);
    this.closeCallback = onClose ?? null;

    const active = document.activeElement;
    this.returnFocusTo = active instanceof HTMLElement ? active : null;

    this.scrim.hidden = false;
    this.root.hidden = false;
    setInteractive(this.root, true);
    this.scrim.classList.add("is-open");
    this.root.classList.add("is-open");
    this.open = true;
    document.addEventListener("keydown", this.onKeyDown);
    this.root.focus();
  }

  /**
   * Hide the sheet and hand focus back to whatever opened it.
   *
   * `hidden` alone does not stop the sheet taking taps: the stylesheet gives
   * `.mobile-sheet` a `display` of its own, which beats the user agent's
   * `[hidden]` rule, and the sheet stays hit-testable for the whole
   * slide-out (`transition: visibility 0s linear var(--duration-base)`). A
   * tap landing where a row used to be would then still fire that row, so
   * the sheet is made non-interactive the moment it closes.
   */
  close(): void {
    if (!this.open) return;
    this.open = false;
    document.removeEventListener("keydown", this.onKeyDown);
    this.scrim.classList.remove("is-open");
    this.root.classList.remove("is-open");
    this.scrim.hidden = true;
    this.root.hidden = true;
    setInteractive(this.root, false);

    const callback = this.closeCallback;
    this.closeCallback = null;
    callback?.();

    const target = this.returnFocusTo;
    this.returnFocusTo = null;
    if (target && document.contains(target)) target.focus();
  }

  /** Re-read every row's state; cheap enough to call on any store change */
  refresh(): void {
    for (const row of this.rendered) {
      this.refreshRow(row);
    }
  }

  private refreshRow(row: RenderedRow): void {
    const spec = row.spec;

    if (spec.kind === "switch") {
      const on = spec.isOn();
      row.element.setAttribute("aria-checked", String(on));
      // `aria-checked` carries the semantics; the stylesheet keys the row
      // highlight off the project's `active` class
      row.element.classList.toggle("active", on);
      if (row.element instanceof HTMLButtonElement) {
        row.element.disabled = spec.isDisabled?.() ?? false;
      }
    }

    if (spec.kind === "select" && row.select) {
      this.syncSelect(spec, row.select, row.value);
    }

    if (row.hint) {
      const text = spec.hint?.() ?? null;
      row.hint.textContent = text ?? "";
      row.hint.hidden = text === null;
    }
  }

  private renderRows(rows: SheetRow[]): void {
    this.rowsHost.replaceChildren();
    this.rendered = rows.map((spec) => this.renderRow(spec));
  }

  private renderRow(spec: SheetRow): RenderedRow {
    const element = document.createElement(
      spec.kind === "select" ? "div" : "button",
    );
    element.className = "sheet-row";
    element.dataset["row"] = spec.id;
    if (element instanceof HTMLButtonElement) element.type = "button";

    // `.sheet-row .icon` sizes and colours the svg directly
    element.innerHTML = icon(spec.icon, 24);

    const textHost = document.createElement("span");
    textHost.className = "sheet-row-text";

    const label = document.createElement("span");
    label.className = "sheet-row-label";
    label.id = this.id + "-" + spec.id + "-label";
    label.textContent = spec.label;
    textHost.append(label);

    if (spec.chip) {
      const chip = document.createElement("span");
      chip.className = "gradient-chip gradient-chip-" + spec.chip;
      chip.setAttribute("aria-hidden", "true");
      textHost.append(chip);
    }

    let hint: HTMLElement | null = null;
    if (spec.hint) {
      hint = document.createElement("span");
      hint.className = "sheet-row-hint";
      textHost.append(hint);
    }

    const control = document.createElement("span");
    control.className = "sheet-row-control";

    let value: HTMLElement | null = null;
    let select: HTMLSelectElement | null = null;

    if (spec.kind === "switch") {
      element.setAttribute("role", "switch");
      control.append(createSwitch());
      element.addEventListener("click", () => {
        spec.onToggle();
        this.refresh();
      });
    } else if (spec.kind === "action") {
      control.append(createChevron("chevronRight"));
      element.addEventListener("click", () => {
        if (spec.closeOnSelect !== false) this.close();
        spec.onSelect();
      });
    } else {
      value = document.createElement("span");
      value.className = "sheet-row-value";

      select = document.createElement("select");
      select.className = "sheet-row-select";
      select.setAttribute("aria-labelledby", label.id);
      const mirrored = select;
      select.addEventListener("change", () => {
        this.applySelect(spec, mirrored);
      });

      control.append(value, createChevron("chevronDown"), select);
    }

    element.append(textHost, control);

    const row: RenderedRow = { spec, element, value, select, hint };
    this.refreshRow(row);
    this.rowsHost.append(element);
    return row;
  }

  /** Copy the mirrored dropdown's options, value and disabled state */
  private syncSelect(
    spec: SheetSelectRow,
    select: HTMLSelectElement,
    value: HTMLElement | null,
  ): void {
    const source = document.getElementById(spec.sourceId);
    if (!(source instanceof HTMLSelectElement)) {
      select.disabled = true;
      if (value) value.textContent = "";
      return;
    }

    const options = Array.from(source.options).map((option) => ({
      value: option.value,
      label:
        option.value === "all"
          ? ALL_OPTION_LABEL
          : (option.textContent ?? option.value).trim(),
    }));

    const unchanged =
      select.options.length === options.length &&
      options.every((option, index) => {
        const existing = select.options[index];
        return (
          existing?.value === option.value &&
          existing.textContent === option.label
        );
      });

    if (!unchanged) {
      select.replaceChildren();
      for (const option of options) {
        const element = document.createElement("option");
        element.value = option.value;
        element.textContent = option.label;
        select.append(element);
      }
    }

    select.value = source.value;
    select.disabled = source.disabled;
    if (value) {
      const selected = options.find((option) => option.value === source.value);
      value.textContent = selected?.label ?? source.value;
    }
  }

  /** Write the choice back to the page's own dropdown */
  private applySelect(spec: SheetSelectRow, select: HTMLSelectElement): void {
    const source = document.getElementById(spec.sourceId);
    if (!(source instanceof HTMLSelectElement)) return;
    if (source.value === select.value) return;
    source.value = select.value;
    source.dispatchEvent(new Event("change", { bubbles: true }));
    this.refresh();
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      this.root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      this.root.focus();
      return;
    }

    const active = document.activeElement;
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && (active === first || active === this.root)) {
      event.preventDefault();
      last.focus();
    }
  }
}

/**
 * Take an element in or out of reach of pointers and assistive tech.
 * `inert` is the standard tool; the inline `pointer-events` is the belt for
 * engines that have not shipped it, and neither waits for a transition.
 */
function setInteractive(element: HTMLElement, interactive: boolean): void {
  if (interactive) {
    element.removeAttribute("inert");
    element.style.pointerEvents = "";
  } else {
    element.setAttribute("inert", "");
    element.style.pointerEvents = "none";
  }
}

/** The switch drawn in a layer row; the row itself carries the ARIA state */
function createSwitch(): HTMLElement {
  const knob = document.createElement("span");
  knob.className = "sheet-switch";
  knob.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("span");
  thumb.className = "sheet-switch-thumb";
  knob.append(thumb);
  return knob;
}

function createChevron(name: IconName): HTMLElement {
  const chevron = document.createElement("span");
  chevron.className = "sheet-row-chevron";
  chevron.innerHTML = icon(name, 20);
  return chevron;
}
