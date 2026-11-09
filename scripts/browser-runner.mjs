// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting
// Minimal Chromium DevTools harness for testing the actual production worker.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

async function removeProfile(profile) {
  // Verify the absolute generated path before recursive cleanup on Windows.
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith("geolibre-browser-")) {
    throw new Error("Unexpected browser profile path; refusing cleanup.");
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function browserExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const executable = candidates.find((path) => path && existsSync(path));
  if (!executable) throw new Error("Chromium was not found. Set CHROME_BIN to a Chrome/Chromium/Edge executable.");
  return executable;
}

class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.id = 0;
    this.errors = [];
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        const detail = message.params.exceptionDetails;
        this.errors.push(detail.exception?.description || detail.text);
      }
    });
    const disconnected = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Chromium DevTools disconnected."));
      }
      this.pending.clear();
    };
    socket.addEventListener("close", disconnected);
    socket.addEventListener("error", disconnected);
  }

  call(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolveCall, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chromium command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCall, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }
}

/** The page sets { done:true, result } or { done:true, error } at expression. */
export async function runBrowser(url, { expression = "globalThis.__geolibreTest", timeoutMs = 120000, fileInputs = [] } = {}) {
  const profile = await mkdtemp(join(tmpdir(), "geolibre-browser-"));
  let child, socket, devtools;
  let output = "", launchError;
  try {
    child = spawn(browserExecutable(), [
      "--headless=new", "--disable-gpu", "--disable-background-networking",
      "--disable-component-update", "--disable-extensions", "--disable-sync",
      "--no-first-run", "--no-default-browser-check", "--metrics-recording-only",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, "about:blank",
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    child.on("error", (error) => { launchError = error; });
    child.stderr.on("data", (data) => { output = (output + data.toString()).slice(-16384); });
    let port;
    const startupDeadline = Date.now() + Math.min(timeoutMs, 30000);
    while (Date.now() < startupDeadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Chromium exited before startup: ${output}`);
      try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (Number.isInteger(port) && port > 0 && port < 65536) break;
      await pause(100);
    }
    if (!port) throw new Error(`Chromium did not start: ${output}`);
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Chromium target discovery failed: ${response.status}`);
    const target = (await response.json()).find((item) => item.type === "page");
    if (!target?.webSocketDebuggerUrl) throw new Error("Chromium has no page target.");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error("Chromium debugger connection timed out.")), 10000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chromium debugger connection failed.")); }, { once: true });
    });
    devtools = new DevTools(socket);
    await devtools.call("Runtime.enable");
    await devtools.call("Page.enable");
    const navigation = await devtools.call("Page.navigate", { url });
    if (navigation.errorText) throw new Error(`Browser navigation failed: ${navigation.errorText}`);
    for (const { selector, file } of fileInputs) {
      if (!existsSync(file)) throw new Error(`Benchmark file does not exist: ${file}`);
      let nodeId = 0;
      const inputDeadline = Date.now() + 30000;
      while (!nodeId && Date.now() < inputDeadline) {
        const document = await devtools.call("DOM.getDocument", { depth: 0 });
        ({ nodeId } = await devtools.call("DOM.querySelector", { nodeId: document.root.nodeId, selector }));
        if (!nodeId) await pause(100);
      }
      if (!nodeId) throw new Error(`Browser file input was not found: ${selector}`);
      // Chromium selects the original file; the harness never reads/imports all
      // bytes merely to send them to the page or the worker.
      await devtools.call("DOM.setFileInputFiles", { nodeId, files: [resolve(file)] });
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const evaluation = await devtools.call("Runtime.evaluate", { expression, returnByValue: true });
      const state = evaluation.result?.value;
      if (state?.done) {
        if (state.error) throw new Error(state.error);
        return state.result;
      }
      if (devtools.errors.length) throw new Error(devtools.errors.join("\n"));
      await pause(100);
    }
    throw new Error(`Browser test timed out after ${timeoutMs}ms.`);
  } catch (cause) {
    throw new Error(`${cause.message}\n${output}`, { cause });
  } finally {
    if (devtools && socket.readyState === WebSocket.OPEN) {
      try { await devtools.call("Browser.close", {}, 1000); } catch { /* Closing disconnects the socket. */ }
    }
    socket?.close();
    if (child && child.exitCode === null && !launchError) {
      child.kill();
      for (let i = 0; i < 20 && child.exitCode === null; i++) await pause(100);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await removeProfile(profile);
  }
}
