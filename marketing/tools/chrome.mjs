// Screenshot local HTML with headless Chrome over the DevTools protocol. No dependencies:
// Node 22 ships a WebSocket client.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const CHROME = process.env.CHROME ?? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((file) => fs.existsSync(file));

export async function launch() {
  if (!CHROME) throw new Error("Chrome not found. Set CHROME=/path/to/chrome");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "skills-chrome-"));
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--force-color-profile=srgb",
    "--allow-file-access-from-files", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = "";
    proc.stderr.on("data", (d) => {
      log += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (m) resolve(m[1]);
    });
    proc.on("exit", (code) => reject(new Error(`Chrome exited with ${code}\n${log}`)));
  });

  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id !== undefined) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
      else resolve(msg.result);
    } else {
      for (const w of [...waiters]) if (w.method === msg.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const event = (method) => new Promise((resolve) => waiters.push({ method, resolve }));

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page("Page.enable");

  return {
    /** Load `file` at width×height CSS px and write a PNG at `scale` device pixels per px. */
    async shot(file, out, { width, height, scale = 1, transparent = false }) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
      await page("Emulation.setDefaultBackgroundColorOverride",
        transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
      const loaded = event("Page.loadEventFired");
      await page("Page.navigate", { url: pathToFileURL(file).href });
      await loaded;
      await page("Runtime.evaluate", {
        expression: "document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))))"
          + ".then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))",
        awaitPromise: true,
      });
      const { data } = await page("Page.captureScreenshot", {
        format: "png", clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: false,
      });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(data, "base64"));
    },
    async close() {
      ws.close();
      const exited = new Promise((resolve) => proc.once("exit", resolve));
      proc.kill();
      await exited;
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
