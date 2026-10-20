#!/usr/bin/env node
/**
 * Makes the published ComfyUI frontend typings usable for rgthree-comfy type checks.
 *
 * Why: `@comfyorg/comfyui-frontend-types` declares the LiteGraph types (LGraphNode, Vector2, ...)
 * but does not export them, so `import type {LGraphNode} from "@comfyorg/frontend"` fails and tsc
 * reports ~1200 errors on a clean `npm ci`. Upstream works around this by editing the file by hand
 * (see commit 20f3c0e: "manually changing typedefs to export what we need").
 *
 * What: this script does the same edit reproducibly. It collects every name that `src_web` imports
 * from "@comfyorg/frontend", keeps the ones the typings declare but do not export, and appends one
 * `export type { ... }` block plus one interface merge (marked so it is only added once). It only
 * touches node_modules; re-run it after every `npm ci`.
 *
 * Usage: node scripts/patch-frontend-types.mjs [--check]
 *   --check  Report what would be added, without writing.
 */
import {readFileSync, writeFileSync, readdirSync, statSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES_FILE = join(ROOT, "node_modules/@comfyorg/comfyui-frontend-types/index.d.ts");
const MARKER = "// [rgthree-comfy dev] exports added by scripts/patch-frontend-types.mjs";
const checkOnly = process.argv.includes("--check");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// 1. Names imported from "@comfyorg/frontend" anywhere in src_web.
const imported = new Set();
const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@comfyorg\/frontend["']/g;
for (const file of walk(join(ROOT, "src_web"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(importRe)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
      if (name) imported.add(name);
    }
  }
}

let types = readFileSync(TYPES_FILE, "utf8");
const alreadyPatched = types.includes(MARKER);
if (alreadyPatched) {
  // Remove our previous block so the list is recomputed from the current sources.
  types = types.slice(0, types.indexOf(MARKER)).replace(/\s+$/, "\n");
}

// 2. Which of those are declared but not exported.
const isDeclared = (n) =>
  new RegExp(`^\\s*(?:export\\s+)?declare\\s+(?:abstract\\s+)?(?:class|interface|type|const|enum|function|namespace)\\s+${n}\\b`, "m").test(types);
const isExported = (n) =>
  new RegExp(`^\\s*export\\s+declare\\s+(?:abstract\\s+)?(?:class|interface|type|const|enum|function|namespace)\\s+${n}\\b`, "m").test(types) ||
  new RegExp(`^\\s*export\\s*(?:type\\s*)?\\{[^}]*\\b${n}\\b[^}]*\\}`, "m").test(types);

const toExport = [...imported].filter((n) => isDeclared(n) && !isExported(n)).sort();
const missing = [...imported].filter((n) => !isDeclared(n) && !isExported(n)).sort();

console.log(`[patch-frontend-types] ${imported.size} names imported from "@comfyorg/frontend"`);
console.log(`[patch-frontend-types] exporting ${toExport.length}: ${toExport.join(", ")}`);
if (missing.length) {
  console.log(`[patch-frontend-types] not declared in typings (left as-is): ${missing.join(", ")}`);
}
if (checkOnly) process.exit(0);

// `export type {}` keeps value-vs-type usage honest: these are only used as types by rgthree, and
// the runtime values come from the global LiteGraph objects.
// rgthree reads ComfyUI's private Symbol keys off `slot.widget` (utils_deprecated_comfyui.ts). The
// typings have no symbol index there, so merge one in (interface merging, same module scope).
const augment = `interface IWidgetLocator {\n  [key: symbol]: any;\n}\n`;
const block = `\n${MARKER}\nexport type { ${toExport.join(", ")} };\n${augment}`;
writeFileSync(TYPES_FILE, types + block, "utf8");
console.log(`[patch-frontend-types] ${alreadyPatched ? "updated" : "patched"} ${TYPES_FILE}`);
