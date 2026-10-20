/**
 * A tiny Chrome DevTools Protocol client for driving a headless Edge/Chrome against ComfyUI.
 * No dependencies: Node 22+ has fetch and WebSocket built in.
 */
import {spawn} from "node:child_process";
import {mkdirSync, rmSync} from "node:fs";
import {setTimeout as sleep} from "node:timers/promises";

export {sleep};

export async function launchBrowser({browserPath, port, profileDir, width = 1600, height = 1000}) {
  rmSync(profileDir, {recursive: true, force: true});
  mkdirSync(profileDir, {recursive: true});
  const proc = spawn(
    browserPath,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "about:blank",
    ],
    {stdio: "ignore"},
  );
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch {}
  }
  if (!target) throw new Error("Browser did not expose a page target");
  const client = await connect(target.webSocketDebuggerUrl);
  client.close = async () => {
    try { client.ws.close(); } catch {}
    proc.kill();
  };
  return client;
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const {resolve, reject} = pending.get(data.id);
      pending.delete(data.id);
      data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result);
    } else if (data.method) {
      for (const l of listeners) l(data);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, {resolve, reject});
      ws.send(JSON.stringify({id, method, params}));
    });
  const client = {
    ws,
    send,
    on: (fn) => listeners.push(fn),
    /** Evaluates an expression (or async IIFE source) in the page and returns its JSON value. */
    async eval(expression) {
      const res = await send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
      if (res.exceptionDetails) {
        throw new Error("Page error: " + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
      }
      return res.result.value;
    },
    async waitFor(expression, {timeout = 30000, interval = 200} = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try {
          const v = await client.eval(expression);
          if (v) return v;
        } catch {}
        await sleep(interval);
      }
      throw new Error("Timed out waiting for: " + expression);
    },
    async mouse(type, x, y, {button = "left", buttons = 0, clickCount = 1} = {}) {
      await send("Input.dispatchMouseEvent", {type, x, y, button, buttons, clickCount, pointerType: "mouse"});
    },
    async move(x, y, buttons = 0) {
      await client.mouse("mouseMoved", x, y, {button: buttons ? "left" : "none", buttons});
    },
    async click(x, y, {button = "left"} = {}) {
      const buttons = button === "right" ? 2 : 1;
      await client.move(x, y);
      await client.mouse("mousePressed", x, y, {button, buttons});
      await client.mouse("mouseReleased", x, y, {button, buttons: 0});
    },
    async drag(x1, y, x2, steps = 8) {
      await client.move(x1, y);
      await client.mouse("mousePressed", x1, y, {button: "left", buttons: 1});
      for (let i = 1; i <= steps; i++) {
        await client.move(x1 + ((x2 - x1) * i) / steps, y, 1);
      }
      await client.mouse("mouseReleased", x2, y, {button: "left", buttons: 0});
    },
    async key(key, text) {
      await send("Input.dispatchKeyEvent", {type: "keyDown", key, text});
      await send("Input.dispatchKeyEvent", {type: "keyUp", key});
    },
    async type(text) {
      await send("Input.insertText", {text});
    },
    async screenshot(clip) {
      const res = await send("Page.captureScreenshot", {format: "png", ...(clip ? {clip: {...clip, scale: 1}} : {})});
      return Buffer.from(res.data, "base64");
    },
  };
  return client;
}
