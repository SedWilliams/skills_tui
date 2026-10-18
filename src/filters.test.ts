import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Skill } from "./core.js";
import {
  NO_FILTER, countFacets, filterRows, folderTree, passes, skillFacets, stepFolder, type Filter,
} from "./filters.js";

const skill = (directory: string, extra: Partial<Skill> = {}): Skill => ({
  directory, name: path.basename(directory), description: "A test skill", text: "", error: "", tags: [], ...extra,
});

// /r/a/skills holds two skills, /r/b splits into two folders, and /r/c leads through single folders.
const SKILLS = [
  skill("/r/a/skills/one", { tags: ["writing"] }),
  skill("/r/a/skills/two"),
  skill("/r/b/x/skills/one", { error: "Invalid YAML" }),
  skill("/r/b/y/skills/three", { tags: ["git", "writing"] }),
  skill("/r/c/deep/chain/skills/four"),
];

describe("filters", () => {
  it("merges folders that lead to one folder and labels the top level with full paths", () => {
    const { roots, folders } = folderTree(SKILLS.map((s) => s.directory));
    expect(roots.map((f) => f.label)).toEqual(["/r/a/skills", "/r/b", "/r/c/deep/chain/skills"]);
    expect(folders.get("/r/b")!.children.map((f) => f.label)).toEqual(["x/skills", "y/skills"]);
    expect(folders.get("/r/b/y/skills")!.parent!.path).toBe("/r/b");
    expect(folders.has("/r/c/deep")).toBe(false);
    // A folder that holds skills stays a row even when it has subfolders.
    const mixed = folderTree(["/m/one", "/m/sub/two"]).roots;
    expect(mixed.map((f) => [f.label, f.children.map((c) => c.label)])).toEqual([["/m", ["sub"]]]);
    expect(folderTree([]).roots).toEqual([]);
  });

  it("counts each facet under the search and the other facets' filters", () => {
    const facets = skillFacets(SKILLS, new Set(["two"]));
    expect(facets.facts[3].folder).toEqual(["/r/b", "/r/b/y/skills"]);
    let counts = countFacets(facets.facts, NO_FILTER, "");
    expect(Object.fromEntries(counts.folder)).toEqual({
      "": 5, "/r/a/skills": 2, "/r/b": 2, "/r/b/x/skills": 1, "/r/b/y/skills": 1, "/r/c/deep/chain/skills": 1,
    });
    expect(Object.fromEntries(counts.status)).toEqual({ "": 5, installed: 1, "not-installed": 4, invalid: 1, duplicate: 2 });
    expect(Object.fromEntries(counts.tag)).toEqual({ "": 5, writing: 2, git: 1 });
    // A facet's own filter leaves its counts alone and narrows the others.
    counts = countFacets(facets.facts, { ...NO_FILTER, tag: "writing" }, "");
    expect(counts.tag.get("")).toBe(5);
    expect(Object.fromEntries(counts.folder)).toEqual({ "": 2, "/r/a/skills": 1, "/r/b": 1, "/r/b/y/skills": 1 });
    expect(counts.status.get("duplicate")).toBe(1);
    expect(countFacets(facets.facts, NO_FILTER, "three").folder.get("")).toBe(1);
  });

  it("matches folders by path, so a filter outlives changes to the tree", () => {
    const { facts } = skillFacets(SKILLS, new Set());
    const names = (filter: Filter, query = "") => SKILLS.filter((_, i) => passes(facts[i], filter, query)).map((s) => s.name);
    expect(names({ ...NO_FILTER, folder: "/r/b" })).toEqual(["one", "three"]);
    expect(names({ ...NO_FILTER, folder: "/r/c/deep" })).toEqual(["four"]);
    expect(names({ ...NO_FILTER, folder: "/r/a/sk" })).toEqual([]);
    expect(names({ ...NO_FILTER, status: "invalid" })).toEqual(["one"]);
    expect(names({ folder: "/r", status: "not-installed", tag: "writing" }, "skills/one")).toEqual(["one"]);
  });

  it("lists folders, statuses, and tags, hiding folders without matches unless they hold the selection", () => {
    const facets = skillFacets(SKILLS, new Set());
    const labels = (filter: Filter, expanded: string[] = []) =>
      filterRows(facets, countFacets(facets.facts, filter, ""), filter, new Set(expanded)).map((r) => r.label);
    expect(labels(NO_FILTER)).toEqual(["Folders", "All folders", "/r/a/skills", "/r/b", "/r/c/deep/chain/skills",
      "Status", "Any status", "Not installed", "Installed", "Invalid", "Duplicate name", "Tags", "All tags", "git", "writing"]);
    const invalid = { ...NO_FILTER, status: "invalid" };
    expect(labels(invalid, ["/r/b"]).slice(0, 5)).toEqual(["Folders", "All folders", "/r/b", "x/skills", "Status"]);
    expect(labels({ ...invalid, folder: "/r/b/y/skills" }, ["/r/b"]).slice(2, 5)).toEqual(["/r/b", "x/skills", "y/skills"]);
    // Tags appear when a matching skill has them, and a selected tag always stays.
    expect(labels(invalid)).not.toContain("Tags");
    expect(labels({ ...invalid, tag: "git" }).slice(-3)).toEqual(["Tags", "All tags", "git"]);
  });

  it("steps through folders at one level, then past the parent, skipping empty folders", () => {
    const facets = skillFacets(SKILLS, new Set());
    const all = countFacets(facets.facts, NO_FILTER, "");
    const step = (current: string, delta: number, counts = all) => stepFolder(facets, counts, current, delta);
    expect(step("", 1)).toBe("/r/a/skills");
    expect(step("", -1)).toBe("/r/c/deep/chain/skills");
    expect(step("/r/a/skills", 1)).toBe("/r/b");
    expect(step("/r/b/x/skills", 1)).toBe("/r/b/y/skills");
    expect(step("/r/b/y/skills", 1)).toBe("/r/c/deep/chain/skills");
    expect(step("/r/b/x/skills", -1)).toBe("/r/a/skills");
    expect(step("/r/c/deep/chain/skills", 1)).toBe("/r/c/deep/chain/skills");
    const writing = countFacets(facets.facts, { ...NO_FILTER, tag: "writing" }, "");
    expect(step("/r/b/y/skills", -1, writing)).toBe("/r/a/skills");
    expect(step("/r/b", 1, writing)).toBe("/r/b");
  });
});
