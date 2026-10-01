import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from digest import Digest, compose, due_today, parse_time, summary


def at(day, hour, minute=0):
    return time.mktime((2026, 9, day, hour, minute, 0, 0, 0, -1))


class DigestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name)
        now = at(28, 10)
        orca = sqlite3.connect(self.state / "orca.sqlite3")
        orca.executescript("""
            CREATE TABLE pairs(id TEXT PRIMARY KEY, project_label TEXT);
            CREATE TABLE jobs(id TEXT PRIMARY KEY, pair_id TEXT, state TEXT, stage TEXT, summary TEXT DEFAULT '',
                result TEXT DEFAULT '', error TEXT DEFAULT '', updated REAL, deleted_at REAL);
            INSERT INTO pairs VALUES ('p1','CRM для таксистов'),('p2','Такси Дубай');
        """)
        orca.executemany("INSERT INTO jobs(id,pair_id,state,stage,summary,result,error,updated,deleted_at) VALUES (?,?,?,?,?,?,?,?,?)", [
            ("a", "p1", "completed", "completed", "Итог", "Готово: добавлена таблица клиентов " + "x" * 200, "", now - 3600, None),
            ("b", "p1", "error", "error", "Ошибка агента", "", "Агент завершил этап с ошибкой", now - 7200, None),
            ("c", "p2", "error", "stopped", "Остановлено с часов", "", "Остановлено с часов", now - 600, None),
            ("d", "p2", "question", "question", "Нужен твой ответ", "", "", now - 300, None),
            ("e", "p1", "completed", "completed", "Старое", "давно", "", now - 3 * 86400, None),
            ("f", "p1", "completed", "completed", "В корзине", "trash", "", now - 100, now - 50),
        ])
        orca.commit(); orca.close()
        projects = sqlite3.connect(self.state / "orca-projects.sqlite3")
        projects.executescript("CREATE TABLE operations(id TEXT PRIMARY KEY, state TEXT, message TEXT);"
                               "INSERT INTO operations VALUES ('o1','approval','План'),('o2','completed','Готово');")
        projects.commit(); projects.close()
        hermes = sqlite3.connect(self.state / "state.sqlite3")
        hermes.executescript("CREATE TABLE jobs(id TEXT PRIMARY KEY, text TEXT, state TEXT, result TEXT DEFAULT '', error TEXT DEFAULT '', created REAL, deleted_at REAL);")
        hermes.executemany("INSERT INTO jobs VALUES (?,?,?,?,?,?,?)", [
            ("h1", "Покажи план на сегодня", "completed", "Три встречи", "", now - 4000, None),
            ("h2", "Удали письмо", "approval", "", "", now - 200, None),
            ("h3", "Старый", "completed", "x", "", now - 5 * 86400, None),
        ])
        hermes.commit(); hermes.close()
        claude = sqlite3.connect(self.state / "claude.sqlite3")
        claude.executescript("CREATE TABLE jobs(id TEXT PRIMARY KEY, label TEXT, state TEXT, result TEXT DEFAULT '', "
                             "error TEXT DEFAULT '', updated REAL, deleted_at REAL, night INTEGER DEFAULT 0);")
        claude.executemany("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)", [
            ("c1", "CRM", "completed", "Тесты зелёные", "", now - 3000, None, 1),
            ("c2", "Shop", "night", "", "", now - 100, None, 1),
            ("c3", "CRM", "error", "", "Упал билд", now - 2000, None, 0),
            ("c4", "CRM", "completed", "в корзине", "", now - 500, now - 10, 1),
        ])
        claude.commit(); claude.close()
        dog = sqlite3.connect(self.state / "watchdog.sqlite3")
        dog.executescript("CREATE TABLE watches(id TEXT PRIMARY KEY, label TEXT, state TEXT, detail TEXT, enabled INTEGER);"
                          "INSERT INTO watches VALUES ('w1','fikra.io','down','HTTP 503',1),('w2','CRM','down','x',0),('w3','shop','ok','HTTP 200',1);")
        dog.commit(); dog.close()

    def tearDown(self):
        self.temp.cleanup()

    def test_compose_summarises_the_day_and_what_waits(self):
        text = compose(self.state, at(28, 10))
        self.assertTrue(text.startswith("Дайджест Мусафира · 28.09 10:00"))
        self.assertIn("Orca за сутки: готово 1, ошибок 1, остановлено 1", text)
        self.assertIn("• CRM для таксистов: Готово: добавлена таблица клиентов", text)
        self.assertIn("✗ CRM для таксистов: Агент завершил этап с ошибкой", text)
        self.assertIn("Ждут твоего ответа: Такси Дубай", text)
        self.assertIn("Новый проект ждёт решения на часах: 1", text)
        self.assertIn("Hermes за сутки: ответов 1, ошибок 0", text)
        self.assertIn("• Покажи план на сегодня → Три встречи", text)
        self.assertIn("Claude за сутки: готово 1, ошибок 1, из них ночью 1", text)
        self.assertIn("• CRM: Тесты зелёные", text)
        self.assertIn("✗ CRM: Упал билд", text)
        self.assertIn("Claude: в ночной смене ждут 1", text)
        self.assertNotIn("Codex", text)
        self.assertIn("Дозор, лежит: fikra.io (HTTP 503)", text)
        self.assertNotIn("CRM (x)", text)
        self.assertIn("Hermes ждёт разрешения на часах", text)
        self.assertNotIn("Старое", text)
        self.assertNotIn("В корзине", text)
        self.assertNotIn("Тишина", text)
        self.assertLess(len(text), 3500)

    def test_summary_counts_across_every_agent_and_pending_prompts(self):
        folder = self.state / "permissions" / "5-1"; folder.mkdir(parents=True)
        (folder / "0123456789abcdef.request.json").write_text("{}")
        (folder / "aaaaaaaaaaaaaaaa.request.json").write_text("{}")
        (folder / "aaaaaaaaaaaaaaaa.decision.json").write_text("{}")
        s = summary(self.state, at(28, 10))
        self.assertEqual({k: s[k] for k in ("working", "waiting", "done", "night", "errors", "down")},
                         {"working": 0, "waiting": 4, "done": 3, "night": 1, "errors": 2, "down": 1})
        self.assertEqual(s["text"], "Работают 0 · ждут решения 4 · готово 3 · ночью 1 · ошибок 2 · упало 1")
        with tempfile.TemporaryDirectory() as empty:
            self.assertEqual(summary(empty)["text"], "Тишина: агенты свободны")

    def test_quiet_day_and_missing_databases(self):
        with tempfile.TemporaryDirectory() as empty:
            text = compose(empty, at(28, 10))
        self.assertIn("Тишина", text)
        self.assertEqual(text.count("\n"), 1)

    def test_schedule_sends_once_per_day_after_the_configured_time(self):
        notes = []
        d = Digest(self.state, lambda key, text: notes.append(key) or True, at="10:00", now=lambda: at(28, 9, 59))
        self.assertTrue(d.enabled)
        self.assertFalse(d.tick())
        self.assertTrue(d.tick(at(28, 10)))
        self.assertFalse(d.tick(at(28, 10, 30)))
        self.assertFalse(d.tick(at(28, 23, 59)))
        self.assertTrue(d.tick(at(29, 12)))  # a sleeping Mac catches up after waking
        self.assertEqual(notes, ["digest:2026-09-28", "digest:2026-09-29"])

    def test_restart_after_delivery_does_not_resend(self):
        already = {"digest:2026-09-28"}
        notes = []
        def notify(key, text):
            if key in already:
                return False
            notes.append(key); return True
        d = Digest(self.state, notify, at="10:00")
        self.assertFalse(d.tick(at(28, 11)))
        self.assertEqual(d.sent_date, "2026-09-28")
        self.assertFalse(d.tick(at(28, 12)))
        self.assertEqual(notes, [])

    def test_disabled_without_time_or_notifier(self):
        for value in ("", None, "25:00", "10:60", "ten", "10"):
            self.assertIsNone(parse_time(value), value)
        self.assertEqual(parse_time(" 7:05 "), (7, 5))
        self.assertFalse(Digest(self.state, lambda k, t: True, at="").enabled)
        self.assertFalse(Digest(self.state, None, at="10:00").enabled)
        self.assertEqual(time.localtime(due_today(at(28, 15), 10, 0))[3:5], (10, 0))


if __name__ == "__main__":
    unittest.main()
