import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACCENT, EditorView, KeyBar, LineInput, MUTED, Panel, editorText, keyRows, useEditor, useEditorKeys,
  type Hint,
} from "./components.js";
import {
  AGENT_NAMES, Config, Store, absolute, byNameThenPath, discover, installationStatus, isSymlink, lexists, readSkill,
  resolveLoose, skillFile, targetPaths, type Skill,
} from "./core.js";
import {
  body, follow, markdown, pad, short, truncate, width as textWidth, wrap, wrapPath, type Line,
} from "./text.js";

export const TEMPLATE = `---
name: my-skill
description: Describe what this skill does and when an agent should use it.
---

# My skill

Write instructions here. Supporting files can live beside SKILL.md.
`;

type Size = { columns: number; rows: number };
type Tone = "error" | "ok" | "info";
type Message = { text: string; tone: Tone };
const toneColor = (tone: Tone) => (tone === "error" ? "red" : tone === "ok" ? "green" : "yellow");

type Screen =
  | { type: "editor"; title: string; text: string; kind: "markdown" | "json" | "text";
      save: (text: string) => void; done: (changed: boolean) => void }
  | { type: "apply"; skill: Skill }
  | { type: "confirm"; message: string; done: (ok: boolean) => void }
  | { type: "trash" }
  | { type: "help" };

interface Nav {
  push: (screen: Screen) => void;
  pop: () => void;
}

function Messages({ messages }: { messages: Message[] }) {
  return (
    <>
      {messages.map((m, i) => <Text key={i} color={toneColor(m.tone)}>{m.text}</Text>)}
    </>
  );
}

function StyledLine({ line }: { line: Line }) {
  switch (line.tone) {
    case "h1": case "h2": return <Text bold color={ACCENT} wrap="truncate">{line.text || " "}</Text>;
    case "h3": return <Text bold wrap="truncate">{line.text || " "}</Text>;
    case "code": return <Text color="green" wrap="truncate">{line.text || " "}</Text>;
    case "fence": case "rule": return <Text color={MUTED} wrap="truncate">{line.text || " "}</Text>;
    case "quote": return <Text italic color={MUTED} wrap="truncate">{line.text || " "}</Text>;
    default: return <Text wrap="truncate">{line.text || " "}</Text>;
  }
}

// ---------- Main screen ----------

export function App({ config: initialConfig, project: initialProject = "", size }: {
  config: Config; project?: string; size?: Size;
}) {
  const windowSize = useWindowSize();
  const { columns, rows } = size ?? windowSize;
  const { exit } = useApp();
  const [config, setConfig] = useState(initialConfig);
  const [project, setProject] = useState(initialProject);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [scanErrors, setScanErrors] = useState<string[]>([]);
  const [scanning, setScanning] = useState(true);
  const [query, setQuery] = useState("");
  const [searchKey, setSearchKey] = useState(0);
  const [focus, setFocus] = useState<"list" | "search" | "project">("list");
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  // Keyed by directory so a new selection starts at the top without an extra render.
  const [preview, setPreview] = useState({ directory: "", top: 0 });
  const [notice, setNotice] = useState<Message | null>(null);
  const [stack, setStack] = useState<{ id: number; screen: Screen }[]>([]);
  const nextId = useRef(0);
  const scanId = useRef(0);
  const listTop = useRef(0);

  const hasSkills = useRef(false);
  hasSkills.current = skills.length > 0;

  const rescan = useCallback((cfg: Config) => {
    const id = ++scanId.current;
    setScanning(true);
    setNotice(null);
    // With an empty list, show skills as they are found so search works during the first scan.
    // A rescan keeps the current list until it finishes, so rows don't vanish and come back.
    let timer: NodeJS.Timeout | undefined;
    let partial: Skill[] = [];
    const progress = hasSkills.current ? undefined : (found: Skill[]) => {
      partial = found;
      timer ??= setTimeout(() => {
        timer = undefined;
        if (scanId.current === id) setSkills([...partial].sort(byNameThenPath));
      }, 100);
    };
    void discover(cfg, () => scanId.current !== id, progress).then(([found, errors]) => {
      clearTimeout(timer);
      if (scanId.current !== id) return;
      setSkills(found);
      setScanErrors(errors);
      setScanning(false);
    });
  }, []);
  useEffect(() => {
    rescan(initialConfig);
    return () => { scanId.current++; };
  }, [rescan, initialConfig]);

  const nav: Nav = useMemo(() => ({
    push: (screen) => setStack((s) => [...s, { id: nextId.current++, screen }]),
    pop: () => setStack((s) => s.slice(0, -1)),
  }), []);

  const searchText = useMemo(
    () => skills.map((s) => `${s.name} ${s.description} ${s.directory}`.toLowerCase()), [skills]);
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return q ? skills.filter((_, i) => searchText[i].includes(q)) : skills;
  }, [skills, searchText, query]);
  const found = filtered.findIndex((s) => s.directory === selectedDir);
  const cursor = found === -1 ? 0 : found;
  const selected: Skill | undefined = filtered[cursor];

  const previewTop = preview.directory === selected?.directory ? preview.top : 0;

  // Layout
  const modal = stack.length > 0;
  const groups: Hint[][] = focus === "search"
    ? [[["Enter", "keep filter"], ["Esc", "clear"], ["↑↓", "select"], ["Tab", "project"]]]
    : focus === "project"
      ? [[["Enter", "done"], ["Tab", "back to list"], ["Ctrl+U", "clear"]]]
      : [[["a", "apply", !!selected], ["e", "edit", !!selected], ["n", "new"], ["x", "remove", !!selected]],
         [["t", "trash"], ["s", "sources"], ["c", "settings"], ["r", "rescan"], ["?", "help"], ["q", "quit"]]];
  const barRows = keyRows(groups, columns);
  const workspaceH = Math.max(6, rows - 1 - 3 - barRows - 1);
  const listW = Math.max(24, Math.floor(columns * 0.42));
  const previewW = columns - listW - 1;
  const projectW = Math.floor(columns * 0.4);
  const searchW = columns - projectW - 1;
  const listRows = workspaceH - 2;
  const listInner = listW - 4;
  const previewInner = previewW - 4;

  const status = useMemo(() => {
    if (!selected) return "";
    try {
      return installationStatus(selected, targetPaths(config, project));
    } catch (exc) {
      return (exc as Error).message;
    }
    // stack.length: re-check after dialogs that install or remove.
  }, [selected, config, project, stack.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const meta = useMemo(() => {
    if (!selected) return [];
    const out: { text: string; color?: string; dim?: boolean; italic?: boolean }[] = [];
    const rowsOf = (label: string, value: string, color?: string, isPath = false) => {
      const [first, ...rest] = isPath ? wrapPath(value, previewInner - 10) : wrap(value, previewInner - 10);
      out.push({ text: pad(label, 10) + first, color });
      rest.forEach((r) => out.push({ text: " ".repeat(10) + r, color }));
    };
    rowsOf("Path", short(selected.directory), undefined, true);
    rowsOf("Installed", status);
    if (isSymlink(selected.directory)) rowsOf("Links to", short(resolveLoose(selected.directory)), undefined, true);
    if (selected.error) rowsOf("Problem", selected.error, "red");
    if (selected.description && !selected.error) {
      out.push({ text: "" });
      wrap(selected.description.split(/\s+/).join(" "), previewInner).forEach((t) => out.push({ text: t, italic: true }));
    }
    const cap = Math.max(1, Math.floor((workspaceH - 2) / 2));
    if (out.length > cap) {
      out.length = cap;
      const last = out[cap - 1].text;
      out[cap - 1] = { ...out[cap - 1],
        text: textWidth(last) + 2 <= previewInner ? `${last} …` : truncate(last, previewInner) };
    }
    return out;
  }, [selected, status, previewInner, workspaceH]);

  const bodyLines = useMemo(() => {
    if (!selected) {
      const intro = scanning ? "Scanning for SKILL.md files…"
        : "## Start your library\n\nPress n to create a skill, or s to add scan folders.\n\n"
          + "The app finds directories containing SKILL.md, including hidden agent folders.";
      return markdown(intro, previewInner);
    }
    return markdown(body(selected.text) || "No instructions yet.", previewInner);
  }, [selected, scanning, previewInner]);
  const bodyH = Math.max(1, workspaceH - 2 - (meta.length ? meta.length + 1 : 0));
  const maxTop = Math.max(0, bodyLines.length - bodyH);
  const top = Math.min(previewTop, maxTop);
  const scrollPreview = (delta: number) => setPreview({ directory: selected?.directory ?? "",
    top: Math.max(0, Math.min(maxTop, top + delta)) });

  // Actions
  const afterChange = (changed: boolean) => { if (changed) rescan(config); };
  const move = (delta: number) => setSelectedDir((prev) => {
    const at = Math.max(0, filtered.findIndex((s) => s.directory === prev));
    return filtered[Math.max(0, Math.min(filtered.length - 1, at + delta))]?.directory ?? null;
  });
  const moveTo = (index: number) => setSelectedDir(filtered[index]?.directory ?? null);
  const clearSearch = () => { setQuery(""); setSearchKey((k) => k + 1); };

  const actions = {
    apply: () => selected && nav.push({ type: "apply", skill: selected }),
    edit: () => {
      if (!selected) return;
      const skill = readSkill(selected.directory);
      nav.push({ type: "editor", kind: "markdown", title: `Edit ${short(skillFile(skill))} · original backed up on save`,
        text: skill.text, save: (text) => new Store(config).save(skill, text), done: afterChange });
    },
    new: () => nav.push({ type: "editor", kind: "markdown", title: `New skill in ${short(absolute(config.library))}`,
      text: TEMPLATE, save: (text) => { new Store(config).create(text); }, done: afterChange }),
    remove: () => {
      if (!selected) return;
      const dir = selected.directory;
      const link = isSymlink(dir);
      nav.push({ type: "confirm",
        message: `Move this ${link ? "link only" : "entire folder and all its files"} to the app trash?\n\n`
          + `${short(dir)}\n\nOther agents linking to this folder may stop finding it. Restore it from Trash.`,
        done: (ok) => {
          if (!ok) return;
          try {
            new Store(config).trash(dir);
            rescan(config);
            setNotice({ text: `Moved ${short(dir)} to Trash`, tone: "ok" });
          } catch (exc) {
            setNotice({ text: (exc as Error).message, tone: "error" });
          }
        } });
    },
    trash: () => nav.push({ type: "trash" }),
    sources: () => {
      let saved = config;
      nav.push({ type: "editor", kind: "text", title: "Scan folders · one directory per line · ~ is supported",
        text: config.roots.join("\n"),
        save: (text) => {
          const roots = [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(absolute))];
          for (const root of roots) {
            if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Directory not found: ${root}`);
          }
          saved = new Config(config.home, roots, config.library, config.targets, config.excludes);
          saved.save();
          setConfig(saved);
        },
        done: (changed) => { if (changed) rescan(saved); } });
    },
    settings: () => {
      let saved = config;
      nav.push({ type: "editor", kind: "json", title: "Settings · scan roots, library, agent targets, exclusions",
        text: config.text(),
        save: (text) => {
          saved = Config.fromText(config.home, text);
          saved.save();
          setConfig(saved);
        },
        done: (changed) => { if (changed) rescan(saved); } });
    },
    rescan: () => rescan(config),
    help: () => nav.push({ type: "help" }),
  };

  useInput((input, key) => {
    if (focus !== "list") {
      if (key.tab) setFocus(focus === "search" ? "project" : "list");
      else if (focus === "search" && key.escape) { clearSearch(); setFocus("list"); }
      else if (key.return || key.escape) setFocus("list");
      else if (focus === "search" && (key.upArrow || key.downArrow)) move(key.upArrow ? -1 : 1);
      return;
    }
    const ctrl = (c: string) => key.ctrl && input === c;
    if (key.upArrow || input === "k") move(-1);
    else if (key.downArrow || input === "j") move(1);
    else if (key.home || input === "g") moveTo(0);
    else if (key.end || input === "G") moveTo(filtered.length - 1);
    else if (key.pageDown) scrollPreview(Math.max(1, bodyH - 1));
    else if (key.pageUp) scrollPreview(-Math.max(1, bodyH - 1));
    else if (input === "/" || ctrl("f") || key.tab) setFocus("search");
    else if (input === "p") setFocus("project");
    else if (key.escape && query) clearSearch();
    else if (key.return || input === "a" || ctrl("a")) actions.apply();
    else if (input === "e" || ctrl("e")) actions.edit();
    else if (input === "n" || ctrl("n")) actions.new();
    else if (input === "x" || key.delete) actions.remove();
    else if (input === "t") actions.trash();
    else if (input === "s" || ctrl("o")) actions.sources();
    else if (input === "c") actions.settings();
    else if (input === "r" || ctrl("r")) actions.rescan();
    else if (input === "?") actions.help();
    else if (input === "q" || ctrl("q")) exit();
  }, { isActive: !modal });

  listTop.current = follow(listTop.current, cursor, listRows, filtered.length);
  const longestName = useMemo(
    () => filtered.reduce((w, s) => Math.max(w, s.name.length + (s.error ? 2 : 0)), 4), [filtered]);
  const nameW = Math.min(Math.floor(listInner * 0.45), longestName);
  // Measuring and truncating text is slow, so each row's columns are kept until the widths change.
  const rowCache = useMemo(() => new WeakMap<Skill, { name: string; description: string }>(), [nameW, listInner]);
  const rowText = (skill: Skill) => {
    let row = rowCache.get(skill);
    if (!row) {
      row = { name: pad((skill.error ? "! " : "") + skill.name, nameW),
        description: truncate(skill.description.split(/\s+/).join(" "), Math.max(0, listInner - nameW - 2)) };
      rowCache.set(skill, row);
    }
    return row;
  };
  const count = filtered.length === skills.length ? `${skills.length}` : `${filtered.length} of ${skills.length}`;
  const warnings = scanErrors.length;
  const statusLine: Message = notice ?? (scanning
    ? { text: `Scanning folders in the background… ${skills.length} found so far`, tone: "info" }
    : { text: `${skills.length} skills found`
        + (warnings ? ` · ${warnings} scan warning${warnings === 1 ? "" : "s"}, press ? for details` : ""), tone: "info" });

  const renderScreen = (screen: Screen, active: boolean) => {
    const common = { active, columns, rows, nav };
    switch (screen.type) {
      case "editor": return <EditorScreen {...common} {...screen} />;
      case "apply": return <ApplyScreen {...common} skill={screen.skill} config={config} initialProject={project} done={afterChange} />;
      case "confirm": return <ConfirmScreen {...common} message={screen.message} done={screen.done} />;
      case "trash": return <TrashScreen {...common} config={config} done={afterChange} />;
      case "help": return <HelpScreen {...common} config={config} scanErrors={scanErrors} />;
    }
  };

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box display={modal ? "none" : "flex"} flexDirection="column" height={rows}>
        <Text wrap="truncate">
          <Text bold color={ACCENT}> Skills cabinet</Text>
          <Text color={MUTED}>  Find and install local agent skills</Text>
        </Text>
        <Box flexDirection="row" gap={1} height={3}>
          <Panel title="Search  /" width={searchW} height={3} focused={focus === "search"}>
            <LineInput key={searchKey} focused={focus === "search" && !modal} width={searchW - 5}
              placeholder="Name, description, or path" onChange={setQuery} />
          </Panel>
          <Panel title="Project  p" width={projectW} height={3} focused={focus === "project"}>
            <LineInput initial={initialProject} focused={focus === "project" && !modal} width={projectW - 5}
              placeholder="Blank for user-wide targets" onChange={setProject} />
          </Panel>
        </Box>
        <Box flexDirection="row" gap={1} height={workspaceH}>
          <Panel title={`Skills · ${count}`} width={listW} height={workspaceH} focused={focus === "list"}>
            {filtered.length === 0 ? (
              <Text color={MUTED}>{scanning ? "Scanning…" : skills.length ? "No matching skills" : "No skills found"}</Text>
            ) : filtered.slice(listTop.current, listTop.current + listRows).map((skill, i) => {
              const index = listTop.current + i;
              const isCursor = index === cursor;
              const { name, description } = rowText(skill);
              if (isCursor) {
                return (
                  <Text key={skill.directory} wrap="truncate" inverse={focus === "list"} bold color={focus === "list" ? undefined : ACCENT}>
                    {pad(`${name}  ${description}`, listInner)}
                  </Text>
                );
              }
              return (
                <Text key={skill.directory} wrap="truncate">
                  <Text color={skill.error ? "red" : undefined}>{name}</Text>
                  <Text color={MUTED}>  {description}</Text>
                </Text>
              );
            })}
          </Panel>
          <Panel title={selected?.name ?? "Preview"} width={previewW} height={workspaceH}
            right={maxTop > 0 ? `${Math.round((top / maxTop) * 100)}%` : ""}>
            {meta.map((m, i) => (
              <Text key={`m${i}`} wrap="truncate" color={m.color} italic={m.italic}>
                {m.color ? m.text : <><Text color={MUTED}>{m.text.slice(0, 10)}</Text>{m.text.slice(10)}</>}
              </Text>
            ))}
            {meta.length ? <Text color={MUTED}>{"─".repeat(Math.max(0, previewInner))}</Text> : null}
            {bodyLines.slice(top, top + bodyH).map((line, i) => <StyledLine key={`b${top + i}`} line={line} />)}
          </Panel>
        </Box>
        <KeyBar groups={groups} width={columns} />
        <Text wrap="truncate" color={statusLine.tone === "info" ? MUTED : toneColor(statusLine.tone)}> {statusLine.text}</Text>
      </Box>
      {stack.map(({ id, screen }, i) => (
        <Box key={id} display={i === stack.length - 1 ? "flex" : "none"} flexDirection="column" height={rows}>
          {renderScreen(screen, i === stack.length - 1)}
        </Box>
      ))}
    </Box>
  );
}

// ---------- Dialog screens ----------

interface ScreenProps {
  active: boolean;
  columns: number;
  rows: number;
  nav: Nav;
}

function EditorScreen({ active, columns, rows, nav, title, text, kind, save, done }: ScreenProps & {
  title: string; text: string; kind: "markdown" | "json" | "text";
  save: (text: string) => void; done: (changed: boolean) => void;
}) {
  const [state, dispatch] = useEditor(text);
  const [error, setError] = useState("");
  const { suspendTerminal } = useApp();
  const groups: Hint[][] = [[["Ctrl+S", "save"], ["Esc", "cancel"], ["Ctrl+Z", "undo"], ["Ctrl+G", "open in $EDITOR"]]];
  const barRows = keyRows(groups, columns);
  const errorLines = error ? wrap(error, columns - 4) : [];
  const viewH = Math.max(3, rows - barRows - 2 - (errorLines.length ? errorLines.length + 1 : 0));
  useEditorKeys(dispatch, viewH, active);

  const openExternal = async () => {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-skills-"));
    const file = path.join(dir, kind === "json" ? "config.json" : kind === "markdown" ? "SKILL.md" : "sources.txt");
    try {
      fs.writeFileSync(file, editorText(state));
      let status: number | null = 0;
      await suspendTerminal(() => {
        status = spawnSync(`${editor} '${file.replaceAll("'", "'\\''")}'`, { stdio: "inherit", shell: true }).status;
      });
      if (status !== 0) throw new Error(`${editor} exited with status ${status}`);
      const updated = fs.readFileSync(file, "utf-8");
      if (updated !== editorText(state)) dispatch({ type: "load", text: updated });
      setError("");
    } catch (exc) {
      setError((exc as Error).message);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === "s") {
      try {
        save(editorText(state));
        nav.pop();
        done(true);
      } catch (exc) {
        setError((exc as Error).message);
      }
    } else if (key.escape) {
      if (editorText(state) === text) {
        nav.pop();
        done(false);
      } else {
        nav.push({ type: "confirm", message: "Discard unsaved changes?",
          done: (ok) => { if (ok) { nav.pop(); done(false); } } });
      }
    } else if (key.ctrl && input === "g") {
      void openExternal();
    }
  }, { isActive: active });

  const dirty = editorText(state) !== text;
  return (
    <>
      <Panel title={title} width={columns} height={rows - barRows} focused right={dirty ? "modified" : ""}>
        <EditorView state={state} width={columns - 4} height={viewH} focused={active} />
        {errorLines.length ? <Text> </Text> : null}
        {errorLines.map((line, i) => <Text key={i} color="yellow">{line}</Text>)}
      </Panel>
      <KeyBar groups={groups} width={columns} />
    </>
  );
}

function ApplyScreen({ active, columns, rows, nav, skill, config, initialProject, done }: ScreenProps & {
  skill: Skill; config: Config; initialProject: string; done: (changed: boolean) => void;
}) {
  const [project, setProject] = useState(initialProject);
  const [mode, setMode] = useState<"copy" | "link">("copy");
  const [checked, setChecked] = useState(() => AGENT_NAMES.map(() => false));
  const [focus, setFocus] = useState(2); // 0 project, 1 mode, then one row per agent
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [, refresh] = useState(0);
  const changed = useRef(false);
  const store = useMemo(() => new Store(config), [config]);

  let paths: Record<string, string> | null = null;
  let pathError = "";
  try {
    paths = targetPaths(config, project);
  } catch (exc) {
    pathError = (exc as Error).message;
  }

  const apply = () => {
    if (!paths) return setMessages([{ text: pathError, tone: "error" }]);
    const agents = AGENT_NAMES.filter((_, i) => checked[i]);
    if (!agents.length) return setMessages([{ text: "Select at least one agent.", tone: "error" }]);
    const targets = paths;
    setBusy(true);
    setMessages([{ text: "Applying…", tone: "info" }]);
    setTimeout(() => {
      const out: Message[] = [];
      const installed = new Set<string>();
      for (const agent of agents) {
        const root = resolveLoose(targets[agent]);
        if (installed.has(root)) {
          out.push({ text: `${agent}: already installed in the shared folder`, tone: "info" });
          continue;
        }
        try {
          const dest = store.install(skill, targets[agent], mode);
          out.push({ text: `${agent}: applied to ${short(dest)}`, tone: "ok" });
          installed.add(root);
          changed.current = true;
        } catch (exc) {
          out.push({ text: `${agent}: ${(exc as Error).message}`, tone: "error" });
        }
      }
      setMessages(out);
      setBusy(false);
    }, 0);
  };

  const removeSelected = () => {
    if (!paths) return setMessages([{ text: pathError, tone: "error" }]);
    const targets = paths;
    const selected = [...new Set(AGENT_NAMES.filter((_, i) => checked[i])
      .map((agent) => path.join(targets[agent], skill.name)))].sort();
    if (!selected.length) return setMessages([{ text: "Select at least one agent.", tone: "error" }]);
    nav.push({ type: "confirm",
      message: "Move these installed folders or links to Trash?\n\n" + selected.map(short).join("\n"),
      done: (ok) => {
        if (!ok) return;
        const out: Message[] = [];
        for (const p of selected) {
          try {
            store.trash(p);
            out.push({ text: `Removed ${short(p)}`, tone: "ok" });
            changed.current = true;
          } catch (exc) {
            out.push({ text: (exc as Error).message, tone: "error" });
          }
        }
        setMessages(out);
        refresh((n) => n + 1);
      } });
  };

  const rowCount = 2 + AGENT_NAMES.length;
  useInput((input, key) => {
    if (busy) return;
    if (key.escape) {
      nav.pop();
      done(changed.current);
      return;
    }
    if (key.downArrow || (key.tab && !key.shift)) setFocus((f) => (f + 1) % rowCount);
    else if (key.upArrow || (key.tab && key.shift)) setFocus((f) => (f + rowCount - 1) % rowCount);
    else if (focus === 0) { if (key.return) setFocus(2); }
    else if (focus === 1 && (input === " " || key.leftArrow || key.rightArrow)) setMode((m) => (m === "copy" ? "link" : "copy"));
    else if (focus >= 2 && input === " ") setChecked((c) => c.map((v, i) => (i === focus - 2 ? !v : v)));
    else if (input === "A") setChecked((c) => c.map(() => !c.every(Boolean)));
    else if (key.return || input === "a") apply();
    else if (input === "x") removeSelected();
  }, { isActive: active });

  const groups: Hint[][] = [[["↑↓", "move"], ["Space", "toggle"], ["A", "all"], ["Enter", "apply selected"],
    ["x", "remove selected"], ["Esc", "close"]]];
  const barRows = keyRows(groups, columns);
  const inner = columns - 4;
  const pointer = (row: number) => <Text color={ACCENT}>{focus === row ? "› " : "  "}</Text>;
  const label = (text: string, row: number) => <Text bold={focus === row}>{pad(text, 9)}</Text>;
  const agentW = Math.max(...AGENT_NAMES.map((a) => a.length)) + 2;
  return (
    <>
      <Panel title={`Apply ${skill.name}`} width={columns} height={rows - barRows} focused>
        {wrap("Existing folders are never overwritten. Review unfamiliar skills before applying them.", inner)
          .map((line, i) => <Text key={i} color={MUTED}>{line}</Text>)}
        <Text> </Text>
        <Box flexDirection="row">
          {pointer(0)}{label("Project", 0)}
          <LineInput initial={initialProject} focused={active && focus === 0} width={inner - 11}
            placeholder="Blank for user-wide installation" onChange={(v) => { setProject(v); setMessages([]); }} />
        </Box>
        <Text> </Text>
        <Text wrap="truncate">
          {pointer(1)}{label("Mode", 1)}
          <Text color={mode === "copy" ? ACCENT : MUTED}>{mode === "copy" ? "●" : "○"} </Text>
          <Text bold={mode === "copy"}>Copy</Text><Text color={MUTED}>  includes every file, keeps edits separate</Text>
        </Text>
        <Text wrap="truncate">
          {"           "}<Text color={mode === "link" ? ACCENT : MUTED}>{mode === "link" ? "●" : "○"} </Text>
          <Text bold={mode === "link"}>Link</Text><Text color={MUTED}>  shares future edits, keep the source in place</Text>
        </Text>
        <Text> </Text>
        <Text>{"  "}<Text bold>Agents</Text></Text>
        {AGENT_NAMES.map((agent, i) => {
          const dest = paths ? path.join(paths[agent], skill.name) : "";
          const state = dest && lexists(dest) ? (isSymlink(dest) ? "linked" : "installed") : "";
          return (
            <Text key={agent} wrap="truncate">
              {pointer(i + 2)}
              <Text color={checked[i] ? ACCENT : MUTED}>{checked[i] ? "[x]" : "[ ]"}</Text>{" "}
              <Text bold={focus === i + 2}>{pad(agent, agentW)}</Text>
              <Text color="green">{pad(state, 11)}</Text>
              <Text color={MUTED}>{dest ? short(dest) : "—"}</Text>
            </Text>
          );
        })}
        <Text> </Text>
        {pathError ? <Text color="red">{pathError}</Text> : <Messages messages={messages} />}
      </Panel>
      <KeyBar groups={groups} width={columns} />
    </>
  );
}

function ConfirmScreen({ active, columns, rows, nav, message, done }: ScreenProps & {
  message: string; done: (ok: boolean) => void;
}) {
  useInput((input, key) => {
    if (input === "y" || input === "Y") { nav.pop(); done(true); }
    else if (input === "n" || input === "N" || key.escape) { nav.pop(); done(false); }
  }, { isActive: active });
  const width = Math.min(columns, 90);
  const lines = message.split("\n").flatMap((line) => wrap(line, width - 4)).map((l) => l || " ");
  return (
    <Box width={columns} height={rows} alignItems="center" justifyContent="center">
      <Panel title="Confirm" width={width} height={lines.length + 5} focused>
        {lines.map((line, i) => <Text key={i}>{line}</Text>)}
        <Text> </Text>
        <Text><Text bold color={ACCENT}>y</Text><Text color={MUTED}> confirm   </Text>
          <Text bold color={ACCENT}>n</Text><Text color={MUTED}> cancel</Text></Text>
      </Panel>
    </Box>
  );
}

function TrashScreen({ active, columns, rows, nav, config, done }: ScreenProps & {
  config: Config; done: (changed: boolean) => void;
}) {
  const store = useMemo(() => new Store(config), [config]);
  const [records, setRecords] = useState(() => store.trashEntries());
  const [cursor, setCursor] = useState(0);
  const [message, setMessage] = useState<Message | null>(null);
  const changed = useRef(false);
  const top = useRef(0);

  const items = records.map((record) => {
    let original = "Unreadable trash record";
    try {
      original = short(JSON.parse(fs.readFileSync(record, "utf-8")).original);
    } catch { /* shown as unreadable */ }
    const id = path.basename(path.dirname(record));
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
    return { removed: m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : id, original };
  });

  useInput((input, key) => {
    if (key.escape || input === "q") { nav.pop(); done(changed.current); }
    else if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor((c) => Math.min(records.length - 1, c + 1));
    else if ((key.return || input === "r") && records.length) {
      try {
        const restored = store.restore(records[cursor]);
        changed.current = true;
        const next = store.trashEntries();
        setRecords(next);
        setCursor((c) => Math.max(0, Math.min(c, next.length - 1)));
        setMessage({ text: `Restored ${short(restored)}`, tone: "ok" });
      } catch (exc) {
        setMessage({ text: (exc as Error).message, tone: "error" });
      }
    }
  }, { isActive: active });

  const groups: Hint[][] = [[["↑↓", "select"], ["Enter", "restore"], ["Esc", "close"]]];
  const barRows = keyRows(groups, columns);
  const listH = Math.max(1, rows - barRows - 2 - 4);
  const inner = columns - 4;
  top.current = follow(top.current, cursor, listH, items.length);
  return (
    <>
      <Panel title="Trash" width={columns} height={rows - barRows} focused
        right={`${records.length} item${records.length === 1 ? "" : "s"}`}>
        <Text color={MUTED} wrap="truncate">Restore removed skill folders or links to their original path.</Text>
        <Text> </Text>
        <Box flexDirection="column" height={listH}>
          {items.length === 0 ? <Text color={MUTED}>Trash is empty.</Text>
            : items.slice(top.current, top.current + listH).map((item, i) => {
              const index = top.current + i;
              const line = `${pad(item.removed, 19)}  ${truncate(item.original, inner - 21, "start")}`;
              return index === cursor
                ? <Text key={index} inverse bold wrap="truncate">{pad(line, inner)}</Text>
                : <Text key={index} wrap="truncate"><Text color={MUTED}>{line.slice(0, 21)}</Text>{line.slice(21)}</Text>;
            })}
        </Box>
        <Text> </Text>
        {message ? <Text color={toneColor(message.tone)} wrap="truncate">{message.text}</Text> : <Text> </Text>}
      </Panel>
      <KeyBar groups={groups} width={columns} />
    </>
  );
}

function helpText(config: Config, scanErrors: string[]): string {
  return `# Skills cabinet

## Keys

- ↑↓ or j/k select a skill. g and G jump to the first and last. PgUp and PgDn scroll the preview.
- / searches names, descriptions, and paths. Enter keeps the filter. Esc clears it.
- p sets a project directory for project-local targets. Blank means user-wide targets.
- Enter or a opens Apply, which copies or links the whole skill folder into the agents you select.
- e edits SKILL.md and saves a backup first. n creates a skill in your library.
- x moves the selected folder to this app's trash. For symlinks, only the link moves.
- t opens Trash, which restores removed items if their original path is free.
- s edits scan folders, one path per line. Removing a scan folder does not delete files.
- c edits settings as JSON. roots adds scan locations. excludes skips directory names or suffixes.
- r rescans. q quits.

In the editor, Ctrl+S saves, Esc cancels, Ctrl+Z undoes, and Ctrl+G opens the text in $VISUAL or $EDITOR.

## Notes

- Codex and Antigravity share .agents/skills for projects. A shared folder needs one install.
- In Apply, x uninstalls only the selected agent targets, including links.
- Scans skip node_modules, Library, caches, virtual environments, and Git internals by default. To scan inside a skipped folder, add the skill directory itself with s.
- The preview checks for a skill with the same name in each target folder. It doesn't compare contents or check what an agent has loaded.
- Editing a linked skill changes the source for every agent using it. Apply copies again to update them.
- The app won't overwrite an existing installation. Remove it first, then apply the new version.
- Invalid skills remain visible so you can repair their frontmatter in the editor.
- This app never executes skills. Review their instructions and supporting files before use.
- Restart or reload the coding agent after applying changes. Pi supports /reload.

## Locations

- Configuration: ${short(path.join(config.home, "config.json"))}
- Backups: ${short(path.join(config.home, "backups"))}

## Scan warnings

${scanErrors.length ? scanErrors.map((e) => `- ${e}`).join("\n") : "None"}
`;
}

function HelpScreen({ active, columns, rows, nav, config, scanErrors }: ScreenProps & {
  config: Config; scanErrors: string[];
}) {
  const [top, setTop] = useState(0);
  const groups: Hint[][] = [[["↑↓", "scroll"], ["PgUp/PgDn", "page"], ["Esc", "close"]]];
  const barRows = keyRows(groups, columns);
  const lines = useMemo(() => markdown(helpText(config, scanErrors), columns - 4), [config, scanErrors, columns]);
  const height = rows - barRows - 2;
  const maxTop = Math.max(0, lines.length - height);
  useInput((input, key) => {
    if (key.escape || input === "q" || input === "?") nav.pop();
    else if (key.upArrow || input === "k") setTop((t) => Math.max(0, t - 1));
    else if (key.downArrow || input === "j") setTop((t) => Math.min(maxTop, t + 1));
    else if (key.pageUp) setTop((t) => Math.max(0, t - height + 1));
    else if (key.pageDown) setTop((t) => Math.min(maxTop, t + height - 1));
  }, { isActive: active });
  return (
    <>
      <Panel title="Help" width={columns} height={rows - barRows} focused
        right={maxTop ? `${Math.round((top / maxTop) * 100)}%` : ""}>
        {lines.slice(top, top + height).map((line, i) => <StyledLine key={top + i} line={line} />)}
      </Panel>
      <KeyBar groups={groups} width={columns} />
    </>
  );
}
