/**
 * Pure logic for the Power Lora Loader UI: row layout, hit testing, strength maths, and the value
 * stored in each `lora_N` widget.
 *
 * This file has no imports on purpose. power_lora_loader.ts draws and handles events; this file only
 * computes. That split lets Node run the unit tests directly on the TypeScript source:
 *
 *   node --test tests/node/power_lora_loader_logic.test.ts
 *
 * Coordinates are "widget space": x = 0 is the node's left edge and `width` is the width the widget
 * is drawn at (the `w` argument LiteGraph and Nodes 2.0 pass to `draw()`).
 */

/** A horizontal [x, width] span. Row parts always use the full row height. */
export type Span = [number, number];

/** What each `lora_N` widget stores. Serialized as-is into the workflow and the API prompt. */
export type LoraRowValue = {
  on: boolean;
  lora: string | null;
  /** The only strength, or the MODEL strength when model & clip are shown separately. */
  strength: number;
  /** The CLIP strength. Only meaningful (and only sent) when shown separately. */
  strengthTwo: number | null;
};

export const DEFAULT_LORA_ROW_VALUE: Readonly<LoraRowValue> = {
  on: true,
  lora: null,
  strength: 1,
  strengthTwo: null,
};

/** Space between the node edge and the row's rounded background. */
export const ROW_MARGIN = 10;
/** Space between parts inside a row. */
export const ROW_GAP = 4;
/** Hit width of each strength arrow. The drawn triangle is smaller and centered. */
export const STRENGTH_ARROW_WIDTH = 14;
export const STRENGTH_VALUE_WIDTH = 34;
/** One strength control: [<][value][>]. */
export const STRENGTH_WIDTH = STRENGTH_ARROW_WIDTH * 2 + STRENGTH_VALUE_WIDTH;
export const REMOVE_WIDTH = 18;
/** Arrow click step. Unchanged from the original widget. */
export const STRENGTH_STEP = 0.05;
/** Strength change per pixel of horizontal drag on the value. */
export const STRENGTH_PER_PIXEL = 0.01;
/** Pointer travel before a press on the value counts as a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 3;

export type StrengthLayout = {dec: Span; value: Span; inc: Span; all: Span};

export type RowLayout = {
  toggle: Span;
  label: Span;
  info: Span | null;
  /** The single strength, or the MODEL strength in separate mode. */
  strength: StrengthLayout;
  /** The CLIP strength (rightmost group), only in separate mode. */
  strengthTwo: StrengthLayout | null;
  remove: Span;
};

/** The names of a row's clickable parts. They match the widget's `hitAreas` keys. */
export type RowPart =
  | "toggle"
  | "lora"
  | "info"
  | "strengthDec"
  | "strengthVal"
  | "strengthInc"
  | "strengthTwoDec"
  | "strengthTwoVal"
  | "strengthTwoInc"
  | "remove";

function strengthAt(x: number): StrengthLayout {
  return {
    dec: [x, STRENGTH_ARROW_WIDTH],
    value: [x + STRENGTH_ARROW_WIDTH, STRENGTH_VALUE_WIDTH],
    inc: [x + STRENGTH_ARROW_WIDTH + STRENGTH_VALUE_WIDTH, STRENGTH_ARROW_WIDTH],
    all: [x, STRENGTH_WIDTH],
  };
}

/**
 * Lays out one LoRA row from right to left, so the label gets whatever width is left:
 *
 *   [toggle] [label .............] [i] [< 1.00 >] ([< 1.00 >]) [x]
 */
export function computeRowLayout(
  width: number,
  height: number,
  options: {showInfo: boolean; showModelAndClip: boolean},
): RowLayout {
  const toggle: Span = [ROW_MARGIN, height * 1.5];
  const remove: Span = [width - ROW_MARGIN - REMOVE_WIDTH - 2, REMOVE_WIDTH];
  let right = remove[0] - ROW_GAP;

  let strengthTwo: StrengthLayout | null = null;
  if (options.showModelAndClip) {
    strengthTwo = strengthAt(right - STRENGTH_WIDTH);
    right -= STRENGTH_WIDTH + ROW_GAP;
  }
  const strength = strengthAt(right - STRENGTH_WIDTH);
  right -= STRENGTH_WIDTH + ROW_GAP;

  let info: Span | null = null;
  if (options.showInfo) {
    const infoWidth = Math.round(height * 0.66) + 4;
    info = [right - infoWidth, infoWidth];
    right -= infoWidth + ROW_GAP;
  }

  const labelX = toggle[0] + toggle[1] + ROW_GAP;
  return {
    toggle,
    label: [labelX, Math.max(0, right - labelX)],
    info,
    strength,
    strengthTwo,
    remove,
  };
}

function inSpan(x: number, span: Span | null): boolean {
  return span != null && x >= span[0] && x <= span[0] + span[1];
}

/** Which part of a row is at `x`, or null for the gaps between parts. */
export function hitTestRow(layout: RowLayout, x: number): RowPart | null {
  if (inSpan(x, layout.remove)) return "remove";
  if (layout.strengthTwo) {
    if (inSpan(x, layout.strengthTwo.dec)) return "strengthTwoDec";
    if (inSpan(x, layout.strengthTwo.value)) return "strengthTwoVal";
    if (inSpan(x, layout.strengthTwo.inc)) return "strengthTwoInc";
  }
  if (inSpan(x, layout.strength.dec)) return "strengthDec";
  if (inSpan(x, layout.strength.value)) return "strengthVal";
  if (inSpan(x, layout.strength.inc)) return "strengthInc";
  if (inSpan(x, layout.info)) return "info";
  if (inSpan(x, layout.toggle)) return "toggle";
  if (inSpan(x, layout.label)) return "lora";
  return null;
}

/** The CSS cursor that tells the user what a part does. */
export function cursorForPart(part: RowPart | null): string {
  if (part === "strengthVal" || part === "strengthTwoVal") return "ew-resize";
  return part ? "pointer" : "default";
}

/** Two decimals, so 0.1 + 0.05 is stored as 0.15 and not 0.15000000000000002. */
export function roundStrength(value: number): number {
  return Math.round(value * 100) / 100;
}

/** One arrow click. A missing value counts as 1, like the original widget. */
export function stepStrength(value: number | null | undefined, direction: 1 | -1): number {
  return roundStrength((value ?? 1) + STRENGTH_STEP * direction);
}

/**
 * The strength while dragging, from where the drag started. Measuring from the start (rather than
 * adding each event's delta) means no drift and the same result in both renderers.
 */
export function dragStrength(startValue: number, deltaX: number): number {
  if (Math.abs(deltaX) < DRAG_THRESHOLD_PX) return startValue;
  const travel = deltaX - Math.sign(deltaX) * DRAG_THRESHOLD_PX;
  return roundStrength(startValue + travel * STRENGTH_PER_PIXEL);
}

/** Parses the value typed into the strength prompt. Returns null for anything that isn't a number. */
export function parseStrengthInput(text: unknown): number | null {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

/**
 * Keeps an incoming widget value usable. Objects are kept as the same object (ComfyUI's widget
 * store holds that reference too); anything else becomes a fresh default row.
 */
export function normalizeLoraRowValue(value: unknown, showModelAndClip: boolean): LoraRowValue {
  if (value != null && typeof value === "object") {
    return value as LoraRowValue;
  }
  const fresh: LoraRowValue = {...DEFAULT_LORA_ROW_VALUE};
  if (showModelAndClip) fresh.strengthTwo = fresh.strength;
  return fresh;
}

/**
 * The value sent to the backend. In single-strength mode `strengthTwo` is left out, so Python uses
 * `strength` for the clip too; in separate mode it is always a number.
 */
export function serializeLoraRowValue(
  value: LoraRowValue,
  showModelAndClip: boolean,
): Omit<LoraRowValue, "strengthTwo"> & {strengthTwo?: number} {
  const {strengthTwo, ...rest} = value;
  return showModelAndClip ? {...rest, strengthTwo: strengthTwo ?? 1} : rest;
}

/** true when every row is on, false when every row is off, null when mixed. No rows counts as on. */
export function allRowsOnState(onValues: unknown[]): boolean | null {
  let allOn = true;
  let allOff = true;
  for (const on of onValues) {
    allOn = allOn && on === true;
    allOff = allOff && on === false;
    if (!allOn && !allOff) return null;
  }
  return allOn;
}

/** Longest common prefix, used to shorten names in the chooser when the Match filter is set. */
export function commonPrefix(values: string[]): string {
  if (!values.length) return "";
  let prefix = values[0]!;
  for (const value of values) {
    let i = 0;
    while (i < prefix.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * The prefix the chooser strips from every name when the Match filter is set. Same as
 * `commonPrefix`, except it never swallows a whole name: with one match (or when one name is the
 * prefix of the others) it backs off to the last folder separator, so no menu entry is empty.
 */
export function chooserPrefix(values: string[]): string {
  const prefix = commonPrefix(values);
  if (!values.includes(prefix)) return prefix;
  const cut = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
  return cut >= 0 ? prefix.slice(0, cut + 1) : "";
}

/** A named LoRA that the server's LoRA list doesn't contain. Unknown until the list has loaded. */
export function isLoraMissing(
  lora: string | null | undefined,
  available: Set<string> | null,
): boolean {
  if (!lora || lora === "None" || !available) return false;
  return !available.has(lora);
}
