// Demo skills for marketing captures. Everything lives under a throwaway HOME, so paths
// render as ~/... and nothing touches the real agent folders.
import * as fs from "node:fs";
import * as path from "node:path";

const LIBRARY = ".config/tui-skills/library";

// [directory under HOME, name, description, body, extra frontmatter]
const SKILLS = [
  [".gemini/config/skills/a11y-check", "a11y-check",
    "Check a component for keyboard access, focus order, and contrast before it goes to review.", `
# Accessibility check

Run this on any new or changed interactive component.

## Steps

- Tab through the component. Focus follows reading order.
- Activate every control with Enter and with Space.
- Body text needs 4.5:1 contrast. Large text needs 3:1.
- Icon-only buttons need an accessible name.

## Report

List each failure with the element, the rule, and a one-line fix.`, "type: design"],

  ["dev/acme-api/.agents/skills/api-docs", "api-docs",
    "Write reference docs for an HTTP endpoint from its route handler and tests. Use when an endpoint is added or its response changes.", `
# API docs

Read the handler, then the tests. The tests show the real response shapes.

- One section per endpoint: method, path, auth, body, responses.
- Copy example payloads from passing tests.`, "type: docs"],

  ["src/bigpowers/skills/brainstorm", "brainstorm",
    "Turn a rough idea into a design by asking one question at a time. Use before writing code for a new feature.", `
# Brainstorm

Ask one question at a time. Wait for the answer before the next one.

- Start with the problem, not the solution.
- Offer two or three approaches with their trade-offs.
- Write the agreed design to docs/design.md.`],

  [`${LIBRARY}/changelog`, "changelog",
    "Group merged pull requests since the last tag into release notes, sorted by what users will notice.", `
# Changelog

- List merged PRs since the last tag with \`git log --merges\`.
- Group them under Added, Changed, Fixed, and Removed.
- Write each entry for users, not reviewers.`, "type: writing"],

  [".agents/skills/commit-message", "commit-message",
    "Write a conventional commit message from the staged diff. Use when the user asks to commit.", `
# Commit message

Read \`git diff --staged\`. Write an imperative subject under 72 characters, then a body that says why.

\`\`\`text
fix(scanner): skip symlink cycles

A link back to an ancestor made the scan loop forever.
\`\`\``, "type: git"],

  ["dev/acme-api/.claude/skills/db-migrations", "db-migrations",
    "Plan reversible schema migrations and check each step against production row counts.", `
# Database migrations

- Every migration has a down step.
- Add columns as nullable, backfill, then add constraints.
- Check the row count before locking a large table.`, "type: data"],

  [".claude/skills/deslop", "deslop",
    "Simplify a finished change without changing its behavior. Use after a workpackage passes its tests.", `
# Deslop

Run after the tests pass. Behavior stays the same.

- Delete code the change no longer needs.
- Inline helpers that have one caller.
- Rename anything whose name no longer matches what it does.`],

  ["dev/storefront/.agents/skills/dockerfile", "dockerfile",
    "Write a multi-stage Dockerfile with a pinned base image and a non-root user.", `
# Dockerfile

- Pin the base image by digest.
- Build in one stage, copy artifacts into a slim runtime stage.
- Run as a non-root user.`, "type: devops"],

  ["src/bigpowers/skills/execute-plan", "execute-plan",
    "Work through an approved plan one task at a time and stop at the first failing check.", `
# Execute plan

Take the next unchecked task. Do it, run its check, and tick it off. Stop when a check fails.`],

  ["Downloads/marketing-skills/skills/landing-copy", "landing-copy",
    "Rewrite a landing page hero so a first-time visitor can say what the product does.", `
# Landing copy

- Headline: what it is and who it is for.
- Subhead: the one result a customer gets.
- One call to action above the fold.`],

  ["Downloads/marketing-skills/skills/launch-email", "launch-email",
    "Draft a launch email with three subject lines and a single call to action.", `
# Launch email

Lead with the change for the reader. Keep it under 150 words and end with one link.`],

  ["src/bigpowers/skills/root-cause", "root-cause",
    "Find the cause of a bug before proposing a fix. Use when a test fails and the reason is unclear.", `
# Root cause

- Reproduce the failure with the smallest input.
- Read the error and the stack trace in full.
- Change one thing at a time and write down what each change showed.`],

  [`${LIBRARY}/pr-review`, "pr-review",
    "Review a pull request for correctness bugs before style. Use when asked to review a diff or a PR.", `
# PR review

Read the whole diff before you comment.

## Order of checks

- Does the change do what the description says?
- Inputs that break it: empty, null, huge, concurrent.
- Error paths that swallow failures.
- Tests that pass without running the new code.

Style comes last, and only when the project has no formatter.

## Output

\`\`\`text
file:line  severity  one-sentence finding
\`\`\``, "type: review"],

  ["Downloads/marketing-skills/skills/pricing-page", "pricing-page",
    "Restructure a pricing page so each buyer finds their plan and its limits in one pass.", `
# Pricing page

- One column per plan, the most popular in the middle.
- Put limits next to prices, not in a footnote.`],

  ["Downloads/marketing-skills/skills/seo-audit", "seo-audit",
    "Audit a page for search ranking problems and list fixes in order of expected impact.", `
# SEO audit

## Check

- Title under 60 characters, primary keyword first
- One h1 that matches search intent
- Meta description under 155 characters
- Canonical URL and no accidental noindex
- Largest Contentful Paint under 2.5 s

## Report

Group fixes as quick wins, content changes, and technical work.`],

  ["dev/acme-api/.claude/skills/sql-review", "sql-review",
    "Review new queries for missing indexes, N+1 loops, and unbounded scans.", `
# SQL review

Run EXPLAIN on every new query against a copy of production data.`, "tags: [data, review]"],

  ["dev/infra/.agents/skills/terraform-plan", "terraform-plan",
    "Read a terraform plan and flag destroys, replacements, and IAM changes before apply.", `
# Terraform plan

Any destroy or replace on a stateful resource needs a written reason before apply.`, "type: devops"],

  ["src/bigpowers/skills/test-first", "test-first",
    "Write the failing test first, then the smallest change that makes it pass.", `
# Test first

Red, green, then refactor. Commit after each green.`],

  ["dev/storefront/.claude/skills/ui-states", "ui-states",
    "List the empty, loading, error, and overflow states of a screen before building it.", `
# UI states

Sketch each state. Long names and zero results count as states too.`, "type: design"],

  [".claude/skills/unslop", "unslop",
    "Cut AI tells from any writing.", `
# Unslop

Scan for filler and puffery, rewrite in plain words, then read it aloud.`],

  ["src/bigpowers/skills/verify-done", "verify-done",
    "Run the checks that prove a task is finished before reporting it done.", `
# Verify done

Run the tests, the type checker, and the build. Paste the output.`],

  ["src/bigpowers/skills/write-plan", "write-plan",
    "Break an approved design into small tasks, each with a check that proves it works.", `
# Write plan

Each task fits in one commit and names the command that proves it works.`],
];

// Invalid frontmatter stays in the list, so the app can show the problem.
const BROKEN = ["notes/drafts/meeting-notes", `---
name: Meeting Notes
description: Summarize a transcript into decisions and action items.
---

# Meeting notes
`];

// [link under HOME, target under HOME]
const LINKS = [
  [".agents/skills/pr-review", `${LIBRARY}/pr-review`],
  [".claude/skills/pr-review", `${LIBRARY}/pr-review`],
  [".pi/agent/skills/deslop", ".claude/skills/deslop"],
  [".pi/agent/skills/unslop", ".claude/skills/unslop"],
];

export const SKILL_COUNT = SKILLS.length + 1;

export function buildDemoHome(home) {
  const write = (dir, text) => {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, "SKILL.md"), text);
  };
  for (const [dir, name, description, body, extra] of SKILLS) {
    write(dir, `---\nname: ${name}\ndescription: ${description}\n${extra ? extra + "\n" : ""}---\n${body}\n`);
  }
  write(...BROKEN);
  for (const [link, target] of LINKS) {
    fs.mkdirSync(path.dirname(path.join(home, link)), { recursive: true });
    fs.symlinkSync(path.join(home, target), path.join(home, link), "dir");
  }
  return home;
}
