from pathlib import Path

from textual.widgets import Checkbox, DataTable, Input, TextArea

from tui_skills.app import Apply, Editor, SkillsApp, Trash
from tui_skills.core import Config, Store, read_skill

TEXT = '---\nname: example\ndescription: A test skill\n---\n\n# Instructions\n'


def make_config(tmp_path):
    return Config(tmp_path / 'config', [], str(tmp_path / 'library'),
                  {agent: str(tmp_path / agent) for agent in ['Codex', 'Claude Code', 'Antigravity', 'Pi']})


async def test_browse_search_edit_apply_remove_restore(tmp_path):
    config = make_config(tmp_path)
    skill_dir = Store(config).create(TEXT)
    app = SkillsApp(config)
    async with app.run_test(size=(140, 45)) as pilot:
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert app.query_one('#skills', DataTable).row_count == 1
        app.query_one('#search', Input).value = 'missing'
        await pilot.pause()
        assert app.query_one('#skills', DataTable).row_count == 0
        app.query_one('#search', Input).value = ''
        await pilot.pause()
        await pilot.click('#edit')
        assert isinstance(app.screen, Editor)
        app.screen.query_one(TextArea).load_text(TEXT + 'Edited\n')
        await pilot.press('ctrl+s')
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert skill_dir.joinpath('SKILL.md').read_text().endswith('Edited\n')
        await pilot.click('#apply')
        assert isinstance(app.screen, Apply)
        app.screen.query_one('#agent-0', Checkbox).value = True
        await pilot.click('#apply')
        await pilot.pause(0.5)
        assert (Path(config.targets['Codex']) / 'example/SKILL.md').is_file()
        await pilot.click('#close')
        await app.workers.wait_for_complete()
        await pilot.pause()
        await pilot.click('#remove')
        await pilot.click('#yes')
        await app.workers.wait_for_complete()
        await pilot.pause()
        await pilot.click('#trash')
        assert isinstance(app.screen, Trash)
        assert app.screen.query_one(DataTable).row_count == 1
        await pilot.click('#restore')
        assert app.screen.query_one(DataTable).row_count == 0
        await pilot.click('#close')


async def test_new_settings_and_dirty_cancel(tmp_path):
    config = make_config(tmp_path)
    app = SkillsApp(config)
    async with app.run_test(size=(120, 40)) as pilot:
        await app.workers.wait_for_complete()
        await pilot.click('#new')
        app.screen.query_one(TextArea).load_text(TEXT)
        await pilot.press('escape')
        await pilot.click('#no')
        assert isinstance(app.screen, Editor)
        await pilot.press('ctrl+s')
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert app.query_one('#skills', DataTable).row_count == 1
        await pilot.click('#settings')
        app.screen.query_one(TextArea).load_text('{}')
        await pilot.press('ctrl+s')
        assert isinstance(app.screen, Editor)
        app.screen.query_one(TextArea).load_text(config.text())
        await pilot.press('ctrl+s')
        await app.workers.wait_for_complete()
        assert (config.home / 'config.json').is_file()
        await pilot.click('#sources')
        app.screen.query_one(TextArea).load_text(str(tmp_path))
        await pilot.press('ctrl+s')
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert app.config.roots == [str(tmp_path)]
        await pilot.click('#help')
        await pilot.press('escape')


async def test_scan_while_modal_open_and_uninstall_link(tmp_path):
    config = make_config(tmp_path)
    source = Store(config).create(TEXT)
    dest = Store(config).install(read_skill(source), Path(config.targets['Pi']), 'link')
    app = SkillsApp(config)
    async with app.run_test(size=(120, 40)) as pilot:
        await app.workers.wait_for_complete()
        await pilot.pause()
        await pilot.click('#apply')
        app.action_rescan()
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert isinstance(app.screen, Apply)
        app.screen.query_one('#agent-3', Checkbox).value = True
        await pilot.click('#uninstall')
        await pilot.click('#yes')
        assert not dest.is_symlink()
        assert (source / 'SKILL.md').is_file()
        await pilot.click('#close')
        await app.workers.wait_for_complete()


async def test_small_terminal_and_shortcuts(tmp_path):
    app = SkillsApp(make_config(tmp_path))
    async with app.run_test(size=(80, 24)) as pilot:
        await app.workers.wait_for_complete()
        await pilot.press('ctrl+n')
        assert isinstance(app.screen, Editor)
        await pilot.press('escape')
        await pilot.press('ctrl+o')
        assert isinstance(app.screen, Editor)
        await pilot.press('escape')
