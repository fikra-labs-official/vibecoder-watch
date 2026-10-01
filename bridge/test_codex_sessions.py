import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from codex_sessions import CodexService, CODEX_MODES
from test_claude_sessions import FakeProcess


def events(thread, text=None, error=None):
    lines = [{"type": "thread.started", "thread_id": thread}, {"type": "turn.started"}]
    if error:
        lines.append({"type": "item.completed", "item": {"type": "error", "message": error}})
    if text is not None:
        lines.append({"type": "item.completed", "item": {"type": "agent_message", "text": text}})
    lines.append({"type": "turn.completed"})
    return "\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n"


class CodexServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.crm = base / "CRM"; self.crm.mkdir()
        self.root = base / "sessions"
        self.rollout("2026/09/27", "01a0e48f-981b-7422-b8e8-75ce82b663a8", str(self.crm), "Почини оплату в CRM", age=10)
        self.rollout("2026/09/26", "01a0d000-0000-7000-8000-000000000001", str(self.crm), "Старый запрос", age=500)
        self.rollout("2026/09/26", "01a0d000-0000-7000-8000-000000000002", str(base / "gone"), "x", age=5)
        self.launches = []
        self.process = FakeProcess(events("01a0e48f-981b-7422-b8e8-75ce82b663a8", "Готово: оплата починена."))
        def runner(argv, cwd, env):
            self.launches.append({"argv": list(argv), "cwd": cwd})
            return self.process
        self.service = CodexService(base / "state", executable="/fake/codex", projects_root=self.root,
                                    runner=runner, notify=lambda key, text: True, timeout=60)

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def rollout(self, day, session, cwd, first_user, age=0):
        folder = self.root / day
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"rollout-2026-09-27T23-30-11-{session}.jsonl"
        lines = [
            {"timestamp": "t", "type": "session_meta", "payload": {"id": session, "cwd": cwd, "source": "exec"}},
            {"type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "## Memory"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nrules"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>\n  <cwd>x</cwd>\n</environment_context>"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "\n# Files pasted by the user:\n\n" + first_user}]}},
        ]
        path.write_text("\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n")
        stamp = time.time() - age
        os.utime(path, (stamp, stamp))

    def wait(self, job_id):
        for _ in range(400):
            job = self.service.rpc("CODEX_JOB", {"id": job_id})["job"]
            if job["state"] in ("completed", "error"):
                return job
            time.sleep(0.005)
        self.fail("job did not finish")

    def test_research_uses_live_search_in_a_read_only_sandbox_without_the_watch_hint(self):
        self.service.rpc("CODEX_SEND", {"id": "6-1", "textId": "6-1", "project": "research", "kind": "research"}, lambda _: "Тема")
        for _ in range(400):
            job = self.service.rpc("CODEX_JOB", {"id": "6-1"})["job"]
            if job["state"] in ("completed", "error"):
                break
            time.sleep(0.005)
        self.assertEqual(job["state"], "completed")
        argv = self.launches[0]["argv"]
        self.assertEqual(argv[:3], ["/fake/codex", "exec", "-C"])
        self.assertEqual(argv[3], str(Path(self.temp.name) / "state" / "research"))
        self.assertIn("«Тема»", argv[4])
        self.assertNotIn("часов:", argv[4].split("## Для часов")[0])
        self.assertIn('web_search="live"', argv)
        self.assertNotIn("--search", argv)
        self.assertIn('sandbox_mode="read-only"', argv)
        self.assertNotIn("resume", argv)
        self.assertEqual(self.service.rpc("CODEX_HISTORY_DETAIL", {"id": "6-1", "field": "text"})["content"], "Тема")
        with self.assertRaises(ValueError) as caught:
            self.service.rpc("CODEX_SEND", {"id": "6-2", "textId": "6-2", "project": "research", "kind": "deep"}, lambda _: "Тема")
        self.assertIn("только Claude", str(caught.exception))

    def test_catalog_from_rollouts_and_codex_argv_for_new_and_resumed_turns(self):
        projects = self.service.rpc("CODEX_PROJECTS", {"limit": 10})["projects"]
        self.assertEqual([p["label"] for p in projects], ["CRM"])
        sessions = self.service.rpc("CODEX_SESSIONS", {"project": str(self.crm), "limit": 10})["sessions"]
        self.assertEqual([s["label"] for s in sessions], ["Почини оплату в CRM", "Старый запрос"])
        from codex_sessions import user_label
        self.assertEqual(user_label("<send_user_message_question_reply>\n[...]"), "")
        self.assertEqual(user_label("## Заголовок\n\nСделай миграцию\nещё"), "Сделай миграцию")
        self.assertEqual(user_label("&#x20;Это слышь, часы"), "Это слышь, часы")
        self.assertEqual([m["id"] for m in self.service.rpc("CODEX_MODES", {"limit": 10})["modes"]], [m[0] for m in CODEX_MODES])
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_PROJECTS", {})
        self.service.rpc("CODEX_SEND", {"id": "1-1", "textId": "1-1", "project": str(self.crm), "mode": "read-only"}, lambda _: "Что в проекте?")
        done = self.wait("1-1")
        self.assertEqual((done["state"], done["result"], done["sessionId"]),
                         ("completed", "Готово: оплата починена.", "01a0e48f-981b-7422-b8e8-75ce82b663a8"))
        argv = self.launches[0]["argv"]
        self.assertEqual(argv[:4], ["/fake/codex", "exec", "-C", str(self.crm)])
        self.assertTrue(argv[4].startswith("Что в проекте?"))
        self.assertIn("часов", argv[4])
        self.assertIn("--json", argv)
        self.assertIn('sandbox_mode="read-only"', argv)
        self.assertIn('approval_policy="never"', argv)
        self.assertIn("--skip-git-repo-check", argv)
        self.assertEqual(self.launches[0]["cwd"], str(self.crm))
        self.process = FakeProcess(events("01a0e48f-981b-7422-b8e8-75ce82b663a8", "Продолжаю."))
        self.service.rpc("CODEX_SEND", {"id": "1-2", "textId": "1-2", "project": str(self.crm), "mode": "bypass",
                                        "sessionId": "01a0e48f-981b-7422-b8e8-75ce82b663a8"}, lambda _: "Дальше")
        self.assertEqual(self.wait("1-2")["result"], "Продолжаю.")
        argv = self.launches[1]["argv"]
        self.assertEqual(argv[:4], ["/fake/codex", "exec", "resume", "01a0e48f-981b-7422-b8e8-75ce82b663a8"])
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", argv)
        self.assertNotIn("-C", argv)

    def test_errors_without_agent_message_and_nonzero_exit(self):
        self.process = FakeProcess(events("01a0e48f-981b-7422-b8e8-75ce82b663a8", None, error="model unavailable"))
        self.service.rpc("CODEX_SEND", {"id": "2-1", "textId": "2-1", "project": str(self.crm)}, lambda _: "x")
        failed = self.wait("2-1")
        self.assertEqual(failed["state"], "error")
        self.assertIn("model unavailable", failed["error"])
        self.process = FakeProcess("", stderr="ERROR rmcp transport closed", returncode=1)
        self.service.rpc("CODEX_SEND", {"id": "2-2", "textId": "2-2", "project": str(self.crm)}, lambda _: "x")
        self.assertIn("rmcp", self.wait("2-2")["error"])
        history = self.service.rpc("CODEX_HISTORY_LIST", {"limit": 3})["items"]
        self.assertEqual([h["id"] for h in history], ["2-2", "2-1"])


if __name__ == "__main__":
    unittest.main()
