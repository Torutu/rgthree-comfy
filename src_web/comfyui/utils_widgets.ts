import type {
  LGraphNode,
  LGraphCanvas as TLGraphCanvas,
  Vector2,
  IBaseWidget,
  ICustomWidget,
  IWidgetOptions,
  CanvasPointerEvent,
} from "@comfyorg/frontend";

import {app} from "scripts/app.js";
import {drawNodeWidget, drawWidgetButton, fitString, isLowQuality} from "./utils_canvas.js";

type Vector4 = [number, number, number, number];

/**
 * Draws a label on teft, and a value on the right, ellipsizing when out of space.
 */
export function drawLabelAndValue(
  ctx: CanvasRenderingContext2D,
  label: string,
  value: string,
  width: number,
  posY: number,
  height: number,
  options?: {offsetLeft: number},
) {
  const outerMargin = 15;
  const innerMargin = 10;
  const midY = posY + height / 2;
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = LiteGraph.WIDGET_SECONDARY_TEXT_COLOR;
  const labelX = outerMargin + innerMargin + (options?.offsetLeft ?? 0);
  ctx.fillText(label, labelX, midY);

  const valueXLeft = labelX + ctx.measureText(label).width + 7;
  const valueXRight = width - (outerMargin + innerMargin);

  ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
  ctx.textAlign = "right";
  ctx.fillText(fitString(ctx, value, valueXRight - valueXLeft), valueXRight, midY);
  ctx.restore();
}

/**
 * Repaints a node's widgets in whichever renderer is active.
 *
 * - Classic LiteGraph canvas: every node shares one <canvas>; marking it dirty repaints everything.
 * - Nodes 2.0 (Vue nodes): ComfyUI's `WidgetLegacy` component gives each canvas-drawn widget its own
 *   <canvas> and only repaints it on mount, resize, palette change, or when `widget.triggerDraw()` is
 *   called. ComfyUI calls `triggerDraw` on every widget of a node after one of its own Vue widgets
 *   changes a value; rgthree widgets change values themselves, so they must do the same.
 *
 * @param widgets Only repaint these (Nodes 2.0). Defaults to all of the node's widgets.
 */
export function redrawNodeWidgets(node: LGraphNode, widgets?: (IBaseWidget | null | undefined)[]) {
  for (const widget of widgets ?? node.widgets ?? []) {
    // rgthree widgets repaint every canvas they're shown on (the node, and the side panel when the
    // node is selected); ComfyUI's single `triggerDraw` hook only reaches the copy mounted last.
    if (widget instanceof Object && "redrawOwnCanvases" in widget) {
      if ((widget as unknown as RgthreeBaseWidget<any>).redrawOwnCanvases(node)) continue;
    }
    (widget as {triggerDraw?: () => void} | null | undefined)?.triggerDraw?.();
  }
  if (node.graph) {
    node.setDirtyCanvas(true, true);
  }
}

/** Nodes 2.0 widget canvases we already listen to, mapped to the widget drawn on each. */
const OWN_CANVAS_WIDGETS = new WeakMap<HTMLCanvasElement, RgthreeBaseWidget<any>>();

export type RgthreeBaseWidgetBounds = {
  /** The bounds, either [x, width] assuming the full height, or [x, y, width, height] if height. */
  bounds: Vector2 | Vector4;
  onDown?(
    event: CanvasPointerEvent,
    pos: Vector2,
    node: LGraphNode,
    bounds: RgthreeBaseWidgetBounds,
  ): boolean | void;
  onUp?(
    event: CanvasPointerEvent,
    pos: Vector2,
    node: LGraphNode,
    bounds: RgthreeBaseWidgetBounds,
  ): boolean | void;
  onMove?(
    event: CanvasPointerEvent,
    pos: Vector2,
    node: LGraphNode,
    bounds: RgthreeBaseWidgetBounds,
  ): boolean | void;
  onClick?(
    event: CanvasPointerEvent,
    pos: Vector2,
    node: LGraphNode,
    bounds: RgthreeBaseWidgetBounds,
  ): boolean | void;
  data?: any;
  wasMouseClickedAndIsOver?: boolean;
};

export type RgthreeBaseHitAreas<Keys extends string> = {
  [K in Keys]: RgthreeBaseWidgetBounds;
};

type NotArray<T> = T extends Array<any> ? never : T;

/**
 * A base widget that handles mouse events more properly.
 */
export abstract class RgthreeBaseWidget<V extends ICustomWidget["value"]> implements ICustomWidget {
  // Needed here b/c it was added to ComfyUI's types for IBaseWidget. No idea what they use it for,
  // or why it's only boolean.
  [symbol: symbol]: boolean;

  // We don't want our value to be an array as a widget will be serialized as an "input" for the API
  // which uses an array value to represent a link. To keep things simpler, we'll avoid using an
  // array at all.
  abstract value: NotArray<V>;

  type: ICustomWidget["type"] = "custom";
  name: string;
  options: IWidgetOptions = {};
  y: number = 0;
  last_y: number = 0;
  disabled: boolean = false;

  protected mouseDowned: Vector2 | null = null;
  protected isMouseDownedAndOver: boolean = false;

  // protected hitAreas: {[key: string]: RgthreeBaseWidgetBounds} = {};
  protected readonly hitAreas: RgthreeBaseHitAreas<any> = {};
  private downedHitAreasForMove: RgthreeBaseWidgetBounds[] = [];
  private downedHitAreasForClick: RgthreeBaseWidgetBounds[] = [];

  constructor(name: string) {
    this.name = name;
  }

  serializeValue(node: LGraphNode, index: number): Promise<V> | V {
    return this.value;
  }

  private clickWasWithinBounds(pos: Vector2, bounds: Vector2 | Vector4) {
    let xStart = bounds[0];
    let xEnd = xStart + (bounds.length > 2 ? bounds[2]! : bounds[1]!);
    const clickedX = pos[0] >= xStart && pos[0] <= xEnd;
    if (bounds.length === 2) {
      return clickedX;
    }
    return clickedX && pos[1] >= bounds[1] && pos[1] <= bounds[1] + bounds[3]!;
  }

  mouse(event: CanvasPointerEvent, pos: Vector2, node: LGraphNode) {
    // Only the primary button interacts. The classic canvas sends right-clicks to its context menu,
    // but Nodes 2.0 forwards every button here; without this a right-click acted like a click.
    if (event.type == "pointerdown" && (event as PointerEvent).button > 0) {
      return false;
    }
    const target = (event as unknown as Event).target;
    if (event.type == "pointerdown" && target instanceof HTMLCanvasElement) {
      this.useCanvas(target);
    }
    pos = this.toNodeSpace(event, pos);

    if (event.type == "pointerdown") {
      this.mouseDowned = [...pos] as Vector2;
      this.isMouseDownedAndOver = true;
      this.downedHitAreasForMove.length = 0;
      this.downedHitAreasForClick.length = 0;
      // Loop over out bounds data and call any specifics.
      let anyHandled = false;
      for (const part of Object.values(this.hitAreas)) {
        if (this.clickWasWithinBounds(pos, part.bounds)) {
          if (part.onMove) {
            this.downedHitAreasForMove.push(part);
          }
          if (part.onClick) {
            this.downedHitAreasForClick.push(part);
          }
          if (part.onDown) {
            const thisHandled = part.onDown.apply(this, [event, pos, node, part]);
            anyHandled = anyHandled || thisHandled == true;
          }
          part.wasMouseClickedAndIsOver = true;
        }
      }
      return this.onMouseDown(event, pos, node) ?? anyHandled;
    }

    // This only fires when LiteGraph has a node_widget (meaning it's pressed), but we may not be
    // the original widget pressed, so we still need `mouseDowned`.
    if (event.type == "pointerup") {
      if (!this.mouseDowned) return true;
      this.downedHitAreasForMove.length = 0;
      const wasMouseDownedAndOver = this.isMouseDownedAndOver;
      this.cancelMouseDown();
      let anyHandled = false;
      for (const part of Object.values(this.hitAreas)) {
        if (part.onUp && this.clickWasWithinBounds(pos, part.bounds)) {
          const thisHandled = part.onUp.apply(this, [event, pos, node, part]);
          anyHandled = anyHandled || thisHandled == true;
        }
        part.wasMouseClickedAndIsOver = false;
      }
      for (const part of this.downedHitAreasForClick) {
        if (this.clickWasWithinBounds(pos, part.bounds)) {
          const thisHandled = part.onClick!.apply(this, [event, pos, node, part]);
          anyHandled = anyHandled || thisHandled == true;
        }
      }
      this.downedHitAreasForClick.length = 0;
      if (wasMouseDownedAndOver) {
        const thisHandled = this.onMouseClick(event, pos, node);
        anyHandled = anyHandled || thisHandled == true;
      }
      return this.onMouseUp(event, pos, node) ?? anyHandled;
    }

    // This only fires when LiteGraph has a node_widget (meaning it's pressed).
    if (event.type == "pointermove") {
      this.isMouseDownedAndOver = !!this.mouseDowned;
      // If we've moved off the button while pressing, then consider us no longer pressing.
      if (
        this.mouseDowned &&
        (pos[0] < 15 ||
          pos[0] > node.size[0] - 15 ||
          pos[1] < this.last_y ||
          pos[1] > this.last_y + LiteGraph.NODE_WIDGET_HEIGHT)
      ) {
        this.isMouseDownedAndOver = false;
      }
      for (const part of Object.values(this.hitAreas)) {
        if (this.downedHitAreasForMove.includes(part)) {
          part.onMove!.apply(this, [event, pos, node, part]);
        }
        if (this.downedHitAreasForClick.includes(part)) {
          part.wasMouseClickedAndIsOver = this.clickWasWithinBounds(pos, part.bounds);
        }
      }
      return this.onMouseMove(event, pos, node) ?? true;
    }
    return false;
  }

  /**
   * Converts a pointer position to the node space this class has always used (x from the node's
   * left edge; this widget's row starts at `last_y`).
   *
   * On the classic canvas LiteGraph already passes node space, so nothing changes. In Nodes 2.0 the
   * event comes from this widget's own small <canvas>, and ComfyUI passes canvas-local positions for
   * down/move but graph-derived ones for pointerup; `offsetX/offsetY` on the event are exact for all
   * three, so use them.
   */
  protected toNodeSpace(event: CanvasPointerEvent, pos: Vector2): Vector2 {
    const target = (event as unknown as Event).target;
    if (target instanceof HTMLCanvasElement && target !== app.canvas?.canvas) {
      return [event.offsetX, (this.last_y || 0) + event.offsetY];
    }
    return pos;
  }

  /**
   * Nodes 2.0 only: the cursor to show at a widget-local position. ComfyUI gives every canvas-drawn
   * widget `class="cursor-crosshair"`, which suggests "connect" rather than "click". Return "" to
   * keep ComfyUI's cursor.
   */
  getCursorAt(x: number, y: number): string {
    return "";
  }

  /** Nodes 2.0 only: the pointer moved over this widget's canvas with no button pressed. */
  protected onOwnCanvasHover(canvas: HTMLCanvasElement, x: number | null, y: number | null) {
    canvas.style.cursor = x == null || y == null ? "" : this.getCursorAt(x, y);
  }

  /** Nodes 2.0 only: the user right-clicked this widget's canvas (ComfyUI then opens its menu). */
  protected onOwnCanvasContextMenu(event: MouseEvent) {}

  /** Nodes 2.0 only: the zoom the widget's canvas was last drawn at (see `fitOwnCanvas`). */
  protected ownCanvasScale = 1;

  /**
   * Nodes 2.0 only: every canvas this widget is shown on, with the height and node it was drawn
   * with. Selecting a node shows a second copy of its widgets in the side panel; ComfyUI's
   * `triggerDraw` hook is one property per widget, so it ends up repainting only that copy.
   */
  private ownCanvases = new Map<HTMLCanvasElement, {height: number; node: LGraphNode}>();
  /** The canvas drawn last. Hit areas are laid out for its width. */
  private lastDrawnCanvas: HTMLCanvasElement | null = null;
  /** The canvas the pointer is on; drawn last so its layout is the one hit areas use. */
  private activeCanvas: HTMLCanvasElement | null = null;

  /** Draws this widget onto one of its Nodes 2.0 canvases (draw() re-fits the canvas itself). */
  protected drawOnOwnCanvas(canvas: HTMLCanvasElement) {
    const entry = this.ownCanvases.get(canvas);
    const ctx = canvas.getContext("2d");
    if (!entry || !ctx) return;
    const width = canvas.getBoundingClientRect().width || canvas.clientWidth;
    (this as unknown as {draw?: Function}).draw?.(ctx, entry.node, width, 1, entry.height);
  }

  /**
   * Repaints every canvas this widget is shown on, the one under the pointer last. Returns false
   * when there are none yet (classic canvas, or not mounted), so callers can fall back.
   */
  redrawOwnCanvases(node: LGraphNode): boolean {
    let any = false;
    for (const canvas of [...this.ownCanvases.keys()]) {
      if (!canvas.isConnected) {
        this.ownCanvases.delete(canvas);
        if (this.activeCanvas === canvas) this.activeCanvas = null;
      }
    }
    for (const canvas of this.ownCanvases.keys()) {
      if (canvas === this.activeCanvas) continue;
      this.drawOnOwnCanvas(canvas);
      any = true;
    }
    if (this.activeCanvas) {
      this.drawOnOwnCanvas(this.activeCanvas);
      any = true;
    }
    return any;
  }

  /** Before handling the pointer on a canvas, make sure hit areas are laid out for that canvas. */
  private useCanvas(canvas: HTMLCanvasElement) {
    this.activeCanvas = canvas;
    if (this.lastDrawnCanvas !== canvas && this.ownCanvases.has(canvas)) {
      this.drawOnOwnCanvas(canvas);
    }
  }

  /**
   * Call first thing in `draw()`; draw with the width it returns.
   *
   * Nodes 2.0 sizes each widget canvas from `getBoundingClientRect()`, i.e. in *screen* pixels, so
   * at any zoom other than 100% the drawing (screen pixels), the canvas' height (derived from its
   * bitmap's aspect ratio) and pointer positions (`offsetX`, unzoomed pixels) all disagree: rows grew
   * or shrank against the node and clicks missed what was drawn. This resizes the canvas so one
   * drawing unit is one unzoomed pixel at any zoom, keeping the bitmap sharp for the current zoom.
   * On the classic canvas it changes nothing and returns `w`.
   */
  protected fitOwnCanvas(
    ctx: CanvasRenderingContext2D,
    w: number,
    height: number,
    node: LGraphNode,
  ): number {
    this.trackOwnCanvas(ctx);
    const canvas = ctx.canvas;
    if (!(canvas instanceof HTMLCanvasElement) || canvas === app.canvas?.canvas) return w;
    this.ownCanvases.set(canvas, {height, node});
    this.lastDrawnCanvas = canvas;
    const layoutWidth = canvas.clientWidth;
    if (!layoutWidth || !w) return w;
    const scale = w / layoutWidth; // `w` is the on-screen width ComfyUI measured.
    const density = 2 * scale; // ComfyUI draws these canvases at 2x.
    const cssHeight = height + 2; // The height ComfyUI's own sizing gives at 100%.
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.max(1, Math.round(layoutWidth * density));
    canvas.height = Math.max(1, Math.round(cssHeight * density));
    ctx.setTransform(density, 0, 0, density, 0, 0);
    ctx.font = (app.canvas as TLGraphCanvas | undefined)?.inner_text_font || ctx.font;
    this.ownCanvasScale = scale;
    return layoutWidth;
  }

  /**
   * Call from `draw()` (`fitOwnCanvas` does). When the widget is drawn on its own Nodes 2.0 canvas,
   * listens to that canvas once (cursor + hover + right-click). Does nothing on the classic canvas.
   */
  protected trackOwnCanvas(ctx: CanvasRenderingContext2D) {
    const canvas = ctx.canvas;
    if (!(canvas instanceof HTMLCanvasElement) || canvas === app.canvas?.canvas) return;
    const known = OWN_CANVAS_WIDGETS.has(canvas);
    OWN_CANVAS_WIDGETS.set(canvas, this);
    if (known) return;
    canvas.addEventListener("pointermove", (e: PointerEvent) => {
      if (e.buttons) return; // Dragging: keep the cursor the press started with.
      const widget = OWN_CANVAS_WIDGETS.get(canvas);
      if (!widget) return;
      // Zooming doesn't repaint (the canvas' layout size doesn't change), so the bitmap gets
      // stretched. Repaint once at the new zoom when the pointer comes by, to keep it sharp.
      const scale = canvas.getBoundingClientRect().width / (canvas.clientWidth || 1);
      if (Math.abs(scale / widget.ownCanvasScale - 1) > 0.15) {
        widget.lastDrawnCanvas = null; // Forces useCanvas() to repaint this canvas.
      }
      widget.useCanvas(canvas);
      widget.onOwnCanvasHover(canvas, e.offsetX, e.offsetY);
    });
    canvas.addEventListener("pointerleave", () => {
      OWN_CANVAS_WIDGETS.get(canvas)?.onOwnCanvasHover(canvas, null, null);
    });
    canvas.addEventListener("contextmenu", (e: MouseEvent) => {
      OWN_CANVAS_WIDGETS.get(canvas)?.onOwnCanvasContextMenu(e);
    });
  }

  /** Sometimes we want to cancel a mouse down, so that an up/move aren't fired. */
  cancelMouseDown() {
    this.mouseDowned = null;
    this.isMouseDownedAndOver = false;
    this.downedHitAreasForMove.length = 0;
  }

  /** An event that fires when the pointer is pressed down (once). */
  onMouseDown(event: CanvasPointerEvent, pos: Vector2, node: LGraphNode): boolean | void {
    return;
  }

  /**
   * An event that fires when the pointer is let go. Only fires if this was the widget that was
   * originally pressed down.
   */
  onMouseUp(event: CanvasPointerEvent, pos: Vector2, node: LGraphNode): boolean | void {
    return;
  }

  /**
   * An event that fires when the pointer is let go _over the widget_ and when the widget that was
   * originally pressed down.
   */
  onMouseClick(event: CanvasPointerEvent, pos: Vector2, node: LGraphNode): boolean | void {
    return;
  }

  /**
   * An event that fires when the pointer is moving after pressing down. Will fire both on and off
   * of the widget. Check `isMouseDownedAndOver` to determine if the mouse is currently over the
   * widget or not.
   */
  onMouseMove(event: CanvasPointerEvent, pos: Vector2, node: LGraphNode): boolean | void {
    return;
  }
}

/**
 * A better implementation of the LiteGraph button widget.
 */
export class RgthreeBetterButtonWidget extends RgthreeBaseWidget<string> {
  override readonly type = "custom";

  value: string = "";
  label: string = "";
  mouseClickCallback: (event: CanvasPointerEvent, pos: Vector2, node: LGraphNode) => boolean | void;

  constructor(
    name: string,
    mouseClickCallback: (
      event: CanvasPointerEvent,
      pos: Vector2,
      node: LGraphNode,
    ) => boolean | void,
    label?: string,
  ) {
    super(name);
    this.mouseClickCallback = mouseClickCallback;
    this.label = label || name;
  }

  draw(ctx: CanvasRenderingContext2D, node: LGraphNode, width: number, y: number, height: number) {
    width = this.fitOwnCanvas(ctx, width, height, node);
    drawWidgetButton(
      ctx,
      {size: [width - 30, height], pos: [15, y]},
      this.label,
      this.isMouseDownedAndOver,
    );
  }

  override getCursorAt(x: number, y: number) {
    return "pointer";
  }

  override onMouseClick(event: CanvasPointerEvent, pos: Vector2, node: LGraphNode) {
    return this.mouseClickCallback(event, pos, node);
  }
}

/**
 * A better implementation of the LiteGraph text widget, including auto ellipsis.
 */
export class RgthreeBetterTextWidget extends RgthreeBaseWidget<string> {
  value: string;

  constructor(name: string, value: string) {
    super(name);
    this.name = name;
    this.value = value;
  }

  draw(ctx: CanvasRenderingContext2D, node: LGraphNode, width: number, y: number, height: number) {
    const widgetData = drawNodeWidget(ctx, {size: [width, height], pos: [15, y]});

    if (!widgetData.lowQuality) {
      drawLabelAndValue(ctx, this.name, this.value, width, y, height);
    }
  }

  override mouse(event: CanvasPointerEvent, pos: Vector2, node: LGraphNode): boolean {
    const canvas = app.canvas as TLGraphCanvas;
    if (event.type == "pointerdown") {
      canvas.prompt("Label", this.value, (v: string) => (this.value = v), event);
      return true;
    }
    return false;
  }
}

/**
 * Options for the Divider Widget.
 */
type RgthreeDividerWidgetOptions = {
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  color: string;
  thickness: number;
};

/**
 * A divider widget; can also be used as a spacer if fed a 0 thickness.
 */
export class RgthreeDividerWidget extends RgthreeBaseWidget<{}> {
  override value = {};
  override options = {serialize: false};
  override readonly type = "custom";

  private readonly widgetOptions: RgthreeDividerWidgetOptions = {
    marginTop: 7,
    marginBottom: 7,
    marginLeft: 15,
    marginRight: 15,
    color: LiteGraph.WIDGET_OUTLINE_COLOR,
    thickness: 1,
  };

  constructor(widgetOptions?: Partial<RgthreeDividerWidgetOptions>) {
    super("divider");
    Object.assign(this.widgetOptions, widgetOptions || {});
  }

  draw(ctx: CanvasRenderingContext2D, node: LGraphNode, width: number, posY: number, h: number) {
    width = this.fitOwnCanvas(ctx, width, h, node);
    if (this.widgetOptions.thickness) {
      ctx.strokeStyle = this.widgetOptions.color;
      const x = this.widgetOptions.marginLeft;
      const y = posY + this.widgetOptions.marginTop;
      const w = width - this.widgetOptions.marginLeft - this.widgetOptions.marginRight;
      ctx.stroke(new Path2D(`M ${x} ${y} h ${w}`));
    }
  }

  computeSize(width: number): [number, number] {
    return [
      width,
      this.widgetOptions.marginTop + this.widgetOptions.marginBottom + this.widgetOptions.thickness,
    ];
  }
}

/**
 * Options for the Label Widget.
 */
export type RgthreeLabelWidgetOptions = {
  align?: "left" | "center" | "right";
  color?: string;
  italic?: boolean;
  size?: number;
  text?: string | (() => string); // Text, or fall back to the name.

  /** A label to put on the right side. */
  actionLabel?: "__PLUS_ICON__" | string;
  actionCallback?: (event: PointerEvent | CanvasPointerEvent) => void;
};

/**
 * A simple label widget, drawn with no background.
 */
export class RgthreeLabelWidget extends RgthreeBaseWidget<string> {
  override readonly type = "custom";
  override options = {serialize: false};
  value = "";

  private readonly widgetOptions: RgthreeLabelWidgetOptions = {};
  private posY: number = 0;

  constructor(name: string, widgetOptions?: RgthreeLabelWidgetOptions) {
    super(name);
    Object.assign(this.widgetOptions, widgetOptions);
  }

  update(widgetOptions: RgthreeLabelWidgetOptions) {
    Object.assign(this.widgetOptions, widgetOptions);
  }

  draw(
    ctx: CanvasRenderingContext2D,
    node: LGraphNode,
    width: number,
    posY: number,
    height: number,
  ) {
    this.posY = posY;
    ctx.save();

    let text = this.widgetOptions.text ?? this.name;
    if (typeof text === "function") {
      text = text();
    }

    ctx.textAlign = this.widgetOptions.align || "left";
    ctx.fillStyle = this.widgetOptions.color || LiteGraph.WIDGET_TEXT_COLOR;
    const oldFont = ctx.font;
    if (this.widgetOptions.italic) {
      ctx.font = "italic " + ctx.font;
    }
    if (this.widgetOptions.size) {
      ctx.font = ctx.font.replace(/\d+px/, `${this.widgetOptions.size}px`);
    }

    const midY = posY + height / 2;
    ctx.textBaseline = "middle";

    if (this.widgetOptions.align === "center") {
      ctx.fillText(text, node.size[0] / 2, midY);
    } else {
      ctx.fillText(text, 15, midY);
    } // TODO(right);

    ctx.font = oldFont;

    if (this.widgetOptions.actionLabel === "__PLUS_ICON__") {
      const plus = new Path2D(
        `M${node.size[0] - 15 - 2} ${posY + 7} v4 h-4 v4 h-4 v-4 h-4 v-4 h4 v-4 h4 v4 h4 z`,
      );
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.fillStyle = "#3a3";
      ctx.strokeStyle = "#383";
      ctx.fill(plus);
      ctx.stroke(plus);
    }
    ctx.restore();
  }

  override mouse(event: CanvasPointerEvent, nodePos: Vector2, node: LGraphNode): boolean {
    if (
      event.type !== "pointerdown" ||
      isLowQuality() ||
      !this.widgetOptions.actionLabel ||
      !this.widgetOptions.actionCallback
    ) {
      return false;
    }

    const pos: Vector2 = [nodePos[0], nodePos[1] - this.posY];
    const rightX = node.size[0] - 15;
    if (pos[0] > rightX || pos[0] < rightX - 16) {
      return false;
    }
    this.widgetOptions.actionCallback(event);
    return true;
  }
}

/** An invisible widget. */
export class RgthreeInvisibleWidget<T extends ICustomWidget["value"]> extends RgthreeBaseWidget<T> {
  override readonly type = "custom";

  value: NotArray<T>;
  private serializeValueFn?: (node: LGraphNode, index: number) => Promise<T> | T;

  constructor(
    name: string,
    type: string,
    value: NotArray<T>,
    serializeValueFn?: (node: LGraphNode, index: number) => Promise<T> | T,
  ) {
    super(name);
    // this.type = type;
    this.value = value;
    this.serializeValueFn = serializeValueFn;
  }

  draw() {
    return;
  }
  computeSize(width: number): Vector2 {
    return [0, 0];
  }

  override serializeValue(node: LGraphNode, index: number): T | Promise<T> {
    return this.serializeValueFn != null
      ? this.serializeValueFn(node, index)
      : super.serializeValue(node, index);
  }
}
