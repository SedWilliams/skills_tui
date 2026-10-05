from pathlib import Path

import pytest

from tui_skills.core import Config, Store, discover, metadata, read_skill, target_paths

TEXT = '---\nname: example\ndescription: A test skill\n---\n\n# Instructions\n'


@pytest.fixture
def config(tmp_path):
    return Config(tmp_path / 'config', [str(tmp_path / 'sources')], str(tmp_path / 'library'),
                  {agent: str(tmp_path / agent) for agent in ['Codex', 'Claude Code', 'Antigravity', 'Pi']})


@pytest.fixture
def skill(config):
    path = Store(config).create(TEXT)
    (path / 'references').mkdir()
    (path / 'references' / 'guide.md').write_text('Reference')
    return read_skill(path)


def test_discovery_hidden_exclusions_cycles_and_invalid(config, skill):
    root = Path(config.roots[0])
    hidden = root / '.hidden' / 'bad'
    hidden.mkdir(parents=True)
    (hidden / 'SKILL.md').write_text('broken')
    skipped = root / 'node_modules' / 'skip'
    skipped.mkdir(parents=True)
    (skipped / 'SKILL.md').write_text(TEXT)
    (root / 'loop').symlink_to(root)
    found, errors = discover(config)
    assert not errors
    assert {s.name for s in found} == {'example', 'bad'}
    assert next(s for s in found if s.name == 'bad').error
    config.roots.append(str(skipped))
    assert len(discover(config)[0]) == 3


def test_copy_includes_assets_and_never_overwrites(config, skill):
    store = Store(config)
    dest = store.install(skill, Path(config.targets['Codex']), 'copy')
    assert (dest / 'references' / 'guide.md').read_text() == 'Reference'
    assert not dest.is_symlink()
    with pytest.raises(FileExistsError):
        store.install(skill, dest.parent, 'copy')
    with pytest.raises(ValueError):
        store.install(skill, skill.directory / 'nested', 'copy')


def test_link_remove_restore_preserves_source(config, skill):
    store = Store(config)
    dest = store.install(skill, Path(config.targets['Pi']), 'link')
    record = store.trash(dest)
    assert skill.file.exists()
    assert not dest.exists()
    store.restore(record / 'entry.json')
    assert dest.is_symlink()
    assert dest.resolve() == skill.directory


def test_trash_restore_refuses_collision_and_scan_excludes_trash(config, skill):
    store = Store(config)
    record = store.trash(skill.directory)
    config.roots.append(str(config.home))
    assert discover(config)[0] == []
    skill.directory.mkdir()
    with pytest.raises(FileExistsError):
        store.restore(record / 'entry.json')
    skill.directory.rmdir()
    store.restore(record / 'entry.json')
    assert skill.file.read_text() == TEXT


def test_save_backup_and_concurrent_edit_protection(config, skill):
    store = Store(config)
    store.save(skill, TEXT + 'More instructions\n')
    backups = list((config.home / 'backups').glob('*.md'))
    assert len(backups) == 1
    assert backups[0].read_text() == TEXT
    with pytest.raises(ValueError, match='changed outside'):
        store.save(skill, TEXT)


def test_embedded_symlinks_refused_in_copy(config, skill):
    (skill.directory / 'link').symlink_to(skill.directory)
    with pytest.raises(ValueError, match='symlinks'):
        Store(config).install(skill, Path(config.targets['Codex']), 'copy')
    assert not (Path(config.targets['Codex']) / skill.name).exists()


@pytest.mark.parametrize('text', ['text', '---\n[]\n---', TEXT.replace('example', '../escape'),
                                 TEXT.replace('A test skill', 'true'), '---\nname: [\n---'])
def test_validation(text):
    with pytest.raises(ValueError):
        metadata(text)


def test_config_roundtrip_and_project_targets(config, tmp_path):
    config.save()
    assert Config.load(config.home).text() == config.text()
    paths = target_paths(config, str(tmp_path))
    assert paths['Codex'] == paths['Antigravity'] == tmp_path / '.agents/skills'
    assert paths['Pi'] == tmp_path / '.pi/skills'
    with pytest.raises(ValueError):
        Config.from_text(config.home, '{}')
    with pytest.raises(ValueError):
        target_paths(config, str(tmp_path / 'missing'))


def test_create_collision_and_multiline_yaml(config):
    text = TEXT.replace('A test skill', '|\n  First line\n  Second line')
    assert 'Second line' in metadata(text)['description']
    Store(config).create(text)
    with pytest.raises(FileExistsError):
        Store(config).create(text)


def test_broken_destination_link_is_not_overwritten(config, skill):
    target = Path(config.targets['Codex'])
    target.mkdir()
    (target / skill.name).symlink_to(target / 'missing')
    with pytest.raises(FileExistsError):
        Store(config).install(skill, target, 'copy')
    assert (target / skill.name).is_symlink()


def test_cannot_trash_ancestor_of_app_storage(config):
    ancestor = config.home.parent
    (ancestor / 'SKILL.md').write_text(TEXT)
    with pytest.raises(ValueError, match='ancestor'):
        Store(config).trash(ancestor)
    assert ancestor.exists()


def test_failed_cross_device_move_preserves_recovered_data(config, skill, monkeypatch):
    def partial_move(source, destination):
        destination = Path(destination)
        destination.mkdir()
        (destination / 'SKILL.md').write_text(TEXT)
        raise OSError('Simulated failure removing source')

    monkeypatch.setattr('tui_skills.core.shutil.move', partial_move)
    store = Store(config)
    with pytest.raises(OSError):
        store.trash(skill.directory)
    records = store.trash_entries()
    assert len(records) == 1
    assert (records[0].parent / 'skill/SKILL.md').read_text() == TEXT
