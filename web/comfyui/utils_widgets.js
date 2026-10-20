import { app } from "../../scripts/app.js";
import { drawNodeWidget, drawWidgetButton, fitString, isLowQuality } from "./utils_canvas.js";
export function drawLabelAndValue(ctx, label, value, width, posY, height, options) {
    var _a;
    const outerMargin = 15;
    const innerMargin = 10;
    const midY = posY + height / 2;
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = LiteGraph.WIDGET_SECONDARY_TEXT_COLOR;
    const labelX = outerMargin + innerMargin + ((_a = options === null || options === void 0 ? void 0 : options.offsetLeft) !== null && _a !== void 0 ? _a : 0);
    ctx.fillText(label, labelX, midY);
    const valueXLeft = labelX + ctx.measureText(label).width + 7;
    const valueXRight = width - (outerMargin + innerMargin);
    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
    ctx.textAlign = "right";
    ctx.fillText(fitString(ctx, value, valueXRight - valueXLeft), valueXRight, midY);
    ctx.restore();
}
export function redrawNodeWidgets(node, widgets) {
    var _a;
    var _b;
    for (const widget of (_b = widgets !== null && widgets !== void 0 ? widgets : node.widgets) !== null && _b !== void 0 ? _b : []) {
        if (widget instanceof Object && "redrawOwnCanvases" in widget) {
            if (widget.redrawOwnCanvases(node))
                continue;
        }
        (_a = widget === null || widget === void 0 ? void 0 : widget.triggerDraw) === null || _a === void 0 ? void 0 : _a.call(widget);
    }
    if (node.graph) {
        node.setDirtyCanvas(true, true);
    }
}
const OWN_CANVAS_WIDGETS = new WeakMap();
export class RgthreeBaseWidget {
    constructor(name) {
        this.type = "custom";
        this.options = {};
        this.y = 0;
        this.last_y = 0;
        this.disabled = false;
        this.mouseDowned = null;
        this.isMouseDownedAndOver = false;
        this.hitAreas = {};
        this.downedHitAreasForMove = [];
        this.downedHitAreasForClick = [];
        this.ownCanvasScale = 1;
        this.ownCanvases = new Map();
        this.lastDrawnCanvas = null;
        this.activeCanvas = null;
        this.name = name;
    }
    serializeValue(node, index) {
        return this.value;
    }
    clickWasWithinBounds(pos, bounds) {
        let xStart = bounds[0];
        let xEnd = xStart + (bounds.length > 2 ? bounds[2] : bounds[1]);
        const clickedX = pos[0] >= xStart && pos[0] <= xEnd;
        if (bounds.length === 2) {
            return clickedX;
        }
        return clickedX && pos[1] >= bounds[1] && pos[1] <= bounds[1] + bounds[3];
    }
    mouse(event, pos, node) {
        var _a, _b, _c;
        if (event.type == "pointerdown" && event.button > 0) {
            return false;
        }
        const target = event.target;
        if (event.type == "pointerdown" && target instanceof HTMLCanvasElement) {
            this.useCanvas(target);
        }
        pos = this.toNodeSpace(event, pos);
        if (event.type == "pointerdown") {
            this.mouseDowned = [...pos];
            this.isMouseDownedAndOver = true;
            this.downedHitAreasForMove.length = 0;
            this.downedHitAreasForClick.length = 0;
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
            return (_a = this.onMouseDown(event, pos, node)) !== null && _a !== void 0 ? _a : anyHandled;
        }
        if (event.type == "pointerup") {
            if (!this.mouseDowned)
                return true;
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
                    const thisHandled = part.onClick.apply(this, [event, pos, node, part]);
                    anyHandled = anyHandled || thisHandled == true;
                }
            }
            this.downedHitAreasForClick.length = 0;
            if (wasMouseDownedAndOver) {
                const thisHandled = this.onMouseClick(event, pos, node);
                anyHandled = anyHandled || thisHandled == true;
            }
            return (_b = this.onMouseUp(event, pos, node)) !== null && _b !== void 0 ? _b : anyHandled;
        }
        if (event.type == "pointermove") {
            this.isMouseDownedAndOver = !!this.mouseDowned;
            if (this.mouseDowned &&
                (pos[0] < 15 ||
                    pos[0] > node.size[0] - 15 ||
                    pos[1] < this.last_y ||
                    pos[1] > this.last_y + LiteGraph.NODE_WIDGET_HEIGHT)) {
                this.isMouseDownedAndOver = false;
            }
            for (const part of Object.values(this.hitAreas)) {
                if (this.downedHitAreasForMove.includes(part)) {
                    part.onMove.apply(this, [event, pos, node, part]);
                }
                if (this.downedHitAreasForClick.includes(part)) {
                    part.wasMouseClickedAndIsOver = this.clickWasWithinBounds(pos, part.bounds);
                }
            }
            return (_c = this.onMouseMove(event, pos, node)) !== null && _c !== void 0 ? _c : true;
        }
        return false;
    }
    toNodeSpace(event, pos) {
        var _a;
        const target = event.target;
        if (target instanceof HTMLCanvasElement && target !== ((_a = app.canvas) === null || _a === void 0 ? void 0 : _a.canvas)) {
            return [event.offsetX, (this.last_y || 0) + event.offsetY];
        }
        return pos;
    }
    getCursorAt(x, y) {
        return "";
    }
    onOwnCanvasHover(canvas, x, y) {
        canvas.style.cursor = x == null || y == null ? "" : this.getCursorAt(x, y);
    }
    onOwnCanvasContextMenu(event) { }
    drawOnOwnCanvas(canvas) {
        var _a, _b;
        const entry = this.ownCanvases.get(canvas);
        const ctx = canvas.getContext("2d");
        if (!entry || !ctx)
            return;
        const width = canvas.getBoundingClientRect().width || canvas.clientWidth;
        (_b = (_a = this).draw) === null || _b === void 0 ? void 0 : _b.call(_a, ctx, entry.node, width, 1, entry.height);
    }
    redrawOwnCanvases(node) {
        let any = false;
        for (const canvas of [...this.ownCanvases.keys()]) {
            if (!canvas.isConnected) {
                this.ownCanvases.delete(canvas);
                if (this.activeCanvas === canvas)
                    this.activeCanvas = null;
            }
        }
        for (const canvas of this.ownCanvases.keys()) {
            if (canvas === this.activeCanvas)
                continue;
            this.drawOnOwnCanvas(canvas);
            any = true;
        }
        if (this.activeCanvas) {
            this.drawOnOwnCanvas(this.activeCanvas);
            any = true;
        }
        return any;
    }
    useCanvas(canvas) {
        this.activeCanvas = canvas;
        if (this.lastDrawnCanvas !== canvas && this.ownCanvases.has(canvas)) {
            this.drawOnOwnCanvas(canvas);
        }
    }
    fitOwnCanvas(ctx, w, height, node) {
        var _a, _b;
        this.trackOwnCanvas(ctx);
        const canvas = ctx.canvas;
        if (!(canvas instanceof HTMLCanvasElement) || canvas === ((_a = app.canvas) === null || _a === void 0 ? void 0 : _a.canvas))
            return w;
        this.ownCanvases.set(canvas, { height, node });
        this.lastDrawnCanvas = canvas;
        const layoutWidth = canvas.clientWidth;
        if (!layoutWidth || !w)
            return w;
        const scale = w / layoutWidth;
        const density = 2 * scale;
        const cssHeight = height + 2;
        canvas.style.height = `${cssHeight}px`;
        canvas.width = Math.max(1, Math.round(layoutWidth * density));
        canvas.height = Math.max(1, Math.round(cssHeight * density));
        ctx.setTransform(density, 0, 0, density, 0, 0);
        ctx.font = ((_b = app.canvas) === null || _b === void 0 ? void 0 : _b.inner_text_font) || ctx.font;
        this.ownCanvasScale = scale;
        return layoutWidth;
    }
    trackOwnCanvas(ctx) {
        var _a;
        const canvas = ctx.canvas;
        if (!(canvas instanceof HTMLCanvasElement) || canvas === ((_a = app.canvas) === null || _a === void 0 ? void 0 : _a.canvas))
            return;
        const known = OWN_CANVAS_WIDGETS.has(canvas);
        OWN_CANVAS_WIDGETS.set(canvas, this);
        if (known)
            return;
        canvas.addEventListener("pointermove", (e) => {
            if (e.buttons)
                return;
            const widget = OWN_CANVAS_WIDGETS.get(canvas);
            if (!widget)
                return;
            const scale = canvas.getBoundingClientRect().width / (canvas.clientWidth || 1);
            if (Math.abs(scale / widget.ownCanvasScale - 1) > 0.15) {
                widget.lastDrawnCanvas = null;
            }
            widget.useCanvas(canvas);
            widget.onOwnCanvasHover(canvas, e.offsetX, e.offsetY);
        });
        canvas.addEventListener("pointerleave", () => {
            var _a;
            (_a = OWN_CANVAS_WIDGETS.get(canvas)) === null || _a === void 0 ? void 0 : _a.onOwnCanvasHover(canvas, null, null);
        });
        canvas.addEventListener("contextmenu", (e) => {
            var _a;
            (_a = OWN_CANVAS_WIDGETS.get(canvas)) === null || _a === void 0 ? void 0 : _a.onOwnCanvasContextMenu(e);
        });
    }
    cancelMouseDown() {
        this.mouseDowned = null;
        this.isMouseDownedAndOver = false;
        this.downedHitAreasForMove.length = 0;
    }
    onMouseDown(event, pos, node) {
        return;
    }
    onMouseUp(event, pos, node) {
        return;
    }
    onMouseClick(event, pos, node) {
        return;
    }
    onMouseMove(event, pos, node) {
        return;
    }
}
export class RgthreeBetterButtonWidget extends RgthreeBaseWidget {
    constructor(name, mouseClickCallback, label) {
        super(name);
        this.type = "custom";
        this.value = "";
        this.label = "";
        this.mouseClickCallback = mouseClickCallback;
        this.label = label || name;
    }
    draw(ctx, node, width, y, height) {
        width = this.fitOwnCanvas(ctx, width, height, node);
        drawWidgetButton(ctx, { size: [width - 30, height], pos: [15, y] }, this.label, this.isMouseDownedAndOver);
    }
    getCursorAt(x, y) {
        return "pointer";
    }
    onMouseClick(event, pos, node) {
        return this.mouseClickCallback(event, pos, node);
    }
}
export class RgthreeBetterTextWidget extends RgthreeBaseWidget {
    constructor(name, value) {
        super(name);
        this.name = name;
        this.value = value;
    }
    draw(ctx, node, width, y, height) {
        const widgetData = drawNodeWidget(ctx, { size: [width, height], pos: [15, y] });
        if (!widgetData.lowQuality) {
            drawLabelAndValue(ctx, this.name, this.value, width, y, height);
        }
    }
    mouse(event, pos, node) {
        const canvas = app.canvas;
        if (event.type == "pointerdown") {
            canvas.prompt("Label", this.value, (v) => (this.value = v), event);
            return true;
        }
        return false;
    }
}
export class RgthreeDividerWidget extends RgthreeBaseWidget {
    constructor(widgetOptions) {
        super("divider");
        this.value = {};
        this.options = { serialize: false };
        this.type = "custom";
        this.widgetOptions = {
            marginTop: 7,
            marginBottom: 7,
            marginLeft: 15,
            marginRight: 15,
            color: LiteGraph.WIDGET_OUTLINE_COLOR,
            thickness: 1,
        };
        Object.assign(this.widgetOptions, widgetOptions || {});
    }
    draw(ctx, node, width, posY, h) {
        width = this.fitOwnCanvas(ctx, width, h, node);
        if (this.widgetOptions.thickness) {
            ctx.strokeStyle = this.widgetOptions.color;
            const x = this.widgetOptions.marginLeft;
            const y = posY + this.widgetOptions.marginTop;
            const w = width - this.widgetOptions.marginLeft - this.widgetOptions.marginRight;
            ctx.stroke(new Path2D(`M ${x} ${y} h ${w}`));
        }
    }
    computeSize(width) {
        return [
            width,
            this.widgetOptions.marginTop + this.widgetOptions.marginBottom + this.widgetOptions.thickness,
        ];
    }
}
export class RgthreeLabelWidget extends RgthreeBaseWidget {
    constructor(name, widgetOptions) {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = "";
        this.widgetOptions = {};
        this.posY = 0;
        Object.assign(this.widgetOptions, widgetOptions);
    }
    update(widgetOptions) {
        Object.assign(this.widgetOptions, widgetOptions);
    }
    draw(ctx, node, width, posY, height) {
        var _a;
        this.posY = posY;
        ctx.save();
        let text = (_a = this.widgetOptions.text) !== null && _a !== void 0 ? _a : this.name;
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
        }
        else {
            ctx.fillText(text, 15, midY);
        }
        ctx.font = oldFont;
        if (this.widgetOptions.actionLabel === "__PLUS_ICON__") {
            const plus = new Path2D(`M${node.size[0] - 15 - 2} ${posY + 7} v4 h-4 v4 h-4 v-4 h-4 v-4 h4 v-4 h4 v4 h4 z`);
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.fillStyle = "#3a3";
            ctx.strokeStyle = "#383";
            ctx.fill(plus);
            ctx.stroke(plus);
        }
        ctx.restore();
    }
    mouse(event, nodePos, node) {
        if (event.type !== "pointerdown" ||
            isLowQuality() ||
            !this.widgetOptions.actionLabel ||
            !this.widgetOptions.actionCallback) {
            return false;
        }
        const pos = [nodePos[0], nodePos[1] - this.posY];
        const rightX = node.size[0] - 15;
        if (pos[0] > rightX || pos[0] < rightX - 16) {
            return false;
        }
        this.widgetOptions.actionCallback(event);
        return true;
    }
}
export class RgthreeInvisibleWidget extends RgthreeBaseWidget {
    constructor(name, type, value, serializeValueFn) {
        super(name);
        this.type = "custom";
        this.value = value;
        this.serializeValueFn = serializeValueFn;
    }
    draw() {
        return;
    }
    computeSize(width) {
        return [0, 0];
    }
    serializeValue(node, index) {
        return this.serializeValueFn != null
            ? this.serializeValueFn(node, index)
            : super.serializeValue(node, index);
    }
}
