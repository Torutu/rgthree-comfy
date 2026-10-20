/**
 * End-to-end check of the Power Lora Loader in a real ComfyUI frontend, in both renderers
 * (Nodes 2.0 / Vue nodes, and the classic LiteGraph canvas), using real mouse events.
 *
 * It clears the graph and switches the "Comfy.VueNodes.Enabled" setting, so it refuses to talk to
 * a ComfyUI that wasn't started from a sandbox base directory (see `make sandbox`).
 *
 * Run on Windows (Node 22+, Edge or Chrome):
 *   node tests/e2e/power_lora_loader.e2e.mjs --url http://127.0.0.1:8288 [--mode vue|classic|both]
 *        [--out <dir for results.json and screenshots>] [--browser <path to msedge.exe/chrome.exe>]
 * Or: make e2e   (starts nothing; expects `make sandbox` to be running)
 */
import {writeFileSync, appendFileSync, mkdirSync, existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {launchBrowser, sleep} from "./cdp.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? true : all[i + 1]]] : acc), []),
);
const URL_BASE = String(args.url || "http://127.0.0.1:8288").replace(/\/$/, "");
const MODES = args.mode === "vue" ? ["vue"] : args.mode === "classic" ? ["classic"] : ["vue", "classic"];
const OUT = String(args.out || join(tmpdir(), "rgthree-e2e-out"));
const BROWSER =
  args.browser ||
  ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((p) => existsSync(p));
const NODE_TYPE = "Power Lora Loader (rgthree)";

mkdirSync(OUT, {recursive: true});
const results = [];
const PROGRESS = join(OUT, "progress.log");
writeFileSync(PROGRESS, "");
function record(mode, name, pass, details) {
  results.push({mode, name, pass, details});
  const line = `${pass ? "PASS" : "FAIL"}  [${mode}] ${name}${details ? "  " + JSON.stringify(details) : ""}`;
  console.log(line);
  appendFileSync(PROGRESS, line + "\n");
}

// ---- Safety: only run against a sandbox server -------------------------------------------------
const stats = await (await fetch(`${URL_BASE}/system_stats`)).json();
const argv = (stats.system?.argv || []).join(" ");
if (!/--base-directory\s+\S*rgthree-comfy-dev/i.test(argv) && !args["allow-any-server"]) {
  console.error(`Refusing: ${URL_BASE} was not started with a sandbox --base-directory (argv: ${argv}).`);
  process.exit(2);
}

const page = await launchBrowser({browserPath: BROWSER, port: 9333, profileDir: join(tmpdir(), "rgthree-e2e-profile")});
await page.send("Page.enable");
await page.send("Runtime.enable");
const consoleErrors = [];
page.on((m) => {
  if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails?.exception?.description?.split("\n").slice(0, 4).join(" | "));
  // A native dialog (e.g. "leave site?") would block every later command; accept it.
  if (m.method === "Page.javascriptDialogOpening") page.send("Page.handleJavaScriptDialog", {accept: true}).catch(() => {});
});

async function openApp() {
  await page.send("Page.navigate", {url: URL_BASE + "/"});
  await page.waitFor(`!!(window.app && app.graph && window.LiteGraph && LiteGraph.registered_node_types?.[${JSON.stringify(NODE_TYPE)}])`, {timeout: 90000});
  await sleep(1500);
}

/** Page-side helpers, installed after every load. */
const HELPERS = `
window.__e2e = {
  rows() { return __pll.widgets.filter((w) => w.name?.startsWith("lora_")); },
  w(name) { return __pll.widgets.find((w) => w.name === name); },
  nodeEl() { return document.querySelector('[data-node-id="' + __pll.id + '"]'); },
  canvases() { const el = this.nodeEl(); return el ? [...el.querySelectorAll("canvas")] : []; },
  canvasOf(name) { const i = __pll.widgets.findIndex((w) => w.name === name); return this.canvases()[i] || null; },
  bounds(name, part) { const b = this.w(name)?.hitAreas?.[part]?.bounds; return b && b[1] > 0 ? [b[0], b[1]] : null; },
  // Screen point (CSS px) at the middle of a widget part.
  point(name, part, dx = 0) {
    const b = this.bounds(name, part); if (!b) return null;
    const localX = b[0] + b[1] / 2 + dx;
    if (LiteGraph.vueNodesMode) {
      const c = this.canvasOf(name); const r = c.getBoundingClientRect();
      return [r.left + localX * (r.width / c.clientWidth), r.top + r.height / 2];
    }
    const w = this.w(name); const h = w.computedHeight || LiteGraph.NODE_WIDGET_HEIGHT;
    const p = app.canvas.ds.convertOffsetToCanvas([__pll.pos[0] + localX, __pll.pos[1] + (w.last_y || w.y) + h / 2]);
    const r = app.canvas.canvas.getBoundingClientRect();
    return [r.left + p[0], r.top + p[1]];
  },
  // A fingerprint of what a widget currently shows.
  pixels(name) {
    if (LiteGraph.vueNodesMode) { const c = this.canvasOf(name); return c ? c.toDataURL() : null; }
    const w = this.w(name); const h = w.computedHeight || LiteGraph.NODE_WIDGET_HEIGHT;
    const p = app.canvas.ds.convertOffsetToCanvas([__pll.pos[0], __pll.pos[1] + (w.last_y || w.y)]);
    const dpr = window.devicePixelRatio || 1;
    const d = app.canvas.canvas.getContext("2d").getImageData(p[0] * dpr, p[1] * dpr, __pll.size[0] * dpr, h * dpr).data;
    let hash = 0; for (let i = 0; i < d.length; i += 7) hash = (hash * 31 + d[i]) | 0; return String(hash);
  },
  cursorAt(name) { const c = LiteGraph.vueNodesMode ? this.canvasOf(name) : app.canvas.canvas; return c ? getComputedStyle(c).cursor : null; },
  // Where a part is *drawn* on screen, from the width the row was laid out with (works whatever
  // units the build draws in), so clicking here tests that hit areas match the visuals.
  drawnPoint(name, part) {
    const w = this.w(name); const b = w?.hitAreas?.[part]?.bounds; if (!b || b[1] <= 0) return null;
    if (!LiteGraph.vueNodesMode) return this.point(name, part);
    const c = this.canvasOf(name); const r = c.getBoundingClientRect();
    const drawnW = w.layout ? w.layout.remove[0] + w.layout.remove[1] + 12 : c.clientWidth;
    return [r.left + (b[0] + b[1] / 2) * (r.width / drawnW), r.top + r.height / 2];
  },
  // Nodes 2.0: on-screen height of a widget's canvas vs. the slot ComfyUI reserved for it.
  fit(name) { const c = this.canvasOf(name); if (!c) return null; const r = c.getBoundingClientRect(); const p = c.parentElement.getBoundingClientRect(); return {canvas: +r.height.toFixed(1), slot: +p.height.toFixed(1), ratio: +(r.height / p.height).toFixed(3)}; },
  // Nodes 2.0: which widgets still repaint when asked (are bound to ComfyUI's canvas component).
  unbound() { return __pll.widgets.filter((w) => { let calls = 0; const o = w.draw; w.draw = function (...a) { calls++; return o.apply(this, a); }; try { w.triggerDraw?.(); } finally { w.draw = o; } return !calls; }).map((w) => w.name); },
};
true`;

async function setupNode(rows) {
  await page.eval(`(async () => {
    app.graph.clear();
    const n = LiteGraph.createNode(${JSON.stringify(NODE_TYPE)});
    n.pos = [220, 200];
    app.graph.add(n);
    window.__pll = n;
    for (const lora of ${JSON.stringify(rows)}) n.addNewLoraWidget(lora);
    n.setSize([480, Math.max(n.size[1], n.computeSize()[1])]);
    app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0];
    app.canvas.setDirty(true, true);
    return n.id;
  })()`);
  await page.eval(HELPERS);
  if (await page.eval("LiteGraph.vueNodesMode")) {
    await page.waitFor("__e2e.canvases().length === __pll.widgets.length", {timeout: 10000});
  }
  await sleep(500);
}

async function nodeScreenshot(file) {
  const rect = await page.eval(`(() => {
    if (LiteGraph.vueNodesMode) { const r = __e2e.nodeEl().getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }
    const p = app.canvas.ds.convertOffsetToCanvas([__pll.pos[0], __pll.pos[1] - LiteGraph.NODE_TITLE_HEIGHT]);
    const r = app.canvas.canvas.getBoundingClientRect();
    return [r.left + p[0], r.top + p[1], __pll.size[0] * app.canvas.ds.scale, (__pll.size[1] + LiteGraph.NODE_TITLE_HEIGHT) * app.canvas.ds.scale];
  })()`);
  const png = await page.screenshot({x: rect[0] - 12, y: rect[1] - 12, width: rect[2] + 24, height: rect[3] + 24});
  writeFileSync(join(OUT, file), png);
}

const click = async (pt, opts) => { await page.click(pt[0], pt[1], opts); await sleep(250); };

async function runSuite(mode) {
  await setupNode(["sandbox_anime.safetensors", "sandbox_detail.safetensors", "gone_missing.safetensors"]);
  const isNew = await page.eval("typeof __e2e.w('lora_1').getCursorAt === 'function'");
  record(mode, "code under test", true, {build: isNew ? "redesigned" : "original", vueNodesMode: await page.eval("!!LiteGraph.vueNodesMode")});
  await nodeScreenshot(`${mode}-1-initial.png`);

  // 1. Cursor over the toggle / value / gap.
  for (const [part, expected] of [["toggle", "pointer"], ["strengthVal", "ew-resize"], ["lora", "pointer"]]) {
    const pt = await page.eval(`__e2e.point("lora_1", ${JSON.stringify(part)})`);
    await page.move(pt[0], pt[1]);
    await sleep(120);
    const cursor = await page.eval(`__e2e.cursorAt("lora_1")`);
    record(mode, `cursor over ${part}`, mode === "classic" ? true : cursor === expected, {cursor, expected: mode === "classic" ? "(LiteGraph decides)" : expected});
  }

  // 2. Toggling a row flips the value AND repaints immediately.
  {
    const before = await page.eval(`({on: __e2e.w("lora_1").value.on, px: __e2e.pixels("lora_1")})`);
    await click(await page.eval(`__e2e.point("lora_1", "toggle")`));
    const after = await page.eval(`({on: __e2e.w("lora_1").value.on, px: __e2e.pixels("lora_1")})`);
    record(mode, "toggle flips value", before.on !== after.on, {before: before.on, after: after.on});
    record(mode, "toggle repaints without reload", before.px !== after.px, {repainted: before.px !== after.px});
    await nodeScreenshot(`${mode}-2-after-toggle.png`);
  }

  // 3. Toggle all from the header.
  {
    const before = await page.eval(`__e2e.rows().map((r) => r.value.on)`);
    const px = await page.eval(`__e2e.pixels("lora_1")`);
    await click(await page.eval(`__e2e.point("PowerLoraLoaderHeaderWidget", "toggle")`));
    const after = await page.eval(`__e2e.rows().map((r) => r.value.on)`);
    const px2 = await page.eval(`__e2e.pixels("lora_1")`);
    record(mode, "toggle all sets every row", after.every((v) => v === after[0]) && JSON.stringify(before) !== JSON.stringify(after), {before, after});
    record(mode, "toggle all repaints the rows", px !== px2, {repainted: px !== px2});
  }

  // 4. Arrow step.
  {
    await page.eval(`(__e2e.w("lora_2").value.strength = 1, true)`);
    const px = await page.eval(`__e2e.pixels("lora_2")`);
    await click(await page.eval(`__e2e.point("lora_2", "strengthInc")`));
    const v = await page.eval(`__e2e.w("lora_2").value.strength`);
    const px2 = await page.eval(`__e2e.pixels("lora_2")`);
    record(mode, "arrow adds 0.05", v === 1.05, {strength: v});
    record(mode, "arrow repaints", px !== px2, {repainted: px !== px2});
  }

  // 5. Drag on the value.
  {
    await page.eval(`(__e2e.w("lora_2").value.strength = 1, true)`);
    const pt = await page.eval(`__e2e.point("lora_2", "strengthVal")`);
    await page.drag(pt[0], pt[1], pt[0] + 63, 9);
    await sleep(250);
    const v = await page.eval(`__e2e.w("lora_2").value.strength`);
    record(mode, "drag +63px gives +0.60 (0.01/px after a 3px dead zone)", v === 1.6, {strength: v});
  }

  // 6. Click the value and type one.
  {
    await click(await page.eval(`__e2e.point("lora_2", "strengthVal")`));
    const dialog = await page.waitFor(`!!document.querySelector(".graphdialog input")`, {timeout: 3000}).catch(() => false);
    if (dialog) {
      await page.eval(`(() => { const i = document.querySelector(".graphdialog input"); i.focus(); i.select(); return true; })()`);
      await page.type("0.7");
      await page.key("Enter", "\r");
      await sleep(250);
    }
    const v = await page.eval(`__e2e.w("lora_2").value.strength`);
    record(mode, "click value opens prompt; typed 0.7 is stored", dialog && v === 0.7, {dialog: !!dialog, strength: v});
  }

  // 7. Add a row with the button + chooser menu.
  {
    const count = await page.eval(`__e2e.rows().length`);
    const btn = await page.eval(`(() => { const name = "➕ Add Lora"; if (LiteGraph.vueNodesMode) { const c = __e2e.canvasOf(name); const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; } const w = __e2e.w(name); const p = app.canvas.ds.convertOffsetToCanvas([__pll.pos[0] + __pll.size[0] / 2, __pll.pos[1] + (w.last_y || w.y) + 10]); const r = app.canvas.canvas.getBoundingClientRect(); return [r.left + p[0], r.top + p[1]]; })()`);
    await click(btn);
    const menu = await page.waitFor(`!!document.querySelector(".litecontextmenu .litemenu-entry")`, {timeout: 4000}).catch(() => false);
    let added = false;
    if (menu) {
      const entry = await page.eval(`(() => { const e = [...document.querySelectorAll(".litecontextmenu .litemenu-entry")].find((x) => /sandbox_style/.test(x.textContent)); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2]; })()`);
      if (entry) await click(entry);
      await sleep(400);
      added = await page.eval(`__e2e.rows().length === ${count} + 1 && /sandbox_style/.test(__e2e.rows().at(-1).value.lora)`);
    }
    record(mode, "add button + chooser adds a row", !!added, {menu: !!menu, rowsBefore: count, rowsAfter: await page.eval(`__e2e.rows().length`)});
    if (await page.eval("LiteGraph.vueNodesMode")) {
      await page.waitFor("__e2e.canvases().length === __pll.widgets.length", {timeout: 5000}).catch(() => {});
    }
  }

  // 8. Remove with the row's x button: first click arms, second removes.
  {
    const has = await page.eval(`!!__e2e.bounds("lora_3", "remove")`);
    if (!has) {
      record(mode, "row has a remove (x) button", false, {note: "no 'remove' hit area in this build"});
    } else {
      const count = await page.eval(`__e2e.rows().length`);
      const px = await page.eval(`__e2e.pixels("lora_3")`);
      await click(await page.eval(`__e2e.point("lora_3", "remove")`));
      const armed = await page.eval(`({still: !!__e2e.w("lora_3"), px: __e2e.pixels("lora_3")})`);
      await nodeScreenshot(`${mode}-3-remove-armed.png`);
      record(mode, "first x click arms (row stays, repaints red)", armed.still && armed.px !== px, {stillThere: armed.still});
      await click(await page.eval(`__e2e.point("lora_3", "remove")`));
      const after = await page.eval(`({rows: __e2e.rows().length, gone: !__e2e.w("lora_3")})`);
      record(mode, "second x click removes the row", after.gone && after.rows === count - 1, after);
      if (await page.eval("LiteGraph.vueNodesMode")) {
        const domOk = await page.waitFor("__e2e.canvases().length === __pll.widgets.length", {timeout: 5000}).catch(() => false);
        record(mode, "Nodes 2.0 DOM drops the removed row", !!domOk, {});
      }
      // Arm, then let it time out.
      await click(await page.eval(`__e2e.point("lora_2", "remove")`));
      await sleep(3400);
      const stillThere = await page.eval(`!!__e2e.w("lora_2") && __e2e.w("lora_2").removeArmedTimer == null`);
      record(mode, "an armed x disarms after 3 s", stillThere, {});
    }
  }

  // 9. Right-click a row: row actions (incl. Remove) must be reachable.
  {
    await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"})); true`);
    const target = await page.eval(`__e2e.rows()[0].name`);
    const pt = await page.eval(`__e2e.point(${JSON.stringify(target)}, "lora")`);
    await click(pt, {button: "right"});
    await sleep(600);
    // Only the row action ("🗑️ Remove"). The menus also contain the node's own "Remove", which
    // would delete the whole node.
    const item = await page.eval(`(() => {
      const els = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().width > 0 && /^🗑️?\\s*Remove$/u.test(e.textContent.trim()));
      const e = els.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0];
      if (!e) return null; const r = e.getBoundingClientRect(); return {text: e.textContent.trim(), pt: [r.left + r.width / 2, r.top + r.height / 2]};
    })()`);
    const count = await page.eval(`__e2e.rows().length`);
    if (item) {
      await click(item.pt);
      await sleep(400);
    }
    const removed = await page.eval(`!__e2e.w(${JSON.stringify(target)})`);
    record(mode, "right-click a row offers Remove, and it works", !!item && removed, {menuItem: item?.text ?? null, rowsBefore: count, rowsAfter: await page.eval(`__e2e.rows().length`)});
    await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"})); true`);
  }

  // 10. Strength mode + what gets serialized / sent to the backend.
  {
    await page.eval(`(__pll.addNewLoraWidget("sandbox_anime.safetensors"), true)`);
    await page.eval(`(__pll.setProperty("Show Strengths", "Separate Model & Clip"), true)`);
    await sleep(200);
    const sep = await page.eval(`(async () => { const p = await app.graphToPrompt(); return Object.entries(p.output[String(__pll.id)].inputs).filter(([k]) => k.startsWith("lora_")).map(([, v]) => v); })()`);
    record(mode, "separate mode sends strengthTwo for every row", sep.length > 0 && sep.every((v) => typeof v.strengthTwo === "number"), {rows: sep});
    await page.eval(`(__pll.setProperty("Show Strengths", "Single Strength"), true)`);
    const single = await page.eval(`(async () => { const p = await app.graphToPrompt(); return Object.entries(p.output[String(__pll.id)].inputs).filter(([k]) => k.startsWith("lora_")).map(([, v]) => v); })()`);
    record(mode, "single mode sends no strengthTwo", single.every((v) => !("strengthTwo" in v)), {rows: single});
    const wv = await page.eval(`app.graph.serialize().nodes.find((n) => String(n.id) === String(__pll.id)).widgets_values`);
    const shapeOk = JSON.stringify(wv[0]) === "{}" && wv[1]?.type === "PowerLoraLoaderHeaderWidget" && JSON.stringify(wv.at(-2)) === "{}" && wv.at(-1) === "" && wv.slice(2, -2).every((v) => "on" in v && "lora" in v && "strength" in v && "strengthTwo" in v);
    record(mode, "workflow widgets_values keep the original shape", shapeOk, {widgets_values: wv});
  }

  // 11. Load a workflow saved by the original node (same structure as a real saved workflow).
  {
    const saved = {
      last_node_id: 68, last_link_id: 0, version: 0.4, links: [], groups: [], config: {}, extra: {},
      nodes: [{
        id: 68, type: NODE_TYPE, pos: [180, 120], size: [484, 200], flags: {}, order: 0, mode: 0,
        inputs: [{name: "model", type: "MODEL", link: null}, {name: "clip", type: "CLIP", link: null}],
        outputs: [{name: "MODEL", type: "MODEL", links: []}, {name: "CLIP", type: "CLIP", links: []}],
        properties: {"Show Strengths": "Single Strength", Match: "", cnr_id: "rgthree-comfy", ver: "1.0.2512112053"},
        widgets_values: [{}, {type: "PowerLoraLoaderHeaderWidget"},
          {on: false, lora: "sandbox_anime.safetensors", strength: 0.5, strengthTwo: null},
          {on: true, lora: "sandbox_detail.safetensors", strength: 1.1, strengthTwo: null},
          {on: false, lora: "gone_missing.safetensors", strength: 1, strengthTwo: null}, {}, ""],
      }],
    };
    await page.eval(`(async () => { await app.loadGraphData(${JSON.stringify(saved)}); return true; })()`);
    await sleep(800);
    await page.eval(`(window.__pll = app.graph.getNodeById(68), true)`);
    await page.eval(HELPERS);
    const back = await page.eval(`app.graph.serialize().nodes.find((n) => String(n.id) === "68").widgets_values`);
    record(mode, "saved workflow loads and re-saves unchanged", JSON.stringify(back) === JSON.stringify(saved.nodes[0].widgets_values), {back});
    const prompt = await page.eval(`(async () => (await app.graphToPrompt()).output["68"].inputs)()`);
    const loras = Object.entries(prompt).filter(([k]) => k.startsWith("lora_")).map(([, v]) => v);
    record(mode, "its API prompt carries every row (on/off kept)", loras.length === 3 && loras.map((l) => l.on).join() === "false,true,false", {loras});
    await sleep(600);
    await nodeScreenshot(`${mode}-4-loaded-workflow.png`);
  }

  // 12. Zoomed out and in: rows keep their size against the node, and clicks land on what is drawn.
  const vue = await page.eval("!!LiteGraph.vueNodesMode");
  await setupNode(["sandbox_anime.safetensors", "sandbox_detail.safetensors", "gone_missing.safetensors"]);
  for (const [label, deltaY, steps] of [["out", 120, 3], ["in", -120, 7]]) {
    // Empty canvas just left of the node's middle (above the node is ComfyUI's top bar).
    const anchor = await page.eval(`(() => { if (!LiteGraph.vueNodesMode) { const p = app.canvas.ds.convertOffsetToCanvas([__pll.pos[0], __pll.pos[1] + __pll.size[1] / 2]); const r = app.canvas.canvas.getBoundingClientRect(); return [r.left + p[0] - 40, r.top + p[1]]; } const r = __e2e.nodeEl().getBoundingClientRect(); return [r.left - 40, r.top + r.height / 2]; })()`);
    for (let i = 0; i < steps; i++) {
      await page.send("Input.dispatchMouseEvent", {type: "mouseWheel", x: anchor[0], y: anchor[1], deltaX: 0, deltaY, modifiers: 2});
      await sleep(120);
    }
    await sleep(700);
    const zoom = +(await page.eval("app.canvas.ds.scale")).toFixed(2);
    const row = await page.eval(`__e2e.rows()[1].name`);
    const at = (name, part) => page.eval(`__e2e.drawnPoint(${JSON.stringify(name)}, ${JSON.stringify(part)})`);
    // Let a hover repaint happen first (both builds repaint on hover), then aim at the drawing.
    let pt = await at(row, "toggle");
    await page.move(pt[0], pt[1]);
    await sleep(250);
    if (vue) {
      const fit = await page.eval(`__e2e.fit(${JSON.stringify(row)})`);
      record(mode, `zoom ${label} (${zoom}): row canvas matches its slot`, !!fit && fit.ratio > 1 && fit.ratio < 1.2, fit);
      pt = await at(row, "remove");
      await page.move(pt[0], pt[1]);
      await sleep(200);
      const cursor = await page.eval(`__e2e.cursorAt(${JSON.stringify(row)})`);
      record(mode, `zoom ${label} (${zoom}): cursor over the drawn x is a pointer`, cursor === "pointer", {cursor});
    }
    await page.eval(`(__e2e.w(${JSON.stringify(row)}).value.strength = 1, true)`);
    await click(await at(row, "strengthInc"));
    const v = await page.eval(`__e2e.w(${JSON.stringify(row)}).value.strength`);
    record(mode, `zoom ${label} (${zoom}): clicking the drawn arrow adds 0.05`, v === 1.05, {strength: v});
    const last = await page.eval(`__e2e.rows().at(-1).name`);
    if (await page.eval(`!!__e2e.bounds(${JSON.stringify(last)}, "remove")`)) {
      await click(await at(last, "remove"));
      await click(await at(last, "remove"));
      const gone = await page.eval(`!__e2e.w(${JSON.stringify(last)})`);
      record(mode, `zoom ${label} (${zoom}): clicking the drawn x twice removes the row`, gone, {});
      if (gone) {
        await page.eval(`(__pll.addNewLoraWidget("gone_missing.safetensors"), true)`);
        await sleep(400);
      }
    }
    await nodeScreenshot(`${mode}-5-zoom-${label}.png`);
  }

  // 13. configure() on a node that already exists (undo, API-format JSON, other extensions) must
  // keep every widget repainting; it used to leave the header frozen on its last picture.
  if (vue) {
    await setupNode(["sandbox_detail.safetensors"]);
    await page.eval(`(__pll.configure(__pll.serialize()), true)`);
    await sleep(800);
    const unbound = await page.eval(`__e2e.unbound()`);
    record(mode, "configure() on the same node keeps every widget repainting", unbound.length === 0, {unbound});
  }

  // 14. Adding the first LoRA to an empty node (real button + menu) updates the header, which
  // used to keep showing "No LoRAs yet".
  if (vue) {
    await setupNode([]);
    const before = await page.eval(`__e2e.pixels("PowerLoraLoaderHeaderWidget")`);
    const btn = await page.eval(`(() => { const r = __e2e.canvasOf("➕ Add Lora").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await click(btn);
    await page.waitFor(`!!document.querySelector(".litecontextmenu .litemenu-entry")`, {timeout: 4000}).catch(() => {});
    const entry = await page.eval(`(() => { const e = [...document.querySelectorAll(".litecontextmenu .litemenu-entry")].find((x) => /sandbox_anime/.test(x.textContent)); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2]; })()`);
    if (entry) await click(entry);
    await sleep(600);
    const after = await page.eval(`__e2e.pixels("PowerLoraLoaderHeaderWidget")`);
    const rows = await page.eval(`__e2e.rows().length`);
    record(mode, "header repaints when the first LoRA is added", rows === 1 && before !== after, {rows});
    // Any add path (not just the button) and configure() must refresh the header's count.
    const px1 = await page.eval(`__e2e.pixels("PowerLoraLoaderHeaderWidget")`);
    await page.eval(`(__pll.addNewLoraWidget("sandbox_detail.safetensors"), true)`);
    await sleep(300);
    const px2 = await page.eval(`__e2e.pixels("PowerLoraLoaderHeaderWidget")`);
    await page.eval(`(() => { const d = __pll.serialize(); d.widgets_values.splice(2, 0, {on: false, lora: "sandbox_anime.safetensors", strength: 1, strengthTwo: null}); __pll.configure(d); return true; })()`);
    await sleep(500);
    const px3 = await page.eval(`__e2e.pixels("PowerLoraLoaderHeaderWidget")`);
    record(mode, "header repaints after addNewLoraWidget and after configure()", px1 !== px2 && px2 !== px3, {rows: await page.eval(`__e2e.rows().length`)});
  }

  // 15. With the node selected, ComfyUI's side panel shows a second copy of the widgets. Changes
  // made on either copy must repaint the node itself (it used to stay stale until a reload).
  if (vue) {
    await setupNode(["sandbox_anime.safetensors", "sandbox_detail.safetensors"]);
    await page.eval(`(async () => { await app.extensionManager.setting.set("Comfy.RightSidePanel.IsOpen", true); return true; })()`);
    const title = await page.eval(`(() => { const r = __e2e.nodeEl().getBoundingClientRect(); return [r.left + 60, r.top + 12]; })()`);
    await click(title);
    await sleep(1200);
    const copies = await page.eval(`[...document.querySelectorAll("canvas")].filter((c) => c !== app.canvas.canvas && !__e2e.nodeEl().contains(c) && c.clientHeight > 15 && c.clientHeight < 40).length`);
    record(mode, "side panel shows a copy of the rows (setup)", copies >= 2, {copies});
    // a) Toggle on the node itself.
    // Hover first, as a person would; the row then lays out for the node's (wider) canvas.
    const near = await page.eval(`(() => { const r = __e2e.canvasOf("lora_1").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await page.move(near[0], near[1]);
    await sleep(150);
    let before = await page.eval(`__e2e.pixels("lora_1")`);
    let was = await page.eval(`__e2e.w("lora_1").value.on`);
    await click(await page.eval(`__e2e.drawnPoint("lora_1", "toggle")`));
    let after = await page.eval(`__e2e.pixels("lora_1")`);
    const flipped = was !== (await page.eval(`__e2e.w("lora_1").value.on`));
    record(mode, "side panel open: toggling on the node repaints the node", flipped && before !== after, {valueChanged: flipped, repainted: before !== after});
    // b) Toggle the first row in the side panel's copy; the node's canvas must change too.
    const panelPt = await page.eval(`(() => {
      const panel = [...document.querySelectorAll("canvas")].filter((c) => c !== app.canvas.canvas && !__e2e.nodeEl().contains(c) && c.clientHeight > 15 && c.clientHeight < 40);
      const rowIndex = __pll.widgets.filter((w) => w.computeSize === undefined || true).findIndex((w) => w.name === "lora_1");
      const c = panel.find((c, i) => true && c.getBoundingClientRect().top > 0 && panel.indexOf(c) === 1) || panel[1];
      const r = c.getBoundingClientRect();
      return [r.left + 25 * (r.width / c.clientWidth), r.top + r.height / 2];
    })()`);
    before = await page.eval(`__e2e.pixels("lora_1")`);
    was = await page.eval(`__e2e.w("lora_1").value.on`);
    await click(panelPt);
    after = await page.eval(`__e2e.pixels("lora_1")`);
    const changed = was !== (await page.eval(`__e2e.w("lora_1").value.on`));
    record(mode, "side panel open: toggling in the panel repaints the node", changed && before !== after, {valueChanged: changed});
    // c) Back on the node: clicks still land where things are drawn (layout is per canvas).
    await page.eval(`(__e2e.w("lora_2").value.strength = 1, true)`);
    const inc = await page.eval(`__e2e.drawnPoint("lora_2", "strengthInc")`);
    await page.move(inc[0], inc[1]);
    await sleep(150);
    await click(await page.eval(`__e2e.drawnPoint("lora_2", "strengthInc")`));
    record(mode, "side panel open: node arrow still adds 0.05", (await page.eval(`__e2e.w("lora_2").value.strength`)) === 1.05, {strength: await page.eval(`__e2e.w("lora_2").value.strength`)});
    await nodeScreenshot(`${mode}-6-side-panel.png`);
    await page.eval(`(async () => { await app.extensionManager.setting.set("Comfy.RightSidePanel.IsOpen", false); return true; })()`);
  }
}

try {
  for (const mode of MODES) {
    await openApp();
    await page.eval(`(async () => {
      await app.extensionManager.setting.set("Comfy.Window.UnloadConfirmation", false);
      await app.extensionManager.setting.set("Comfy.VueNodes.Enabled", ${mode === "vue"});
      return true;
    })()`);
    await openApp();
    const vue = await page.eval("!!LiteGraph.vueNodesMode");
    if (vue !== (mode === "vue")) {
      record(mode, "renderer switched", false, {vueNodesMode: vue});
      continue;
    }
    try {
      await runSuite(mode);
    } catch (e) {
      record(mode, "suite crashed", false, {error: String(e.message || e)});
    }
  }
} finally {
  // Leave the sandbox in Nodes 2.0 mode (its starting state).
  try { await page.eval(`(async () => { await app.extensionManager.setting.set("Comfy.VueNodes.Enabled", true); return true; })()`); } catch {}
  await page.close();
}
const failed = results.filter((r) => !r.pass).length;
writeFileSync(join(OUT, "results.json"), JSON.stringify({url: URL_BASE, failed, consoleErrors, results}, null, 2));
console.log(`\n${results.length - failed}/${results.length} passed. Page errors: ${consoleErrors.length}. Output: ${OUT}`);
if (consoleErrors.length) console.log(consoleErrors.slice(0, 10).join("\n"));
process.exit(failed ? 1 : 0);
