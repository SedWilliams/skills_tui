// Render an ANSI frame from the app as SVG. Text uses a monospace web font; box-drawing
// characters and the Apply screen's radio dots are drawn as paths, the way terminal
// emulators do, so borders join without gaps at any line height.

export const THEMES = {
  dark: {
    bg: "#0f1317", bar: "#151a1f", border: "#262d34", fg: "#d9dfe5", dots: "#3a434c", title: "#7d8893",
    ansi: ["#1b2026", "#f0727a", "#8fd69f", "#e8c27a", "#6fb3f5", "#c79bf2", "#5ccfe6", "#d9dfe5",
      "#6c7781", "#ff8a91", "#a6e3b3", "#f2d38f", "#8cc4ff", "#d8b4fe", "#7dd9ec", "#ffffff"],
  },
  light: {
    bg: "#ffffff", bar: "#f3f5f7", border: "#d6dce2", fg: "#1d2127", dots: "#c8cfd6", title: "#69737d",
    ansi: ["#1d2127", "#c4242e", "#1a7d38", "#8f5d00", "#0b62c4", "#7a46d4", "#087b94", "#e9edf1",
      "#69737d", "#d1333c", "#1f8f43", "#9f6c00", "#1a72d6", "#8a57e0", "#0c8aa5", "#ffffff"],
  },
};

const RESET = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };

function applySgr(style, params) {
  const codes = params === "" ? [0] : params.split(";").map(Number);
  const next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) Object.assign(next, RESET);
    else if (c === 1) next.bold = true;
    else if (c === 2) next.dim = true;
    else if (c === 3) next.italic = true;
    else if (c === 4) next.underline = true;
    else if (c === 7) next.inverse = true;
    else if (c === 22) next.bold = next.dim = false;
    else if (c === 23) next.italic = false;
    else if (c === 24) next.underline = false;
    else if (c === 27) next.inverse = false;
    else if (c >= 30 && c <= 37) next.fg = c - 30;
    else if (c >= 90 && c <= 97) next.fg = c - 90 + 8;
    else if (c === 39) next.fg = null;
    else if (c >= 40 && c <= 47) next.bg = c - 40;
    else if (c >= 100 && c <= 107) next.bg = c - 100 + 8;
    else if (c === 49) next.bg = null;
    else if ((c === 38 || c === 48) && codes[i + 1] === 5) i += 2; // 256 colors: unused by the app
    else if ((c === 38 || c === 48) && codes[i + 1] === 2) i += 4;
  }
  return next;
}

/** Parse a frame into rows of { ch, ...style } cells, `columns` wide. Styles carry across lines. */
export function parse(ansi, columns, rows) {
  const grid = [];
  let style = { ...RESET };
  const lines = ansi.split("\n");
  for (let r = 0; r < rows; r++) {
    const line = lines[r] ?? "";
    const cells = [];
    for (let i = 0; i < line.length;) {
      const sgr = /^\u001B\[([0-9;]*)m/.exec(line.slice(i, i + 24));
      if (sgr) {
        style = applySgr(style, sgr[1]);
        i += sgr[0].length;
        continue;
      }
      const ch = String.fromCodePoint(line.codePointAt(i));
      cells.push({ ch, ...style });
      i += ch.length;
    }
    while (cells.length < columns) cells.push({ ch: " ", ...RESET });
    grid.push(cells.slice(0, columns));
  }
  return grid;
}

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// Segments from the cell centre to each edge, keyed by character.
const LINES = {
  "─": "lr", "│": "tb", "┌": "rb", "┐": "lb", "└": "tr", "┘": "tl",
  "├": "tbr", "┤": "tbl", "┬": "lrb", "┴": "lrt", "┼": "lrtb",
};
const ARCS = { "╭": "rb", "╮": "lb", "╰": "tr", "╯": "tl" };

function boxPath(ch, x, y, w, h) {
  const cx = x + w / 2, cy = y + h / 2;
  const to = { l: [x, cy], r: [x + w, cy], t: [cx, y], b: [cx, y + h] };
  if (LINES[ch]) {
    // One path through the centre for the first two edges keeps corners mitred.
    const [first, ...rest] = [...LINES[ch]];
    return `M${to[first][0]} ${to[first][1]}L${cx} ${cy}`
      + rest.map((e, i) => `${i ? `M${cx} ${cy}` : ""}L${to[e][0]} ${to[e][1]}`).join("");
  }
  if (ARCS[ch]) {
    const [a, b] = ARCS[ch];
    const r = Math.min(w, h) / 2;
    const [ax, ay] = to[a], [bx, by] = to[b];
    // Straight in from the first edge, a quarter circle around the centre, out to the second edge.
    const p1 = [cx + Math.sign(ax - cx) * r, cy + Math.sign(ay - cy) * r];
    const p2 = [cx + Math.sign(bx - cx) * r, cy + Math.sign(by - cy) * r];
    // The arc bends toward the cell centre: counterclockwise on screen when turning clockwise.
    const sweep = (p1[0] - cx) * (p2[1] - cy) - (p1[1] - cy) * (p2[0] - cx) > 0 ? 0 : 1;
    return `M${ax} ${ay}L${p1[0]} ${p1[1]}A${r} ${r} 0 0 ${sweep} ${p2[0]} ${p2[1]}L${bx} ${by}`;
  }
  return null;
}

/**
 * SVG markup for a parsed grid. Metrics are CSS pixels: `font` size, `cell` width and
 * `line` height. Ascent and descent are the font's em fractions, for baseline placement.
 */
export function toSvg(grid, theme, { font = 15, cell = 9, line = 19, ascent = 1.02, descent = 0.3 } = {}) {
  const rows = grid.length, columns = grid[0]?.length ?? 0;
  const width = columns * cell, height = rows * line;
  const baseline = (line - (ascent + descent) * font) / 2 + ascent * font;
  const color = (index, fallback) => (index === null ? fallback : theme.ansi[index]);
  const rects = [], texts = [], paths = new Map(), dots = [];
  const stroke = (fill, d) => paths.set(fill, (paths.get(fill) ?? "") + d);

  grid.forEach((cells, r) => {
    const y = r * line;
    let run = null;
    const flush = () => {
      if (!run || !run.text.trim()) { run = null; return; }
      const attrs = [`x="${run.x}"`, `y="${(y + baseline).toFixed(2)}"`, `fill="${run.fill}"`];
      if (run.bold) attrs.push(`font-weight="700"`);
      if (run.italic) attrs.push(`font-style="italic"`);
      if (run.dim) attrs.push(`opacity="0.5"`);
      if (run.underline) attrs.push(`text-decoration="underline"`);
      // No-break spaces keep column alignment; browsers ignore xml:space in inline SVG.
      texts.push(`<text ${attrs.join(" ")}>${escape(run.text).replaceAll(" ", " ")}</text>`);
      run = null;
    };
    cells.forEach((c, col) => {
      let fg = color(c.fg, theme.fg), bg = color(c.bg, null);
      if (c.inverse) [fg, bg] = [bg ?? theme.bg, fg];
      const x = col * cell;
      if (bg) {
        const last = rects[rects.length - 1];
        if (last && last.y === y && last.fill === bg && last.x + last.w === x) last.w += cell;
        else rects.push({ x, y, w: cell, fill: bg });
      }
      const box = boxPath(c.ch, x, y, cell, line);
      if (box || c.ch === "●" || c.ch === "○") {
        flush();
        if (box) stroke(fg, box);
        else dots.push(`<circle cx="${x + cell / 2}" cy="${y + line / 2}" r="${(cell * 0.34).toFixed(2)}" `
          + (c.ch === "●" ? `fill="${fg}"/>` : `fill="none" stroke="${fg}" stroke-width="1.2"/>`));
        return;
      }
      const key = [fg, c.bold, c.italic, c.dim, c.underline].join();
      if (run && run.key !== key) flush();
      if (!run) run = { key, x, text: "", fill: fg, bold: c.bold, italic: c.italic, dim: c.dim, underline: c.underline };
      run.text += c.ch;
    });
    flush();
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" `
    + `class="term" font-size="${font}" xml:space="preserve">`
    + rects.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${line}" fill="${b.fill}"/>`).join("")
    + [...paths].map(([fill, d]) => `<path d="${d}" stroke="${fill}" stroke-width="1" fill="none"/>`).join("")
    + dots.join("") + texts.join("") + "</svg>";
}
