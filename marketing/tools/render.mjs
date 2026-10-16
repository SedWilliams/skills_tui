#!/usr/bin/env node
// Turn captured frames into terminal-window PNGs, plus numbered frames for the demo GIF and video.
// Usage: node render.mjs <frames.json> <out-dir>
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "./chrome.mjs";
import { THEMES, parse, toSvg } from "./terminal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [framesFile, outDir] = process.argv.slice(2);
if (!framesFile || !outDir) throw new Error("Usage: node render.mjs <frames.json> <out-dir>");
const { stills, demo } = JSON.parse(fs.readFileSync(framesFile, "utf-8"));

// Fonts are OFL-licensed and fetched once into a local cache.
const FONTS = {
  "JetBrainsMono.ttf": "https://github.com/google/fonts/raw/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf",
  "JetBrainsMono-Italic.ttf": "https://github.com/google/fonts/raw/main/ofl/jetbrainsmono/JetBrainsMono-Italic%5Bwght%5D.ttf",
  "Archivo.ttf": "https://github.com/google/fonts/raw/main/ofl/archivo/Archivo%5Bwdth,wght%5D.ttf",
};
const fontDir = path.join(here, ".cache", "fonts");
for (const [name, url] of Object.entries(FONTS)) {
  const file = path.join(fontDir, name);
  if (fs.existsSync(file)) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url}: ${res.status}`);
  fs.mkdirSync(fontDir, { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
const font = (name) => pathToFileURL(path.join(fontDir, name)).href;

const METRICS = { font: 15, cell: 9, line: 19 };
const BAR = 38, PAD_X = 16, PAD_Y = 14;
const windowSize = (columns, rows) => ({
  width: columns * METRICS.cell + PAD_X * 2 + 2,
  height: rows * METRICS.line + PAD_Y * 2 + BAR + 3,
});

const css = (theme) => `
@font-face { font-family: JBM; src: url("${font("JetBrainsMono.ttf")}"); font-weight: 100 800; }
@font-face { font-family: JBM; src: url("${font("JetBrainsMono-Italic.ttf")}"); font-weight: 100 800; font-style: italic; }
@font-face { font-family: Archivo; src: url("${font("Archivo.ttf")}"); font-weight: 100 900; font-stretch: 62% 125%; }
html, body { margin: 0; background: transparent; }
.win { box-sizing: border-box; background: ${theme.bg}; border: 1px solid ${theme.border}; border-radius: 12px; overflow: hidden; }
.bar { height: ${BAR}px; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between;
  padding: 0 14px; background: ${theme.bar}; border-bottom: 1px solid ${theme.border}; position: relative;
  font: 500 13px JBM; color: ${theme.title}; }
.dots { display: flex; gap: 8px; }
.dots i { width: 12px; height: 12px; border-radius: 50%; background: ${theme.dots}; }
.title { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
.key { display: flex; align-items: center; gap: 8px; }
kbd { font: 700 12px JBM; color: ${theme.fg}; background: ${theme.bg}; border: 1px solid ${theme.border};
  border-bottom-width: 2px; border-radius: 5px; padding: 1px 7px; }
.screen { padding: ${PAD_Y}px ${PAD_X}px; }
.term { display: block; font-family: JBM; font-variant-ligatures: none; font-feature-settings: "calt" 0, "liga" 0; }
`;

function windowHtml(frame, theme, { key = "" } = {}) {
  const { width, height } = windowSize(frame.columns, frame.rows);
  const [cap, ...label] = key.split("  ");
  return `<div class="win" style="width:${width}px;height:${height}px">
<div class="bar"><span class="dots"><i></i><i></i><i></i></span>
<span class="title">tui-skills · ${frame.columns}×${frame.rows}</span>
<span class="key">${key ? `<kbd>${cap}</kbd><span>${label.join("  ")}</span>` : ""}</span></div>
<div class="screen">${toSvg(parse(frame.ansi, frame.columns, frame.rows), theme, METRICS)}</div></div>`;
}

const page = (theme, body, extra = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${css(theme)}${extra}</style></head><body>${body}</body></html>`;

const browser = await launch();
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(outDir, ".html-"));
let n = 0;
async function shoot(html, out, size) {
  const file = path.join(tmp, `${n++}.html`);
  fs.writeFileSync(file, html);
  await browser.shot(file, out, size);
}

// Stills: every screen in the dark theme at 2x and 3x, and the main screen in the light theme too.
for (const frame of stills) {
  const size = windowSize(frame.columns, frame.rows);
  for (const [themeName, scales] of [["dark", [2, 3]], ["light", frame.name === "browse" ? [2, 3] : []]]) {
    for (const scale of scales) {
      await shoot(page(THEMES[themeName], windowHtml(frame, THEMES[themeName])),
        path.join(outDir, "screens", `${frame.name}-${themeName}@${scale}x.png`), { ...size, scale, transparent: true });
    }
  }
}

// Snippets: a slice of a still without window chrome or background, for close-ups in thumbnails.
// rows and cols are half-open [start, end) ranges of terminal cells.
const SNIPPETS = [
  { name: "apply-agents", still: "apply-all", rows: [9, 13], cols: [2, 32], theme: "dark", scale: 4 },
  { name: "list", still: "browse", rows: [5, 30], cols: [0, 46], theme: "dark", scale: 3 },
  { name: "list", still: "browse", rows: [5, 30], cols: [0, 46], theme: "light", scale: 3 },
];
for (const { name, still, rows: [r0, r1], cols: [c0, c1], theme: themeName, scale } of SNIPPETS) {
  const frame = stills.find((f) => f.name === still);
  const grid = parse(frame.ansi, frame.columns, frame.rows).slice(r0, r1).map((row) => row.slice(c0, c1));
  await shoot(page(THEMES[themeName], toSvg(grid, THEMES[themeName], METRICS)),
    path.join(outDir, "snippets", `${name}-${themeName}@${scale}x.png`),
    { width: (c1 - c0) * METRICS.cell, height: (r1 - r0) * METRICS.line, scale, transparent: true });
}

// Demo frames. The GIF shows the key in the title bar; the 1080p video adds a large keycast below.
const theme = THEMES.dark;
const size = windowSize(demo.columns, demo.rows);
const zoom = 1.3;
const videoCss = `
body { width: 1920px; height: 1080px; background: #0b0e11; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 40px; }
.stage { width: ${size.width * zoom}px; height: ${size.height * zoom}px; }
.stage .win { transform: scale(${zoom}); transform-origin: 0 0; box-shadow: 0 30px 80px rgba(0,0,0,.5); }
.cast { height: 64px; display: flex; align-items: center; gap: 18px; font: 500 30px JBM; color: #9aa5b0; }
.cast kbd { font: 700 28px JBM; padding: 6px 16px; border-radius: 10px; border-bottom-width: 3px; background: #151a1f; }
.cast.empty { visibility: hidden; }`;
const manifest = [];
for (const [i, frame] of demo.frames.entries()) {
  const name = `${String(i).padStart(4, "0")}.png`;
  const full = { ...frame, columns: demo.columns, rows: demo.rows };
  // GIF transparency is 1-bit, so the GIF window gets square corners instead of jagged round ones.
  await shoot(page(theme, windowHtml(full, theme, { key: frame.key }), ".win { border-radius: 0; }"),
    path.join(outDir, "demo", "gif", name), { ...size, scale: 2 });
  const [cap, ...label] = (frame.key || " ").split("  ");
  await shoot(page(theme, `<div class="stage">${windowHtml(full, theme)}</div>`
      + `<div class="cast${frame.key ? "" : " empty"}"><kbd>${cap}</kbd><span>${label.join("  ")}</span></div>`, videoCss),
    path.join(outDir, "demo", "video", name), { width: 1920, height: 1080, scale: 1 });
  manifest.push({ file: name, ms: frame.ms });
}
fs.writeFileSync(path.join(outDir, "demo", "manifest.json"), JSON.stringify(manifest, null, 2));

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Rendered ${stills.length} stills and ${demo.frames.length} demo frames into ${outDir}`);
