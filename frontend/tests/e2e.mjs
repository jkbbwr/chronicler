#!/usr/bin/env bun
// End-to-end smoke tests for Chronicler.
//
// Boots the dev stack (vite + electron + rust backend), attaches to the
// renderer over CDP, points the app at a temp project, and exercises the
// paths that have regressed before: typing stability, autosave, external
// file changes, search, and session restore.
//
// Usage: bun frontend/tests/e2e.mjs   (from the repo root or frontend/)
// Requires ports 5173 and 9223 to be free.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CDP = "http://127.0.0.1:9223";
const frontendDir = path.resolve(import.meta.dir, "..");

const results = [];
let ws = null;
let devProc = null;
let msgId = 0;
const pending = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`evaluate failed: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ""}`);
  }
  return res.result.value;
}

async function waitFor(description, fn, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${description}`);
}

function step(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function connect() {
  await waitFor("CDP endpoint", async () => {
    try {
      const r = await fetch(`${CDP}/json/version`);
      return r.ok;
    } catch {
      return false;
    }
  }, 60000);

  let pageWsUrl = null;
  await waitFor("renderer page target", async () => {
    const targets = await (await fetch(`${CDP}/json`)).json();
    const page = targets.find((t) => t.type === "page" && t.url.includes("localhost:5173"));
    if (page) pageWsUrl = page.webSocketDebuggerUrl;
    return !!page;
  }, 60000);

  ws = new WebSocket(pageWsUrl);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP websocket failed"));
  });
  await send("Runtime.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // The page target exists before the preload bridge does
  await waitFor("chronicler bridge ready", async () => {
    try {
      return await evaluate("!!window.chronicler");
    } catch {
      return false;
    }
  }, 60000);
}

async function main() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "chronicler-e2e-"));
  fs.writeFileSync(path.join(project, "Alpha.md"), "# Alpha\n\nThe dragon slept.\n");

  devProc = spawn("bun", ["run", "dev"], {
    cwd: frontendDir,
    stdio: "ignore",
    detached: true,
  });

  try {
    await connect();

    // -- Open the temp project through the app's own flow
    await evaluate(`window.chronicler.openProject(${JSON.stringify(project)})`);
    await waitFor("binder shows Alpha", async () =>
      (await evaluate(`[...document.querySelectorAll('.file-item')].some(e => e.textContent.includes('Alpha'))`)));
    step("open project via IPC", true);

    // -- Open the file and type; characters must land in order with focus kept
    await evaluate(`(() => {
      const el = [...document.querySelectorAll('.file-item')].find(e => e.textContent.includes('Alpha'));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await waitFor("editor open", async () => (await evaluate(`!!document.querySelector('.cm-content')`)));
    await evaluate(`document.querySelector('.cm-content').focus()`);
    for (const ch of "typed by e2e ") {
      await send("Input.insertText", { text: ch });
      await sleep(20);
    }
    const typing = await evaluate(`JSON.stringify({
      focus: !!document.activeElement.closest('.cm-editor'),
      content: document.querySelector('.cm-content').textContent,
    })`);
    const t = JSON.parse(typing);
    step("typing keeps focus and order", t.focus && t.content.includes("typed by e2e "), t.content.slice(0, 40));

    // -- Autosave reaches disk
    await waitFor("autosave", async () =>
      fs.readFileSync(path.join(project, "Alpha.md"), "utf8").includes("typed by e2e "), 8000);
    step("autosave writes to disk", true);

    // -- External change reloads a clean buffer
    fs.writeFileSync(path.join(project, "Alpha.md"), "# Alpha\n\nEXTERNAL EDIT\n");
    await waitFor("external reload", async () =>
      (await evaluate(`document.querySelector('.cm-content').textContent`)).includes("EXTERNAL EDIT"), 8000);
    step("file watcher reloads clean buffer", true);

    // -- Project search finds content
    const search = await evaluate(`window.chronicler.invoke('project/search', { query: 'external' }).then(r => JSON.stringify(r.results))`);
    const hits = JSON.parse(search);
    step("project search", hits.length === 1 && hits[0].file === "Alpha.md", `hits=${hits.length}`);

    // -- Session restore across reload
    await evaluate(`location.reload()`);
    await sleep(2500);
    await connect(); // reload drops the CDP target; reattach
    await waitFor("session restored", async () =>
      (await evaluate(`[...document.querySelectorAll('.tab')].map(t => t.textContent).join()`)).includes("Alpha.md"));
    step("session restores open tabs", true);
  } catch (err) {
    step("(aborted)", false, String(err.message ?? err));
  } finally {
    try { ws?.close(); } catch {}
    if (devProc?.pid) {
      try { process.kill(-devProc.pid, "SIGTERM"); } catch {}
    }
    await sleep(1000);
    fs.rmSync(project, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
