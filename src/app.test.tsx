import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./app.js";
import { AGENT_NAMES, Config, Store, isSymlink, readSkill } from "./core.js";

const TEXT = "---\nname: example\ndescription: A test skill\n---\n\n# Instructions\n";
const KEY = {
  up: "\u001B[A", down: "\u001B[B", enter: "\r", escape: "\u001B", tab: "\t", backspace: "\u007F",
  pageDown: "\u001B[6~", ctrlS: "\u0013",
};

let tmp: string;
let config: Config;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tui-skills-app-")));
  config = new Config(path.join(tmp, "config"), [], path.join(tmp, "library"),
    Object.fromEntries(AGENT_NAMES.map((agent) => [agent, path.join(tmp, agent)])));
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, label: string, frame: () => string | undefined) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await tick(20);
  }
  throw new Error(`Timed out waiting for ${label}\n${frame()}`);
}

function start(size = { columns: 100, rows: 32 }) {
  const app = render(<App config={config} size={size} />);
  const frame = () => stripVTControlCharacters(app.lastFrame() ?? "");
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      app.stdin.write(key);
      await tick();
    }
  };
  const waitFor = (text: string | RegExp) => until(
    () => (typeof text === "string" ? frame().includes(text) : text.test(frame())), String(text), frame);
  return { app, frame, press, waitFor };
}

describe("app", () => {
  it("searches, edits, applies, removes, and restores", async () => {
    const dir = new Store(config).create(TEXT);
    const { app, frame, press, waitFor } = start();
    await waitFor("1 skills found");
    expect(frame()).toContain("Skills · 1");
    expect(frame()).toContain("Instructions");

    await press("/", "missing");
    await waitFor("No matching skills");
    await press(KEY.escape);
    await waitFor("Skills · 1");

    await press("e");
    await waitFor("─ Edit ");
    await press(KEY.pageDown, "Edited", KEY.ctrlS);
    await waitFor("1 skills found");
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toMatch(/Edited$/);

    await press("a");
    await waitFor("Apply example");
    await press(" ", KEY.enter);
    await waitFor("Codex: applied to");
    expect(fs.existsSync(path.join(config.targets.Codex, "example", "SKILL.md"))).toBe(true);
    await press(KEY.escape);
    await waitFor("Installed Codex");

    await press("x");
    await waitFor("entire folder and all its files");
    await press("y");
    await waitFor("Moved");
    expect(fs.existsSync(dir)).toBe(false);

    await press("t");
    await waitFor("1 item");
    await press(KEY.enter);
    await waitFor("Restored");
    expect(frame()).toContain("Trash is empty.");
    expect(fs.existsSync(path.join(dir, "SKILL.md"))).toBe(true);
    await press(KEY.escape);
    await waitFor("Skills · 1");
    app.unmount();
  });

  it("creates skills, validates settings, and confirms discarding edits", async () => {
    const { app, frame, press, waitFor } = start({ columns: 100, rows: 40 });
    await waitFor("0 skills found");
    await press("n");
    await waitFor("New skill in");
    await press(KEY.pageDown, "x");
    await press(KEY.escape);
    await waitFor("Discard unsaved changes?");
    await press("n");
    await waitFor("New skill in");
    await press(KEY.backspace, KEY.ctrlS);
    await waitFor("1 skills found");
    expect(fs.existsSync(path.join(config.library, "my-skill", "SKILL.md"))).toBe(true);

    await press("c");
    await waitFor("Settings");
    // Break the JSON: the editor stays open and shows the error.
    await press("{", KEY.ctrlS);
    await waitFor("Invalid JSON");
    await press("\u001A", KEY.ctrlS); // Ctrl+Z, then save the original text
    await waitFor("1 skills found");
    expect(fs.existsSync(path.join(config.home, "config.json"))).toBe(true);

    await press("s");
    await waitFor("Scan folders");
    await press(KEY.pageDown, tmp, KEY.ctrlS);
    await waitFor("1 skills found");
    expect(Config.load(config.home).roots).toEqual([tmp]);

    await press("?");
    await waitFor("─ Help ");
    await press(KEY.pageDown, KEY.pageDown);
    await waitFor("Scan warnings");
    await press(KEY.escape);
    await waitFor("Skills · 1");
    expect(frame()).not.toContain("Scan warnings");
    app.unmount();
  });

  it("keeps dialogs open across rescans and uninstalls a link", async () => {
    const source = new Store(config).create(TEXT);
    const dest = new Store(config).install(readSkill(source), config.targets.Pi, "link");
    const { app, press, waitFor } = start();
    await waitFor("Installed Pi ↗");
    await press("a");
    await waitFor("Apply example");
    await waitFor("linked");
    await press(KEY.down, KEY.down, KEY.down, " ", "x");
    await waitFor("Move these installed folders or links to Trash?");
    await press("y");
    await waitFor("Removed");
    expect(isSymlink(dest)).toBe(false);
    expect(fs.existsSync(path.join(source, "SKILL.md"))).toBe(true);
    await press(KEY.escape);
    await waitFor("Not installed at selected targets");
    app.unmount();
  });

  it("fits a small terminal and reports bad project paths", async () => {
    new Store(config).create(TEXT);
    const { app, frame, press, waitFor } = start({ columns: 80, rows: 24 });
    await waitFor("1 skills found");
    for (const line of frame().split("\n")) expect(line.length).toBeLessThanOrEqual(80);
    expect(frame().split("\n").length).toBeLessThanOrEqual(24);
    await press("p", "/definitely/missing", KEY.enter);
    await waitFor("Project directory does not exist");
    app.unmount();
  });
});
