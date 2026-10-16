#!/usr/bin/env node
// Rebuild every marketing asset from the real app. Nothing here is needed to use the app.
// It exists so the README images can't drift from it: each run builds the app, drives it
// headlessly in a throwaway home directory, and renders what it drew.
//
//   npm run assets
//
// The README images go to docs/assets. Every other screen, the close-up snippets, and a
// 1080p demo video stay in marketing/tools/.cache/build.
// Needs Node 22, Google Chrome (CHROME=/path/to/chrome to override), and Python 3. The
// first run downloads fonts, Pillow, and ffmpeg into marketing/tools/.cache.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const cache = path.join(here, ".cache");
const build = path.join(cache, "build");
const run = (command, ...args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });

run("npm", "run", "--silent", "build");
fs.mkdirSync(build, { recursive: true });
const frames = path.join(build, "frames.json");
run(process.execPath, path.join(here, "capture.mjs"), frames);
run(process.execPath, path.join(here, "render.mjs"), frames, build);

// The GIF and MP4 encoder runs in its own virtual environment. pip skips packages it already has.
const venv = path.join(cache, "venv");
const python = path.join(venv, "bin", "python");
if (!fs.existsSync(python)) run("python3", "-m", "venv", venv);
run(python, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "pillow", "imageio-ffmpeg");
run(python, path.join(here, "encode.py"), build, path.join(build, "demo.gif"), path.join(build, "demo.mp4"));

const docs = path.join(root, "docs", "assets");
fs.mkdirSync(docs, { recursive: true });
for (const file of ["social-card.png", "demo.gif"]) {
  fs.copyFileSync(path.join(build, file), path.join(docs, file));
  console.log(`docs/assets/${file}: ${(fs.statSync(path.join(docs, file)).size / 1e6).toFixed(2)} MB`);
}
