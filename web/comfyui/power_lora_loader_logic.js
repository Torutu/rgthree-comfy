export const DEFAULT_LORA_ROW_VALUE = {
    on: true,
    lora: null,
    strength: 1,
    strengthTwo: null,
};
export const ROW_MARGIN = 10;
export const ROW_GAP = 4;
export const STRENGTH_ARROW_WIDTH = 14;
export const STRENGTH_VALUE_WIDTH = 34;
export const STRENGTH_WIDTH = STRENGTH_ARROW_WIDTH * 2 + STRENGTH_VALUE_WIDTH;
export const REMOVE_WIDTH = 18;
export const STRENGTH_STEP = 0.05;
export const STRENGTH_PER_PIXEL = 0.01;
export const DRAG_THRESHOLD_PX = 3;
function strengthAt(x) {
    return {
        dec: [x, STRENGTH_ARROW_WIDTH],
        value: [x + STRENGTH_ARROW_WIDTH, STRENGTH_VALUE_WIDTH],
        inc: [x + STRENGTH_ARROW_WIDTH + STRENGTH_VALUE_WIDTH, STRENGTH_ARROW_WIDTH],
        all: [x, STRENGTH_WIDTH],
    };
}
export function computeRowLayout(width, height, options) {
    const toggle = [ROW_MARGIN, height * 1.5];
    const remove = [width - ROW_MARGIN - REMOVE_WIDTH - 2, REMOVE_WIDTH];
    let right = remove[0] - ROW_GAP;
    let strengthTwo = null;
    if (options.showModelAndClip) {
        strengthTwo = strengthAt(right - STRENGTH_WIDTH);
        right -= STRENGTH_WIDTH + ROW_GAP;
    }
    const strength = strengthAt(right - STRENGTH_WIDTH);
    right -= STRENGTH_WIDTH + ROW_GAP;
    let info = null;
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
function inSpan(x, span) {
    return span != null && x >= span[0] && x <= span[0] + span[1];
}
export function hitTestRow(layout, x) {
    if (inSpan(x, layout.remove))
        return "remove";
    if (layout.strengthTwo) {
        if (inSpan(x, layout.strengthTwo.dec))
            return "strengthTwoDec";
        if (inSpan(x, layout.strengthTwo.value))
            return "strengthTwoVal";
        if (inSpan(x, layout.strengthTwo.inc))
            return "strengthTwoInc";
    }
    if (inSpan(x, layout.strength.dec))
        return "strengthDec";
    if (inSpan(x, layout.strength.value))
        return "strengthVal";
    if (inSpan(x, layout.strength.inc))
        return "strengthInc";
    if (inSpan(x, layout.info))
        return "info";
    if (inSpan(x, layout.toggle))
        return "toggle";
    if (inSpan(x, layout.label))
        return "lora";
    return null;
}
export function cursorForPart(part) {
    if (part === "strengthVal" || part === "strengthTwoVal")
        return "ew-resize";
    return part ? "pointer" : "default";
}
export function roundStrength(value) {
    return Math.round(value * 100) / 100;
}
export function stepStrength(value, direction) {
    return roundStrength((value !== null && value !== void 0 ? value : 1) + STRENGTH_STEP * direction);
}
export function dragStrength(startValue, deltaX) {
    if (Math.abs(deltaX) < DRAG_THRESHOLD_PX)
        return startValue;
    const travel = deltaX - Math.sign(deltaX) * DRAG_THRESHOLD_PX;
    return roundStrength(startValue + travel * STRENGTH_PER_PIXEL);
}
export function parseStrengthInput(text) {
    const trimmed = String(text !== null && text !== void 0 ? text : "").trim();
    if (!trimmed)
        return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
}
export function normalizeLoraRowValue(value, showModelAndClip) {
    if (value != null && typeof value === "object") {
        return value;
    }
    const fresh = { ...DEFAULT_LORA_ROW_VALUE };
    if (showModelAndClip)
        fresh.strengthTwo = fresh.strength;
    return fresh;
}
export function serializeLoraRowValue(value, showModelAndClip) {
    const { strengthTwo, ...rest } = value;
    return showModelAndClip ? { ...rest, strengthTwo: strengthTwo !== null && strengthTwo !== void 0 ? strengthTwo : 1 } : rest;
}
export function allRowsOnState(onValues) {
    let allOn = true;
    let allOff = true;
    for (const on of onValues) {
        allOn = allOn && on === true;
        allOff = allOff && on === false;
        if (!allOn && !allOff)
            return null;
    }
    return allOn;
}
export function commonPrefix(values) {
    if (!values.length)
        return "";
    let prefix = values[0];
    for (const value of values) {
        let i = 0;
        while (i < prefix.length && prefix[i] === value[i])
            i++;
        prefix = prefix.slice(0, i);
        if (!prefix)
            break;
    }
    return prefix;
}
export function chooserPrefix(values) {
    const prefix = commonPrefix(values);
    if (!values.includes(prefix))
        return prefix;
    const cut = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
    return cut >= 0 ? prefix.slice(0, cut + 1) : "";
}
export function isLoraMissing(lora, available) {
    if (!lora || lora === "None" || !available)
        return false;
    return !available.has(lora);
}
