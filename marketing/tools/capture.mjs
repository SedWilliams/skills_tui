#!/usr/bin/env node
// Drive the built app headlessly against a demo HOME and record its ANSI frames.
// Usage: node capture.mjs <out.json>   (run `npm run build` first)
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SKILL_COUNT, buildDemoHome } from "./demo-data.mjs";

process.env.NODE_ENV ??= "production";
process.env.FORCE_COLOR ??= "1";
const { createElement } = await import("react");
const { render: inkRender } = await import("ink");
const { App } = await import("../../dist/app.js");
const { AGENTS, Config } = await import("../../dist/core.js");

// Like ink-testing-library, but its stdout reports the real size. That library fixes the
// width at 100 columns, and Ink drops the gaps in rows wider than the stream it writes to.
class Stdout extends EventEmitter {
  constructor(columns, rows) {
    super();
    Object.assign(this, { columns, rows, lastFrame: "" });
  }
  write = (frame) => { this.lastFrame = frame; };
}
class Stdin extends EventEmitter {
  isTTY = true;
  data = null;
  write = (data) => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

function render(tree, columns, rows) {
  const stdout = new Stdout(columns, rows);
  const stdin = new Stdin();
  const instance = inkRender(tree, { stdout, stderr: new Stdout(columns, rows), stdin,
    debug: true, exitOnCtrlC: false, patchConsole: false });
  return { stdin, lastFrame: () => stdout.lastFrame, unmount: instance.unmount };
}

const KEY = {
  up: "\u001B[A", down: "\u001B[B", end: "\u001B[F",
  enter: "\r", escape: "\u001B", space: " ", ctrlS: "\u0013",
};
const FOUND = `${SKILL_COUNT} skills found`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One app session in a fresh demo HOME. Sessions share process.env.HOME, so run them one at a time. */
async function session(columns, rows) {
  const home = buildDemoHome(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skills-demo-"))));
  process.env.HOME = home;
  const config = new Config(path.join(home, ".config/tui-skills"), [home], path.join(home, ".config/tui-skills/library"),
    Object.fromEntries(Object.entries(AGENTS).map(([agent, paths]) => [agent, path.join(home, paths[0])])));
  const app = render(createElement(App, { config }), columns, rows);
  const ansi = () => app.lastFrame();
  const text = () => stripVTControlCharacters(ansi());
  const s = {
    columns, rows, ansi,
    async press(...keys) {
      for (const key of keys) {
        app.stdin.write(key);
        await sleep(40);
      }
    },
    async waitFor(pattern) {
      for (let i = 0; i < 200; i++) {
        if (typeof pattern === "string" ? text().includes(pattern) : pattern.test(text())) return;
        await sleep(20);
      }
      throw new Error(`Timed out waiting for ${pattern}\n${text()}`);
    },
    /** Move the list cursor down until the preview panel shows this skill. */
    async select(name) {
      for (let i = 0; i < 40; i++) {
        if (text().includes(`─ ${name} ─`)) return;
        await s.press("j");
      }
      throw new Error(`Could not select ${name}`);
    },
    close() {
      app.unmount();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
  return s;
}

async function still(name, columns, rows, steps) {
  const s = await session(columns, rows);
  await s.waitFor(FOUND);
  await steps(s);
  await sleep(60);
  const frame = { name, columns, rows, ansi: s.ansi() };
  s.close();
  return frame;
}

const stills = [
  await still("browse", 110, 32, (s) => s.select("pr-review")),
  await still("small", 80, 24, (s) => s.select("pr-review")),
  await still("search", 110, 32, async (s) => {
    await s.press("/", ..."review");
    await s.waitFor("3 of");
  }),
  await still("filter", 110, 32, async (s) => {
    await s.press("f", ...Array(6).fill(KEY.down));
    await s.waitFor("Filter: ~/Downloads/marketing-skills/skills");
  }),
  await still("invalid", 110, 32, (s) => s.select("meeting-notes")),
  await still("apply", 110, 32, async (s) => {
    await s.select("seo-audit");
    await s.press("a", KEY.space, KEY.down, KEY.space, KEY.enter);
    await s.waitFor("Claude Code: applied");
  }),
  await still("apply-all", 110, 32, async (s) => {
    await s.select("seo-audit");
    await s.press("a", "A", KEY.enter);
    await s.waitFor("Pi: applied");
  }),
  // With the folder filter on, as in the demo, the two new copies stay out of the list.
  await still("installed", 110, 32, async (s) => {
    await s.press("f", ...Array(6).fill(KEY.down), KEY.enter);
    await s.select("seo-audit");
    await s.press("a", KEY.space, KEY.down, KEY.space, KEY.enter);
    await s.waitFor("Claude Code: applied");
    await s.press(KEY.escape);
    await s.waitFor("Installed Codex, Claude Code");
    await s.waitFor(`${SKILL_COUNT + 2} skills found`);
  }),
  await still("editor", 110, 32, async (s) => {
    await s.select("seo-audit");
    await s.press("e");
    await s.waitFor("─ Edit ");
    await s.press(...Array(13).fill(KEY.down), KEY.end, KEY.enter, ..."- Alt text on every image");
  }),
  await still("trash", 110, 32, async (s) => {
    await s.select("meeting-notes");
    await s.press("x");
    await s.waitFor("entire folder");
    await s.press("y");
    await s.waitFor("Moved");
    await s.press("t");
    await s.waitFor("1 item");
  }),
];

// The animated demo: each frame records how long it stays on screen and the key that produced it.
async function demo() {
  const s = await session(110, 32);
  const frames = [];
  const shot = (ms, key = "") => frames.push({ ansi: s.ansi(), ms, key });
  const step = async (keys, ms, label = "") => {
    await s.press(...[keys].flat());
    shot(ms, label);
  };
  shot(700);
  await s.waitFor(FOUND);
  await sleep(60);
  shot(1700);
  for (const ms of [420, 420, 1000]) await step("j", ms, "j  next skill");
  await step("/", 600, "/  search");
  for (const [i, c] of [..."review"].entries()) await step(c, i === 5 ? 1600 : 120, "/  search");
  await step(KEY.escape, 900, "Esc  clear search");
  await step("f", 650, "f  filter");
  for (let i = 0; i < 6; i++) await step(KEY.down, i === 5 ? 1300 : 240, "↓  preview folder");
  await step(KEY.enter, 600, "Enter  keep filter");
  await step("]", 1100, "]  next folder");
  await step("[", 900, "[  previous folder");
  for (const ms of [380, 380, 1100]) await step("j", ms, "j  next skill");
  await step("a", 1500, "a  apply");
  await step(KEY.space, 650, "Space  toggle Codex");
  await step(KEY.down, 380, "↓  move");
  await step(KEY.space, 850, "Space  toggle Claude Code");
  await s.press(KEY.enter);
  await s.waitFor("Claude Code: applied");
  shot(2400, "Enter  apply");
  await s.press(KEY.escape);
  await s.waitFor("Installed Codex, Claude Code");
  await sleep(120);
  shot(2200, "Esc  close");
  await step("e", 1300, "e  edit SKILL.md");
  for (let i = 0; i < 13; i++) await step(KEY.down, 70, "↓  move");
  await step(KEY.end, 300, "End");
  await step(KEY.enter, 300, "Enter  new line");
  for (const c of "- Alt text on every image") await step(c, 55, "type");
  frames[frames.length - 1].ms = 900;
  await s.press(KEY.ctrlS);
  await s.waitFor("Alt text on every image");
  await s.waitFor(/skills found/);
  await sleep(120);
  shot(3200, "Ctrl+S  save, original backed up");
  s.close();
  return { columns: 110, rows: 32, frames };
}

const out = process.argv[2] ?? "frames.json";
fs.writeFileSync(out, JSON.stringify({ stills, demo: await demo() }));
console.log(`Wrote ${stills.length} stills and a demo to ${out}`);
process.exit(0);
