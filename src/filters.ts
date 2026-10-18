// The folder tree, facets, and counts behind the skill list filters. No UI or file access.
import * as path from "node:path";
import type { Skill } from "./core.js";
import { short } from "./text.js";

export interface Folder {
  path: string;
  /** The path below the parent folder, or the whole path for a top-level folder. */
  label: string;
  parent?: Folder;
  children: Folder[];
}

export type Facet = "folder" | "status" | "tag";
/** One value per facet. An empty string matches every skill. */
export type Filter = Record<Facet, string>;
export const NO_FILTER: Filter = { folder: "", status: "", tag: "" };
const FACETS: Facet[] = ["folder", "status", "tag"];
export const STATUSES: [value: string, label: string][] = [
  ["not-installed", "Not installed"], ["installed", "Installed"], ["invalid", "Invalid"], ["duplicate", "Duplicate name"],
];

/** A skill's values for each facet, with its folders listed from the top level down. */
export type Facts = Record<Facet, string[]> & { directory: string; text: string };

export interface Facets {
  roots: Folder[];
  folders: Map<string, Folder>;
  /** One entry per skill, in list order. */
  facts: Facts[];
}

/** Skill counts by facet value. The empty value counts every skill the other facets allow. */
export type Counts = Record<Facet, Map<string, number>>;

const within = (directory: string, folder: string) =>
  directory.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);

/**
 * Arrange the folders that hold skills into a tree. A folder that only leads to one other
 * folder merges into it, so ~/.codex/.tmp/plugins/plugins is one row instead of four.
 */
export function folderTree(directories: string[]): Pick<Facets, "roots" | "folders"> {
  const holders = new Set<string>();
  const children = new Map<string, Set<string>>();
  for (const directory of directories) {
    let dir = path.dirname(directory);
    holders.add(dir);
    for (let parent = path.dirname(dir); parent !== dir; dir = parent, parent = path.dirname(dir)) {
      const known = children.has(parent);
      children.set(parent, (children.get(parent) ?? new Set<string>()).add(dir));
      if (known) break; // Its ancestors are linked already.
    }
  }
  const skip = (dir: string) => {
    while (!holders.has(dir) && children.get(dir)?.size === 1) dir = [...children.get(dir)!][0];
    return dir;
  };
  const folders = new Map<string, Folder>();
  const byLabel = (a: Folder, b: Folder) => a.label.localeCompare(b.label);
  const build = (dir: string, parent?: Folder): Folder => {
    const folder: Folder = { path: dir, label: parent ? path.relative(parent.path, dir) : short(dir), parent, children: [] };
    folders.set(dir, folder);
    folder.children = [...children.get(dir) ?? []].map((child) => build(skip(child), folder)).sort(byLabel);
    return folder;
  };
  // The tree starts below the folders that every skill shares, usually the home directory.
  const top = skip(path.parse(directories[0] ?? path.sep).root);
  const roots = holders.has(top) ? [build(top)] : [...children.get(top) ?? []].map((dir) => build(skip(dir))).sort(byLabel);
  return { roots, folders };
}

/** Everything the filters need from the skill list. `installed` holds the names found in agent targets. */
export function skillFacets(skills: Skill[], installed: Set<string>): Facets {
  const { roots, folders } = folderTree(skills.map((s) => s.directory));
  const copies = new Map<string, number>();
  for (const { name } of skills) copies.set(name, (copies.get(name) ?? 0) + 1);
  const facts = skills.map((skill): Facts => {
    const folder: string[] = [];
    for (let f = folders.get(path.dirname(skill.directory)); f; f = f.parent) folder.unshift(f.path);
    const status = [installed.has(skill.name) ? "installed" : "not-installed"];
    if (skill.error) status.push("invalid");
    if (copies.get(skill.name)! > 1) status.push("duplicate");
    return { directory: skill.directory, text: `${skill.name} ${skill.description} ${skill.directory}`.toLowerCase(),
      folder, status, tag: skill.tags };
  });
  return { roots, folders, facts };
}

/** Whether a skill matches the search and every filter except `ignore`. */
export function passes(facts: Facts, filter: Filter, query: string, ignore?: Facet): boolean {
  if (query && !facts.text.includes(query)) return false;
  // Folders match by path, so the filter keeps working after a rescan reshapes the tree.
  return FACETS.every((facet) => facet === ignore || !filter[facet]
    || (facet === "folder" ? within(facts.directory, filter.folder) : facts[facet].includes(filter[facet])));
}

/** Each facet is counted under the search and the other facets' filters, so counts show what selecting a value would list. */
export function countFacets(facts: Facts[], filter: Filter, query: string): Counts {
  const counts: Counts = { folder: new Map(), status: new Map(), tag: new Map() };
  for (const f of facts) {
    for (const facet of FACETS) {
      if (!passes(f, filter, query, facet)) continue;
      for (const value of ["", ...f[facet]]) counts[facet].set(value, (counts[facet].get(value) ?? 0) + 1);
    }
  }
  return counts;
}

/** A line in the filter panel. Headings have no facet. Any other row sets its facet to `value`. */
export interface Row {
  facet?: Facet;
  value: string;
  label: string;
  count: number;
  depth: number;
  folder?: Folder;
  open?: boolean;
}

export function filterRows({ roots }: Facets, counts: Counts, filter: Filter, expanded: Set<string>): Row[] {
  const heading = (label: string): Row => ({ value: "", label, count: 0, depth: 0 });
  const option = (facet: Facet, value: string, label: string, depth = 0): Row =>
    ({ facet, value, label, depth, count: counts[facet].get(value) ?? 0 });
  const rows = [heading("Folders"), option("folder", "", "All folders")];
  const visit = (folder: Folder, depth: number) => {
    // Folders without matches are hidden, except the ones leading to the selected folder.
    if (!counts.folder.get(folder.path) && folder.path !== filter.folder && !within(filter.folder, folder.path)) return;
    const open = expanded.has(folder.path);
    rows.push({ ...option("folder", folder.path, folder.label, depth), folder, open });
    if (open) folder.children.forEach((child) => visit(child, depth + 1));
  };
  roots.forEach((root) => visit(root, 0));
  rows.push(heading("Status"), option("status", "", "Any status"),
    ...STATUSES.map(([value, label]) => option("status", value, label)));
  const tags = [...counts.tag.keys()].filter(Boolean);
  if (filter.tag && !tags.includes(filter.tag)) tags.push(filter.tag);
  if (tags.length) rows.push(heading("Tags"), option("tag", "", "All tags"), ...tags.sort().map((tag) => option("tag", tag, tag)));
  return rows;
}

/**
 * The folder after `current` at the same level, or the one before it when `delta` is negative.
 * When a level runs out, the step continues past the parent folder. Folders without matches are skipped.
 */
export function stepFolder({ roots, folders }: Facets, counts: Counts, current: string, delta: number): string {
  const siblings = (folder?: Folder) =>
    (folder?.parent?.children ?? roots).filter((f) => f === folder || counts.folder.get(f.path));
  let folder = folders.get(current);
  if (!folder) return (delta > 0 ? siblings()[0] : siblings().at(-1))?.path ?? current;
  for (; folder; folder = folder.parent) {
    const level = siblings(folder);
    const next = level[level.indexOf(folder) + delta];
    if (next) return next.path;
  }
  return current;
}
