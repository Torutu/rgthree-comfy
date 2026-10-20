var _a, _b;
import { app } from "../../scripts/app.js";
import { RgthreeBaseServerNode } from "./base_node.js";
import { rgthree } from "./rgthree.js";
import { addConnectionLayoutSupport } from "./utils.js";
import { NodeTypesString } from "./constants.js";
import { drawInfoIcon, drawRoundedRectangle, fitString, isLowQuality } from "./utils_canvas.js";
import { RgthreeBaseWidget, RgthreeBetterButtonWidget, RgthreeDividerWidget, redrawNodeWidgets, } from "./utils_widgets.js";
import { rgthreeApi } from "../../rgthree/common/rgthree_api.js";
import { SERVICE as CONFIG_SERVICE } from "./services/config_service.js";
import { showLoraChooser } from "./utils_menu.js";
import { moveArrayItem } from "../../rgthree/common/shared_utils.js";
import { RgthreeLoraInfoDialog } from "./dialog_info.js";
import { LORA_INFO_SERVICE } from "../../rgthree/common/model_info_service.js";
import { allRowsOnState, chooserPrefix, computeRowLayout, cursorForPart, dragStrength, hitTestRow, isLoraMissing, normalizeLoraRowValue, parseStrengthInput, serializeLoraRowValue, stepStrength, } from "./power_lora_loader_logic.js";
const PROP_LABEL_SHOW_STRENGTHS = "Show Strengths";
const PROP_LABEL_SHOW_STRENGTHS_STATIC = `@${PROP_LABEL_SHOW_STRENGTHS}`;
const PROP_LABEL_LORA_MATCH = "Match";
const PROP_LABEL_LORA_MATCH_STATIC = `@${PROP_LABEL_LORA_MATCH}`;
const PROP_VALUE_SHOW_STRENGTHS_SINGLE = "Single Strength";
const PROP_VALUE_SHOW_STRENGTHS_SEPARATE = "Separate Model & Clip";
const REMOVE_CONFIRM_MS = 3000;
const ROW_CONTEXT_MENU_MS = 1500;
const COLOR_ACCENT = "#89B";
const COLOR_DANGER = "#d9534f";
const COLOR_WARNING = "#e8a33d";
const COLOR_HOVER = "rgba(255,255,255,0.08)";
function isSeparateStrengths(node) {
    var _c;
    return ((_c = node.properties) === null || _c === void 0 ? void 0 : _c[PROP_LABEL_SHOW_STRENGTHS]) === PROP_VALUE_SHOW_STRENGTHS_SEPARATE;
}
function unwrapNode(nodeOrDto) {
    var _c;
    return (_c = nodeOrDto === null || nodeOrDto === void 0 ? void 0 : nodeOrDto.node) !== null && _c !== void 0 ? _c : nodeOrDto;
}
class RgthreePowerLoraLoader extends RgthreeBaseServerNode {
    constructor(title = NODE_CLASS.title) {
        super(title);
        this.serialize_widgets = true;
        this.logger = rgthree.newLogSession(`[Power Lora Stack]`);
        this.loraWidgetsCounter = 0;
        this.topDivider = null;
        this.headerWidget = null;
        this.widgetButtonSpacer = null;
        this.addLoraButton = null;
        this.availableLoras = null;
        this.contextMenuRow = null;
        this.properties[PROP_LABEL_SHOW_STRENGTHS] = PROP_VALUE_SHOW_STRENGTHS_SINGLE;
        this.properties[PROP_LABEL_LORA_MATCH] = "";
        this.loadAvailableLoras();
        if (rgthree.loadingApiJson) {
            const fullApiJson = rgthree.loadingApiJson;
            setTimeout(() => {
                this.configureFromApiJson(fullApiJson);
            }, 16);
        }
    }
    configureFromApiJson(fullApiJson) {
        var _c, _d;
        if (this.id == null) {
            const [n, v] = this.logger.errorParts("Cannot load from API JSON without node id.");
            (_c = console[n]) === null || _c === void 0 ? void 0 : _c.call(console, ...v);
            return;
        }
        const nodeData = fullApiJson[this.id] || fullApiJson[String(this.id)] || fullApiJson[Number(this.id)];
        if (nodeData == null) {
            const [n, v] = this.logger.errorParts(`No node found in API JSON for node id ${this.id}.`);
            (_d = console[n]) === null || _d === void 0 ? void 0 : _d.call(console, ...v);
            return;
        }
        this.configure({
            widgets_values: Object.values(nodeData.inputs).filter((input) => typeof (input === null || input === void 0 ? void 0 : input["lora"]) === "string"),
        });
    }
    configure(info) {
        var _c;
        while ((_c = this.widgets) === null || _c === void 0 ? void 0 : _c.length)
            this.removeWidget(0);
        if (info.id != null) {
            super.configure(info);
        }
        this._tempWidth = this.size[0];
        this._tempHeight = this.size[1];
        for (const widgetValue of info.widgets_values || []) {
            if ((widgetValue === null || widgetValue === void 0 ? void 0 : widgetValue.lora) !== undefined) {
                const widget = this.addNewLoraWidget();
                widget.value = { ...widgetValue };
            }
        }
        this.addNonLoraWidgets();
        this.size[0] = this._tempWidth;
        this.size[1] = Math.max(this._tempHeight, this.computeSize()[1]);
        this.redrawLoraWidgets();
    }
    onNodeCreated() {
        var _c;
        (_c = super.onNodeCreated) === null || _c === void 0 ? void 0 : _c.call(this);
        this.addNonLoraWidgets();
        const computed = this.computeSize();
        this.size = this.size || [0, 0];
        this.size[0] = Math.max(this.size[0], computed[0]);
        this.size[1] = Math.max(this.size[1], computed[1]);
        this.setDirtyCanvas(true, true);
    }
    addNewLoraWidget(lora) {
        this.loraWidgetsCounter++;
        const widget = this.addCustomWidget(new PowerLoraLoaderWidget("lora_" + this.loraWidgetsCounter));
        if (lora)
            widget.setLora(lora);
        const spacerIndex = this.widgetButtonSpacer
            ? this.widgets.indexOf(this.widgetButtonSpacer)
            : -1;
        if (spacerIndex >= 0) {
            moveArrayItem(this.widgets, widget, spacerIndex);
        }
        this.redrawLoraWidgets([this.headerWidget]);
        return widget;
    }
    addNonLoraWidgets() {
        var _c, _d, _e, _f;
        (_c = this.topDivider) !== null && _c !== void 0 ? _c : (this.topDivider = new RgthreeDividerWidget({ marginTop: 4, marginBottom: 0, thickness: 0 }));
        moveArrayItem(this.widgets, this.addCustomWidget(this.topDivider), 0);
        (_d = this.headerWidget) !== null && _d !== void 0 ? _d : (this.headerWidget = new PowerLoraLoaderHeaderWidget());
        moveArrayItem(this.widgets, this.addCustomWidget(this.headerWidget), 1);
        (_e = this.widgetButtonSpacer) !== null && _e !== void 0 ? _e : (this.widgetButtonSpacer = new RgthreeDividerWidget({
            marginTop: 4,
            marginBottom: 0,
            thickness: 0,
        }));
        this.addCustomWidget(this.widgetButtonSpacer);
        (_f = this.addLoraButton) !== null && _f !== void 0 ? _f : (this.addLoraButton = new RgthreeBetterButtonWidget("➕ Add Lora", (event, pos, node) => {
            this.showLoraChooser(event, (value) => {
                if (value.includes("Power Lora Chooser")) {
                }
                else if (value !== "NONE") {
                    this.addNewLoraWidget(value);
                    this.fitHeightToRows();
                }
            });
            return true;
        }, "+ Add LoRA"));
        this.addCustomWidget(this.addLoraButton);
    }
    async showLoraChooser(event, onChoose) {
        const lorasDetails = await rgthreeApi.getLoras();
        let loras = lorasDetails.map((l) => l.file);
        let prefix = "";
        if (this.properties[PROP_LABEL_LORA_MATCH]) {
            const rgx = new RegExp(this.properties[PROP_LABEL_LORA_MATCH]);
            loras = loras.filter((l) => l.match(rgx));
            prefix = chooserPrefix(loras);
            if (prefix) {
                loras = loras.map((l) => l.replace(prefix, ""));
            }
        }
        showLoraChooser(event, (value) => {
            if (typeof value === "string") {
                onChoose(prefix + value);
            }
            this.setDirtyCanvas(true, true);
        }, null, [...loras]);
    }
    loadAvailableLoras(force = false) {
        rgthreeApi
            .getLoras(force)
            .then((details) => {
            this.availableLoras = new Set(details.map((d) => d.file));
            this.redrawLoraWidgets();
        })
            .catch(() => {
        });
    }
    redrawLoraWidgets(widgets) {
        redrawNodeWidgets(this, widgets);
    }
    getLoraWidgets() {
        return (this.widgets || []).filter((w) => { var _c; return (_c = w.name) === null || _c === void 0 ? void 0 : _c.startsWith("lora_"); });
    }
    setLoraOn(widget, on) {
        widget.value.on = on;
        this.redrawLoraWidgets([widget, this.headerWidget]);
    }
    moveLoraWidget(widget, direction) {
        var _c, _d;
        const index = this.widgets.indexOf(widget);
        if (index < 0 || !((_d = (_c = this.widgets[index + direction]) === null || _c === void 0 ? void 0 : _c.name) === null || _d === void 0 ? void 0 : _d.startsWith("lora_")))
            return;
        moveArrayItem(this.widgets, widget, index + direction);
        this.redrawLoraWidgets();
    }
    removeLoraWidget(widget) {
        var _c;
        if (!this.widgets.includes(widget))
            return;
        widget.disarmRemove();
        const rowHeight = widget.computedHeight || LiteGraph.NODE_WIDGET_HEIGHT;
        this.removeWidget(widget);
        if (((_c = this.contextMenuRow) === null || _c === void 0 ? void 0 : _c.widget) === widget)
            this.contextMenuRow = null;
        this.fitHeightToRows(rowHeight + 4);
        this.redrawLoraWidgets();
    }
    fitHeightToRows(removedHeight = 0) {
        const needed = this.computeSize()[1];
        const height = Math.max(needed, this.size[1] - removedHeight);
        if (height !== this.size[1]) {
            this.setSize([this.size[0], height]);
        }
    }
    noteRowContextMenu(widget) {
        this.contextMenuRow = { widget, time: performance.now() };
    }
    getLoraRowMenuItems(widget) {
        var _c, _d, _e, _f;
        const index = this.widgets.indexOf(widget);
        const canMoveUp = !!((_d = (_c = this.widgets[index - 1]) === null || _c === void 0 ? void 0 : _c.name) === null || _d === void 0 ? void 0 : _d.startsWith("lora_"));
        const canMoveDown = !!((_f = (_e = this.widgets[index + 1]) === null || _e === void 0 ? void 0 : _e.name) === null || _f === void 0 ? void 0 : _f.startsWith("lora_"));
        return [
            {
                content: `ℹ️ Show Info`,
                callback: () => {
                    widget.showLoraInfoDialog();
                },
            },
            null,
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
    getSlotInPosition(canvasX, canvasY) {
        var _c;
        const slot = super.getSlotInPosition(canvasX, canvasY);
        if (!slot) {
            let lastWidget = null;
            for (const widget of this.widgets) {
                if (!widget.last_y)
                    return;
                if (canvasY > this.pos[1] + widget.last_y) {
                    lastWidget = widget;
                    continue;
                }
                break;
            }
            if ((_c = lastWidget === null || lastWidget === void 0 ? void 0 : lastWidget.name) === null || _c === void 0 ? void 0 : _c.startsWith("lora_")) {
                return { widget: lastWidget, output: { type: "LORA WIDGET" } };
            }
        }
        return slot;
    }
    getSlotMenuOptions(slot) {
        var _c, _d;
        if ((_d = (_c = slot === null || slot === void 0 ? void 0 : slot.widget) === null || _c === void 0 ? void 0 : _c.name) === null || _d === void 0 ? void 0 : _d.startsWith("lora_")) {
            const widget = slot.widget;
            new LiteGraph.ContextMenu(this.getLoraRowMenuItems(widget), {
                title: "LORA WIDGET",
                event: rgthree.lastCanvasMouseEvent,
            });
            return undefined;
        }
        return this.defaultGetSlotMenuOptions(slot);
    }
    getExtraMenuOptions(canvas, options) {
        super.getExtraMenuOptions(canvas, options);
        const separate = isSeparateStrengths(this);
        options.push({
            content: separate ? "Show a single strength" : "Show separate model & clip strengths",
            callback: () => {
                this.setProperty(PROP_LABEL_SHOW_STRENGTHS, separate ? PROP_VALUE_SHOW_STRENGTHS_SINGLE : PROP_VALUE_SHOW_STRENGTHS_SEPARATE);
            },
        });
        const row = this.contextMenuRow;
        if (row &&
            performance.now() - row.time <= ROW_CONTEXT_MENU_MS &&
            this.widgets.includes(row.widget)) {
            options.unshift({ content: `LoRA: ${row.widget.value.lora || "None"}`, disabled: true }, ...this.getLoraRowMenuItems(row.widget), null);
        }
        return [];
    }
    onPropertyChanged(name, value, prevValue) {
        var _c;
        (_c = super.onPropertyChanged) === null || _c === void 0 ? void 0 : _c.call(this, name, value, prevValue);
        if (name === PROP_LABEL_SHOW_STRENGTHS) {
            const separate = value === PROP_VALUE_SHOW_STRENGTHS_SEPARATE;
            for (const widget of this.getLoraWidgets())
                widget.syncStrengthMode(separate);
            this.redrawLoraWidgets();
        }
        return true;
    }
    refreshComboInNode(defs) {
        this.loadAvailableLoras(true);
    }
    hasLoraWidgets() {
        var _c;
        return !!((_c = this.widgets) === null || _c === void 0 ? void 0 : _c.find((w) => { var _c; return (_c = w.name) === null || _c === void 0 ? void 0 : _c.startsWith("lora_"); }));
    }
    allLorasState() {
        return allRowsOnState(this.getLoraWidgets().map((w) => { var _c; return (_c = w.value) === null || _c === void 0 ? void 0 : _c.on; }));
    }
    toggleAllLoras() {
        var _c;
        const allOn = this.allLorasState();
        const toggledTo = !allOn ? true : false;
        for (const widget of this.getLoraWidgets()) {
            if (((_c = widget.value) === null || _c === void 0 ? void 0 : _c.on) != null) {
                widget.value.on = toggledTo;
            }
        }
        this.redrawLoraWidgets();
    }
    static setUp(comfyClass, nodeData) {
        RgthreeBaseServerNode.registerForOverride(comfyClass, nodeData, NODE_CLASS);
    }
    static onRegisteredForOverride(comfyClass, ctxClass) {
        addConnectionLayoutSupport(NODE_CLASS, app, [
            ["Left", "Right"],
            ["Right", "Left"],
        ]);
        setTimeout(() => {
            NODE_CLASS.category = comfyClass.category;
        });
    }
    getHelp() {
        return `
      <p>
        The ${this.type.replace("(rgthree)", "")} is a powerful node that condenses 100s of pixels
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
_a = PROP_LABEL_SHOW_STRENGTHS_STATIC, _b = PROP_LABEL_LORA_MATCH_STATIC;
RgthreePowerLoraLoader.title = NodeTypesString.POWER_LORA_LOADER;
RgthreePowerLoraLoader.type = NodeTypesString.POWER_LORA_LOADER;
RgthreePowerLoraLoader.comfyClass = NodeTypesString.POWER_LORA_LOADER;
RgthreePowerLoraLoader[_a] = {
    type: "combo",
    values: [PROP_VALUE_SHOW_STRENGTHS_SINGLE, PROP_VALUE_SHOW_STRENGTHS_SEPARATE],
};
RgthreePowerLoraLoader[_b] = {
    type: "string",
};
function drawSwitch(ctx, span, posY, height, value, hovered) {
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
    const knobX = value === true
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
function drawStrength(ctx, layout, posY, height, value, textColor, hover) {
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
    ctx.fill(new Path2D(`M ${incX} ${midY - arrowH / 2} l ${arrowW} ${arrowH / 2} l -${arrowW} ${arrowH / 2} z`));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (textColor)
        ctx.fillStyle = textColor;
    ctx.fillText(fitString(ctx, value.toFixed(2), layout.value[1]), layout.value[0] + layout.value[1] / 2, midY);
    ctx.restore();
}
function drawRemoveButton(ctx, span, posY, height, armed, hovered) {
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
    ctx.stroke(new Path2D(`M ${cx - r} ${cy - r} L ${cx + r} ${cy + r} M ${cx + r} ${cy - r} L ${cx - r} ${cy + r}`));
    ctx.restore();
}
function drawWarningIcon(ctx, x, midY, size) {
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
class PowerLoraLoaderHeaderWidget extends RgthreeBaseWidget {
    constructor(name = "PowerLoraLoaderHeaderWidget") {
        super(name);
        this.value = { type: "PowerLoraLoaderHeaderWidget" };
        this.type = "custom";
        this.hitAreas = {
            toggle: { bounds: [0, 0], onDown: this.onToggleDown },
        };
        this.showModelAndClip = null;
        this.hoveringToggle = false;
    }
    draw(ctx, node, w, posY, height) {
        var _c;
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
                ctx.fillText(fitString(ctx, "No LoRAs yet. Use “+ Add LoRA” below.", w - 30), w / 2, posY + height / 2);
                ctx.restore();
            }
            return;
        }
        this.showModelAndClip = isSeparateStrengths(node);
        const layout = computeRowLayout(w, height, {
            showInfo: false,
            showModelAndClip: this.showModelAndClip,
        });
        const allLoraState = node.allLorasState();
        posY += 2;
        const midY = posY + height * 0.5;
        ctx.save();
        drawSwitch(ctx, layout.toggle, posY, height, allLoraState, this.hoveringToggle);
        this.hitAreas.toggle.bounds = layout.toggle;
        if (!isLowQuality()) {
            const onCount = rows.filter((r) => { var _c; return ((_c = r.value) === null || _c === void 0 ? void 0 : _c.on) === true; }).length;
            ctx.globalAlpha = app.canvas.editor_alpha * 0.55;
            ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            const label = `Toggle All  ·  ${onCount} of ${rows.length} on`;
            ctx.fillText(fitString(ctx, label, layout.label[1] + 20), layout.label[0], midY);
            ctx.textAlign = "center";
            const lastGroup = (_c = layout.strengthTwo) !== null && _c !== void 0 ? _c : layout.strength;
            ctx.fillText(this.showModelAndClip ? "Clip" : "Strength", lastGroup.all[0] + lastGroup.all[1] / 2, midY);
            if (this.showModelAndClip) {
                ctx.fillText("Model", layout.strength.all[0] + layout.strength.all[1] / 2, midY);
            }
        }
        ctx.restore();
    }
    getCursorAt(x, y) {
        const [start, width] = this.hitAreas.toggle.bounds;
        return width > 0 && x >= start && x <= start + width ? "pointer" : "default";
    }
    onOwnCanvasHover(canvas, x, y) {
        super.onOwnCanvasHover(canvas, x, y);
        const hovering = x != null && y != null && this.getCursorAt(x, y) === "pointer";
        if (hovering !== this.hoveringToggle) {
            this.hoveringToggle = hovering;
            this.drawOnOwnCanvas(canvas);
        }
    }
    onToggleDown(event, pos, node) {
        node.toggleAllLoras();
        this.cancelMouseDown();
        return true;
    }
}
class PowerLoraLoaderWidget extends RgthreeBaseWidget {
    constructor(name) {
        super(name);
        this.type = "custom";
        this.haveMouseMovedStrength = false;
        this.strengthDragStart = null;
        this.loraInfoPromise = null;
        this.loraInfo = null;
        this.showModelAndClip = null;
        this.layout = null;
        this.hoverPart = null;
        this.removeArmedTimer = null;
        this.hostNode = null;
        this.hitAreas = {
            toggle: { bounds: [0, 0], onDown: this.onToggleDown },
            lora: { bounds: [0, 0], onClick: this.onLoraClick },
            info: { bounds: [0, 0], onDown: this.onInfoDown },
            strengthDec: { bounds: [0, 0], onClick: this.onStrengthDecDown },
            strengthVal: { bounds: [0, 0], onClick: this.onStrengthValUp },
            strengthInc: { bounds: [0, 0], onClick: this.onStrengthIncDown },
            strengthAny: {
                bounds: [0, 0],
                onDown: this.onStrengthAnyDown,
                onMove: this.onStrengthAnyMove,
            },
            strengthTwoDec: { bounds: [0, 0], onClick: this.onStrengthTwoDecDown },
            strengthTwoVal: { bounds: [0, 0], onClick: this.onStrengthTwoValUp },
            strengthTwoInc: { bounds: [0, 0], onClick: this.onStrengthTwoIncDown },
            strengthTwoAny: {
                bounds: [0, 0],
                onDown: this.onStrengthTwoAnyDown,
                onMove: this.onStrengthTwoAnyMove,
            },
            remove: { bounds: [0, 0], onClick: this.onRemoveClick },
        };
        this._value = {
            on: true,
            lora: null,
            strength: 1,
            strengthTwo: null,
        };
    }
    set value(v) {
        this._value = normalizeLoraRowValue(v, !!this.showModelAndClip);
        this.getLoraInfo();
    }
    get value() {
        return this._value;
    }
    setLora(lora) {
        this._value.lora = lora;
        this.getLoraInfo();
    }
    syncStrengthMode(separate) {
        var _c;
        if (this.showModelAndClip === separate)
            return;
        const old = this.showModelAndClip;
        this.showModelAndClip = separate;
        if (separate) {
            if (old != null) {
                this.value.strengthTwo = (_c = this.value.strength) !== null && _c !== void 0 ? _c : 1;
            }
        }
        else {
            this.value.strengthTwo = null;
        }
    }
    draw(ctx, node, w, posY, height) {
        var _c, _d, _e, _f, _g;
        var _h, _j, _k;
        this.hostNode = node;
        w = this.fitOwnCanvas(ctx, w, height, node);
        this.syncStrengthMode(isSeparateStrengths(node));
        const showInfo = !!CONFIG_SERVICE.getConfigValue("nodes.power_lora_loader.show_info_badge");
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
        drawRoundedRectangle(ctx, {
            pos: [layout.toggle[0], posY],
            size: [w - layout.toggle[0] * 2, height],
            colorStroke: armed ? COLOR_DANGER : undefined,
        });
        drawSwitch(ctx, layout.toggle, posY, height, this.value.on, hover === "toggle");
        if (lowQuality) {
            ctx.restore();
            return;
        }
        drawRemoveButton(ctx, layout.remove, posY, height, armed, hover === "remove");
        if (!this.value.on) {
            ctx.globalAlpha = app.canvas.editor_alpha * 0.4;
        }
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        const strengthColor = (value) => { var _c, _d; return (((_c = this.loraInfo) === null || _c === void 0 ? void 0 : _c.strengthMax) != null && value > this.loraInfo.strengthMax) ||
            (((_d = this.loraInfo) === null || _d === void 0 ? void 0 : _d.strengthMin) != null && value < this.loraInfo.strengthMin)
            ? "#c66"
            : undefined; };
        const hoverOf = (prefix) => hover === `${prefix}Dec`
            ? "dec"
            : hover === `${prefix}Val`
                ? "value"
                : hover === `${prefix}Inc`
                    ? "inc"
                    : null;
        const strength = (_h = this.value.strength) !== null && _h !== void 0 ? _h : 1;
        drawStrength(ctx, layout.strength, posY, height, strength, strengthColor(strength), hoverOf("strength"));
        if (layout.strengthTwo) {
            const strengthTwo = (_j = this.value.strengthTwo) !== null && _j !== void 0 ? _j : 1;
            drawStrength(ctx, layout.strengthTwo, posY, height, strengthTwo, strengthColor(strengthTwo), hoverOf("strengthTwo"));
        }
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
            drawInfoIcon(ctx, layout.info[0] + (layout.info[1] - infoIconSize) / 2, posY + (height - infoIconSize) / 2, infoIconSize, ((_d = (_c = this.loraInfo) === null || _c === void 0 ? void 0 : _c.raw) === null || _d === void 0 ? void 0 : _d.civitai) ? "FILLED" : ((_e = this.loraInfo) === null || _e === void 0 ? void 0 : _e.hasInfoFile) ? "OUTLINED" : "GRAYED");
        }
        let [labelX, labelWidth] = layout.label;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        if (armed) {
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#f2b8b5";
            ctx.fillText(fitString(ctx, "Click × again to remove this LoRA", labelWidth), labelX, midY);
        }
        else {
            const lora = (_f = this.value) === null || _f === void 0 ? void 0 : _f.lora;
            const missing = isLoraMissing(lora, (_k = (_g = this.hostNode) === null || _g === void 0 ? void 0 : _g.availableLoras) !== null && _k !== void 0 ? _k : null);
            if (missing) {
                drawWarningIcon(ctx, labelX, midY, 10);
                labelX += 14;
                labelWidth -= 14;
                ctx.fillStyle = COLOR_WARNING;
            }
            else if (!lora || lora === "None") {
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
    applyHitAreas(layout) {
        var _c, _d, _e, _f;
        var _g, _h, _j, _k, _l;
        const none = [0, -1];
        const h = this.hitAreas;
        h.toggle.bounds = layout.toggle;
        h.lora.bounds = layout.label;
        h.info.bounds = (_g = layout.info) !== null && _g !== void 0 ? _g : [0, 0];
        h.strengthDec.bounds = layout.strength.dec;
        h.strengthVal.bounds = layout.strength.value;
        h.strengthInc.bounds = layout.strength.inc;
        h.strengthAny.bounds = layout.strength.all;
        h.strengthTwoDec.bounds = (_h = (_c = layout.strengthTwo) === null || _c === void 0 ? void 0 : _c.dec) !== null && _h !== void 0 ? _h : none;
        h.strengthTwoVal.bounds = (_j = (_d = layout.strengthTwo) === null || _d === void 0 ? void 0 : _d.value) !== null && _j !== void 0 ? _j : none;
        h.strengthTwoInc.bounds = (_k = (_e = layout.strengthTwo) === null || _e === void 0 ? void 0 : _e.inc) !== null && _k !== void 0 ? _k : none;
        h.strengthTwoAny.bounds = (_l = (_f = layout.strengthTwo) === null || _f === void 0 ? void 0 : _f.all) !== null && _l !== void 0 ? _l : none;
        h.remove.bounds = layout.remove;
    }
    getCursorAt(x, y) {
        return cursorForPart(this.layout ? hitTestRow(this.layout, x) : null);
    }
    onOwnCanvasHover(canvas, x, y) {
        super.onOwnCanvasHover(canvas, x, y);
        const part = x == null || !this.layout ? null : hitTestRow(this.layout, x);
        if (part !== this.hoverPart) {
            this.hoverPart = part;
            this.drawOnOwnCanvas(canvas);
        }
    }
    onOwnCanvasContextMenu(event) {
        var _c;
        (_c = this.hostNode) === null || _c === void 0 ? void 0 : _c.noteRowContextMenu(this);
    }
    serializeValue(node, index) {
        var _c;
        const separate = isSeparateStrengths(unwrapNode(node));
        this.syncStrengthMode(separate);
        if (separate) {
            this.value.strengthTwo = (_c = this.value.strengthTwo) !== null && _c !== void 0 ? _c : 1;
        }
        return serializeLoraRowValue(this.value, separate);
    }
    onToggleDown(event, pos, node) {
        this.disarmRemove();
        node.setLoraOn(this, !this.value.on);
        this.cancelMouseDown();
        return true;
    }
    onInfoDown(event, pos, node) {
        this.showLoraInfoDialog();
    }
    onLoraClick(event, pos, node) {
        node.showLoraChooser(event, (value) => {
            this.value.lora = value;
            this.loraInfo = null;
            this.getLoraInfo();
            node.redrawLoraWidgets([this]);
        });
        this.cancelMouseDown();
    }
    onRemoveClick(event, pos, node) {
        const loader = node;
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
    disarmRemove() {
        if (this.removeArmedTimer != null) {
            window.clearTimeout(this.removeArmedTimer);
            this.removeArmedTimer = null;
        }
    }
    onMouseDown(event, pos, node) {
        if (this.removeArmedTimer != null &&
            this.layout &&
            hitTestRow(this.layout, pos[0]) !== "remove") {
            this.disarmRemove();
            node.redrawLoraWidgets([this]);
        }
    }
    onStrengthDecDown(event, pos, node) {
        this.stepStrength(node, -1, false);
    }
    onStrengthIncDown(event, pos, node) {
        this.stepStrength(node, 1, false);
    }
    onStrengthTwoDecDown(event, pos, node) {
        this.stepStrength(node, -1, true);
    }
    onStrengthTwoIncDown(event, pos, node) {
        this.stepStrength(node, 1, true);
    }
    onStrengthAnyDown(event, pos, node) {
        var _c;
        this.strengthDragStart = { x: pos[0], value: (_c = this.value.strength) !== null && _c !== void 0 ? _c : 1 };
    }
    onStrengthTwoAnyDown(event, pos, node) {
        var _c;
        this.strengthDragStart = { x: pos[0], value: (_c = this.value.strengthTwo) !== null && _c !== void 0 ? _c : 1 };
    }
    onStrengthAnyMove(event, pos, node) {
        this.doOnStrengthAnyMove(pos, node, false);
    }
    onStrengthTwoAnyMove(event, pos, node) {
        this.doOnStrengthAnyMove(pos, node, true);
    }
    doOnStrengthAnyMove(pos, node, isTwo = false) {
        const start = this.strengthDragStart;
        if (!start)
            return;
        const next = dragStrength(start.value, pos[0] - start.x);
        if (next === start.value && !this.haveMouseMovedStrength)
            return;
        this.haveMouseMovedStrength = true;
        const prop = isTwo ? "strengthTwo" : "strength";
        if (this.value[prop] !== next) {
            this.value[prop] = next;
            node.redrawLoraWidgets([this]);
        }
    }
    onStrengthValUp(event, pos, node) {
        this.doOnStrengthValUp(event, node, false);
    }
    onStrengthTwoValUp(event, pos, node) {
        this.doOnStrengthValUp(event, node, true);
    }
    doOnStrengthValUp(event, node, isTwo = false) {
        if (this.haveMouseMovedStrength)
            return;
        let prop = isTwo ? "strengthTwo" : "strength";
        const canvas = app.canvas;
        canvas.prompt("Value", this.value[prop], (v) => {
            const parsed = parseStrengthInput(v);
            if (parsed == null)
                return;
            this.value[prop] = parsed;
            node.redrawLoraWidgets([this]);
        }, event);
    }
    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedStrength = false;
        this.strengthDragStart = null;
    }
    showLoraInfoDialog() {
        if (!this.value.lora || this.value.lora === "None") {
            return;
        }
        const infoDialog = new RgthreeLoraInfoDialog(this.value.lora).show();
        infoDialog.addEventListener("close", ((e) => {
            if (e.detail.dirty) {
                this.getLoraInfo(true);
            }
        }));
    }
    stepStrength(node, direction, isTwo = false) {
        if (this.haveMouseMovedStrength)
            return;
        let prop = isTwo ? "strengthTwo" : "strength";
        this.value[prop] = stepStrength(this.value[prop], direction);
        node.redrawLoraWidgets([this]);
    }
    getLoraInfo(force = false) {
        if (!this.loraInfoPromise || force == true) {
            let promise;
            if (this.value.lora && this.value.lora != "None") {
                promise = LORA_INFO_SERVICE.getInfo(this.value.lora, force, true);
            }
            else {
                promise = Promise.resolve(null);
            }
            this.loraInfoPromise = promise.then((v) => {
                var _c;
                this.loraInfo = v;
                (_c = this.hostNode) === null || _c === void 0 ? void 0 : _c.redrawLoraWidgets([this]);
                return v;
            });
        }
        return this.loraInfoPromise;
    }
}
const NODE_CLASS = RgthreePowerLoraLoader;
app.registerExtension({
    name: "rgthree.PowerLoraLoader",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === NODE_CLASS.type) {
            NODE_CLASS.setUp(nodeType, nodeData);
        }
    },
});
