/**
 * Unit tests for src_web/comfyui/power_lora_loader_logic.ts (pure functions, no ComfyUI needed).
 *
 * Run: node --test tests/node/*.test.ts   (Node 23.6+ runs TypeScript by stripping the types)
 *      make check                         (runs these with the other checks)
 */
import {test, describe} from "node:test";
import assert from "node:assert/strict";

import {
  allRowsOnState,
  chooserPrefix,
  commonPrefix,
  computeRowLayout,
  cursorForPart,
  dragStrength,
  hitTestRow,
  isLoraMissing,
  normalizeLoraRowValue,
  parseStrengthInput,
  REMOVE_WIDTH,
  ROW_MARGIN,
  roundStrength,
  serializeLoraRowValue,
  stepStrength,
  STRENGTH_WIDTH,
  type RowLayout,
  type Span,
} from "../../src_web/comfyui/power_lora_loader_logic.ts";

function spans(layout: RowLayout): [string, Span][] {
  const list: [string, Span][] = [
    ["toggle", layout.toggle],
    ["label", layout.label],
    ["strengthDec", layout.strength.dec],
    ["strengthVal", layout.strength.value],
    ["strengthInc", layout.strength.inc],
    ["remove", layout.remove],
  ];
  if (layout.info) list.push(["info", layout.info]);
  if (layout.strengthTwo) {
    list.push(["strengthTwoDec", layout.strengthTwo.dec]);
    list.push(["strengthTwoVal", layout.strengthTwo.value]);
    list.push(["strengthTwoInc", layout.strengthTwo.inc]);
  }
  return list.sort((a, b) => a[1][0] - b[1][0]);
}

describe("computeRowLayout", () => {
  for (const width of [300, 360, 484, 700]) {
    for (const showModelAndClip of [false, true]) {
      for (const showInfo of [false, true]) {
        test(`width ${width}, separate=${showModelAndClip}, info=${showInfo}: parts fit and never overlap`, () => {
          const layout = computeRowLayout(width, 20, {showInfo, showModelAndClip});
          const sorted = spans(layout);
          for (const [name, [x, w]] of sorted) {
            assert.ok(x >= ROW_MARGIN, `${name} starts inside the left margin`);
            assert.ok(x + w <= width - ROW_MARGIN, `${name} ends inside the right margin`);
            assert.ok(w >= 0, `${name} has a width`);
          }
          for (let i = 1; i < sorted.length; i++) {
            const [prevName, [px, pw]] = sorted[i - 1]!;
            const [name, [x]] = sorted[i]!;
            assert.ok(px + pw <= x, `${prevName} overlaps ${name}`);
          }
        });
      }
    }
  }

  test("the label gets the leftover width and the remove button sits at the right edge", () => {
    const layout = computeRowLayout(484, 20, {showInfo: true, showModelAndClip: false});
    assert.deepEqual(layout.toggle, [10, 30]);
    assert.equal(layout.remove[1], REMOVE_WIDTH);
    assert.equal(layout.remove[0] + layout.remove[1], 484 - ROW_MARGIN - 2);
    assert.equal(layout.strength.all[1], STRENGTH_WIDTH);
    assert.ok(layout.label[1] > 250, "a 484px node leaves room for long LoRA names");
  });

  test("separate mode puts the clip strength (strengthTwo) rightmost, model strength left of it", () => {
    const layout = computeRowLayout(484, 20, {showInfo: false, showModelAndClip: true});
    assert.ok(layout.strengthTwo);
    assert.ok(layout.strength.all[0] < layout.strengthTwo!.all[0]);
  });

  test("a very narrow node clamps the label width at 0 instead of going negative", () => {
    const layout = computeRowLayout(150, 20, {showInfo: true, showModelAndClip: true});
    assert.equal(layout.label[1], 0);
  });
});

describe("hitTestRow", () => {
  const layout = computeRowLayout(484, 20, {showInfo: true, showModelAndClip: true});
  const center = ([x, w]: Span) => x + w / 2;

  test("the center of every part hits that part", () => {
    assert.equal(hitTestRow(layout, center(layout.toggle)), "toggle");
    assert.equal(hitTestRow(layout, center(layout.label)), "lora");
    assert.equal(hitTestRow(layout, center(layout.info!)), "info");
    assert.equal(hitTestRow(layout, center(layout.strength.dec)), "strengthDec");
    assert.equal(hitTestRow(layout, center(layout.strength.value)), "strengthVal");
    assert.equal(hitTestRow(layout, center(layout.strength.inc)), "strengthInc");
    assert.equal(hitTestRow(layout, center(layout.strengthTwo!.dec)), "strengthTwoDec");
    assert.equal(hitTestRow(layout, center(layout.strengthTwo!.value)), "strengthTwoVal");
    assert.equal(hitTestRow(layout, center(layout.strengthTwo!.inc)), "strengthTwoInc");
    assert.equal(hitTestRow(layout, center(layout.remove)), "remove");
  });

  test("margins and gaps hit nothing", () => {
    assert.equal(hitTestRow(layout, 2), null);
    assert.equal(hitTestRow(layout, 482), null);
    assert.equal(hitTestRow(layout, layout.remove[0] - 2), null);
  });

  test("cursor: pointer for buttons, ew-resize for draggable values, default elsewhere", () => {
    assert.equal(cursorForPart("toggle"), "pointer");
    assert.equal(cursorForPart("remove"), "pointer");
    assert.equal(cursorForPart("strengthVal"), "ew-resize");
    assert.equal(cursorForPart("strengthTwoVal"), "ew-resize");
    assert.equal(cursorForPart(null), "default");
  });
});

describe("strength maths", () => {
  test("arrow steps are 0.05 and stored with two decimals", () => {
    assert.equal(stepStrength(1, 1), 1.05);
    assert.equal(stepStrength(0.1, 1), 0.15);
    assert.equal(stepStrength(0.05, -1), 0);
    assert.equal(stepStrength(null, 1), 1.05, "a missing strength counts as 1");
  });

  test("dragging measures from the press, ignores small jitter, 0.01 per pixel after it", () => {
    assert.equal(dragStrength(1, 2), 1, "under the 3px threshold nothing changes");
    assert.equal(dragStrength(1, 13), 1.1);
    assert.equal(dragStrength(1, -13), 0.9);
    assert.equal(dragStrength(0.5, 103), 1.5);
  });

  test("roundStrength keeps two decimals", () => {
    assert.equal(roundStrength(0.1 + 0.2), 0.3);
    assert.equal(roundStrength(-0.125), -0.12);
  });

  test("typed values: numbers are accepted as typed, junk is rejected", () => {
    assert.equal(parseStrengthInput("0.123"), 0.123);
    assert.equal(parseStrengthInput(" -1 "), -1);
    assert.equal(parseStrengthInput("abc"), null);
    assert.equal(parseStrengthInput(""), null);
    assert.equal(parseStrengthInput(null), null);
  });
});

describe("widget value", () => {
  test("objects are kept as the same object (ComfyUI's widget store shares the reference)", () => {
    const value = {on: false, lora: "a.safetensors", strength: 0.5, strengthTwo: null};
    assert.equal(normalizeLoraRowValue(value, false), value);
  });

  test("non-objects become a default row; separate mode copies strength into strengthTwo", () => {
    assert.deepEqual(normalizeLoraRowValue(undefined, false), {
      on: true,
      lora: null,
      strength: 1,
      strengthTwo: null,
    });
    assert.deepEqual(normalizeLoraRowValue("x", true), {
      on: true,
      lora: null,
      strength: 1,
      strengthTwo: 1,
    });
    assert.deepEqual(normalizeLoraRowValue(null, false), {
      on: true,
      lora: null,
      strength: 1,
      strengthTwo: null,
    });
  });

  test("single mode sends no strengthTwo (Python then uses strength for clip)", () => {
    const sent = serializeLoraRowValue(
      {on: true, lora: "a", strength: 0.7, strengthTwo: 0.2},
      false,
    );
    assert.deepEqual(sent, {on: true, lora: "a", strength: 0.7});
    assert.ok(!("strengthTwo" in sent));
  });

  test("separate mode always sends a numeric strengthTwo", () => {
    assert.deepEqual(
      serializeLoraRowValue({on: false, lora: "a", strength: 0.7, strengthTwo: null}, true),
      {
        on: false,
        lora: "a",
        strength: 0.7,
        strengthTwo: 1,
      },
    );
    assert.equal(
      serializeLoraRowValue({on: true, lora: "a", strength: 1, strengthTwo: 0}, true).strengthTwo,
      0,
    );
  });

  test("serializing never mutates the stored value", () => {
    const value = {on: true, lora: "a", strength: 1, strengthTwo: 0.4};
    serializeLoraRowValue(value, false);
    assert.equal(value.strengthTwo, 0.4);
  });
});

describe("toggle-all state", () => {
  test("all on / all off / mixed / empty", () => {
    assert.equal(allRowsOnState([true, true]), true);
    assert.equal(allRowsOnState([false, false]), false);
    assert.equal(allRowsOnState([true, false]), null);
    assert.equal(
      allRowsOnState([]),
      true,
      "no rows counts as on, like the original allLorasState()",
    );
    assert.equal(allRowsOnState([true, undefined]), null, "a malformed value is treated as mixed");
  });
});

describe("chooser helpers", () => {
  test("commonPrefix", () => {
    assert.equal(commonPrefix(["sdxl/a.safetensors", "sdxl/b.safetensors"]), "sdxl/");
    assert.equal(commonPrefix(["a", "b"]), "");
    assert.equal(commonPrefix(["only/one.safetensors"]), "only/one.safetensors");
    assert.equal(commonPrefix([]), "");
  });

  test("chooserPrefix never turns a name into an empty menu entry", () => {
    assert.equal(chooserPrefix(["sdxl/a.safetensors", "sdxl/b.safetensors"]), "sdxl/");
    assert.equal(
      chooserPrefix(["sdxl/only.safetensors"]),
      "sdxl/",
      "one match keeps its file name",
    );
    assert.equal(chooserPrefix(["only.safetensors"]), "");
    assert.equal(chooserPrefix(["style", "style_v2"]), "", "one name is a prefix of another");
    assert.equal(chooserPrefix(["win\\x\\a.st", "win\\x\\a.st"]), "win\\x\\");
    assert.equal(chooserPrefix([]), "");
  });

  test("isLoraMissing only says yes when the list is loaded and lacks the file", () => {
    const available = new Set(["a.safetensors"]);
    assert.equal(isLoraMissing("a.safetensors", available), false);
    assert.equal(isLoraMissing("gone.safetensors", available), true);
    assert.equal(isLoraMissing("gone.safetensors", null), false, "unknown until loaded");
    assert.equal(isLoraMissing(null, available), false);
    assert.equal(isLoraMissing("None", available), false);
  });
});
