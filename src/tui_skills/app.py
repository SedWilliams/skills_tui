from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Callable, Optional

from rich.console import Group
from rich.table import Table
from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, HorizontalScroll, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import (
    Button, Checkbox, DataTable, Footer, Header, Input, Label, Markdown,
    Select, Static, TextArea,
)
from textual.worker import get_current_worker

from .core import (
    AGENTS, Config, Skill, Store, absolute, discover, installation_status,
    read_skill, target_paths,
)

TEMPLATE = '''---
name: my-skill
description: Describe what this skill does and when an agent should use it.
---

# My skill

Write instructions here. Supporting files can live beside SKILL.md.
'''


def body(text: str) -> str:
    """Return SKILL.md without its frontmatter, which the detail header already shows."""
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        if end is not None:
            return "\n".join(lines[end + 1:]).strip()
    return text


def short(path: Path) -> str:
    try:
        return "~/" + str(path.relative_to(Path.home()))
    except ValueError:
        return str(path)


class Confirm(ModalScreen[bool]):
    BINDINGS = [("escape", "cancel", "Cancel")]

    def __init__(self, message: str):
        super().__init__()
        self.message = message

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog confirm"):
            yield Label(self.message, markup=False, classes="message")
            with Horizontal(classes="buttons"):
                yield Button("Cancel", id="no")
                yield Button("Confirm", variant="error", id="yes")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.dismiss(event.button.id == "yes")

    def action_cancel(self) -> None:
        self.dismiss(False)


class Editor(ModalScreen[bool]):
    BINDINGS = [("ctrl+s", "save", "Save"), ("escape", "cancel", "Cancel")]

    def __init__(self, title: str, text: str, save: Callable[[str], object], language: Optional[str] = "markdown"):
        super().__init__()
        self.editor_title, self.original, self.save_callback = title, text, save
        self.language = language

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog editor"):
            yield Label(self.editor_title, markup=False, classes="title")
            yield TextArea(self.original, language=self.language, show_line_numbers=True, id="editor")
            yield Static("", id="editor-error", markup=False)
            with Horizontal(classes="buttons"):
                yield Button("Cancel", id="cancel")
                yield Button("Save", id="save", variant="primary")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one(TextArea).focus()

    def action_save(self) -> None:
        try:
            self.save_callback(self.query_one(TextArea).text)
        except (OSError, ValueError) as exc:
            error = self.query_one("#editor-error", Static)
            error.update(str(exc))
            error.display = True
            return
        self.dismiss(True)

    def action_cancel(self) -> None:
        if self.query_one(TextArea).text != self.original:
            self.app.push_screen(Confirm("Discard unsaved changes?"), self.discard)
        else:
            self.dismiss(False)

    def discard(self, confirmed: bool) -> None:
        if confirmed:
            self.dismiss(False)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.id == "save":
            self.action_save()
        elif event.button.id == "cancel":
            self.action_cancel()


class Apply(ModalScreen[bool]):
    BINDINGS = [("escape", "cancel", "Close")]

    def __init__(self, skill: Skill, config: Config, project: str):
        super().__init__()
        self.skill, self.config, self.project = skill, config, project
        self.changed = False
        self.busy = False

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog apply"):
            yield Label(f"Apply {self.skill.name}", markup=False, classes="title")
            yield Static("Existing folders are never overwritten. Review unfamiliar skills before applying them.",
                         classes="hint")
            project = Input(self.project, placeholder="Blank for user-wide installation", id="project")
            project.border_title = "Project"
            yield project
            mode = Select([("Copy: includes every file, keeps edits separate", "copy"),
                           ("Link: shares future edits, keep the source in place", "link")],
                          value="copy", allow_blank=False, id="mode")
            mode.border_title = "Mode"
            yield mode
            with VerticalScroll(id="agent-options") as agents:
                agents.border_title = "Agents"
                for i, agent in enumerate(AGENTS):
                    yield Checkbox(agent, id=f"agent-{i}")
                    yield Static("", id=f"target-{i}", markup=False, classes="target-path")
            yield Static("", id="apply-result", markup=False)
            with Horizontal(classes="buttons"):
                yield Button("Close", id="close")
                yield Button("Remove selected", id="uninstall", variant="error")
                yield Button("Apply selected", id="apply", variant="primary")

    def on_mount(self) -> None:
        self.update_paths()

    def on_input_changed(self, event: Input.Changed) -> None:
        self.update_paths()

    def update_paths(self) -> None:
        try:
            paths = target_paths(self.config, self.query_one("#project", Input).value)
            for i, (agent, path) in enumerate(paths.items()):
                self.query_one(f"#target-{i}", Static).update(short(path / self.skill.name))
            self.query_one("#apply-result", Static).update("")
        except ValueError as exc:
            self.query_one("#apply-result", Static).update(str(exc))

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.id == "close":
            self.action_cancel()
        elif event.button.id == "uninstall" and not self.busy:
            try:
                paths = target_paths(self.config, self.query_one("#project", Input).value)
                selected = {paths[agent] / self.skill.name for i, agent in enumerate(AGENTS)
                            if self.query_one(f"#agent-{i}", Checkbox).value}
                if not selected:
                    raise ValueError("Select at least one agent.")
            except ValueError as exc:
                self.query_one("#apply-result", Static).update(str(exc))
                return

            def remove(confirmed: bool) -> None:
                if not confirmed:
                    return
                messages = []
                for path in sorted(selected):
                    try:
                        Store(self.config).trash(path)
                        messages.append(f"Removed {path}")
                        self.changed = True
                    except (OSError, ValueError) as exc:
                        messages.append(str(exc))
                self.query_one("#apply-result", Static).update("\n".join(messages))

            self.app.push_screen(Confirm("Move these installed folders or links to Trash?\n\n" +
                                         "\n".join(str(path) for path in sorted(selected))), remove)
        elif event.button.id == "apply" and not self.busy:
            try:
                paths = target_paths(self.config, self.query_one("#project", Input).value)
            except ValueError as exc:
                self.query_one("#apply-result", Static).update(str(exc))
                return
            selected = [agent for i, agent in enumerate(AGENTS) if self.query_one(f"#agent-{i}", Checkbox).value]
            if not selected:
                self.query_one("#apply-result", Static).update("Select at least one agent.")
                return
            self.busy = True
            self.query_one("#apply", Button).disabled = True
            self.query_one("#uninstall", Button).disabled = True
            self.query_one("#close", Button).disabled = True
            messages, done = [], set()
            try:
                for agent in selected:
                    root = paths[agent]
                    if root.resolve() in done:
                        messages.append(f"{agent}: already installed in the shared folder")
                        continue
                    try:
                        dest = await asyncio.to_thread(Store(self.config).install, self.skill, root,
                                                       self.query_one("#mode", Select).value)
                        messages.append(f"{agent}: applied to {dest}")
                        done.add(root.resolve())
                        self.changed = True
                    except (OSError, ValueError) as exc:
                        messages.append(f"{agent}: {exc}")
                self.query_one("#apply-result", Static).update("\n".join(messages))
            finally:
                self.busy = False
                self.query_one("#apply", Button).disabled = False
                self.query_one("#uninstall", Button).disabled = False
                self.query_one("#close", Button).disabled = False

    def action_cancel(self) -> None:
        if not self.busy:
            self.dismiss(self.changed)


class Trash(ModalScreen[bool]):
    BINDINGS = [("escape", "cancel", "Close")]

    def __init__(self, store: Store):
        super().__init__()
        self.store = store
        self.changed = False
        self.records: list[Path] = []

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog trash"):
            yield Label("Trash", classes="title")
            yield Static("Restore removed skill folders or links to their original path.", classes="hint")
            yield DataTable(id="trash-table", cursor_type="row")
            yield Static("", id="trash-result", markup=False)
            with Horizontal(classes="buttons"):
                yield Button("Close", id="close")
                yield Button("Restore selected", id="restore", variant="primary")

    def on_mount(self) -> None:
        self.query_one(DataTable).add_columns("Removed", "Original path")
        self.refresh_rows()

    def refresh_rows(self) -> None:
        table = self.query_one(DataTable)
        table.clear()
        self.records = self.store.trash_entries()
        for i, record in enumerate(self.records):
            try:
                original = json.loads(record.read_text(encoding="utf-8"))["original"]
            except (OSError, ValueError, KeyError):
                original = "Unreadable trash record"
            table.add_row(record.parent.name, Text(original), key=str(i))
        self.query_one("#restore", Button).disabled = not self.records
        if not self.records:
            self.query_one("#trash-result", Static).update("Trash is empty.")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.id == "close":
            self.action_cancel()
        elif event.button.id == "restore" and self.records:
            try:
                record = self.records[self.query_one(DataTable).cursor_row]
                path = self.store.restore(record)
                self.changed = True
                self.refresh_rows()
                self.query_one("#trash-result", Static).update(f"Restored {path}")
            except (OSError, ValueError, KeyError) as exc:
                self.query_one("#trash-result", Static).update(str(exc))

    def action_cancel(self) -> None:
        self.dismiss(self.changed)


class SkillsApp(App):
    TITLE = "Skills cabinet"
    SUB_TITLE = "Find and install local agent skills"
    CSS = '''
    #toolbar { height: 3; margin: 1 1 0 1; }
    #toolbar Input { border: round $border-blurred; }
    #toolbar Input:focus { border: round $border; }
    #search { width: 1fr; }
    #scope { width: 40%; margin-left: 1; }
    #workspace { height: 1fr; margin: 0 1; }
    #toolbar Input { border-title-color: $foreground-muted; }
    .panel { border: round $border-blurred; border-title-color: $foreground-muted; }
    .panel:focus-within { border: round $border; border-title-color: $text; }
    #catalog { width: 44%; }
    #skills { height: 1fr; }
    #detail { width: 1fr; margin-left: 1; }
    #detail-meta { height: auto; max-height: 10; padding: 0 1; margin-bottom: 1; background: $boost; }
    #preview-scroll { height: 1fr; padding: 0 1; }
    #actions { height: auto; margin: 0 1; }
    #actions Button { min-width: 8; margin-right: 1; }
    #actions .separator { width: 1; height: 3; margin-right: 1; color: $border-blurred; }
    #status { height: 1; padding: 0 2; color: $foreground-muted; }
    ModalScreen { align: center middle; background: $background 70%; }
    .dialog { width: 85%; max-width: 120; height: auto; max-height: 94%; padding: 1 2;
              border: round $border; background: $surface; }
    .dialog .title { width: 1fr; text-style: bold; color: $text; margin-bottom: 1; }
    .dialog .message { width: 1fr; margin-bottom: 1; }
    .dialog .hint { color: $foreground-muted; margin-bottom: 1; }
    .buttons { height: 3; align-horizontal: right; margin-top: 1; }
    .buttons Button { margin-left: 1; }
    .editor, .help { height: 92%; }
    .editor TextArea, .help VerticalScroll { height: 1fr; }
    #editor-error { height: auto; max-height: 5; color: $warning; margin-top: 1; display: none; }
    .confirm { width: 70%; max-width: 90; }
    .apply { height: 90%; }
    .apply Input, .apply Select { margin-bottom: 1; }
    .apply Input { border: round $border-blurred; }
    .apply Input:focus { border: round $border; }
    #agent-options { height: 1fr; min-height: 6; border: round $border-blurred; padding: 0 1;
                     border-title-color: $foreground-muted; }
    #agent-options Checkbox { border: none; padding: 0; height: 1; background: transparent; }
    #agent-options Checkbox:focus { text-style: bold; }
    .target-path { padding-left: 4; height: auto; color: $foreground-muted; margin-bottom: 1; }
    #apply-result { height: auto; max-height: 9; color: $warning; }
    .trash { height: 75%; }
    #trash-table { height: 1fr; }
    #trash-result { height: auto; color: $foreground-muted; }
    '''
    BINDINGS = [
        ("ctrl+f", "search", "Search"), ("ctrl+n", "new", "New"),
        ("ctrl+e", "edit", "Edit"), ("ctrl+a", "apply", "Apply"),
        ("ctrl+r", "rescan", "Rescan"), ("ctrl+o", "sources", "Sources"),
        ("ctrl+comma", "settings", "Settings"),
        ("ctrl+q", "quit", "Quit"),
    ]

    def __init__(self, config: Config, project: str = ""):
        super().__init__()
        self.config, self.project = config, project
        self.skills: list[Skill] = []
        self.filtered: list[Skill] = []
        self.scan_errors: list[str] = []

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="toolbar"):
            search = Input(placeholder="Name, description, or path", id="search")
            search.border_title = "Search"
            yield search
            scope = Input(self.project, placeholder="Blank for user-wide targets", id="scope")
            scope.border_title = "Project"
            yield scope
        with Horizontal(id="workspace"):
            with Vertical(id="catalog", classes="panel") as catalog:
                catalog.border_title = "Skills"
                yield DataTable(id="skills", cursor_type="row", zebra_stripes=True)
            with Vertical(id="detail", classes="panel") as detail:
                detail.border_title = "Preview"
                yield Static("", id="detail-meta")
                with VerticalScroll(id="preview-scroll"):
                    yield Markdown("## Your local skills\n\nScanning for `SKILL.md` files…", id="preview")
        with HorizontalScroll(id="actions"):
            yield Button("Apply", id="apply", variant="primary")
            for title, ident in [("Edit", "edit"), ("New", "new"), ("Remove", "remove")]:
                yield Button(title, id=ident)
            yield Static("│\n│\n│", classes="separator")
            for title, ident in [("Trash", "trash"), ("Sources", "sources"), ("Settings", "settings"),
                                 ("Rescan", "rescan"), ("Help", "help")]:
                yield Button(title, id=ident)
        yield Static("Scanning…", id="status", markup=False)
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#skills", DataTable).add_columns("Skill", "Description")
        self.action_rescan()
        self.query_one("#search", Input).focus()

    @work(thread=True, exclusive=True, group="scan")
    def scan(self) -> None:
        worker = get_current_worker()
        skills, errors = discover(self.config, lambda: worker.is_cancelled)
        if not worker.is_cancelled:
            self.call_from_thread(self.finish_scan, skills, errors)

    def check_action(self, action: str, parameters: tuple) -> bool:
        return not isinstance(self.screen, ModalScreen)

    def action_rescan(self) -> None:
        self.screen_stack[0].query_one("#status", Static).update("Scanning folders in the background…")
        self.scan()

    def finish_scan(self, skills: list[Skill], errors: list[str]) -> None:
        self.skills, self.scan_errors = skills, errors
        self.filter_skills()

    def selected(self) -> Optional[Skill]:
        table = self.screen_stack[0].query_one("#skills", DataTable)
        return self.filtered[table.cursor_row] if 0 <= table.cursor_row < len(self.filtered) else None

    def filter_skills(self) -> None:
        selected = self.selected()
        query = self.screen_stack[0].query_one("#search", Input).value.casefold()
        self.filtered = [s for s in self.skills if query in f"{s.name} {s.description} {s.directory}".casefold()]
        main = self.screen_stack[0]
        table = main.query_one("#skills", DataTable)
        table.clear()
        for i, skill in enumerate(self.filtered):
            name = Text.assemble(("! ", "bold red"), skill.name) if skill.error else Text(skill.name)
            table.add_row(name,
                          Text(" ".join(skill.description.split())[:90]), key=str(i))
        if selected:
            row = next((i for i, s in enumerate(self.filtered) if s.directory == selected.directory), 0)
            table.move_cursor(row=row)
        count = (f"{len(self.skills)}" if len(self.filtered) == len(self.skills)
                 else f"{len(self.filtered)} of {len(self.skills)}")
        main.query_one("#catalog").border_title = f"Skills · {count}"
        warnings = len(self.scan_errors)
        main.query_one("#status", Static).update(
            f"{len(self.skills)} skills found" +
            (f" · {warnings} scan warning{'s' if warnings != 1 else ''}, see Help" if warnings else "")
        )
        self.show_selected()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "search":
            self.filter_skills()
        elif event.input.id == "scope":
            self.project = event.value
            self.show_selected()

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        if event.data_table.id == "skills":
            self.show_selected()

    def show_selected(self) -> None:
        skill = self.selected()
        main = self.screen_stack[0]
        for ident in ("edit", "apply", "remove"):
            main.query_one(f"#{ident}", Button).disabled = skill is None
        detail = main.query_one("#detail")
        if not skill:
            detail.border_title = "Preview"
            main.query_one("#detail-meta", Static).update(
                "No matching skills" if self.skills else "No skills found")
            main.query_one("#preview", Markdown).update(
                "## Start your library\n\nUse **New** to create a skill, or **Sources** to add scan folders.\n\n"
                "The app finds directories containing `SKILL.md`, including hidden agent folders."
            )
            return
        try:
            status = installation_status(skill, target_paths(self.config, self.project))
        except ValueError as exc:
            status = str(exc)
        rows = [("Path", short(skill.directory), ""), ("Installed", status, "")]
        if skill.directory.is_symlink():
            rows.append(("Links to", short(skill.directory.resolve()), ""))
        if skill.error:
            rows.append(("Problem", skill.error, "bold red"))
        grid = Table.grid(padding=(0, 1))
        grid.add_column(style="dim", no_wrap=True)
        grid.add_column(overflow="fold")
        for label, value, style in rows:
            grid.add_row(label, Text(value, style))
        info = [grid]
        if skill.description:
            info.append(Text("\n" + " ".join(skill.description.split()), "italic"))
        detail.border_title = skill.name
        main.query_one("#detail-meta", Static).update(Group(*info))
        main.query_one("#preview", Markdown).update(body(skill.text) or "*No instructions yet*")
        main.query_one("#preview-scroll", VerticalScroll).scroll_home(animate=False)

    def action_search(self) -> None:
        self.query_one("#search", Input).focus()

    def after_change(self, changed: bool) -> None:
        if changed:
            self.action_rescan()

    def action_new(self) -> None:
        self.push_screen(Editor(f"New skill in {short(absolute(self.config.library))}", TEMPLATE,
                                Store(self.config).create), self.after_change)

    def action_edit(self) -> None:
        selected = self.selected()
        if selected:
            skill = read_skill(selected.directory)
            self.push_screen(Editor(f"Edit {short(skill.file)} · original backed up on save", skill.text,
                                    lambda text: Store(self.config).save(skill, text)), self.after_change)

    def action_apply(self) -> None:
        skill = self.selected()
        if skill:
            self.push_screen(Apply(skill, self.config, self.project), self.after_change)

    def action_remove(self) -> None:
        skill = self.selected()
        if not skill:
            return
        message = (f"Move this {'link only' if skill.directory.is_symlink() else 'entire folder and all its files'} to the app trash?\n\n"
                   f"{skill.directory}\n\nOther agents linking to this folder may stop finding it. Restore it from Trash.")

        def remove(confirmed: bool) -> None:
            if confirmed:
                try:
                    Store(self.config).trash(skill.directory)
                    self.action_rescan()
                except (OSError, ValueError) as exc:
                    self.notify(str(exc), severity="error")
        self.push_screen(Confirm(message), remove)

    def action_trash(self) -> None:
        self.push_screen(Trash(Store(self.config)), self.after_change)

    def action_sources(self) -> None:
        def save(text: str) -> None:
            roots = list(dict.fromkeys(str(absolute(line.strip())) for line in text.splitlines() if line.strip()))
            for root in roots:
                if not Path(root).is_dir():
                    raise ValueError(f"Directory not found: {root}")
            config = Config(self.config.home, roots, self.config.library, self.config.targets, self.config.excludes)
            config.save()
            self.config = config
        self.push_screen(Editor("Scan folders · one directory per line · ~ is supported",
                                "\n".join(self.config.roots), save, None), self.after_change)

    def action_settings(self) -> None:
        def save(text: str) -> None:
            config = Config.from_text(self.config.home, text)
            config.save()
            self.config = config
        self.push_screen(Editor("Settings · scan roots, library, agent targets, exclusions", self.config.text(),
                                save, "json"), self.after_change)

    def action_help(self) -> None:
        text = """# Skills cabinet

- Search by name, description, or path. Select a row with the mouse or arrow keys.
- New creates a skill in your configured library. Edit saves SKILL.md with a backup.
- Apply copies or links the entire skill folder into the selected agents' directories.
- The project field switches to project-local targets. Blank means user-wide targets.
- Codex and Antigravity share .agents/skills for projects. A shared folder needs one install.
- Remove moves the selected folder to this app's trash. For symlinks, only the link moves.
- Trash restores removed items if their original path is free.
- Sources edits scan folders, one path per line. Removing a scan folder does not delete files.
- Settings accepts JSON. roots adds scan locations; excludes skips directory names or suffixes.
- Apply > Remove selected uninstalls only the selected agent targets, including links.
- Scans skip node_modules, Library, caches, virtual environments, and Git internals by default.
  To scan inside a skipped folder, add the skill directory itself in Sources.
- The preview checks for a skill with the same name in each target folder.
  It doesn't compare contents or check what an agent has loaded.
- Editing a linked skill changes the source for every agent using it. Apply copies again to update them.
- The app won't overwrite an existing installation. Remove it first, then apply the new version.
- Invalid skills remain visible so you can repair their frontmatter in the editor.
- This app never executes skills. Review their instructions and supporting files before use.
- Restart or reload the coding agent after applying changes. Pi supports /reload.

Configuration: CONFIG_PATH
Backups: BACKUP_PATH

Scan warnings:
WARNINGS
""".replace("CONFIG_PATH", str(self.config.home / "config.json")).replace(
            "BACKUP_PATH", str(self.config.home / "backups")).replace(
            "WARNINGS", "\n".join(self.scan_errors) or "None")
        self.push_screen(Help(text))

    def on_button_pressed(self, event: Button.Pressed) -> None:
        action = getattr(self, f"action_{event.button.id}", None)
        if action:
            action()


class Help(ModalScreen):
    BINDINGS = [("escape", "close", "Close")]

    def __init__(self, text: str):
        super().__init__()
        self.text = text

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog help"):
            with VerticalScroll():
                yield Markdown(self.text)
            with Horizontal(classes="buttons"):
                yield Button("Close", id="close", variant="primary")

    def action_close(self) -> None:
        self.dismiss()

    def on_button_pressed(self) -> None:
        self.dismiss()


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage local coding-agent skills in your terminal")
    parser.add_argument("--root", action="append", default=[], help="Additional scan directory, repeatable")
    parser.add_argument("--project", default="", help="Project directory for local agent targets")
    parser.add_argument("--config-dir", help="Alternate app configuration and data directory")
    args = parser.parse_args()
    try:
        config = Config.load(absolute(args.config_dir) if args.config_dir else None)
    except (OSError, ValueError) as exc:
        parser.error(f"Could not load configuration: {exc}")
    config.roots.extend(str(absolute(root)) for root in args.root)
    SkillsApp(config, args.project).run()


if __name__ == "__main__":
    main()
