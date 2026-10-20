import type {
  ComfyNodeDef,
  LGraphNode as TLGraphNode,
  LGraphCanvas,
  Vector2,
  IContextMenuValue,
  IFoundSlot,
  CanvasMouseEvent,
  ISerialisedNode,
  ICustomWidget,
  CanvasPointerEvent,
} from "@comfyorg/frontend";
import type {ComfyApiFormat} from "typings/comfy.js";
import type {RgthreeModelInfo} from "typings/rgthree.js";

import {app} from "scripts/app.js";
import {RgthreeBaseServerNode} from "./base_node.js";
import {rgthree} from "./rgthree.js";
import {addConnectionLayoutSupport} from "./utils.js";
import {NodeTypesString} from "./constants.js";
import {drawInfoIcon, drawRoundedRectangle, fitString, isLowQuality} from "./utils_canvas.js";
import {
  RgthreeBaseHitAreas,
  RgthreeBaseWidget,
  RgthreeBetterButtonWidget,
  RgthreeDividerWidget,
  redrawNodeWidgets,
} from "./utils_widgets.js";
import {rgthreeApi} from "rgthree/common/rgthree_api.js";
import {SERVICE as CONFIG_SERVICE} from "./services/config_service.js";
import {showLoraChooser} from "./utils_menu.js";
import {moveArrayItem} from "rgthree/common/shared_utils.js";
import {RgthreeLoraInfoDialog} from "./dialog_info.js";
import {LORA_INFO_SERVICE} from "rgthree/common/model_info_service.js";
import {
  allRowsOnState,
  chooserPrefix,
  computeRowLayout,
  cursorForPart,
  dragStrength,
  hitTestRow,
  isLoraMissing,
  normalizeLoraRowValue,
  parseStrengthInput,
  serializeLoraRowValue,
  stepStrength,
  type LoraRowValue,
  type RowLayout,
  type RowPart,
  type Span,
  type StrengthLayout,
} from "./power_lora_loader_logic.js";
// import { RgthreePowerLoraChooserDialog } from "./dialog_power_lora_chooser.js";

const PROP_LABEL_SHOW_STRENGTHS = "Show Strengths";
const PROP_LABEL_SHOW_STRENGTHS_STATIC = `@${PROP_LABEL_SHOW_STRENGTHS}`;
const PROP_LABEL_LORA_MATCH = "Match";
const PROP_LABEL_LORA_MATCH_STATIC = `@${PROP_LABEL_LORA_MATCH}`;
const PROP_VALUE_SHOW_STRENGTHS_SINGLE = "Single Strength";
const PROP_VALUE_SHOW_STRENGTHS_SEPARATE = "Separate Model & Clip";

/** How long a first click on a row's remove button stays armed, waiting for the confirming click. */
const REMOVE_CONFIRM_MS = 3000;
/** How long after a right-click on a row (Nodes 2.0) the node menu offers that row's actions. */
const ROW_CONTEXT_MENU_MS = 1500;

const COLOR_ACCENT = "#89B"; // rgthree's existing toggle-on colour.
const COLOR_DANGER = "#d9534f";
const COLOR_WARNING = "#e8a33d";
const COLOR_HOVER = "rgba(255,255,255,0.08)";

/** True when the node's "Show Strengths" property asks for separate model & clip strengths. */
function isSeparateStrengths(node: TLGraphNode): boolean {
  return node.properties?.[PROP_LABEL_SHOW_STRENGTHS] === PROP_VALUE_SHOW_STRENGTHS_SEPARATE;
}

/**
 * `serializeValue(node)` is not always given the node: ComfyUI 1.55's graphToPrompt passes an
 * ExecutableNodeDTO, a wrapper with `.node`, `.widgets` and `.mode` but no `.properties`.
 */
function unwrapNode(nodeOrDto: TLGraphNode): TLGraphNode {
  return (nodeOrDto as {node?: TLGraphNode})?.node ?? nodeOrDto;
}

/**
 * The Power Lora Loader is a super-simply Lora Loader node that can load multiple Loras at once
 * in an ultra-condensed node allowing fast toggling, and advanced strength setting.
 */
class RgthreePowerLoraLoader extends RgthreeBaseServerNode {
  static override title = NodeTypesString.POWER_LORA_LOADER;
  static override type = NodeTypesString.POWER_LORA_LOADER;
  static comfyClass = NodeTypesString.POWER_LORA_LOADER;

  override serialize_widgets = true;

  private logger = rgthree.newLogSession(`[Power Lora Stack]`);

  static [PROP_LABEL_SHOW_STRENGTHS_STATIC] = {
    type: "combo",
    values: [PROP_VALUE_SHOW_STRENGTHS_SINGLE, PROP_VALUE_SHOW_STRENGTHS_SEPARATE],
  };

  static [PROP_LABEL_LORA_MATCH_STATIC] = {
    type: "string",
  };

  /** Counts the number of lora widgets. This is used to give unique names.  */
  private loraWidgetsCounter = 0;

  /**
   * Our non-row widgets. They are created once and reused by every `configure()`: Nodes 2.0 keys a
   * widget's canvas by node id + widget name and keeps it bound to the object it first mounted, so
   * a new header with the same name would never be repainted (it kept showing "No LoRAs yet").
   */
  private topDivider: RgthreeDividerWidget | null = null;
  /** The header row (toggle all + column labels); repainted whenever a row's state changes. */
  private headerWidget: PowerLoraLoaderHeaderWidget | null = null;
  /** Keep track of the spacer, new lora widgets will go before it when it exists. */
  private widgetButtonSpacer: ICustomWidget | null = null;
  private addLoraButton: RgthreeBetterButtonWidget | null = null;

  /** LoRA files the server knows about, used to flag missing ones. Null until the list loads. */
  availableLoras: Set<string> | null = null;

  /** Nodes 2.0: the row last right-clicked, so the node's menu can offer that row's actions. */
  private contextMenuRow: {widget: PowerLoraLoaderWidget; time: number} | null = null;

  constructor(title = NODE_CLASS.title) {
    super(title);

    this.properties[PROP_LABEL_SHOW_STRENGTHS] = PROP_VALUE_SHOW_STRENGTHS_SINGLE;
    this.properties[PROP_LABEL_LORA_MATCH] = "";

    // Prefetch loras list (also used to flag rows whose LoRA file is missing).
    this.loadAvailableLoras();

    // [🤮] If ComfyUI is loading from API JSON it doesn't pass us the actual information at all
    // (like, in a `configure` call) and tries to set the widget data on its own. Unfortunately,
    // since Power Lora Loader has dynamic widgets, this fails on ComfyUI's side. We can do so after
    // the fact but, unfortuntely, we need to do it after a timeout since we don't have any
    // information at this point to be able to tell what data we need (like, even the node id, let
    // alone the actual data).
    if (rgthree.loadingApiJson) {
      const fullApiJson = rgthree.loadingApiJson;
      setTimeout(() => {
        this.configureFromApiJson(fullApiJson);
      }, 16);
    }
  }

  private configureFromApiJson(fullApiJson: ComfyApiFormat) {
    if (this.id == null) {
      const [n, v] = this.logger.errorParts("Cannot load from API JSON without node id.");
      console[n]?.(...v);
      return;
    }
    const nodeData =
      fullApiJson[this.id] || fullApiJson[String(this.id)] || fullApiJson[Number(this.id)];
    if (nodeData == null) {
      const [n, v] = this.logger.errorParts(`No node found in API JSON for node id ${this.id}.`);
      console[n]?.(...v);
      return;
    }
    this.configure({
      widgets_values: Object.values(nodeData.inputs).filter(
        (input) => typeof (input as any)?.["lora"] === "string",
      ),
    });
  }

  /**
   * Handles configuration from a saved workflow by first removing our default widgets that were
   * added in `onNodeCreated`, letting `super.configure` and do nothing, then create our lora
   * widgets and, finally, add back in our default widgets.
   */
  override configure(
    info: ISerialisedNode | {widgets_values: ISerialisedNode["widgets_values"]},
  ): void {
    // Detach every widget: LiteGraph's configure assigns widgets_values by position, which would write
    // row values into the header and button. The non-row widgets are put back below.
    while (this.widgets?.length) this.removeWidget(0);
    // Since we may be calling into configure manually for just widgets_values setting (like, from
    // API JSON) we want to only call the parent class's configure with a real ISerialisedNode data.
    if ((info as ISerialisedNode).id != null) {
      super.configure(info as ISerialisedNode);
    }

    (this as any)._tempWidth = this.size[0];
    (this as any)._tempHeight = this.size[1];
    for (const widgetValue of info.widgets_values || []) {
      if ((widgetValue as LoraRowValue)?.lora !== undefined) {
        const widget = this.addNewLoraWidget();
        widget.value = {...(widgetValue as LoraRowValue)};
      }
    }
    this.addNonLoraWidgets();
    this.size[0] = (this as any)._tempWidth;
    this.size[1] = Math.max((this as any)._tempHeight, this.computeSize()[1]);
    // On a node that already exists (undo, API-format JSON) the reused widgets keep their canvases,
    // which only repaint when asked.
    this.redrawLoraWidgets();
  }

  /**
   * Adds the non-lora widgets. If we'll be configured then we remove them and add them back, so
   * this is really only for newly created nodes in the current session.
   */
  override onNodeCreated() {
    super.onNodeCreated?.();
    this.addNonLoraWidgets();
    const computed = this.computeSize();
    this.size = this.size || [0, 0];
    this.size[0] = Math.max(this.size[0], computed[0]);
    this.size[1] = Math.max(this.size[1], computed[1]);
    this.setDirtyCanvas(true, true);
  }

  /** Adds a new lora widget in the proper slot. */
  private addNewLoraWidget(lora?: string) {
    this.loraWidgetsCounter++;
    const widget = this.addCustomWidget(
      new PowerLoraLoaderWidget("lora_" + this.loraWidgetsCounter),
    ) as PowerLoraLoaderWidget;
    if (lora) widget.setLora(lora);
    // Above the spacer, when it's in the list (during configure() it isn't yet).
    const spacerIndex = this.widgetButtonSpacer
      ? this.widgets.indexOf(this.widgetButtonSpacer)
      : -1;
    if (spacerIndex >= 0) {
      moveArrayItem(this.widgets, widget, spacerIndex);
    }
    // The header's count and toggle-all state include this row.
    this.redrawLoraWidgets([this.headerWidget]);
    return widget;
  }

  /**
   * Adds the non-lora widgets around any lora ones that may be there from configuration. The same
   * objects are reused on every call (see `topDivider`).
   */
  private addNonLoraWidgets() {
    this.topDivider ??= new RgthreeDividerWidget({marginTop: 4, marginBottom: 0, thickness: 0});
    moveArrayItem(this.widgets, this.addCustomWidget(this.topDivider), 0);
    this.headerWidget ??= new PowerLoraLoaderHeaderWidget();
    moveArrayItem(this.widgets, this.addCustomWidget(this.headerWidget), 1);

    this.widgetButtonSpacer ??= new RgthreeDividerWidget({
      marginTop: 4,
      marginBottom: 0,
      thickness: 0,
    });
    this.addCustomWidget(this.widgetButtonSpacer);

    this.addLoraButton ??= new RgthreeBetterButtonWidget(
      // The widget name is also its key in the API prompt, so it stays as it always was.
      "➕ Add Lora",
      (event: CanvasMouseEvent, pos: Vector2, node: TLGraphNode) => {
        this.showLoraChooser(event, (value: string) => {
          if (value.includes("Power Lora Chooser")) {
            // new RgthreePowerLoraChooserDialog().show();
          } else if (value !== "NONE") {
            this.addNewLoraWidget(value);
            this.fitHeightToRows();
          }
          // }, null, ["⚡️ Power Lora Chooser", ...loras]);
        });
        return true;
      },
      "+ Add LoRA",
    );
    this.addCustomWidget(this.addLoraButton);
  }

  async showLoraChooser(event: CanvasMouseEvent, onChoose: (value: string) => void) {
    const lorasDetails = await rgthreeApi.getLoras();
    let loras = lorasDetails.map((l) => l.file);
    let prefix = "";
    if (this.properties[PROP_LABEL_LORA_MATCH]) {
      const rgx = new RegExp(this.properties[PROP_LABEL_LORA_MATCH] as string);
      loras = loras.filter((l) => l.match(rgx));
      prefix = chooserPrefix(loras);
      if (prefix) {
        loras = loras.map((l) => l.replace(prefix, ""));
      }
    }
    showLoraChooser(
      event as MouseEvent,
      (value: IContextMenuValue | string) => {
        if (typeof value === "string") {
          onChoose(prefix + value);
        }
        this.setDirtyCanvas(true, true);
      },
      null,
      [...loras],
    );
  }

  /** Fetches the server's LoRA list (cached by rgthreeApi) and repaints so missing files show. */
  private loadAvailableLoras(force = false) {
    rgthreeApi
      .getLoras(force)
      .then((details) => {
        this.availableLoras = new Set(details.map((d) => d.file));
        this.redrawLoraWidgets();
      })
      .catch(() => {
        // Without the list we simply can't flag missing files; everything else still works.
      });
  }

  /**
   * Repaints after a state change. Pass the widgets whose look changed; with no argument every
   * widget repaints. See `redrawNodeWidgets` for why Nodes 2.0 needs this.
   */
  redrawLoraWidgets(widgets?: (PowerLoraLoaderWidget | PowerLoraLoaderHeaderWidget | null)[]) {
    redrawNodeWidgets(this, widgets);
  }

  /** The `lora_N` row widgets, top to bottom. */
  getLoraWidgets(): PowerLoraLoaderWidget[] {
    return (this.widgets || []).filter((w) =>
      w.name?.startsWith("lora_"),
    ) as PowerLoraLoaderWidget[];
  }

  /** Turns one row on or off and repaints it and the header (whose toggle-all state may change). */
  setLoraOn(widget: PowerLoraLoaderWidget, on: boolean) {
    widget.value.on = on;
    this.redrawLoraWidgets([widget, this.headerWidget]);
  }

  /** Moves a row up (-1) or down (+1) among the rows. Presentation only; order doesn't affect output. */
  moveLoraWidget(widget: PowerLoraLoaderWidget, direction: -1 | 1) {
    const index = this.widgets.indexOf(widget);
    if (index < 0 || !this.widgets[index + direction]?.name?.startsWith("lora_")) return;
    moveArrayItem(this.widgets, widget, index + direction);
    this.redrawLoraWidgets();
  }

  /**
   * Removes a row. Goes through `removeWidget` (so `onRemove` runs and ComfyUI's widget list sees the
   * change), then shrinks the node by the removed row's height and repaints.
   */
  removeLoraWidget(widget: PowerLoraLoaderWidget) {
    if (!this.widgets.includes(widget)) return;
    widget.disarmRemove();
    const rowHeight = (widget as any).computedHeight || LiteGraph.NODE_WIDGET_HEIGHT;
    this.removeWidget(widget);
    if (this.contextMenuRow?.widget === widget) this.contextMenuRow = null;
    this.fitHeightToRows(rowHeight + 4);
    this.redrawLoraWidgets();
  }

  /**
   * Grows the node when rows don't fit. After a removal, shrinks it by `removedHeight` but never
   * below what the rows need, so space the user added by resizing is kept.
   */
  private fitHeightToRows(removedHeight = 0) {
    const needed = this.computeSize()[1];
    const height = Math.max(needed, this.size[1] - removedHeight);
    if (height !== this.size[1]) {
      this.setSize([this.size[0], height]);
    }
  }

  /** Remembers which row was right-clicked (Nodes 2.0), for `getExtraMenuOptions`. */
  noteRowContextMenu(widget: PowerLoraLoaderWidget) {
    this.contextMenuRow = {widget, time: performance.now()};
  }

  /** The menu items for one row. Shared by the classic row menu and the Nodes 2.0 node menu. */
  private getLoraRowMenuItems(widget: PowerLoraLoaderWidget): (IContextMenuValue | null)[] {
    const index = this.widgets.indexOf(widget);
    const canMoveUp = !!this.widgets[index - 1]?.name?.startsWith("lora_");
    const canMoveDown = !!this.widgets[index + 1]?.name?.startsWith("lora_");
    return [
      {
        content: `ℹ️ Show Info`,
        callback: () => {
          widget.showLoraInfoDialog();
        },
      },
      null, // Divider
      {
        content: `${widget.value.on ? "⚫" : "🟢"} Toggle ${widget.value.on ? "Off" : "On"}`,
        callback: () => {
          this.setLoraOn(widget, !widget.value.on);
        },
      },
      {
        content: `⬆️ Move Up`,
        disabled: !canMoveUp,
        callback: () => {
          this.moveLoraWidget(widget, -1);
        },
      },
      {
        content: `⬇️ Move Down`,
        disabled: !canMoveDown,
        callback: () => {
          this.moveLoraWidget(widget, 1);
        },
      },
      {
        content: `🗑️ Remove`,
        callback: () => {
          this.removeLoraWidget(widget);
        },
      },
    ];
  }

  /**
   * Hacks the `getSlotInPosition` call made from LiteGraph so we can show a custom context menu
   * for widgets.
   *
   * Normally this method, called from LiteGraph's processContextMenu, will only get Inputs or
   * Outputs. But that's not good enough because we we also want to provide a custom menu when
   * clicking a widget for this node... so we are left to HACK once again!
   *
   * To achieve this:
   *  - Here, in LiteGraph's processContextMenu it asks the clicked node to tell it which input or
   *    output the user clicked on in `getSlotInPosition`
   *  - We check, and if we didn't, then we see if we clicked a widget and, if so, pass back some
   *    data that looks like we clicked an output to fool LiteGraph like a silly child.
   *  - As LiteGraph continues in its `processContextMenu`, it will then immediately call
   *    the clicked node's `getSlotMenuOptions` when `getSlotInPosition` returns data.
   *  - So, just below, we can then give LiteGraph the ContextMenu options we have.
   *
   * The only issue is that LiteGraph also checks `input/output.type` to set the ContextMenu title,
   * so we need to supply that property (and set it to what we want our title). Otherwise, this
   * should be pretty clean.
   *
   * Classic canvas only: in Nodes 2.0 a right-click opens ComfyUI's own menu instead, which gets the
   * row actions from `getExtraMenuOptions` below.
   */
  override getSlotInPosition(canvasX: number, canvasY: number): any {
    const slot = super.getSlotInPosition(canvasX, canvasY);
    // No slot, let's see if it's a widget.
    if (!slot) {
      let lastWidget = null;
      for (const widget of this.widgets) {
        // If last_y isn't set, something is wrong. Bail.
        if (!widget.last_y) return;
        if (canvasY > this.pos[1] + widget.last_y) {
          lastWidget = widget;
          continue;
        }
        break;
      }
      // Only care about lora widget clicks.
      if (lastWidget?.name?.startsWith("lora_")) {
        return {widget: lastWidget, output: {type: "LORA WIDGET"}};
      }
    }
    return slot;
  }

  /**
   * Working with the overridden `getSlotInPosition` above, this method checks if the passed in
   * option is actually a widget from it and then hijacks the context menu all together.
   */
  override getSlotMenuOptions(slot: IFoundSlot) {
    // Oddly, LiteGraph doesn't call back into our node with a custom menu (even though it let's us
    // define a custom menu to begin with... wtf?). So, we'll return null so the default is not
    // triggered and then we'll just show one ourselves because.. yea.
    if (slot?.widget?.name?.startsWith("lora_")) {
      const widget = slot.widget as PowerLoraLoaderWidget;
      new LiteGraph.ContextMenu(this.getLoraRowMenuItems(widget), {
        title: "LORA WIDGET",
        event: rgthree.lastCanvasMouseEvent!,
      });

      // [🤮] ComfyUI doesn't have a possible return type as falsy, even though the impl skips the
      // menu when the return is falsy. Casting as any.
      return undefined as any;
    }
    return this.defaultGetSlotMenuOptions(slot);
  }

  /**
   * Adds the strength-mode switch to the node menu (both renderers), and, in Nodes 2.0, the actions
   * of the row that was just right-clicked, at the top. They're inserted into `options` rather than
   * returned: other code wraps this method (ComfyUI's "Favorite Widget" entries come from such a
   * wrapper) and doesn't pass our return value on.
   */
  override getExtraMenuOptions(
    canvas: LGraphCanvas,
    options: (IContextMenuValue<unknown> | null)[],
  ): (IContextMenuValue<unknown> | null)[] {
    super.getExtraMenuOptions(canvas, options);
    const separate = isSeparateStrengths(this);
    options.push({
      content: separate ? "Show a single strength" : "Show separate model & clip strengths",
      callback: () => {
        this.setProperty(
          PROP_LABEL_SHOW_STRENGTHS,
          separate ? PROP_VALUE_SHOW_STRENGTHS_SINGLE : PROP_VALUE_SHOW_STRENGTHS_SEPARATE,
        );
      },
    });

    const row = this.contextMenuRow;
    if (
      row &&
      performance.now() - row.time <= ROW_CONTEXT_MENU_MS &&
      this.widgets.includes(row.widget)
    ) {
      options.unshift(
        {content: `LoRA: ${row.widget.value.lora || "None"}`, disabled: true},
        ...this.getLoraRowMenuItems(row.widget),
        null,
      );
    }
    return [];
  }

  /** Keeps every row's strengths in step with "Show Strengths" and repaints when it changes. */
  override onPropertyChanged(name: string, value: unknown, prevValue?: unknown) {
    super.onPropertyChanged?.(name, value, prevValue);
    if (name === PROP_LABEL_SHOW_STRENGTHS) {
      const separate = value === PROP_VALUE_SHOW_STRENGTHS_SEPARATE;
      for (const widget of this.getLoraWidgets()) widget.syncStrengthMode(separate);
      this.redrawLoraWidgets();
    }
    return true;
  }

  /**
   * When `refreshComboInNode` is called from ComfyUI, then we'll kick off a fresh loras fetch.
   */
  override refreshComboInNode(defs: any) {
    this.loadAvailableLoras(true);
  }

  /**
   * Returns true if there are any Lora Widgets. Useful for widgets to ask as they render.
   */
  hasLoraWidgets() {
    return !!this.widgets?.find((w) => w.name?.startsWith("lora_"));
  }

  /**
   * This will return true when all lora widgets are on, false when all are off, or null if it's
   * mixed.
   */
  allLorasState() {
    return allRowsOnState(this.getLoraWidgets().map((w) => (w.value as any)?.on));
  }

  /**
   * Toggles all the loras on or off.
   */
  toggleAllLoras() {
    const allOn = this.allLorasState();
    const toggledTo = !allOn ? true : false;
    for (const widget of this.getLoraWidgets()) {
      if ((widget.value as any)?.on != null) {
        (widget.value as any).on = toggledTo;
      }
    }
    this.redrawLoraWidgets();
  }

  static override setUp(comfyClass: typeof LGraphNode, nodeData: ComfyNodeDef) {
    RgthreeBaseServerNode.registerForOverride(comfyClass, nodeData, NODE_CLASS);
  }

  static override onRegisteredForOverride(comfyClass: any, ctxClass: any) {
    addConnectionLayoutSupport(NODE_CLASS, app, [
      ["Left", "Right"],
      ["Right", "Left"],
    ]);
    setTimeout(() => {
      NODE_CLASS.category = comfyClass.category;
    });
  }

  override getHelp() {
    return `
      <p>
        The ${this.type!.replace("(rgthree)", "")} is a powerful node that condenses 100s of pixels
        of functionality in a single, dynamic node that allows you to add loras, change strengths,
        and quickly toggle on/off all without taking up half your screen.
      </p>
      <ul>
        <li><p>
          Add as many Lora's as you would like by clicking the "+ Add LoRA" button.
          There's no real limit!
        </p></li>
        <li><p>
          Each row: the switch turns the LoRA on or off; click the name to pick another LoRA; the
          arrows change the strength by 0.05; drag the number left/right to change it, or click it
          to type a value. A name shown in orange was not found in your loras folder.
        </p></li>
        <li><p>
          Remove a row with the <code>×</code> at its right end: click once (it turns red), then
          click again within 3 seconds. Ctrl+Z undoes it like any other edit.
        </p></li>
        <li><p>
          Right-click on a Lora widget for special options to move the lora up or down
          (no image affect, only presentational), toggle it on/off, or delete the row all together.
        </p></li>
        <li>
          <p>
            <strong>Properties.</strong> You can change the following properties (by right-clicking
            on the node, and select "Properties" or "Properties Panel" from the menu):
          </p>
          <ul>
            <li><p>
              <code>${PROP_LABEL_SHOW_STRENGTHS}</code> - Change between showing a single, simple
              strength (which will be used for both model and clip), or a more advanced view with
              both model and clip strengths being modifiable. The node's right-click menu has the
              same switch.
            </p></li>
          </ul>
        </li>
      </ul>`;
  }
}

/** Draws the on/off switch: a filled accent track when on, a grey one when off, null = mixed. */
function drawSwitch(
  ctx: CanvasRenderingContext2D,
  span: Span,
  posY: number,
  height: number,
  value: boolean | null,
  hovered: boolean,
) {
  const [x, width] = span;
  const trackH = height - 8;
  const trackW = width - 8;
  const trackX = x + 4;
  const trackY = posY + 4;
  ctx.save();
  if (!isLowQuality()) {
    ctx.beginPath();
    ctx.roundRect(trackX, trackY, trackW, trackH, [trackH / 2]);
    ctx.fillStyle = value === true ? COLOR_ACCENT : "rgba(255,255,255,0.14)";
    ctx.globalAlpha = value === true ? 0.9 : 1;
    ctx.fill();
    if (hovered) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.stroke();
    }
  }
  const radius = trackH / 2 - 1.5;
  const knobX =
    value === true
      ? trackX + trackW - trackH / 2
      : value === false
        ? trackX + trackH / 2
        : trackX + trackW / 2;
  ctx.globalAlpha = 1;
  ctx.fillStyle = value === true ? "#fff" : value === false ? "#9a9a9a" : "#ccc";
  ctx.beginPath();
  ctx.arc(knobX, posY + height / 2, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Draws one [<][value][>] strength control. */
function drawStrength(
  ctx: CanvasRenderingContext2D,
  layout: StrengthLayout,
  posY: number,
  height: number,
  value: number,
  textColor: string | undefined,
  hover: "dec" | "value" | "inc" | null,
) {
  const midY = posY + height / 2;
  ctx.save();
  if (hover) {
    const span = layout[hover];
    ctx.fillStyle = COLOR_HOVER;
    ctx.beginPath();
    ctx.roundRect(span[0], posY + 2, span[1], height - 4, [4]);
    ctx.fill();
  }
  const arrowW = 6;
  const arrowH = 8;
  const decX = layout.dec[0] + (layout.dec[1] - arrowW) / 2;
  ctx.fill(new Path2D(`M ${decX} ${midY} l ${arrowW} ${arrowH / 2} l 0 -${arrowH} z`));
  const incX = layout.inc[0] + (layout.inc[1] - arrowW) / 2;
  ctx.fill(
    new Path2D(
      `M ${incX} ${midY - arrowH / 2} l ${arrowW} ${arrowH / 2} l -${arrowW} ${arrowH / 2} z`,
    ),
  );
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (textColor) ctx.fillStyle = textColor;
  ctx.fillText(
    fitString(ctx, value.toFixed(2), layout.value[1]),
    layout.value[0] + layout.value[1] / 2,
    midY,
  );
  ctx.restore();
}

/** Draws the row's remove button: a muted ×, red when hovered, a red pill once armed. */
function drawRemoveButton(
  ctx: CanvasRenderingContext2D,
  span: Span,
  posY: number,
  height: number,
  armed: boolean,
  hovered: boolean,
) {
  const [x, width] = span;
  const cx = x + width / 2;
  const cy = posY + height / 2;
  ctx.save();
  if (armed || hovered) {
    ctx.beginPath();
    ctx.roundRect(x + 1, posY + 2, width - 2, height - 4, [5]);
    ctx.fillStyle = armed ? COLOR_DANGER : "rgba(217,83,79,0.25)";
    ctx.fill();
  }
  const r = 3.5;
  ctx.strokeStyle = armed ? "#fff" : hovered ? "#f2b8b5" : LiteGraph.WIDGET_SECONDARY_TEXT_COLOR;
  ctx.globalAlpha = armed || hovered ? 1 : 0.6;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.stroke(
    new Path2D(
      `M ${cx - r} ${cy - r} L ${cx + r} ${cy + r} M ${cx + r} ${cy - r} L ${cx - r} ${cy + r}`,
    ),
  );
  ctx.restore();
}

/** A small warning triangle drawn before the name of a LoRA that wasn't found. */
function drawWarningIcon(ctx: CanvasRenderingContext2D, x: number, midY: number, size: number) {
  ctx.save();
  ctx.fillStyle = COLOR_WARNING;
  ctx.beginPath();
  ctx.moveTo(x + size / 2, midY - size / 2);
  ctx.lineTo(x + size, midY + size / 2);
  ctx.lineTo(x, midY + size / 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#222";
  ctx.fillRect(x + size / 2 - 0.75, midY - size / 6, 1.5, size / 3);
  ctx.fillRect(x + size / 2 - 0.75, midY + size / 4, 1.5, 1.5);
  ctx.restore();
}

/**
 * The PowerLoraLoaderHeaderWidget that renders a toggle all switch, as well as some title info
 * (more necessary for the double model & clip strengths to label them). With no rows it shows a
 * short hint instead of an empty band.
 */
class PowerLoraLoaderHeaderWidget extends RgthreeBaseWidget<{type: string}> {
  override value = {type: "PowerLoraLoaderHeaderWidget"};
  override readonly type = "custom";

  protected override hitAreas: RgthreeBaseHitAreas<"toggle"> = {
    toggle: {bounds: [0, 0] as Vector2, onDown: this.onToggleDown},
  };

  private showModelAndClip: boolean | null = null;
  private hoveringToggle = false;

  constructor(name: string = "PowerLoraLoaderHeaderWidget") {
    super(name);
  }

  draw(
    ctx: CanvasRenderingContext2D,
    node: RgthreePowerLoraLoader,
    w: number,
    posY: number,
    height: number,
  ) {
    w = this.fitOwnCanvas(ctx, w, height, node);
    const rows = node.getLoraWidgets();
    if (!rows.length) {
      this.hitAreas.toggle.bounds = [0, -1];
      if (!isLowQuality()) {
        ctx.save();
        ctx.globalAlpha = app.canvas.editor_alpha * 0.55;
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(
          fitString(ctx, "No LoRAs yet. Use “+ Add LoRA” below.", w - 30),
          w / 2,
          posY + height / 2,
        );
        ctx.restore();
      }
      return;
    }
    // Since draw is the loop that runs, this is where we'll check the property state (rather than
    // expect the node to tell us it's state etc).
    this.showModelAndClip = isSeparateStrengths(node);
    const layout = computeRowLayout(w, height, {
      showInfo: false,
      showModelAndClip: this.showModelAndClip,
    });
    const allLoraState = node.allLorasState();

    // Move slightly down. We don't have a border and this feels a bit nicer.
    posY += 2;
    const midY = posY + height * 0.5;
    ctx.save();
    drawSwitch(ctx, layout.toggle, posY, height, allLoraState, this.hoveringToggle);
    this.hitAreas.toggle.bounds = layout.toggle;

    if (!isLowQuality()) {
      const onCount = rows.filter((r) => r.value?.on === true).length;
      ctx.globalAlpha = app.canvas.editor_alpha * 0.55;
      ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const label = `Toggle All  ·  ${onCount} of ${rows.length} on`;
      ctx.fillText(fitString(ctx, label, layout.label[1] + 20), layout.label[0], midY);

      ctx.textAlign = "center";
      const lastGroup = layout.strengthTwo ?? layout.strength;
      ctx.fillText(
        this.showModelAndClip ? "Clip" : "Strength",
        lastGroup.all[0] + lastGroup.all[1] / 2,
        midY,
      );
      if (this.showModelAndClip) {
        ctx.fillText("Model", layout.strength.all[0] + layout.strength.all[1] / 2, midY);
      }
    }
    ctx.restore();
  }

  override getCursorAt(x: number, y: number) {
    const [start, width] = this.hitAreas.toggle.bounds;
    return width > 0 && x >= start && x <= start + width ? "pointer" : "default";
  }

  protected override onOwnCanvasHover(
    canvas: HTMLCanvasElement,
    x: number | null,
    y: number | null,
  ) {
    super.onOwnCanvasHover(canvas, x, y);
    const hovering = x != null && y != null && this.getCursorAt(x, y) === "pointer";
    if (hovering !== this.hoveringToggle) {
      this.hoveringToggle = hovering;
      this.drawOnOwnCanvas(canvas);
    }
  }

  /**
   * Handles a pointer down on the toggle's defined hit area.
   */
  onToggleDown(event: CanvasMouseEvent, pos: Vector2, node: TLGraphNode) {
    (node as RgthreePowerLoraLoader).toggleAllLoras();
    this.cancelMouseDown();
    return true;
  }
}

/**
 * The PowerLoaderWidget that combines several custom drawing and functionality in a single row.
 */
class PowerLoraLoaderWidget extends RgthreeBaseWidget<LoraRowValue> {
  override readonly type = "custom";

  /** Whether the strength has changed with mouse move (to cancel mouse up). */
  private haveMouseMovedStrength = false;
  /** Where a press on a strength control started, for dragging (x in node space, value). */
  private strengthDragStart: {x: number; value: number} | null = null;
  private loraInfoPromise: Promise<RgthreeModelInfo | null> | null = null;
  private loraInfo: RgthreeModelInfo | null = null;

  private showModelAndClip: boolean | null = null;

  /** The last layout drawn; used for hover and cursor hit testing. */
  private layout: RowLayout | null = null;
  /** Nodes 2.0: the part under the pointer, for hover highlights. */
  private hoverPart: RowPart | null = null;
  /** Armed by a first click on ×; a second click within REMOVE_CONFIRM_MS removes the row. */
  private removeArmedTimer: number | null = null;
  /** The node this row was last drawn in (to repaint after async work, like loading LoRA info). */
  private hostNode: RgthreePowerLoraLoader | null = null;

  protected override hitAreas: RgthreeBaseHitAreas<
    | "toggle"
    | "lora"
    | "info"
    | "strengthDec"
    | "strengthVal"
    | "strengthInc"
    | "strengthAny"
    | "strengthTwoDec"
    | "strengthTwoVal"
    | "strengthTwoInc"
    | "strengthTwoAny"
    | "remove"
  > = {
    toggle: {bounds: [0, 0] as Vector2, onDown: this.onToggleDown},
    lora: {bounds: [0, 0] as Vector2, onClick: this.onLoraClick},
    info: {bounds: [0, 0] as Vector2, onDown: this.onInfoDown},

    strengthDec: {bounds: [0, 0] as Vector2, onClick: this.onStrengthDecDown},
    strengthVal: {bounds: [0, 0] as Vector2, onClick: this.onStrengthValUp},
    strengthInc: {bounds: [0, 0] as Vector2, onClick: this.onStrengthIncDown},
    strengthAny: {
      bounds: [0, 0] as Vector2,
      onDown: this.onStrengthAnyDown,
      onMove: this.onStrengthAnyMove,
    },

    strengthTwoDec: {bounds: [0, 0] as Vector2, onClick: this.onStrengthTwoDecDown},
    strengthTwoVal: {bounds: [0, 0] as Vector2, onClick: this.onStrengthTwoValUp},
    strengthTwoInc: {bounds: [0, 0] as Vector2, onClick: this.onStrengthTwoIncDown},
    strengthTwoAny: {
      bounds: [0, 0] as Vector2,
      onDown: this.onStrengthTwoAnyDown,
      onMove: this.onStrengthTwoAnyMove,
    },

    remove: {bounds: [0, 0] as Vector2, onClick: this.onRemoveClick},
  };

  constructor(name: string) {
    super(name);
  }

  private _value: LoraRowValue = {
    on: true,
    lora: null as string | null,
    strength: 1,
    strengthTwo: null as number | null,
  };

  set value(v) {
    // In case widgets are messed up, we can correct course here.
    this._value = normalizeLoraRowValue(v, !!this.showModelAndClip);
    this.getLoraInfo();
  }

  get value() {
    return this._value;
  }

  setLora(lora: string) {
    this._value.lora = lora;
    this.getLoraInfo();
  }

  /**
   * Keeps `strengthTwo` consistent with the strength mode: switching to separate copies the single
   * strength into the clip strength; switching back clears it.
   */
  syncStrengthMode(separate: boolean) {
    if (this.showModelAndClip === separate) return;
    const old = this.showModelAndClip;
    this.showModelAndClip = separate;
    if (separate) {
      // If we're setting show both AND we're not null, then re-set to the current strength.
      if (old != null) {
        this.value.strengthTwo = this.value.strength ?? 1;
      }
    } else {
      this.value.strengthTwo = null;
    }
  }

  /** Draws our widget with a toggle, lora selector, and number selector all in a single row. */
  draw(ctx: CanvasRenderingContext2D, node: TLGraphNode, w: number, posY: number, height: number) {
    this.hostNode = node as RgthreePowerLoraLoader;
    w = this.fitOwnCanvas(ctx, w, height, node);
    // Since draw is the loop that runs, this is where we'll check the property state (rather than
    // expect the node to tell us it's state etc).
    this.syncStrengthMode(isSeparateStrengths(node));

    const showInfo = !!CONFIG_SERVICE.getConfigValue("nodes.power_lora_loader.show_info_badge");
    // Lay out against `w` (the width we're drawn at). In Nodes 2.0 this is the widget canvas'
    // width, which can be narrower than node.size[0]; right-aligned parts would be clipped.
    const layout = computeRowLayout(w, height, {
      showInfo,
      showModelAndClip: !!this.showModelAndClip,
    });
    this.layout = layout;
    this.applyHitAreas(layout);

    ctx.save();
    const lowQuality = isLowQuality();
    const midY = posY + height * 0.5;
    const armed = this.removeArmedTimer != null;
    const hover = this.hoverPart;

    // Draw the background.
    drawRoundedRectangle(ctx, {
      pos: [layout.toggle[0], posY],
      size: [w - layout.toggle[0] * 2, height],
      colorStroke: armed ? COLOR_DANGER : undefined,
    });

    // Draw the toggle
    drawSwitch(ctx, layout.toggle, posY, height, this.value.on, hover === "toggle");

    // If low quality, then we're done rendering.
    if (lowQuality) {
      ctx.restore();
      return;
    }

    // The remove button stays fully visible on disabled rows, so they're easy to clean up.
    drawRemoveButton(ctx, layout.remove, posY, height, armed, hover === "remove");

    // If we're not toggled on, then make everything after faded.
    if (!this.value.on) {
      ctx.globalAlpha = app.canvas.editor_alpha * 0.4;
    }

    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;

    const strengthColor = (value: number) =>
      (this.loraInfo?.strengthMax != null && value > this.loraInfo.strengthMax) ||
      (this.loraInfo?.strengthMin != null && value < this.loraInfo.strengthMin)
        ? "#c66"
        : undefined;
    const hoverOf = (prefix: "strength" | "strengthTwo") =>
      hover === `${prefix}Dec`
        ? "dec"
        : hover === `${prefix}Val`
          ? "value"
          : hover === `${prefix}Inc`
            ? "inc"
            : null;

    const strength = this.value.strength ?? 1;
    drawStrength(
      ctx,
      layout.strength,
      posY,
      height,
      strength,
      strengthColor(strength),
      hoverOf("strength"),
    );
    if (layout.strengthTwo) {
      const strengthTwo = this.value.strengthTwo ?? 1;
      drawStrength(
        ctx,
        layout.strengthTwo,
        posY,
        height,
        strengthTwo,
        strengthColor(strengthTwo),
        hoverOf("strengthTwo"),
      );
    }

    // Draw an info emoji; if checks if it's enabled (to quickly turn it on or off)
    if (layout.info) {
      const infoIconSize = height * 0.66;
      if (hover === "info") {
        ctx.save();
        ctx.fillStyle = COLOR_HOVER;
        ctx.beginPath();
        ctx.roundRect(layout.info[0], posY + 1, layout.info[1], height - 2, [4]);
        ctx.fill();
        ctx.restore();
      }
      drawInfoIcon(
        ctx,
        layout.info[0] + (layout.info[1] - infoIconSize) / 2,
        posY + (height - infoIconSize) / 2,
        infoIconSize,
        this.loraInfo?.raw?.civitai ? "FILLED" : this.loraInfo?.hasInfoFile ? "OUTLINED" : "GRAYED",
      );
    }

    // Draw lora label (or the remove confirmation, while armed).
    let [labelX, labelWidth] = layout.label;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    if (armed) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#f2b8b5";
      ctx.fillText(fitString(ctx, "Click × again to remove this LoRA", labelWidth), labelX, midY);
    } else {
      const lora = this.value?.lora;
      const missing = isLoraMissing(lora, this.hostNode?.availableLoras ?? null);
      if (missing) {
        drawWarningIcon(ctx, labelX, midY, 10);
        labelX += 14;
        labelWidth -= 14;
        ctx.fillStyle = COLOR_WARNING;
      } else if (!lora || lora === "None") {
        ctx.fillStyle = LiteGraph.WIDGET_SECONDARY_TEXT_COLOR;
      }
      if (hover === "lora" && this.value.on) {
        ctx.save();
        ctx.fillStyle = COLOR_HOVER;
        ctx.beginPath();
        ctx.roundRect(layout.label[0] - 2, posY + 1, layout.label[1] + 4, height - 2, [4]);
        ctx.fill();
        ctx.restore();
      }
      const loraLabel = !lora || lora === "None" ? "Choose a LoRA…" : String(lora);
      ctx.fillText(fitString(ctx, loraLabel, labelWidth), labelX, midY);
    }

    ctx.globalAlpha = app.canvas.editor_alpha;
    ctx.restore();
  }

  /** Copies the layout into the hit areas RgthreeBaseWidget.mouse() tests against. */
  private applyHitAreas(layout: RowLayout) {
    const none: Vector2 = [0, -1];
    const h = this.hitAreas;
    h.toggle.bounds = layout.toggle;
    h.lora.bounds = layout.label;
    h.info.bounds = layout.info ?? [0, 0];
    h.strengthDec.bounds = layout.strength.dec;
    h.strengthVal.bounds = layout.strength.value;
    h.strengthInc.bounds = layout.strength.inc;
    h.strengthAny.bounds = layout.strength.all;
    h.strengthTwoDec.bounds = layout.strengthTwo?.dec ?? none;
    h.strengthTwoVal.bounds = layout.strengthTwo?.value ?? none;
    h.strengthTwoInc.bounds = layout.strengthTwo?.inc ?? none;
    h.strengthTwoAny.bounds = layout.strengthTwo?.all ?? none;
    h.remove.bounds = layout.remove;
  }

  override getCursorAt(x: number, y: number) {
    return cursorForPart(this.layout ? hitTestRow(this.layout, x) : null);
  }

  protected override onOwnCanvasHover(
    canvas: HTMLCanvasElement,
    x: number | null,
    y: number | null,
  ) {
    super.onOwnCanvasHover(canvas, x, y);
    const part = x == null || !this.layout ? null : hitTestRow(this.layout, x);
    if (part !== this.hoverPart) {
      this.hoverPart = part;
      this.drawOnOwnCanvas(canvas);
    }
  }

  protected override onOwnCanvasContextMenu(event: MouseEvent) {
    this.hostNode?.noteRowContextMenu(this);
  }

  override serializeValue(node: TLGraphNode, index: number): LoraRowValue | Promise<LoraRowValue> {
    // Read the mode from the node, not from `this.showModelAndClip`: that is only set once the row
    // has been drawn, so a row that wasn't redrawn after the mode changed (off screen, collapsed,
    // or any row in Nodes 2.0) used to drop its clip strength here.
    const separate = isSeparateStrengths(unwrapNode(node));
    this.syncStrengthMode(separate);
    if (separate) {
      this.value.strengthTwo = this.value.strengthTwo ?? 1;
    }
    return serializeLoraRowValue(this.value, separate) as LoraRowValue;
  }

  onToggleDown(event: CanvasMouseEvent, pos: Vector2, node: TLGraphNode) {
    this.disarmRemove();
    (node as RgthreePowerLoraLoader).setLoraOn(this, !this.value.on);
    this.cancelMouseDown(); // Clear the down since we handle it.
    return true;
  }

  onInfoDown(event: CanvasMouseEvent, pos: Vector2, node: TLGraphNode) {
    this.showLoraInfoDialog();
  }

  onLoraClick(event: CanvasMouseEvent, pos: Vector2, node: RgthreePowerLoraLoader) {
    node.showLoraChooser(event, (value: string) => {
      this.value.lora = value;
      this.loraInfo = null;
      this.getLoraInfo();
      node.redrawLoraWidgets([this]);
    });
    this.cancelMouseDown();
  }

  /**
   * First click arms the button (row turns red, label asks for a second click); a second click
   * within REMOVE_CONFIRM_MS removes the row.
   */
  onRemoveClick(event: CanvasPointerEvent, pos: Vector2, node: TLGraphNode) {
    const loader = node as RgthreePowerLoraLoader;
    if (this.removeArmedTimer != null) {
      loader.removeLoraWidget(this);
      return true;
    }
    this.removeArmedTimer = window.setTimeout(() => {
      this.removeArmedTimer = null;
      loader.redrawLoraWidgets([this]);
    }, REMOVE_CONFIRM_MS);
    loader.redrawLoraWidgets([this]);
    return true;
  }

  /** Cancels a pending remove confirmation. */
  disarmRemove() {
    if (this.removeArmedTimer != null) {
      window.clearTimeout(this.removeArmedTimer);
      this.removeArmedTimer = null;
    }
  }

  override onMouseDown(event: CanvasPointerEvent, pos: Vector2, node: TLGraphNode): boolean | void {
    // Any press other than on the armed × cancels the pending removal.
    if (
      this.removeArmedTimer != null &&
      this.layout &&
      hitTestRow(this.layout, pos[0]) !== "remove"
    ) {
      this.disarmRemove();
      (node as RgthreePowerLoraLoader).redrawLoraWidgets([this]);
    }
  }

  onStrengthDecDown(event: CanvasMouseEvent, pos: Vector2, node: TLGraphNode) {
    this.stepStrength(node, -1, false);
  }
  onStrengthIncDown(event: CanvasMouseEvent, pos: Vector2, node: TLGraphNode) {
    this.stepStrength(node, 1, false);
  }
  onStrengthTwoDecDown(event: CanvasMouseEvent, pos: Vector2, node: TLGraphNode) {
    this.stepStrength(node, -1, true);
  }
  onStrengthTwoIncDown(event: CanvasMouseEvent, pos: Vector2, node: TLGraphNode) {
    this.stepStrength(node, 1, true);
  }

  onStrengthAnyDown(event: CanvasMouseEvent, pos: Vector2, node: TLGraphNode) {
    this.strengthDragStart = {x: pos[0], value: this.value.strength ?? 1};
  }

  onStrengthTwoAnyDown(event: CanvasMouseEvent, pos: Vector2, node: TLGraphNode) {
    this.strengthDragStart = {x: pos[0], value: this.value.strengthTwo ?? 1};
  }

  onStrengthAnyMove(event: CanvasMouseEvent, pos: Vector2, node: TLGraphNode) {
    this.doOnStrengthAnyMove(pos, node, false);
  }

  onStrengthTwoAnyMove(event: CanvasMouseEvent, pos: Vector2, node: TLGraphNode) {
    this.doOnStrengthAnyMove(pos, node, true);
  }

  /** Drag to change: the new value comes from the distance to the press, not from event deltas. */
  private doOnStrengthAnyMove(pos: Vector2, node: TLGraphNode, isTwo = false) {
    const start = this.strengthDragStart;
    if (!start) return;
    const next = dragStrength(start.value, pos[0] - start.x);
    if (next === start.value && !this.haveMouseMovedStrength) return;
    this.haveMouseMovedStrength = true;
    const prop: "strengthTwo" | "strength" = isTwo ? "strengthTwo" : "strength";
    if (this.value[prop] !== next) {
      this.value[prop] = next;
      (node as RgthreePowerLoraLoader).redrawLoraWidgets([this]);
    }
  }

  onStrengthValUp(event: CanvasPointerEvent, pos: Vector2, node: TLGraphNode) {
    this.doOnStrengthValUp(event, node, false);
  }

  onStrengthTwoValUp(event: CanvasPointerEvent, pos: Vector2, node: TLGraphNode) {
    this.doOnStrengthValUp(event, node, true);
  }

  private doOnStrengthValUp(event: CanvasPointerEvent, node: TLGraphNode, isTwo = false) {
    if (this.haveMouseMovedStrength) return;
    let prop: "strengthTwo" | "strength" = isTwo ? "strengthTwo" : "strength";
    const canvas = app.canvas as LGraphCanvas;
    canvas.prompt(
      "Value",
      this.value[prop]!,
      (v: string) => {
        const parsed = parseStrengthInput(v);
        if (parsed == null) return; // Ignore anything that isn't a number instead of storing NaN.
        this.value[prop] = parsed;
        (node as RgthreePowerLoraLoader).redrawLoraWidgets([this]);
      },
      event,
    );
  }

  override onMouseUp(event: CanvasPointerEvent, pos: Vector2, node: TLGraphNode): boolean | void {
    super.onMouseUp(event, pos, node);
    this.haveMouseMovedStrength = false;
    this.strengthDragStart = null;
  }

  showLoraInfoDialog() {
    if (!this.value.lora || this.value.lora === "None") {
      return;
    }
    const infoDialog = new RgthreeLoraInfoDialog(this.value.lora).show();
    infoDialog.addEventListener("close", ((e: CustomEvent<{dirty: boolean}>) => {
      if (e.detail.dirty) {
        this.getLoraInfo(true);
      }
    }) as EventListener);
  }

  private stepStrength(node: TLGraphNode, direction: -1 | 1, isTwo = false) {
    // A press that turned into a drag already changed the value; don't also step it on release.
    if (this.haveMouseMovedStrength) return;
    let prop: "strengthTwo" | "strength" = isTwo ? "strengthTwo" : "strength";
    this.value[prop] = stepStrength(this.value[prop], direction);
    (node as RgthreePowerLoraLoader).redrawLoraWidgets([this]);
  }

  private getLoraInfo(force = false) {
    if (!this.loraInfoPromise || force == true) {
      let promise;
      if (this.value.lora && this.value.lora != "None") {
        promise = LORA_INFO_SERVICE.getInfo(this.value.lora, force, true);
      } else {
        promise = Promise.resolve(null);
      }
      this.loraInfoPromise = promise.then((v) => {
        this.loraInfo = v;
        // The info icon and strength colours depend on it; repaint once it arrives.
        this.hostNode?.redrawLoraWidgets([this]);
        return v;
      });
    }
    return this.loraInfoPromise;
  }
}

/** An uniformed name reference to the node class. */
const NODE_CLASS = RgthreePowerLoraLoader;

/** Register the node. */
app.registerExtension({
  name: "rgthree.PowerLoraLoader",
  async beforeRegisterNodeDef(nodeType: typeof LGraphNode, nodeData: ComfyNodeDef) {
    if (nodeData.name === NODE_CLASS.type) {
      NODE_CLASS.setUp(nodeType, nodeData);
    }
  },
});
