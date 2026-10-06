// Filesystem operations, kept independent of the terminal UI.
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { load as loadYaml } from "js-yaml";

export const AGENTS: Record<string, readonly [userWide: string, projectLocal: string]> = {
  Codex: [".agents/skills", ".agents/skills"],
  "Claude Code": [".claude/skills", ".claude/skills"],
  Antigravity: [".gemini/config/skills", ".agents/skills"],
  Pi: [".pi/agent/skills", ".pi/skills"],
};
export const AGENT_NAMES = Object.keys(AGENTS);
export const DEFAULT_EXCLUDES = [
  ".git", ".venv", "venv", "__pycache__", "node_modules", ".Trash",
  "Library", ".cache", "Caches", ".npm", ".local/share/Trash",
];
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function absolute(value: string): string {
  const expanded = value === "~" || value.startsWith("~/") ? os.homedir() + value.slice(1) : value;
  return path.resolve(expanded);
}

/** Like Python's Path.resolve(): follows existing links but tolerates missing parts. */
export function resolveLoose(p: string): string {
  const full = path.resolve(p);
  try {
    return fs.realpathSync(full);
  } catch {
    const parent = path.dirname(full);
    return parent === full ? full : path.join(resolveLoose(parent), path.basename(full));
  }
}

/** True for any existing path, including broken symlinks. */
export function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isInside(child: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.tui-skills-${randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(temp, text, { encoding: "utf-8", flag: "wx" });
    if (fs.existsSync(file)) fs.chmodSync(temp, fs.statSync(file).mode & 0o777);
    fs.renameSync(temp, file);
  } finally {
    if (lexists(temp)) fs.unlinkSync(temp);
  }
}

export class Config {
  constructor(
    public home: string,
    public roots: string[],
    public library: string,
    public targets: Record<string, string>,
    public excludes: string[] = [...DEFAULT_EXCLUDES],
  ) {}

  static load(home?: string): Config {
    home = home ?? absolute(process.env.TUI_SKILLS_HOME || "~/.config/tui-skills");
    const file = path.join(home, "config.json");
    if (fs.existsSync(file)) return Config.fromText(home, fs.readFileSync(file, "utf-8"));
    const targets = Object.fromEntries(
      Object.entries(AGENTS).map(([name, paths]) => [name, path.join(os.homedir(), paths[0])]),
    );
    return new Config(home, [os.homedir()], path.join(home, "library"), targets);
  }

  static fromText(home: string, text: string): Config {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (exc) {
      throw new Error(`Invalid JSON: ${(exc as Error).message}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Configuration must be a JSON object");
    }
    const { roots, targets, library, excludes = DEFAULT_EXCLUDES } = data as Record<string, unknown>;
    const nonempty = (x: unknown) => typeof x === "string" && x.trim() !== "";
    if (!Array.isArray(roots) || !roots.every(nonempty)) {
      throw new Error("roots must be a list of nonempty paths");
    }
    if (!targets || typeof targets !== "object" || Array.isArray(targets)
        || Object.keys(targets).sort().join("\n") !== [...AGENT_NAMES].sort().join("\n")) {
      throw new Error("targets must contain Codex, Claude Code, Antigravity, and Pi");
    }
    if (!Object.values(targets).every(nonempty)) throw new Error("Each target must be a nonempty path");
    if (!nonempty(library)) throw new Error("library must be a nonempty path");
    if (!Array.isArray(excludes) || !excludes.every((x) => typeof x === "string")) {
      throw new Error("excludes must be a list of directory names or path suffixes");
    }
    return new Config(home, roots as string[], library as string,
      targets as Record<string, string>, excludes as string[]);
  }

  text(): string {
    return JSON.stringify({ roots: this.roots, library: this.library,
      targets: this.targets, excludes: this.excludes }, null, 2) + "\n";
  }

  save(): void {
    atomicWrite(path.join(this.home, "config.json"), this.text());
  }

  scanRoots(): string[] {
    // Explicit roots are scanned even when their ancestors are excluded.
    return [this.library, ...Object.values(this.targets), ...this.roots].map(absolute);
  }
}

export interface Skill {
  directory: string;
  name: string;
  description: string;
  text: string;
  error: string;
  types?: string[];
}

export function skillTypes(skill: Skill): string[] {
  const types = new Set((skill.types ?? []).map(normalizeType).filter(Boolean));
  const source = `${skill.directory} ${skill.name}`.toLowerCase();
  if (/marketing/.test(source)) types.add("marketing");
  if (/bigpowers/.test(source)) types.add("bigpowers");
  if (/unslop|deslop/.test(source)) types.add("ai-unslop");
  return types.size ? [...types].sort() : ["other"];
}

function normalizeType(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export const skillFile = (skill: Skill) => path.join(skill.directory, "SKILL.md");

export function metadata(text: string): Record<string, unknown> & { name: string; description: string } {
  const lines = text.split(/\r?\n/);
  if (text === "" || lines[0].trim() !== "---") {
    throw new Error("SKILL.md needs YAML frontmatter starting with ---");
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) throw new Error("Missing closing --- for frontmatter");
  let data: unknown;
  try {
    data = loadYaml(lines.slice(1, end).join("\n"));
  } catch (exc) {
    throw new Error(`Invalid YAML: ${(exc as Error).message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Frontmatter must be a YAML mapping");
  }
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== "string" || name.length > 64 || !NAME.test(name)) {
    throw new Error("name must be 1-64 lowercase letters, numbers, and single hyphens");
  }
  if (typeof description !== "string" || !description.trim() || description.length > 1024) {
    throw new Error("description must be nonempty text, at most 1024 characters");
  }
  return data as Record<string, unknown> & { name: string; description: string };
}

function parseSkill(directory: string, read: () => string): Skill {
  let text = "";
  try {
    text = read();
    const data = metadata(text);
    const nested = data.metadata && typeof data.metadata === "object"
      ? data.metadata as Record<string, unknown> : {};
    const types = [data.type, data.category, data.tags, nested.type, nested.category, nested.tags]
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value): value is string => typeof value === "string");
    return { directory, name: data.name, description: data.description, text, error: "", types };
  } catch (exc) {
    return { directory, name: path.basename(directory), description: "Invalid skill", text,
      error: (exc as Error).message };
  }
}

export function readSkill(directory: string): Skill {
  return parseSkill(directory, () => fs.readFileSync(path.join(directory, "SKILL.md"), "utf-8"));
}

async function readSkillAsync(directory: string): Promise<Skill> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(directory, "SKILL.md"), "utf-8");
  } catch (exc) {
    return parseSkill(directory, () => { throw exc; });
  }
  return parseSkill(directory, () => text);
}

export const byNameThenPath = (a: Skill, b: Skill) => {
  const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
  if (x !== y) return x < y ? -1 : 1;
  return a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0;
};

/** Directories read at once. Sequential awaits leave the disk and thread pool mostly idle. */
const SCAN_CONCURRENCY = 32;

/**
 * Find every directory containing SKILL.md under the configured roots.
 * `progress` receives the skills found so far, unsorted, as the scan goes.
 */
export async function discover(
  config: Config, cancelled: () => boolean = () => false, progress?: (skills: Skill[]) => void,
): Promise<[Skill[], string[]]> {
  const skills: Skill[] = [];
  const errors: string[] = [];
  const visited = new Set<string>();
  const trash = resolveLoose(path.join(config.home, "trash"));
  const backups = resolveLoose(path.join(config.home, "backups"));
  const fail = (directory: string, exc: unknown) => {
    if (errors.length < 100) errors.push(`${directory}: ${(exc as Error).message}`);
  };

  // `real` is the resolved path. A plain subdirectory's real path is its parent's real path
  // plus its name, so only roots and symlinks need a realpath call to detect cycles.
  type Item = { directory: string; real: string };
  const visit = async ({ directory, real }: Item, queue: Item[], links: Item[]) => {
    if (visited.has(real) || real === trash || real === backups) return;
    visited.add(real);
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    const marker = entries.find((e) => e.name === "SKILL.md");
    if (marker && (marker.isFile() || (marker.isSymbolicLink() && isFile(path.join(directory, marker.name))))) {
      skills.push(await readSkillAsync(directory));
      // Assets and references are part of this skill, not scan roots.
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (config.excludes.some((rule) => entry.name === rule || child.endsWith("/" + rule))) continue;
      if (entry.isDirectory()) {
        queue.push({ directory: child, real: path.join(real, entry.name) });
        continue;
      }
      try {
        if (!(await fsp.stat(child)).isDirectory()) continue;
        links.push({ directory: child, real: await fsp.realpath(child) });
      } catch {
        // Broken links are not directories.
      }
    }
  };

  // Roots run one after another so the library and agent targets claim their skills
  // before a broader root such as the home directory reaches the same folders.
  for (let root of config.scanRoots()) {
    if (cancelled()) break;
    try {
      if (isFile(root)) root = path.dirname(root);
      const queue: Item[] = [{ directory: root, real: await fsp.realpath(root) }];
      // Linked directories wait until the regular tree is done, so a folder reachable both
      // directly and through a link is listed at its real location.
      const links: Item[] = [];
      let active = 0;
      await new Promise<void>((resolve) => {
        const pump = () => {
          if (!queue.length && !active) queue.push(...links.splice(0).reverse());
          while (active < SCAN_CONCURRENCY && queue.length && !cancelled()) {
            const item = queue.pop()!;
            active++;
            const found = skills.length;
            void visit(item, queue, links).catch((exc) => fail(item.directory, exc)).finally(() => {
              active--;
              if (progress && skills.length !== found) progress(skills);
              pump();
            });
          }
          if (active === 0) resolve();
        };
        pump();
      });
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code !== "ENOENT") fail(root, exc);
    }
  }
  return [skills.sort(byNameThenPath), errors];
}

export function targetPaths(config: Config, project = ""): Record<string, string> {
  if (project.trim()) {
    const root = absolute(project);
    if (!isDir(root)) throw new Error("Project directory does not exist");
    return Object.fromEntries(Object.entries(AGENTS).map(([agent, paths]) => [agent, path.join(root, paths[1])]));
  }
  return Object.fromEntries(Object.entries(config.targets).map(([agent, p]) => [agent, absolute(p)]));
}

export function installationStatus(skill: Skill, targets: Record<string, string>): string {
  const installed = [];
  for (const [agent, root] of Object.entries(targets)) {
    const dest = path.join(root, skill.name);
    if (isFile(path.join(dest, "SKILL.md"))) installed.push(agent + (isSymlink(dest) ? " ↗" : ""));
  }
  return installed.join(", ") || "Not installed at selected targets";
}

/** Move like shutil.move: rename, falling back to copy and delete across devices. */
export function move(source: string, destination: string): void {
  try {
    fs.renameSync(source, destination);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "EXDEV") throw exc;
    fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
    + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export class Store {
  /** Replaceable so tests can simulate a failed cross-device move. */
  move: (source: string, destination: string) => void = move;

  constructor(public config: Config) {}

  create(text: string): string {
    const { name } = metadata(text);
    const directory = path.join(absolute(this.config.library), name);
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    try {
      fs.mkdirSync(directory);
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Already exists: ${directory}`);
      throw exc;
    }
    try {
      atomicWrite(path.join(directory, "SKILL.md"), text);
    } catch (exc) {
      fs.rmdirSync(directory);
      throw exc;
    }
    return directory;
  }

  save(skill: Skill, text: string): void {
    metadata(text);
    const file = fs.realpathSync(skillFile(skill));
    if (fs.readFileSync(file, "utf-8") !== skill.text) {
      throw new Error("File changed outside this editor. Cancel and rescan before editing.");
    }
    const backup = path.join(this.config.home, "backups",
      `${randomUUID().replaceAll("-", "")}-${path.basename(skill.directory)}.md`);
    atomicWrite(backup, skill.text);
    atomicWrite(file, text);
  }

  trash(target: string): string {
    target = absolute(target); // Do not resolve links: remove the link, not its source.
    const link = isSymlink(target);
    if (!link && !isFile(path.join(target, "SKILL.md"))) {
      throw new Error("Refusing to remove a directory without SKILL.md");
    }
    const trash = path.join(this.config.home, "trash");
    if (!link) {
      const [resolved, trashResolved] = [resolveLoose(target), resolveLoose(trash)];
      if (resolved === trashResolved || isInside(trashResolved, resolved)) {
        throw new Error("Cannot move the app's own storage or an ancestor into its trash");
      }
    }
    fs.mkdirSync(trash, { recursive: true });
    const entry = path.join(trash, timestamp() + "-" + randomBytes(4).toString("hex"));
    fs.mkdirSync(entry);
    atomicWrite(path.join(entry, "entry.json"), JSON.stringify({ original: target }, null, 2));
    try {
      this.move(target, path.join(entry, "skill"));
    } catch (exc) {
      // Cross-device moves can fail after copying or partly removing the source.
      // Keep any recovered data instead of deleting the only surviving copy.
      if (!lexists(path.join(entry, "skill"))) fs.rmSync(entry, { recursive: true, force: true });
      throw exc;
    }
    return entry;
  }

  trashEntries(): string[] {
    const trash = path.join(this.config.home, "trash");
    let names: string[];
    try {
      names = fs.readdirSync(trash);
    } catch {
      return [];
    }
    return names.map((name) => path.join(trash, name, "entry.json")).filter(isFile).sort().reverse();
  }

  restore(record: string): string {
    const original = JSON.parse(fs.readFileSync(record, "utf-8")).original;
    if (typeof original !== "string") throw new Error("Unreadable trash record");
    if (lexists(original)) throw new Error(`Cannot restore: ${original} already exists`);
    fs.mkdirSync(path.dirname(original), { recursive: true });
    this.move(path.join(path.dirname(record), "skill"), original);
    fs.unlinkSync(record);
    fs.rmdirSync(path.dirname(record));
    return original;
  }

  install(skill: Skill, root: string, mode: string): string {
    const { name } = metadata(fs.readFileSync(skillFile(skill), "utf-8"));
    const source = fs.realpathSync(skill.directory);
    root = resolveLoose(root);
    const dest = path.join(root, name);
    if (lexists(dest)) throw new Error(`Already exists: ${dest}. Remove it first or choose another target.`);
    if (root === source || isInside(root, source)) throw new Error("Cannot install a skill inside itself");
    fs.mkdirSync(root, { recursive: true });
    if (mode === "link") {
      fs.symlinkSync(source, dest, "dir");
    } else if (mode === "copy") {
      // Do not follow embedded links into arbitrary directories or cycles.
      for (const entry of fs.readdirSync(source, { recursive: true, withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("This skill contains symlinks. Use link mode instead.");
      }
      const staging = fs.mkdtempSync(path.join(root, ".tui-skills-"));
      try {
        fs.cpSync(source, path.join(staging, "skill"), { recursive: true, preserveTimestamps: true });
        // mkdir reserves the name without overwriting a racing installation.
        fs.mkdirSync(dest);
        try {
          fs.renameSync(path.join(staging, "skill"), dest);
        } catch (exc) {
          fs.rmdirSync(dest);
          throw exc;
        }
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    } else {
      throw new Error("Mode must be copy or link");
    }
    return dest;
  }
}
