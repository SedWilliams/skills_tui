"""Filesystem operations, kept independent of the terminal UI."""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

import yaml

AGENTS = {
    "Codex": (".agents/skills", ".agents/skills"),
    "Claude Code": (".claude/skills", ".claude/skills"),
    "Antigravity": (".gemini/config/skills", ".agents/skills"),
    "Pi": (".pi/agent/skills", ".pi/skills"),
}
DEFAULT_EXCLUDES = [
    ".git", ".venv", "venv", "__pycache__", "node_modules", ".Trash",
    "Library", ".cache", "Caches", ".npm", ".local/share/Trash",
]
NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def absolute(value: str) -> Path:
    return Path(os.path.abspath(os.path.expanduser(value)))


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".tui-skills-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
        if path.exists():
            os.chmod(temp, path.stat().st_mode & 0o777)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


@dataclass
class Config:
    home: Path
    roots: list[str]
    library: str
    targets: dict[str, str]
    excludes: list[str] = field(default_factory=lambda: list(DEFAULT_EXCLUDES))

    @classmethod
    def load(cls, home: Optional[Path] = None) -> Config:
        home = home or absolute(os.environ.get("TUI_SKILLS_HOME", "~/.config/tui-skills"))
        path = home / "config.json"
        if path.exists():
            return cls.from_text(home, path.read_text(encoding="utf-8"))
        return cls(home, [str(Path.home())], str(home / "library"), {
            name: str(Path.home() / paths[0]) for name, paths in AGENTS.items()
        })

    @classmethod
    def from_text(cls, home: Path, text: str) -> Config:
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("Configuration must be a JSON object")
        roots, targets = data.get("roots"), data.get("targets")
        if not isinstance(roots, list) or not all(isinstance(x, str) and x.strip() for x in roots):
            raise ValueError("roots must be a list of nonempty paths")
        if not isinstance(targets, dict) or set(targets) != set(AGENTS):
            raise ValueError("targets must contain Codex, Claude Code, Antigravity, and Pi")
        if not all(isinstance(x, str) and x.strip() for x in targets.values()):
            raise ValueError("Each target must be a nonempty path")
        library = data.get("library")
        if not isinstance(library, str) or not library.strip():
            raise ValueError("library must be a nonempty path")
        excludes = data.get("excludes", DEFAULT_EXCLUDES)
        if not isinstance(excludes, list) or not all(isinstance(x, str) for x in excludes):
            raise ValueError("excludes must be a list of directory names or path suffixes")
        return cls(home, roots, library, targets, excludes)

    def text(self) -> str:
        return json.dumps({"roots": self.roots, "library": self.library,
                           "targets": self.targets, "excludes": self.excludes}, indent=2) + "\n"

    def save(self) -> None:
        atomic_write(self.home / "config.json", self.text())

    def scan_roots(self) -> list[Path]:
        # Explicit roots are scanned even when their ancestors are excluded.
        return [absolute(p) for p in [self.library, *self.targets.values(), *self.roots]]


@dataclass
class Skill:
    directory: Path
    name: str
    description: str
    text: str
    error: str = ""

    @property
    def file(self) -> Path:
        return self.directory / "SKILL.md"


def metadata(text: str) -> dict:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("SKILL.md needs YAML frontmatter starting with ---")
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        raise ValueError("Missing closing --- for frontmatter")
    try:
        data = yaml.safe_load("\n".join(lines[1:end]))
    except yaml.YAMLError as exc:
        raise ValueError(f"Invalid YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("Frontmatter must be a YAML mapping")
    name, description = data.get("name"), data.get("description")
    if not isinstance(name, str) or len(name) > 64 or not NAME.fullmatch(name):
        raise ValueError("name must be 1-64 lowercase letters, numbers, and single hyphens")
    if not isinstance(description, str) or not description.strip() or len(description) > 1024:
        raise ValueError("description must be nonempty text, at most 1024 characters")
    return data


def read_skill(directory: Path) -> Skill:
    text = ""
    try:
        text = (directory / "SKILL.md").read_text(encoding="utf-8")
        data = metadata(text)
        return Skill(directory, data["name"], data["description"], text)
    except (OSError, UnicodeError, ValueError) as exc:
        return Skill(directory, directory.name, "Invalid skill", text, str(exc))


def discover(config: Config, cancelled: Callable[[], bool] = lambda: False) -> tuple[list[Skill], list[str]]:
    skills, errors = [], []
    visited = set()
    trash = (config.home / "trash").resolve()
    backups = (config.home / "backups").resolve()
    for root in config.scan_roots():
        if not root.exists():
            continue
        if root.is_file():
            root = root.parent
        stack = [root]
        while stack and not cancelled():
            directory = stack.pop()
            try:
                resolved = directory.resolve()
                if resolved in visited or resolved == trash or resolved == backups:
                    continue
                visited.add(resolved)
                if (directory / "SKILL.md").is_file():
                    skills.append(read_skill(directory))
                    # Assets and references are part of this skill, not scan roots.
                    continue
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if not entry.is_dir(follow_symlinks=True):
                            continue
                        path = Path(entry.path)
                        if any(path.name == rule or path.as_posix().endswith("/" + rule)
                               for rule in config.excludes):
                            continue
                        stack.append(path)
            except (OSError, RuntimeError) as exc:
                if len(errors) < 100:
                    errors.append(f"{directory}: {exc}")
    return sorted(skills, key=lambda s: (s.name.lower(), str(s.directory))), errors


def target_paths(config: Config, project: str = "") -> dict[str, Path]:
    if project.strip():
        root = absolute(project)
        if not root.is_dir():
            raise ValueError("Project directory does not exist")
        return {agent: root / paths[1] for agent, paths in AGENTS.items()}
    return {agent: absolute(path) for agent, path in config.targets.items()}


def installation_status(skill: Skill, targets: dict[str, Path]) -> str:
    installed = []
    for agent, root in targets.items():
        dest = root / skill.name
        if (dest / "SKILL.md").is_file():
            installed.append(agent + (" ↗" if dest.is_symlink() else ""))
    return ", ".join(installed) or "Not installed at selected targets"


class Store:
    def __init__(self, config: Config):
        self.config = config

    def create(self, text: str) -> Path:
        name = metadata(text)["name"]
        directory = absolute(self.config.library) / name
        directory.mkdir(parents=True, exist_ok=False)
        try:
            atomic_write(directory / "SKILL.md", text)
        except Exception:
            directory.rmdir()
            raise
        return directory

    def save(self, skill: Skill, text: str) -> None:
        metadata(text)
        file = skill.file.resolve(strict=True)
        if file.read_text(encoding="utf-8") != skill.text:
            raise ValueError("File changed outside this editor. Cancel and rescan before editing.")
        backup = self.config.home / "backups" / f"{uuid.uuid4().hex}-{skill.directory.name}.md"
        atomic_write(backup, skill.text)
        atomic_write(file, text)

    def trash(self, path: Path) -> Path:
        path = absolute(str(path))  # Do not resolve links: remove the link, not its source.
        if not path.is_symlink() and not (path / "SKILL.md").is_file():
            raise ValueError("Refusing to remove a directory without SKILL.md")
        trash = self.config.home / "trash"
        if not path.is_symlink() and (path.resolve() == trash.resolve() or path.resolve() in trash.resolve().parents):
            raise ValueError("Cannot move the app's own storage or an ancestor into its trash")
        trash.mkdir(parents=True, exist_ok=True)
        entry = trash / (datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8])
        entry.mkdir()
        atomic_write(entry / "entry.json", json.dumps({"original": str(path)}, indent=2))
        try:
            shutil.move(str(path), str(entry / "skill"))
        except Exception:
            # Cross-device moves can fail after copying or partly removing the source.
            # Keep any recovered data instead of deleting the only surviving copy.
            if not os.path.lexists(entry / "skill"):
                shutil.rmtree(entry)
            raise
        return entry

    def trash_entries(self) -> list[Path]:
        return sorted((self.config.home / "trash").glob("*/entry.json"), reverse=True)

    def restore(self, record: Path) -> Path:
        original = Path(json.loads(record.read_text(encoding="utf-8"))["original"])
        if os.path.lexists(original):
            raise FileExistsError(f"Cannot restore: {original} already exists")
        original.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(record.parent / "skill"), str(original))
        record.unlink()
        record.parent.rmdir()
        return original

    def install(self, skill: Skill, root: Path, mode: str) -> Path:
        name = metadata(skill.file.read_text(encoding="utf-8"))["name"]
        source = skill.directory.resolve(strict=True)
        root = root.resolve()
        dest = root / name
        if os.path.lexists(dest):
            raise FileExistsError(f"Already exists: {dest}. Remove it first or choose another target.")
        if root == source or source in root.parents:
            raise ValueError("Cannot install a skill inside itself")
        root.mkdir(parents=True, exist_ok=True)
        if mode == "link":
            dest.symlink_to(source, target_is_directory=True)
        elif mode == "copy":
            # Do not follow embedded links into arbitrary directories or cycles.
            for directory, dirs, files in os.walk(source):
                for item in dirs + files:
                    if (Path(directory) / item).is_symlink():
                        raise ValueError("This skill contains symlinks. Use link mode instead.")
            staging = Path(tempfile.mkdtemp(prefix=".tui-skills-", dir=root))
            try:
                shutil.copytree(source, staging / "skill")
                # mkdir reserves the name without overwriting a racing installation.
                dest.mkdir()
                try:
                    os.replace(staging / "skill", dest)
                except Exception:
                    dest.rmdir()
                    raise
            finally:
                shutil.rmtree(staging)
        else:
            raise ValueError("Mode must be copy or link")
        return dest
