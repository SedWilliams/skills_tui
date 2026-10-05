import { Box, Text, useInput, usePaste, type Key } from "ink";
import { useReducer, useRef, useState, type ReactNode } from "react";
import { follow, truncate, width as textWidth } from "./text.js";

export const ACCENT = "cyan";
export const MUTED = "gray";

/** A rounded box with its title set into the top border. */
export function Panel(props: {
  title: string; width: number; height?: number; focused?: boolean; right?: string; children: ReactNode;
}) {
  const { title, width, height, focused = false, right = "" } = props;
  const color = focused ? ACCENT : MUTED;
  const label = truncate(title, Math.max(0, width - 6 - (right ? textWidth(right) + 3 : 0)));
  const fill = Math.max(0, width - 5 - textWidth(label) - (right ? textWidth(right) + 3 : 0));
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0}>
      <Text color={color}>
        ╭─ <Text bold color={focused ? undefined : MUTED}>{label}</Text> {"─".repeat(fill)}
        {right ? <Text> <Text color={MUTED}>{right}</Text> ─</Text> : null}╮
      </Text>
      <Box borderStyle="round" borderTop={false} borderColor={color} flexDirection="column" width={width}
        paddingX={1} overflow="hidden" height={height === undefined ? undefined : height - 1}>
        {props.children}
      </Box>
    </Box>
  );
}

export type Hint = [key: string, label: string, enabled?: boolean];

const hintText = (hints: Hint[]) => hints.map(([k, l]) => `${k} ${l}`).join("  ");

/** How many rows the key bar needs: one if every group fits, else one row per group. */
export function keyRows(groups: Hint[][], columns: number): number {
  return textWidth(groups.map(hintText).join("  │  ")) <= columns - 2 ? 1 : groups.length;
}

export function KeyBar({ groups, width }: { groups: Hint[][]; width: number }) {
  const rows = keyRows(groups, width) === 1 ? [groups] : groups.map((g) => [g]);
  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      {rows.map((row, r) => (
        <Text key={r} wrap="truncate">
          {row.map((hints, g) => (
            <Text key={g}>
              {g > 0 ? <Text color={MUTED}>  │  </Text> : null}
              {hints.map(([key, label, enabled = true], i) => (
                <Text key={key} dimColor={!enabled}>
                  {i > 0 ? "  " : ""}<Text bold color={enabled ? ACCENT : MUTED}>{key}</Text>
                  <Text color={MUTED}> {label}</Text>
                </Text>
              ))}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

const printable = (input: string, key: Key) =>
  input !== "" && !key.ctrl && !key.meta && !key.return && !key.tab && !key.escape
  && !key.backspace && !key.delete;

// ---------- Single-line input ----------

type LineState = { value: string; cursor: number };
type LineAction =
  | { type: "insert"; text: string } | { type: "backspace" } | { type: "delete" }
  | { type: "move"; to: (s: LineState) => number } | { type: "clear-before" };

function lineReducer(s: LineState, a: LineAction): LineState {
  switch (a.type) {
    case "insert":
      return { value: s.value.slice(0, s.cursor) + a.text + s.value.slice(s.cursor), cursor: s.cursor + a.text.length };
    case "backspace":
      return s.cursor === 0 ? s : { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 };
    case "delete":
      return { ...s, value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1) };
    case "move":
      return { ...s, cursor: Math.max(0, Math.min(s.value.length, a.to(s))) };
    case "clear-before":
      return { value: s.value.slice(s.cursor), cursor: 0 };
  }
}

/** Uncontrolled: reports changes through onChange. Remount with a new `key` to reset it. */
export function LineInput(props: {
  initial?: string; focused: boolean; placeholder?: string; width: number; onChange: (value: string) => void;
}) {
  const { focused, placeholder = "", width } = props;
  const [state, setState] = useState(() => ({ value: props.initial ?? "", cursor: (props.initial ?? "").length }));
  // Report changes from the key handler, not an effect, so the parent's update lands in the
  // same render as the keystroke. The ref keeps several keys in one input chunk in order.
  const current = useRef(state);
  const dispatch = (action: LineAction) => {
    const next = lineReducer(current.current, action);
    if (next === current.current) return;
    const changed = next.value !== current.current.value;
    current.current = next;
    setState(next);
    if (changed) props.onChange(next.value);
  };

  useInput((input, key) => {
    if (key.leftArrow) dispatch({ type: "move", to: (s) => s.cursor - 1 });
    else if (key.rightArrow) dispatch({ type: "move", to: (s) => s.cursor + 1 });
    else if (key.home || (key.ctrl && input === "a")) dispatch({ type: "move", to: () => 0 });
    else if (key.end || (key.ctrl && input === "e")) dispatch({ type: "move", to: (s) => s.value.length });
    else if (key.backspace) dispatch({ type: "backspace" });
    else if (key.delete || (key.ctrl && input === "d")) dispatch({ type: "delete" });
    else if (key.ctrl && input === "u") dispatch({ type: "clear-before" });
    else if (printable(input, key)) dispatch({ type: "insert", text: input.replace(/[\r\n]+/g, " ") });
  }, { isActive: focused });
  usePaste((text) => dispatch({ type: "insert", text: text.replace(/[\r\n]+/g, " ") }), { isActive: focused });

  if (!state.value && !focused) return <Text color={MUTED} wrap="truncate">{placeholder}</Text>;
  if (!state.value) {
    return <Text wrap="truncate"><Text inverse>{placeholder[0] ?? " "}</Text><Text color={MUTED}>{placeholder.slice(1)}</Text></Text>;
  }
  // Scroll horizontally so the cursor stays in view.
  const start = Math.max(0, state.cursor - width + 1);
  const visible = state.value.slice(start, start + width);
  const at = state.cursor - start;
  if (!focused) return <Text wrap="truncate">{visible}</Text>;
  return (
    <Text wrap="truncate">
      {visible.slice(0, at)}<Text inverse>{visible[at] ?? " "}</Text>{visible.slice(at + 1)}
    </Text>
  );
}

// ---------- Multi-line editor ----------

type Snapshot = { lines: string[]; row: number; col: number };
export type EditorState = Snapshot & { past: Snapshot[] };
type EditorAction =
  | { type: "insert"; text: string } | { type: "newline" } | { type: "backspace" } | { type: "delete" }
  | { type: "move"; rows?: number; cols?: number } | { type: "home" } | { type: "end" }
  | { type: "top" } | { type: "bottom" } | { type: "undo" } | { type: "load"; text: string };

const snap = (s: EditorState): Snapshot => ({ lines: s.lines, row: s.row, col: s.col });
const edit = (s: EditorState, next: Snapshot): EditorState => ({ ...next, past: [...s.past.slice(-199), snap(s)] });

export function editorText(s: EditorState): string {
  return s.lines.join("\n");
}

export function initEditor(text: string): EditorState {
  return { lines: text.split(/\r?\n/), row: 0, col: 0, past: [] };
}

function editorReducer(s: EditorState, a: EditorAction): EditorState {
  const line = s.lines[s.row];
  switch (a.type) {
    case "insert": {
      const parts = a.text.replaceAll("\t", "  ").split(/\r\n|\r|\n/);
      const head = line.slice(0, s.col), tail = line.slice(s.col);
      const inserted = parts.length === 1 ? [head + parts[0] + tail]
        : [head + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + tail];
      const lines = [...s.lines.slice(0, s.row), ...inserted, ...s.lines.slice(s.row + 1)];
      const row = s.row + parts.length - 1;
      const col = parts.length === 1 ? s.col + parts[0].length : parts[parts.length - 1].length;
      return edit(s, { lines, row, col });
    }
    case "newline":
      return editorReducer(s, { type: "insert", text: "\n" });
    case "backspace": {
      if (s.col > 0) {
        const lines = [...s.lines];
        lines[s.row] = line.slice(0, s.col - 1) + line.slice(s.col);
        return edit(s, { lines, row: s.row, col: s.col - 1 });
      }
      if (s.row === 0) return s;
      const prev = s.lines[s.row - 1];
      const lines = [...s.lines.slice(0, s.row - 1), prev + line, ...s.lines.slice(s.row + 1)];
      return edit(s, { lines, row: s.row - 1, col: prev.length });
    }
    case "delete": {
      if (s.col < line.length) {
        const lines = [...s.lines];
        lines[s.row] = line.slice(0, s.col) + line.slice(s.col + 1);
        return edit(s, { lines, row: s.row, col: s.col });
      }
      if (s.row === s.lines.length - 1) return s;
      const lines = [...s.lines.slice(0, s.row), line + s.lines[s.row + 1], ...s.lines.slice(s.row + 2)];
      return edit(s, { lines, row: s.row, col: s.col });
    }
    case "move": {
      if (a.cols) {
        // Horizontal moves wrap across line ends.
        let { row, col } = s;
        col += a.cols;
        if (col < 0 && row > 0) { row -= 1; col = s.lines[row].length; }
        else if (col > s.lines[row].length && row < s.lines.length - 1) { row += 1; col = 0; }
        return { ...s, row, col: Math.max(0, Math.min(col, s.lines[row].length)) };
      }
      const row = Math.max(0, Math.min(s.lines.length - 1, s.row + (a.rows ?? 0)));
      return { ...s, row, col: Math.min(s.col, s.lines[row].length) };
    }
    case "home":
      return { ...s, col: 0 };
    case "end":
      return { ...s, col: line.length };
    case "top":
      return { ...s, row: 0, col: 0 };
    case "bottom":
      return { ...s, row: s.lines.length - 1, col: s.lines[s.lines.length - 1].length };
    case "undo": {
      const prev = s.past[s.past.length - 1];
      return prev ? { ...prev, past: s.past.slice(0, -1) } : s;
    }
    case "load":
      return edit(s, { ...initEditor(a.text) });
  }
}

export function useEditor(text: string) {
  return useReducer(editorReducer, text, initEditor);
}

/** Editing keys only. The owning screen handles save, cancel, and other commands. */
export function useEditorKeys(
  dispatch: (a: EditorAction) => void, rows: number, active: boolean,
) {
  useInput((input, key) => {
    if (key.upArrow) dispatch({ type: "move", rows: -1 });
    else if (key.downArrow) dispatch({ type: "move", rows: 1 });
    else if (key.leftArrow) dispatch({ type: "move", cols: -1 });
    else if (key.rightArrow) dispatch({ type: "move", cols: 1 });
    else if (key.pageUp) dispatch({ type: "move", rows: -rows });
    else if (key.pageDown) dispatch({ type: "move", rows });
    else if (key.home && key.ctrl) dispatch({ type: "top" });
    else if (key.end && key.ctrl) dispatch({ type: "bottom" });
    else if (key.home || (key.ctrl && input === "a")) dispatch({ type: "home" });
    else if (key.end || (key.ctrl && input === "e")) dispatch({ type: "end" });
    else if (key.return) dispatch({ type: "newline" });
    else if (key.backspace) dispatch({ type: "backspace" });
    else if (key.delete || (key.ctrl && input === "d")) dispatch({ type: "delete" });
    else if (key.tab) dispatch({ type: "insert", text: "  " });
    else if (key.ctrl && input === "z") dispatch({ type: "undo" });
    else if (printable(input, key)) dispatch({ type: "insert", text: input });
  }, { isActive: active });
  usePaste((text) => dispatch({ type: "insert", text }), { isActive: active });
}

export function EditorView({ state, width, height, focused }: {
  state: EditorState; width: number; height: number; focused: boolean;
}) {
  const scroll = useRef({ top: 0, left: 0 });
  const gutter = String(state.lines.length).length + 2;
  const columns = Math.max(1, width - gutter);
  const top = follow(scroll.current.top, state.row, height, state.lines.length);
  const left = state.col < scroll.current.left ? state.col
    : state.col >= scroll.current.left + columns ? state.col - columns + 1 : scroll.current.left;
  scroll.current = { top, left };
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {state.lines.slice(top, top + height).map((line, i) => {
        const row = top + i;
        const number = <Text color={row === state.row ? ACCENT : MUTED}>{String(row + 1).padStart(gutter - 2)}  </Text>;
        const visible = line.slice(left, left + columns);
        if (row !== state.row || !focused) return <Text key={row} wrap="truncate">{number}{visible}</Text>;
        const at = state.col - left;
        return (
          <Text key={row} wrap="truncate">
            {number}{visible.slice(0, at)}<Text inverse>{visible[at] ?? " "}</Text>{visible.slice(at + 1)}
          </Text>
        );
      })}
    </Box>
  );
}
