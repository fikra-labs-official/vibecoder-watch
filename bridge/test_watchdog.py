import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.error import URLError

from watchdog import Watchdog, origin_repo, spoken_url


class Completed:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout, self.returncode, self.stderr = stdout, returncode, stderr


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = [1_700_000_000.0]
        self.notes, self.pages, self.runs = [], {}, []
        self.gh = json.dumps([{"name": "Tests", "status": "in_progress", "conclusion": None, "headBranch": "main", "url": "u0"},
                              {"name": "Tests", "status": "completed", "conclusion": "success", "headBranch": "main", "url": "u1"}])
        def runner(argv, **kwargs):
            self.runs.append(argv)
            if argv[:2] == ["gh", "run"]:
                return Completed(self.gh) if isinstance(self.gh, str) else self.gh
            if argv[:2] == ["git", "-C"]:
                return Completed("git@github.com:fikra-labs-official/musafir-watch.git\n")
            return Completed("", 1)
        def fetch(url):
            answer = self.pages.get(url, ("ok", "HTTP 200"))
            if isinstance(answer, Exception):
                raise answer
            return answer
        self.dog = Watchdog(self.temp.name, notify=lambda key, text: self.notes.append((key, text)) or True,
                            runner=runner, fetch=fetch, now=lambda: self.clock[0])
        self.project = Path(self.temp.name) / "musafir-watch"; self.project.mkdir()

    def tearDown(self):
        self.dog.close()
        self.temp.cleanup()

    def test_spoken_addresses_and_origin_repositories(self):
        self.assertEqual(spoken_url("Фикра лабс точка ру"), "https://фикралабс.ру")
        self.assertEqual(spoken_url("https://www.example.com/health"), "https://example.com/health")
        self.assertEqual(spoken_url("api точка example точка com слэш status."), "https://api.example.com/status")
        self.assertIsNone(spoken_url("просто слова без адреса"))
        self.assertIsNone(spoken_url(""))
        self.assertIsNone(spoken_url(None))
        self.assertEqual(origin_repo(self.project, runner=lambda *a, **k: Completed("https://github.com/o/r.git\n")), "o/r")
        self.assertEqual(origin_repo(self.project, runner=lambda *a, **k: Completed("git@github.com:o/r\n")), "o/r")
        self.assertIsNone(origin_repo(self.project, runner=lambda *a, **k: Completed("", 128, "fatal")))
        self.assertIsNone(origin_repo(self.project, runner=lambda *a, **k: Completed("https://gitlab.com/o/r.git")))

    def test_site_watch_from_dictation_announces_only_changes(self):
        added = self.dog.rpc("WATCH_ADD", {"kind": "url", "textId": "1-1"}, lambda _: "Фикра лабс точка ру")
        watch = added["watch"]
        self.assertEqual((watch["kind"], watch["target"], watch["label"], watch["state"]), ("url", "https://фикралабс.ру", "фикралабс.ру", "ok"))
        self.assertIn("слежу за сайтом фикралабс.ру", added["message"])
        self.assertEqual(self.notes, [])
        again = self.dog.rpc("WATCH_ADD", {"kind": "url", "target": "фикралабс.ру"})
        self.assertTrue(again["existing"])
        self.assertEqual(self.dog.rpc("WATCH_LIST", {})["count"], 1)
        with self.assertRaises(ValueError):
            self.dog.rpc("WATCH_ADD", {"kind": "url", "textId": "1-2"}, lambda _: "ничего похожего")
        with self.assertRaises(ValueError):
            self.dog.rpc("WATCH_ADD", {"kind": "dns", "target": "x"})
        self.pages["https://фикралабс.ру"] = ("down", "HTTP 503")
        self.assertEqual(self.dog.tick(), 0)            # not due yet
        self.clock[0] += 300
        self.assertEqual(self.dog.tick(), 1)
        self.assertEqual(self.dog.tick(), 0)
        self.assertEqual(len(self.notes), 1)
        self.assertEqual(self.notes[0][1], "Дозор · фикралабс.ру\nСайт упал: HTTP 503")
        self.assertTrue(self.notes[0][0].startswith(f"watch:{watch['id']}:down:"))
        self.clock[0] += 300
        self.dog.tick()
        self.assertEqual(len(self.notes), 1)             # still down: silent
        self.pages["https://фикралабс.ру"] = URLError("timed out")
        self.clock[0] += 300
        self.dog.tick()
        self.assertEqual(len(self.notes), 1)
        self.pages["https://фикралабс.ру"] = ("ok", "HTTP 200")
        checked = self.dog.rpc("WATCH_CHECK", {"id": watch["id"]})["watch"]
        self.assertEqual((checked["state"], checked["detail"]), ("ok", "HTTP 200"))
        self.assertEqual(self.notes[-1][1], "Дозор · фикралабс.ру\nСайт снова в порядке: HTTP 200")
        self.dog.rpc("WATCH_REMOVE", {"id": watch["id"]})
        self.assertEqual(self.dog.rpc("WATCH_LIST", {})["items"], [])
        with self.assertRaises(ValueError):
            self.dog.rpc("WATCH_CHECK", {"id": watch["id"]})
        with self.assertRaises(ValueError):
            self.dog.rpc("WATCH_CHECK", {"id": "nope"})

    def test_ci_watch_reads_the_latest_finished_run_of_the_origin(self):
        added = self.dog.rpc("WATCH_ADD", {"kind": "ci", "project": str(self.project), "label": "musafir-watch"})
        watch = added["watch"]
        self.assertEqual((watch["target"], watch["state"], watch["detail"]), ("fikra-labs-official/musafir-watch", "ok", "Tests · main: success"))
        self.assertIn("-R", self.runs[-1]); self.assertIn("fikra-labs-official/musafir-watch", self.runs[-1])
        self.gh = json.dumps([{"name": "Deploy", "status": "completed", "conclusion": "cancelled", "headBranch": "main", "url": "u2"},
                              {"name": "Tests", "status": "completed", "conclusion": "failure", "headBranch": "main", "url": "https://github.com/x/y/actions/runs/7"}])
        self.clock[0] += 300
        self.dog.tick()
        self.assertEqual(self.notes[-1][1], "Дозор · musafir-watch\nCI упал: Tests · main: failure\nhttps://github.com/x/y/actions/runs/7")
        self.gh = Completed("", 1, "gh: not logged in")
        self.clock[0] += 300
        self.dog.tick()
        current = self.dog.rpc("WATCH_LIST", {})["items"][0]
        self.assertEqual(current["state"], "down")       # a failed check keeps the last known state
        self.assertTrue(current["detail"].startswith("gh: not logged in"))
        self.assertEqual(len(self.notes), 1)
        with self.assertRaises(ValueError):
            self.dog.rpc("WATCH_ADD", {"kind": "ci", "project": str(Path(self.temp.name) / "nowhere")})
        by_name = self.dog.rpc("WATCH_ADD", {"kind": "ci", "target": "o/r"})["watch"]
        self.assertEqual(by_name["label"], "r")


if __name__ == "__main__":
    unittest.main()
