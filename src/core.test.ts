import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_NAMES, Config, Skill, Store, discover, isSymlink, metadata, readSkill, skillFile, targetPaths,
} from "./core.js";

export const TEXT = "---\nname: example\ndescription: A test skill\n---\n\n# Instructions\n";

let tmp: string;
let config: Config;
let skill: Skill;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tui-skills-test-")));
  config = new Config(path.join(tmp, "config"), [path.join(tmp, "sources")], path.join(tmp, "library"),
    Object.fromEntries(AGENT_NAMES.map((agent) => [agent, path.join(tmp, agent)])));
  const dir = new Store(config).create(TEXT);
  fs.mkdirSync(path.join(dir, "references"));
  fs.writeFileSync(path.join(dir, "references", "guide.md"), "Reference");
  skill = readSkill(dir);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("core", () => {
  it("discovers hidden and invalid skills, honours exclusions, and skips cycles", async () => {
    const root = config.roots[0];
    const hidden = path.join(root, ".hidden", "bad");
    fs.mkdirSync(hidden, { recursive: true });
    fs.writeFileSync(path.join(hidden, "SKILL.md"), "broken");
    const skipped = path.join(root, "node_modules", "skip");
    fs.mkdirSync(skipped, { recursive: true });
    fs.writeFileSync(path.join(skipped, "SKILL.md"), TEXT);
    fs.symlinkSync(root, path.join(root, "loop"));
    const [found, errors] = await discover(config);
    expect(errors).toEqual([]);
    expect(new Set(found.map((s) => s.name))).toEqual(new Set(["example", "bad"]));
    expect(found.find((s) => s.name === "bad")!.error).toBeTruthy();
    config.roots.push(skipped);
    expect((await discover(config))[0]).toHaveLength(3);
  });

  it("copies supporting files and never overwrites", () => {
    const store = new Store(config);
    const dest = store.install(skill, config.targets.Codex, "copy");
    expect(fs.readFileSync(path.join(dest, "references", "guide.md"), "utf-8")).toBe("Reference");
    expect(isSymlink(dest)).toBe(false);
    expect(() => store.install(skill, path.dirname(dest), "copy")).toThrow(/Already exists/);
    expect(() => store.install(skill, path.join(skill.directory, "nested"), "copy")).toThrow(/inside itself/);
  });

  it("removes and restores a link without touching its source", () => {
    const store = new Store(config);
    const dest = store.install(skill, config.targets.Pi, "link");
    const record = store.trash(dest);
    expect(fs.existsSync(skillFile(skill))).toBe(true);
    expect(fs.existsSync(dest)).toBe(false);
    store.restore(path.join(record, "entry.json"));
    expect(isSymlink(dest)).toBe(true);
    expect(fs.realpathSync(dest)).toBe(skill.directory);
  });

  it("refuses restore collisions and never scans its own trash", async () => {
    const store = new Store(config);
    const record = store.trash(skill.directory);
    config.roots.push(config.home);
    expect((await discover(config))[0]).toEqual([]);
    fs.mkdirSync(skill.directory);
    expect(() => store.restore(path.join(record, "entry.json"))).toThrow(/already exists/);
    fs.rmdirSync(skill.directory);
    store.restore(path.join(record, "entry.json"));
    expect(fs.readFileSync(skillFile(skill), "utf-8")).toBe(TEXT);
  });

  it("backs up on save and detects external edits", () => {
    const store = new Store(config);
    store.save(skill, TEXT + "More instructions\n");
    const backups = fs.readdirSync(path.join(config.home, "backups")).filter((f) => f.endsWith(".md"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(config.home, "backups", backups[0]), "utf-8")).toBe(TEXT);
    expect(() => store.save(skill, TEXT)).toThrow(/changed outside/);
  });

  it("refuses to copy skills with embedded symlinks", () => {
    fs.symlinkSync(skill.directory, path.join(skill.directory, "link"));
    expect(() => new Store(config).install(skill, config.targets.Codex, "copy")).toThrow(/symlinks/);
    expect(fs.existsSync(path.join(config.targets.Codex, skill.name))).toBe(false);
  });

  it.each(["text", "---\n[]\n---", TEXT.replace("example", "../escape"),
    TEXT.replace("A test skill", "true"), "---\nname: [\n---"])("rejects invalid frontmatter %#", (text) => {
    expect(() => metadata(text)).toThrow();
  });

  it("round-trips config and computes project targets", () => {
    config.save();
    expect(Config.load(config.home).text()).toBe(config.text());
    const paths = targetPaths(config, tmp);
    expect(paths.Codex).toBe(path.join(tmp, ".agents/skills"));
    expect(paths.Antigravity).toBe(paths.Codex);
    expect(paths.Pi).toBe(path.join(tmp, ".pi/skills"));
    expect(() => Config.fromText(config.home, "{}")).toThrow();
    expect(() => targetPaths(config, path.join(tmp, "missing"))).toThrow(/does not exist/);
  });

  it("parses multiline YAML and refuses duplicate names", () => {
    const text = TEXT.replace("example", "multi").replace("A test skill", "|\n  First line\n  Second line");
    expect(metadata(text).description).toContain("Second line");
    new Store(config).create(text);
    expect(() => new Store(config).create(text)).toThrow(/Already exists/);
  });

  it("does not overwrite a broken destination link", () => {
    const target = config.targets.Codex;
    fs.mkdirSync(target);
    fs.symlinkSync(path.join(target, "missing"), path.join(target, skill.name));
    expect(() => new Store(config).install(skill, target, "copy")).toThrow(/Already exists/);
    expect(isSymlink(path.join(target, skill.name))).toBe(true);
  });

  it("refuses to trash an ancestor of its own storage", () => {
    const ancestor = path.dirname(config.home);
    fs.writeFileSync(path.join(ancestor, "SKILL.md"), TEXT);
    expect(() => new Store(config).trash(ancestor)).toThrow(/ancestor/);
    expect(fs.existsSync(ancestor)).toBe(true);
  });

  it("keeps recovered data when a cross-device move fails partway", () => {
    const store = new Store(config);
    store.move = (_source, destination) => {
      fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, "SKILL.md"), TEXT);
      throw new Error("Simulated failure removing source");
    };
    expect(() => store.trash(skill.directory)).toThrow(/Simulated/);
    const records = store.trashEntries();
    expect(records).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(records[0]), "skill", "SKILL.md"), "utf-8")).toBe(TEXT);
  });
});
