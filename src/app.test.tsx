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
  up: "\u001B[A", down: "\u001B[B", right: "\u001B[C", left: "\u001B[D", enter: "\r", escape: "\u001B", tab: "\t",
  backspace: "\u007F",
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
  it("filters by folder, tag, and status with a live preview at 80x24", async () => {
    new Store(config).create(TEXT.replace("name: example", "name: campaign")
      .replace("description: A test skill", "description: A test skill\ntags: [Marketing]"));
    const packs = path.join(tmp, "packs");
    for (const [dir, text] of [["alpha/skills/drafting", TEXT.replace("example", "drafting")],
      ["alpha/skills/editing", TEXT.replace("example", "editing")], ["beta/skills/broken", "no frontmatter"]]) {
      fs.mkdirSync(path.join(packs, dir), { recursive: true });
      fs.writeFileSync(path.join(packs, dir, "SKILL.md"), text);
    }
    config.roots.push(packs);
    const { app, frame, press, waitFor } = start({ columns: 80, rows: 24 });
    await waitFor("4 skills found");

    // The list previews the highlighted folder. Esc closes the panel without selecting it.
    await press("f");
    await waitFor("All folders");
    await press(KEY.down); // library
    await waitFor("Skills · 1 of 4");
    await press(KEY.down, KEY.right, KEY.down); // packs, opened, then alpha/skills
    await waitFor("Skills · 2 of 4");
    expect(frame()).toContain("alpha/skills");
    for (const line of frame().split("\n")) expect(line.length).toBeLessThanOrEqual(80);
    expect(frame().split("\n").length).toBeLessThanOrEqual(24);
    await press(KEY.escape);
    await waitFor("Filter: all skills");
    expect(frame()).toContain("Skills · 4");

    // Reopening starts on the current selection, so the list stays put until the highlight moves.
    await press("f");
    await waitFor("All folders");
    expect(frame()).toContain("Skills · 4");

    // Enter selects. ] and [ step through folders at one level, then past the parent.
    await press(KEY.down, KEY.down, KEY.down, KEY.enter, "r"); // alpha/skills
    await waitFor(/Filter: \S*alpha\/skills/);
    await waitFor("4 skills found");
    expect(frame()).toContain("Skills · 2 of 4");
    await press("]");
    await waitFor("broken");
    await press("[", "[");
    await waitFor("campaign");
    expect(frame()).toContain("Skills · 1 of 4");

    // ← closes a folder, and * opens every folder below the highlighted row.
    await press("f", KEY.down, KEY.left); // packs
    await until(() => !frame().includes("alpha/skills"), "packs to close", frame);
    await press("*");
    await waitFor("beta/skills");
    await press(KEY.escape);
    await waitFor(/Filter: \S*library/);

    // Panel counts follow the search, and folders without matches drop out.
    await press(KEY.escape, "/", "drafting", KEY.tab);
    await waitFor(/All folders +1 │/);
    expect(frame()).not.toContain("library");
    await press(KEY.escape, KEY.escape);
    await waitFor("Skills · 4");

    // Tags and statuses combine. Space selects without closing the panel.
    await press("f", "G"); // marketing, the last tag
    await waitFor("Skills · 1 of 4");
    await press(KEY.enter);
    await waitFor("Filter: tag marketing");
    await press("f", KEY.up, KEY.up, KEY.up); // Invalid
    await waitFor("No matching skills");
    await press(" ", KEY.down, KEY.down, KEY.enter); // All tags
    await waitFor("Filter: Invalid");
    expect(frame()).toContain("Skills · 1 of 4");
    expect(frame()).toContain("broken");
    app.unmount();
  });

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
