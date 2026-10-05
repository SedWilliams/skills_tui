// Text layout helpers. Ink wraps text on its own, but scrolling needs exact line counts.
import * as os from "node:os";
import * as path from "node:path";
import cliTruncate from "cli-truncate";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

export type Tone = "h1" | "h2" | "h3" | "code" | "fence" | "quote" | "rule" | "plain";
export interface Line {
  text: string;
  tone: Tone;
}

export const width = stringWidth;

export function truncate(text: string, columns: number, position: "end" | "start" = "end"): string {
  return columns <= 0 ? "" : cliTruncate(text, columns, { position });
}

export function pad(text: string, columns: number): string {
  const fitted = truncate(text, columns);
  return fitted + " ".repeat(Math.max(0, columns - stringWidth(fitted)));
}

export function wrap(text: string, columns: number): string[] {
  if (columns <= 0) return [];
  return wrapAnsi(text, columns, { hard: true, trim: false }).split("\n");
}

/** Wrap with the continuation lines indented, for "label  value" rows. */
export function hang(text: string, columns: number, indent: number): string[] {
  const [first, ...rest] = wrap(text, columns);
  return [first ?? "", ...rest.flatMap((line) => wrap(line.trimStart(), columns - indent)
    .map((part) => " ".repeat(indent) + part))];
}

/** Wrap a filesystem path at separators where possible. */
export function wrapPath(p: string, columns: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const part of p.split(/(?<=\/)/)) {
    if (line && stringWidth(line + part) > columns) {
      lines.push(...wrap(line, columns));
      line = "";
    }
    line += part;
  }
  return [...lines, ...wrap(line, columns)];
}

/** Return SKILL.md without its frontmatter, which the detail header already shows. */
export function body(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end !== -1) return lines.slice(end + 1).join("\n").trim();
  }
  return text;
}

export function short(p: string): string {
  const home = os.homedir();
  return p === home ? "~" : p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

/** A light Markdown pass: enough structure to read a skill, without hiding its source. */
export function markdown(text: string, columns: number): Line[] {
  const out: Line[] = [];
  let fenced = false;
  for (const raw of text.replaceAll("\t", "    ").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      out.push({ text: truncate(raw, columns), tone: "fence" });
      continue;
    }
    if (fenced) {
      out.push(...wrap(raw, columns).map((t) => ({ text: t, tone: "code" as Tone })));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const level = heading[1].length;
      const tone: Tone = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
      if (out.length && out[out.length - 1].text !== "") out.push({ text: "", tone: "plain" });
      out.push(...wrap(heading[2], columns).map((t) => ({ text: t, tone })));
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push({ text: "─".repeat(columns), tone: "rule" });
    } else if (/^\s*>/.test(raw)) {
      out.push(...wrap(raw.replace(/^\s*>\s?/, "│ "), columns).map((t) => ({ text: t, tone: "quote" as Tone })));
    } else {
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
      if (bullet) {
        const indent = bullet[1].length + 2;
        out.push(...hang(`${bullet[1]}• ${bullet[2]}`, columns, indent).map((t) => ({ text: t, tone: "plain" as Tone })));
      } else {
        out.push(...wrap(raw, columns).map((t) => ({ text: t, tone: "plain" as Tone })));
      }
    }
  }
  return out;
}

/** Keep a cursor visible inside a scrolled window of `rows` lines. */
export function follow(top: number, cursor: number, rows: number, total: number): number {
  if (cursor < top) top = cursor;
  if (cursor >= top + rows) top = cursor - rows + 1;
  return Math.max(0, Math.min(top, Math.max(0, total - rows)));
}
