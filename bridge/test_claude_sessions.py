import json
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

from claude_sessions import ClaudeService, MODES


class FakeProcess:
    """hang=True blocks communicate() until terminate()/kill(), like a real child."""

    def __init__(self, stdout="", stderr="", returncode=0, hang=False):
        self.stdout, self.stderr, self.returncode, self.hang = stdout, stderr, returncode, hang
        self.terminated = self.killed = False
        self.done = threading.Event()

    def communicate(self, timeout=None):
        if self.hang:
            if not self.done.wait(5):
                raise subprocess.TimeoutExpired("claude", timeout)
        if self.terminated or self.killed:
            self.returncode = -15
            return "", ""
        return self.stdout, self.stderr

    def poll(self):
        return None if (self.hang and not self.done.is_set()) else self.returncode

    def terminate(self):
        self.terminated = True
        self.done.set()

    def kill(self):
        self.killed = True
        self.done.set()


class KillFallbackProcess(FakeProcess):
    def __init__(self, kill_stops=True):
        super().__init__(hang=True)
        self.kill_stops = kill_stops
        self.wait_calls = 0

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True
        if self.kill_stops:
            self.returncode = -9
            self.done.set()

    def wait(self, timeout=None):
        self.wait_calls += 1
        if self.done.is_set():
            return self.returncode
        raise subprocess.TimeoutExpired("claude", timeout)


def at(day, hour, minute=0):
    return time.mktime((2026, 9, day, hour, minute, 0, 0, 0, -1))


def result_json(text, session="11111111-2222-3333-4444-555555555555", denials=None, is_error=False):
    return json.dumps({"type": "result", "result": text, "session_id": session, "is_error": is_error,
                       "permission_denials": denials or [], "num_turns": 1}, ensure_ascii=False)


class PromptingProcess(FakeProcess):
    """Behaves like Claude asking the permission tool: writes a request, waits for the decision."""

    def __init__(self, directory, command="npm test", request=None):
        super().__init__(hang=True)
        self.directory, self.command, self.request = Path(directory), command, request
        self.decision = None

    def communicate(self, timeout=None):
        self.directory.mkdir(parents=True, exist_ok=True)
        request = self.request or {"id": "0123456789abcdef", "toolName": "Bash", "input": {"command": self.command}, "created": time.time()}
        (self.directory / "0123456789abcdef.request.json").write_text(json.dumps(request))
        deadline = time.time() + 5
        path = self.directory / "0123456789abcdef.decision.json"
        while time.time() < deadline and not path.exists() and not self.done.is_set():
            time.sleep(0.02)
        if self.done.is_set():
            self.returncode = -15
            return "", ""
        if path.exists():
            self.decision = json.loads(path.read_text())
        self.returncode = 0
        self.stdout = result_json("выполнено" if self.decision and self.decision.get("allow") else "команда отклонена")
        return self.stdout, ""


class ClaudeServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.crm = base / "CRM"; self.crm.mkdir()
        self.shop = base / "Shop"; self.shop.mkdir()
        self.root = base / "projects"; self.root.mkdir()
        self.write_session(self.root / "-crm", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", str(self.crm),
                           summary="Починить оплату", age=10)
        self.write_session(self.root / "-crm", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", str(self.crm),
                           first_user="Добавь тесты для заказов " + "х" * 100, age=100)
        (self.root / "-crm" / "agent-child.jsonl").write_text('{"cwd":"/nope"}\n')
        self.write_session(self.root / "-shop", "cccccccc-cccc-cccc-cccc-cccccccccccc", str(self.shop), age=50)
        self.write_session(self.root / "-gone", "dddddddd-dddd-dddd-dddd-dddddddddddd", str(base / "gone"), age=1)
        self.launches, self.notes = [], []
        self.process = FakeProcess(result_json("Готово: оплата починена."))
        def runner(argv, cwd, env):
            self.launches.append({"argv": list(argv), "cwd": cwd, "env": dict(env)})
            if isinstance(self.process, OSError):
                raise self.process
            return self.process
        self.service = ClaudeService(base / "state", executable="/fake/claude", projects_root=self.root,
                                     runner=runner, notify=lambda key, text: self.notes.append((key, text)) or True,
                                     timeout=60)
        self.service.KEEP_AWAKE = None  # no caffeinate in tests

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def write_session(self, folder, session_id, cwd, summary=None, first_user=None, age=0):
        folder.mkdir(exist_ok=True)
        path = folder / f"{session_id}.jsonl"
        lines = [{"type": "permission-mode", "sessionId": session_id, "permissionMode": "default"}]
        if summary:
            lines.append({"type": "summary", "summary": summary, "leafUuid": "x"})
        lines.append({"type": "user", "cwd": cwd, "sessionId": session_id,
                      "message": {"role": "user", "content": first_user or "привет"}})
        path.write_text("\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n")
        stamp = time.time() - age
        import os
        os.utime(path, (stamp, stamp))
        return path

    def wait(self, job_id):
        for _ in range(400):
            job = self.service.rpc("CLAUDE_JOB", {"id": job_id})["job"]
            if job["state"] in ("completed", "error", "unknown"):
                return job
            time.sleep(0.005)
        self.fail("job did not finish")

    def test_projects_and_sessions_come_from_claude_session_files(self):
        projects = self.service.rpc("CLAUDE_PROJECTS", {"limit": 10})["projects"]
        self.assertEqual([p["label"] for p in projects], ["CRM", "Shop"])
        self.assertEqual(projects[0]["id"], str(self.crm))
        sessions = self.service.rpc("CLAUDE_SESSIONS", {"project": str(self.crm), "limit": 10})["sessions"]
        self.assertEqual([s["id"][:8] for s in sessions], ["aaaaaaaa", "bbbbbbbb"])
        self.assertEqual(sessions[0]["label"], "Починить оплату")
        self.assertTrue(sessions[1]["label"].startswith("Добавь тесты для заказов"))
        self.assertLessEqual(len(sessions[1]["label"]), 60)
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_SESSIONS", {"project": str(self.temp.name) + "/gone"})
        modes = self.service.rpc("CLAUDE_MODES", {"limit": 10})["modes"]
        self.assertEqual([m["id"] for m in modes], [m[0] for m in MODES])

    def test_task_runs_headless_in_the_project_and_continues_the_returned_session(self):
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_SEND", {"id": "1-1", "textId": "1-1", "project": "/nowhere", "mode": "auto"}, lambda _: "x")
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_SEND", {"id": "1-1", "textId": "1-1", "project": str(self.crm), "mode": "yolo"}, lambda _: "x")
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_SEND", {"id": "1-1", "textId": "1-1", "project": str(self.crm), "sessionId": "abc"}, lambda _: "x")
        queued = self.service.rpc("CLAUDE_SEND", {"id": "1-1", "textId": "1-1", "project": str(self.crm), "mode": "auto"},
                                  lambda _: "Почини оплату")["job"]
        self.assertEqual((queued["state"], queued["projectLabel"], queued["mode"]), ("queued", "CRM", "auto"))
        done = self.wait("1-1")
        self.assertEqual(done["state"], "completed")
        self.assertEqual(done["result"], "Готово: оплата починена.")
        self.assertEqual(done["sessionId"], "11111111-2222-3333-4444-555555555555")
        launch = self.launches[0]
        self.assertEqual(launch["cwd"], str(self.crm))
        argv = launch["argv"]
        self.assertEqual(argv[:3], ["/fake/claude", "-p", "Почини оплату"])
        self.assertIn("--permission-mode", argv)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "auto")
        self.assertEqual(argv[argv.index("--permission-prompts") + 1], "host")
        self.assertEqual(argv[argv.index("--permission-prompt-tool") + 1], "mcp__musafir__approve")
        config = json.loads(argv[argv.index("--mcp-config") + 1])
        self.assertIn("permission_tool.py", config["mcpServers"]["musafir"]["args"][0])
        self.assertTrue(config["mcpServers"]["musafir"]["env"]["MUSAFIR_PERMISSION_DIR"].endswith("permissions/1-1"))
        self.assertNotIn("--resume", argv)
        self.assertFalse(any(k.startswith("CLAUDE_CODE_") for k in launch["env"]))
        self.assertEqual(self.notes[-1][0], "claude:1-1:completed")
        # The same id is idempotent; a different session for the same id conflicts.
        self.assertEqual(self.service.rpc("CLAUDE_SEND", {"id": "1-1", "textId": "1-1", "project": str(self.crm), "mode": "auto"})["job"]["state"], "completed")
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_SEND", {"id": "1-1", "textId": "1-1", "project": str(self.crm),
                                             "sessionId": "11111111-2222-3333-4444-555555555555"})
        # The next dictation continues the returned session with --resume.
        self.process = FakeProcess(result_json("Продолжаю.", denials=[{"tool_name": "Bash"}]))
        self.service.rpc("CLAUDE_SEND", {"id": "1-2", "textId": "1-2", "project": str(self.crm), "mode": "bypass",
                                         "sessionId": "11111111-2222-3333-4444-555555555555"}, lambda _: "Дальше")
        done = self.wait("1-2")
        argv = self.launches[1]["argv"]
        self.assertEqual(argv[argv.index("--resume") + 1], "11111111-2222-3333-4444-555555555555")
        self.assertIn("--dangerously-skip-permissions", argv)
        self.assertEqual(argv[argv.index("--permission-prompts") + 1], "none")
        self.assertNotIn("--permission-prompt-tool", argv)
        self.assertIn("Отклонено запросов разрешений: 1", done["result"])
        latest = self.service.rpc("CLAUDE_LATEST", {"project": str(self.crm)})["job"]
        self.assertEqual(latest["id"], "1-2")

    def test_general_target_is_fixed_isolated_fresh_and_resumable(self):
        state = Path(self.temp.name) / "state"
        general = state / "workspaces" / "claude"
        source = "  Общая задача без проекта 😀\n"
        queued = self.service.rpc("CLAUDE_SEND", {
            "id": "1-8", "textId": "1-8", "project": "general", "kind": "task",
            "mode": "auto", "startFresh": True}, lambda _: source)["job"]
        self.assertEqual((queued["id"], queued["project"], queued["projectLabel"]),
                         ("1-8", str(general), "Общая задача"))
        done = self.wait("1-8")
        self.assertEqual(self.service._job("1-8")["source_text"], source)
        self.assertEqual(self.launches[0]["cwd"], str(general))
        self.assertTrue(general.is_dir())
        self.assertEqual(general.parent, state / "workspaces")
        self.assertNotEqual(general, state)
        self.assertNotEqual(general, state / "research")
        self.assertNotIn("--resume", self.launches[0]["argv"])
        self.assertIn("--permission-mode", self.launches[0]["argv"])
        self.assertNotIn("--dangerously-skip-permissions", self.launches[0]["argv"])
        self.write_session(self.root / "-general", "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
                           str(general), summary="Общий разговор")
        self.assertNotIn(str(general), [p["id"] for p in self.service.rpc(
            "CLAUDE_PROJECTS", {"limit": 10})["projects"]])
        self.assertEqual([item["label"] for item in self.service.rpc("CLAUDE_SESSIONS", {
            "project": "general", "limit": 10})["sessions"]], ["Общий разговор"])
        self.assertEqual(self.service.rpc("CLAUDE_LATEST", {"project": "general"})["job"]["id"], "1-8")
        self.assertEqual(self.service.rpc("CLAUDE_LATEST", {"project": str(general)})["job"]["id"], "1-8")
        self.assertEqual(self.service.rpc("CLAUDE_HISTORY_LIST", {
            "project": "general", "limit": 3})["items"][0]["id"], "1-8")
        detail = self.service.rpc("CLAUDE_HISTORY_DETAIL", {"id": "1-8", "field": "text"})
        self.assertEqual(detail["content"], source)
        self.assertEqual(detail["context"]["project"], "general")
        self.assertEqual(detail["context"]["label"], "Общая задача")
        self.assertEqual(detail["context"]["mode"], "auto")
        self.assertEqual(self.service.rpc("CLAUDE_SEND", {
            "id": "1-8", "textId": "1-8", "project": str(general), "kind": "task",
            "mode": "auto", "startFresh": True})["job"]["id"], "1-8")

        self.process = FakeProcess(result_json("Продолжаю общую задачу."))
        self.service.rpc("CLAUDE_SEND", {
            "id": "1-9", "textId": "1-9", "project": str(general), "kind": "task",
            "mode": "auto", "startFresh": False, "sessionId": done["sessionId"]}, lambda _: "Продолжи")
        self.assertEqual(self.wait("1-9")["state"], "completed")
        self.assertEqual(self.launches[1]["cwd"], str(general))
        self.assertEqual(self.launches[1]["argv"][self.launches[1]["argv"].index("--resume") + 1],
                         done["sessionId"])
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_SEND", {
                "id": "1-10", "textId": "1-10", "project": "general", "startFresh": True,
                "sessionId": done["sessionId"]}, lambda _: "x")
        for invalid in (str(state / "workspaces" / "other"), str(general / ".." / "claude")):
            with self.assertRaises(ValueError):
                self.service.rpc("CLAUDE_SEND", {
                    "id": "1-11", "textId": "1-11", "project": invalid,
                    "startFresh": True}, lambda _: "x")

    def test_general_target_refuses_a_workspace_symlink(self):
        base = Path(self.temp.name)
        state = base / "unsafe-state"
        outside = base / "outside"; outside.mkdir()
        (state / "workspaces").mkdir(parents=True)
        (state / "workspaces" / "claude").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            ClaudeService(state, executable="/fake/claude", projects_root=self.root,
                          runner=lambda argv, cwd, env: FakeProcess(result_json("x")))

    def test_replay_requires_the_same_text_id_and_options_and_keeps_exact_source(self):
        params = {"id": "9-1", "textId": "9-2", "project": str(self.crm),
                  "mode": "auto", "night": True}
        source = '\tТочный текст 😀\n'
        first = self.service.rpc("CLAUDE_SEND", params, lambda _: source)["job"]
        self.assertEqual(first["state"], "night")
        self.assertEqual(
            self.service.rpc("CLAUDE_HISTORY_DETAIL", {"id": "9-1", "field": "text"})["content"],
            source)
        self.assertEqual(self.service.rpc("CLAUDE_SEND", dict(params), lambda _: "wrong")["job"]["id"], "9-1")
        for changed in (
                {"textId": "9-3"}, {"mode": "bypass"}, {"night": False},
                {"project": str(self.shop)}):
            with self.assertRaises(ValueError):
                self.service.rpc("CLAUDE_SEND", {**params, **changed}, lambda _: source)

    def test_process_is_submitting_until_spawn_succeeds(self):
        entered, release = threading.Event(), threading.Event()
        process = FakeProcess(result_json("Готово"))
        def slow_runner(argv, cwd, env):
            entered.set()
            release.wait(2)
            return process
        self.service.runner = slow_runner
        self.service.rpc("CLAUDE_SEND", {
            "id": "9-4", "textId": "9-4", "project": str(self.crm)}, lambda _: "Задача")
        self.assertTrue(entered.wait(1))
        self.assertEqual(self.service.rpc("CLAUDE_JOB", {"id": "9-4"})["job"]["state"], "submitting")
        release.set()
        self.assertEqual(self.wait("9-4")["state"], "completed")

    def test_stop_during_spawn_is_unknown_until_the_late_process_is_terminated(self):
        entered, release = threading.Event(), threading.Event()
        process = FakeProcess(hang=True)
        def slow_runner(argv, cwd, env):
            entered.set()
            release.wait(2)
            return process
        self.service.runner = slow_runner
        self.service.rpc("CLAUDE_SEND", {
            "id": "9-5", "textId": "9-5", "project": str(self.crm)}, lambda _: "Задача")
        self.assertTrue(entered.wait(1))
        stopped = self.service.rpc("CLAUDE_STOP", {"id": "9-5"})["job"]
        self.assertEqual(stopped["state"], "unknown")
        self.assertNotEqual(stopped["error"], "Остановлено с часов")
        release.set()
        for _ in range(200):
            if self.service._job("9-5")["error"] == "Остановлено с часов":
                break
            time.sleep(0.005)
        self.assertTrue(process.terminated)
        self.assertEqual(self.service._job("9-5")["error"], "Остановлено с часов")

    def test_failures_are_errors_and_stop_terminates_the_child(self):
        self.process = FakeProcess(result_json("Не могу: нет доступа", is_error=True), returncode=1)
        self.service.rpc("CLAUDE_SEND", {"id": "2-1", "textId": "2-1", "project": str(self.shop)}, lambda _: "x")
        failed = self.wait("2-1")
        self.assertEqual(failed["state"], "error")
        self.assertIn("Не могу: нет доступа", failed["error"])
        self.assertEqual(self.notes[-1][0], "claude:2-1:error")
        self.process = FakeProcess("not json at all", stderr="boom", returncode=2)
        self.service.rpc("CLAUDE_SEND", {"id": "2-2", "textId": "2-2", "project": str(self.shop)}, lambda _: "x")
        self.assertIn("boom", self.wait("2-2")["error"])
        self.process = OSError("missing")
        self.service.rpc("CLAUDE_SEND", {"id": "2-3", "textId": "2-3", "project": str(self.shop)}, lambda _: "x")
        self.assertIn("не запустился", self.wait("2-3")["error"])
        hanging = FakeProcess(hang=True)
        self.process = hanging
        self.service.rpc("CLAUDE_SEND", {"id": "2-4", "textId": "2-4", "project": str(self.shop)}, lambda _: "x")
        for _ in range(200):
            if "2-4" in self.service.processes:
                break
            time.sleep(0.005)
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_SEND", {"id": "2-5", "textId": "2-5", "project": str(self.shop)}, lambda _: "x")
        stopped = self.service.rpc("CLAUDE_STOP", {"id": "2-4"})["job"]
        self.assertEqual((stopped["state"], stopped["error"]), ("error", "Остановлено с часов"))
        self.assertTrue(hanging.terminated)
        self.assertEqual(self.wait("2-4")["error"], "Остановлено с часов")
        self.assertEqual(self.service.rpc("CLAUDE_STOP", {"id": "2-4"})["job"]["state"], "error")
        self.assertFalse(any(k == "claude:2-4:error" for k, _ in self.notes))

    def test_stop_kills_after_bounded_wait_and_reports_unconfirmed_kill(self):
        fallback = KillFallbackProcess()
        confirmed, reason = self.service._terminate_process(fallback)
        self.assertTrue(confirmed)
        self.assertEqual(reason, "")
        self.assertTrue(fallback.terminated and fallback.killed)
        self.assertEqual(fallback.wait_calls, 2)

        unkillable = KillFallbackProcess(kill_stops=False)
        self.process = unkillable
        self.service.rpc("CLAUDE_SEND", {
            "id": "2-6", "textId": "2-6", "project": str(self.crm)}, lambda _: "x")
        for _ in range(200):
            if "2-6" in self.service.processes:
                break
            time.sleep(0.005)
        stopped = self.service.rpc("CLAUDE_STOP", {"id": "2-6"})["job"]
        self.assertEqual(stopped["state"], "unknown")
        self.assertNotEqual(stopped["error"], "Остановлено с часов")
        self.assertIn("не подтверждено", stopped["error"])
        self.assertEqual(stopped["result"], stopped["error"])
        unkillable.done.set()

    def test_running_without_a_process_cannot_report_confirmed_stop(self):
        process = FakeProcess(hang=True)
        self.process = process
        self.service.rpc("CLAUDE_SEND", {
            "id": "2-7", "textId": "2-7", "project": str(self.crm)}, lambda _: "x")
        for _ in range(200):
            if "2-7" in self.service.processes:
                break
            time.sleep(0.005)
        with self.service.lock:
            self.service.processes.pop("2-7", None)
        stopped = self.service.rpc("CLAUDE_STOP", {"id": "2-7"})["job"]
        self.assertEqual(stopped["state"], "unknown")
        self.assertNotEqual(stopped["error"], "Остановлено с часов")
        self.assertEqual(stopped["result"], stopped["error"])
        process.done.set()

    def test_result_persists_beyond_the_watch_reader_cap_without_silent_truncation(self):
        result = "начало🙂" + "я" * 200_500 + "КОНЕЦ"
        self.process = FakeProcess(result_json(result))
        self.service.rpc("CLAUDE_SEND", {"id": "2-9", "textId": "2-9", "project": str(self.crm)}, lambda _: "x")
        self.assertEqual(self.wait("2-9")["state"], "completed")
        self.assertEqual(self.service._job("2-9")["result"], result)
        tail = self.service.rpc("CLAUDE_HISTORY_DETAIL", {
            "id": "2-9", "field": "result", "offset": len(result) - 5, "limit": 5})
        self.assertEqual((tail["content"], tail["total"], tail["complete"]), ("КОНЕЦ", len(result), True))

    def test_timeout_and_history_with_trash(self):
        self.service.timeout = 30
        self.process = FakeProcess()
        def communicate(timeout=None):
            raise subprocess.TimeoutExpired("claude", timeout)
        self.process.communicate = communicate
        self.service.rpc("CLAUDE_SEND", {"id": "3-1", "textId": "3-1", "project": str(self.shop)}, lambda _: "x")
        timed = self.wait("3-1")
        self.assertIn("не уложился", timed["error"])
        self.process = FakeProcess(result_json("Ответ " + "я" * 1500))
        self.service.rpc("CLAUDE_SEND", {"id": "3-2", "textId": "3-2", "project": str(self.shop)}, lambda _: "Вопрос")
        done = self.wait("3-2")
        self.assertEqual(len(done["result"]), 1000)
        self.assertTrue(done["hasMore"])
        rest = self.service.rpc("CLAUDE_JOB", {"id": "3-2", "cursor": done["nextCursor"]})["job"]
        self.assertEqual(len(done["result"] + rest["result"]), 1506)
        items = self.service.rpc("CLAUDE_HISTORY_LIST", {"limit": 3})["items"]
        self.assertEqual([i["id"] for i in items], ["3-2", "3-1"])
        self.assertEqual(items[0]["projectLabel"], "Shop")
        detail = self.service.rpc("CLAUDE_HISTORY_DETAIL", {"id": "3-1", "field": "result"})
        self.assertIn("не уложился", detail["content"])
        self.service.rpc("CLAUDE_HISTORY_SET_DELETED", {"id": "3-1", "deleted": True})
        self.assertEqual([i["id"] for i in self.service.rpc("CLAUDE_HISTORY_LIST", {})["items"]], ["3-2"])
        self.assertEqual(self.service.rpc("CLAUDE_LATEST", {})["job"]["id"], "3-2")
        self.assertEqual(self.service.rpc("CLAUDE_HISTORY_EMPTY_TRASH", {}), {"ok": True, "removed": 1})
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_JOB", {"id": "3-1"})

    def test_permission_prompt_reaches_the_watch_and_the_decision_returns(self):
        folder = Path(self.temp.name) / "state" / "permissions" / "5-1"
        self.process = PromptingProcess(folder)
        self.service.rpc("CLAUDE_SEND", {"id": "5-1", "textId": "5-1", "project": str(self.crm), "mode": "auto"}, lambda _: "Прогони тесты")
        for _ in range(200):
            job = self.service.rpc("CLAUDE_JOB", {"id": "5-1"})["job"]
            if job["state"] == "approval":
                break
            time.sleep(0.01)
        self.assertEqual(job["state"], "approval")
        self.assertEqual(job["approval"]["id"], "0123456789abcdef")
        self.assertEqual(job["approval"]["text"], "Bash:\nnpm test")
        for _ in range(200):
            if any(k == "claude:5-1:approval:0123456789abcdef" for k, _ in self.notes):
                break
            time.sleep(0.01)
        self.assertIn("npm test", dict(self.notes)["claude:5-1:approval:0123456789abcdef"])
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_APPROVE", {"id": "5-1", "approvalId": "ffffffffffffffff", "allow": True})
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_APPROVE", {"id": "5-1", "approvalId": "0123456789abcdef", "allow": "yes"})
        decided = self.service.rpc("CLAUDE_APPROVE", {"id": "5-1", "approvalId": "0123456789abcdef", "allow": True})["job"]
        self.assertIn(decided["state"], ("running", "completed"))
        done = self.wait("5-1")
        self.assertEqual((done["state"], done["result"]), ("completed", "выполнено"))
        self.assertEqual(self.process.decision["allow"], True)
        self.assertFalse(folder.exists())
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_APPROVE", {"id": "5-1", "approvalId": "0123456789abcdef", "allow": False})

    def test_denied_prompt_and_stop_deny_pending_prompts(self):
        folder = Path(self.temp.name) / "state" / "permissions" / "5-2"
        self.process = PromptingProcess(folder, command="rm -rf build")
        self.service.rpc("CLAUDE_SEND", {"id": "5-2", "textId": "5-2", "project": str(self.crm)}, lambda _: "Удали сборку")
        for _ in range(200):
            if self.service.rpc("CLAUDE_JOB", {"id": "5-2"})["job"]["state"] == "approval":
                break
            time.sleep(0.01)
        self.service.rpc("CLAUDE_APPROVE", {"id": "5-2", "approvalId": "0123456789abcdef", "allow": False})
        self.assertEqual(self.service.rpc("CLAUDE_APPROVE", {"id": "5-2", "approvalId": "0123456789abcdef", "allow": False})["job"]["id"], "5-2")
        self.assertEqual(self.wait("5-2")["result"], "команда отклонена")
        folder2 = Path(self.temp.name) / "state" / "permissions" / "5-3"
        self.process = PromptingProcess(folder2)
        self.service.rpc("CLAUDE_SEND", {"id": "5-3", "textId": "5-3", "project": str(self.shop)}, lambda _: "x")
        for _ in range(200):
            if self.service.rpc("CLAUDE_JOB", {"id": "5-3"})["job"]["state"] == "approval":
                break
            time.sleep(0.01)
        stopped = self.service.rpc("CLAUDE_STOP", {"id": "5-3"})["job"]
        self.assertEqual(stopped["state"], "error")
        self.assertTrue(self.process.terminated)

    def test_night_tasks_wait_for_the_window_and_run_one_after_another_without_prompts(self):
        first = self.service.rpc("CLAUDE_SEND", {"id": "7-1", "textId": "7-1", "project": str(self.crm), "mode": "auto", "night": True},
                                 lambda _: "Прогони тесты")["job"]
        self.assertEqual((first["state"], first["night"]), ("night", True))
        self.assertIn("Старт в 01:00", first["result"])
        self.service.rpc("CLAUDE_SEND", {"id": "7-2", "textId": "7-2", "project": str(self.crm), "night": True}, lambda _: "Обнови зависимости")
        self.service.rpc("CLAUDE_SEND", {"id": "7-3", "textId": "7-3", "project": str(self.shop), "night": True}, lambda _: "Почини витрину")
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_SEND", {"id": "7-4", "textId": "7-4", "project": str(self.crm), "night": "да"}, lambda _: "x")
        self.assertEqual(self.launches, [])
        status = self.service.rpc("CLAUDE_NIGHT", {"limit": 10})
        self.assertEqual((status["active"], status["at"], status["count"]), (False, "01:00", 3))
        self.assertEqual([j["id"] for j in status["jobs"]], ["7-1", "7-2", "7-3"])
        self.assertEqual(status["jobs"][2]["projectLabel"], "Shop")
        self.assertEqual(self.service.rpc("CLAUDE_HISTORY_LIST", {"limit": 3})["items"][0]["state"], "night")
        self.service.rpc("CLAUDE_HISTORY_SET_DELETED", {"id": "7-2", "deleted": True})
        self.assertEqual(self.service.rpc("CLAUDE_NIGHT", {})["count"], 2)
        self.assertFalse(self.service.tick(at(28, 0, 30)))   # 00:30 is before tonight's window
        self.assertFalse(self.service.tick(at(28, 12, 0)))   # noon is after it
        self.assertEqual(self.launches, [])
        self.assertTrue(self.service.tick(at(28, 1, 5)))
        self.assertFalse(self.service.tick(at(28, 1, 6)))    # already running
        self.assertEqual(self.wait("7-1")["result"], "Готово: оплата починена.")
        self.assertEqual(self.wait("7-3")["state"], "completed")
        self.service.shift.join(2)
        self.assertEqual([l["cwd"] for l in self.launches], [str(self.crm), str(self.shop)])
        argv = self.launches[0]["argv"]
        self.assertEqual(argv[argv.index("--permission-prompts") + 1], "none")
        self.assertNotIn("--permission-prompt-tool", argv)
        summary = next(text for key, text in self.notes if key.startswith("claude:night:"))
        self.assertIn("Ночная смена Claude: готово 2, ошибок 0", summary)
        self.assertIn("• CRM: Готово: оплата починена.", summary)
        self.assertEqual(self.service.rpc("CLAUDE_NIGHT", {})["active"], False)
        self.assertEqual(self.service.rpc("CLAUDE_NIGHT_RUN", {})["started"], False)
        self.assertFalse(self.service.tick(at(28, 1, 7)))    # nothing left tonight

    def test_night_stop_halts_the_current_task_and_keeps_the_rest_for_the_next_night(self):
        self.process = FakeProcess(hang=True)
        self.service.rpc("CLAUDE_SEND", {"id": "8-1", "textId": "8-1", "project": str(self.crm), "night": True}, lambda _: "Долгая задача")
        self.service.rpc("CLAUDE_SEND", {"id": "8-2", "textId": "8-2", "project": str(self.shop), "night": True}, lambda _: "Вторая")
        run = self.service.rpc("CLAUDE_NIGHT_RUN", {})
        self.assertEqual((run["started"], run["active"]), (True, True))
        for _ in range(400):
            if self.service.rpc("CLAUDE_JOB", {"id": "8-1"})["job"]["state"] == "running":
                break
            time.sleep(0.005)
        self.assertEqual(self.service.rpc("CLAUDE_NIGHT_STOP", {})["ok"], True)
        self.assertEqual(self.wait("8-1")["error"], "Остановлено с часов")
        self.service.shift.join(2)
        self.assertTrue(self.process.terminated)
        self.assertEqual(self.service.rpc("CLAUDE_JOB", {"id": "8-2"})["job"]["state"], "night")
        self.assertEqual(self.service.rpc("CLAUDE_NIGHT", {})["active"], False)
        self.assertEqual(len(self.launches), 1)
        self.service.rpc("CLAUDE_HISTORY_SET_DELETED", {"id": "8-2", "deleted": True})
        self.assertEqual(self.service.rpc("CLAUDE_HISTORY_EMPTY_TRASH", {})["removed"], 1)

    def test_research_runs_web_only_and_sends_the_report_as_a_file(self):
        files = []
        self.service.send_file = lambda key, name, data, caption="": files.append((key, name, data, caption)) or True
        report = ("## Для часов\nДва вывода.\nТретий вывод.\n## Отчёт\n### Контекст\nМного текста (источник: https://a.example).\n"
                  "- Источник — https://a.example")
        self.process = FakeProcess(result_json(report))
        job = self.service.rpc("CLAUDE_SEND", {"id": "6-1", "textId": "6-1", "project": "research", "kind": "research"},
                               lambda _: "Zepp OS и ИИ-агенты")["job"]
        self.assertEqual((job["kind"], job["projectLabel"]), ("research", "Исследование"))
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_SEND", {"id": "6-2", "textId": "6-2", "project": "research", "kind": "poem"}, lambda _: "x")
        done = self.wait("6-1")
        argv = self.launches[0]["argv"]
        self.assertEqual(self.launches[0]["cwd"], str(Path(self.temp.name) / "state" / "research"))
        self.assertIn("Zepp OS и ИИ-агенты", argv[2])
        self.assertIn("## Для часов", argv[2])
        self.assertEqual(argv[argv.index("--tools") + 1], "WebSearch,WebFetch")
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(argv[argv.index("--allowedTools") + 1:argv.index("--allowedTools") + 3], ["WebSearch", "WebFetch"])
        self.assertEqual(argv[argv.index("--permission-prompts") + 1], "none")
        for flag in ("--resume", "--permission-mode", "--mcp-config", "--append-system-prompt"):
            self.assertNotIn(flag, argv)
        self.assertTrue(done["result"].startswith("Два вывода.\nТретий вывод.\n\nПолный отчёт"))
        detail = self.service.rpc("CLAUDE_HISTORY_DETAIL", {"id": "6-1", "field": "result"})
        self.assertEqual(detail["content"], report)
        self.assertEqual(detail["context"], {
            "target": "claude", "project": str(Path(self.temp.name) / "state" / "research"), "label": "Исследование",
            "sessionId": "11111111-2222-3333-4444-555555555555", "mode": "auto",
            "jobId": "6-1", "openJob": True, "resumeJob": True, "autoRecord": False,
        })
        self.assertEqual(dict(self.notes)["claude:6-1:completed"], "Claude · Исследование\nДва вывода.\nТретий вывод.")
        key, name, data, caption = files[0]
        self.assertEqual(key, "claude:6-1:report")
        self.assertTrue(name.endswith("-claude-zepp-os-и-ии-агенты.md"), name)
        self.assertIn(report.encode(), data)
        self.assertIn("Zepp OS", caption)
        saved = list((Path(self.temp.name) / "state" / "research").glob("*.md"))
        self.assertEqual([p.name for p in saved], [name])
        self.assertEqual(self.service.rpc("CLAUDE_LATEST", {"project": "research"})["job"]["id"], "6-1")
        self.assertEqual(self.service.rpc("CLAUDE_HISTORY_LIST", {"limit": 3})["items"][0]["projectLabel"], "Исследование")

    def test_presets_run_without_dictation_under_a_read_only_allowlist(self):
        presets = self.service.rpc("CLAUDE_QUICK_LIST", {"limit": 10})["items"]
        self.assertEqual([p["id"] for p in presets], ["broken", "status", "review"])
        self.assertEqual(presets[0]["label"], "Что упало?")
        job = self.service.rpc("CLAUDE_SEND", {"id": "4-1", "project": str(self.crm), "mode": "bypass", "presetId": "broken"})["job"]
        self.assertEqual(job["preset"], "broken")
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_SEND", {"id": "4-2", "project": str(self.shop), "presetId": "nope"})
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_SEND", {"id": "4-3", "project": "research", "kind": "research", "presetId": "broken"})
        self.assertEqual(self.wait("4-1")["state"], "completed")
        argv = self.launches[0]["argv"]
        self.assertIn("Разберись, что сломалось", argv[2])
        self.assertEqual(argv[argv.index("--permission-prompts") + 1], "none")
        self.assertIn("--strict-mcp-config", argv)
        allowed = argv[argv.index("--allowedTools") + 1:argv.index("--permission-prompts")]
        self.assertIn("Bash(gh pr view*)", allowed); self.assertIn("Read", allowed)
        for wide in ("Edit", "Write", "Bash(gh *)", "Bash(git *)", "Bash"):
            self.assertNotIn(wide, allowed)
        for flag in ("--dangerously-skip-permissions", "--permission-mode", "--mcp-config", "--resume"):
            self.assertNotIn(flag, argv)
        self.assertEqual(self.service.rpc("CLAUDE_HISTORY_DETAIL", {"id": "4-1", "field": "text"})["content"][:20], "Разберись, что слома")

    def test_deep_research_runs_the_bundled_workflow_and_keeps_the_last_turn(self):
        files = []
        self.service.send_file = lambda key, name, data, caption="": files.append(name) or True
        first = json.dumps({"type": "result", "result": "Я запустил исследование в фоне.", "session_id": "11111111-2222-3333-4444-555555555555",
                            "is_error": False, "permission_denials": [], "num_turns": 2})
        noise = json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "content": "result: nope"}]}})
        final = json.dumps({"type": "result", "result": "## Для часов\nГлавный вывод.\n## Отчёт\nПодробно (источник)", "session_id": "11111111-2222-3333-4444-555555555555",
                            "is_error": False, "permission_denials": [{"tool_name": "Bash"}] * 60, "num_turns": 1})
        self.process = FakeProcess("\n".join([json.dumps({"type": "system", "subtype": "init"}), first, noise, final]) + "\n")
        timeouts = []
        original = self.process.communicate
        self.process.communicate = lambda timeout=None: timeouts.append(timeout) or original(timeout)
        job = self.service.rpc("CLAUDE_SEND", {"id": "6-5", "textId": "6-5", "project": "research", "kind": "deep"},
                               lambda _: "Умные часы  и агенты")["job"]
        self.assertEqual(job["kind"], "deep")
        done = self.wait("6-5")
        self.assertEqual(done["result"], "Главный вывод.\n\nПолный отчёт: файл в Telegram и в Истории.")
        self.assertEqual(timeouts, [3600])
        argv = self.launches[0]["argv"]
        self.assertEqual(argv[2], "/deep-research Умные часы и агенты")
        self.assertEqual(argv[argv.index("--output-format") + 1], "stream-json")
        self.assertIn("--verbose", argv)
        self.assertEqual(argv[argv.index("--allowedTools") + 1:argv.index("--permission-prompts")], ["Workflow(deep-research)", "WebSearch", "WebFetch"])
        self.assertIn("Дождись уведомления", argv[argv.index("--append-system-prompt") + 1])
        full = self.service.rpc("CLAUDE_HISTORY_DETAIL", {"id": "6-5", "field": "result"})["content"]
        self.assertTrue(full.startswith("## Для часов"))
        self.assertNotIn("Отклонено запросов разрешений", full)
        self.assertEqual(len(files), 1)

    def test_pr_review_lists_open_prs_and_takes_the_number_from_the_picker_or_the_dictation(self):
        calls = []
        def run(argv, **kwargs):
            calls.append(argv)
            class Out: pass
            out = Out(); out.returncode, out.stderr = 0, ""
            if argv[:3] == ["git", "-C", str(self.crm)]:
                out.stdout = "git@github.com:fikra/crm.git\n"
            elif argv[:3] == ["git", "-C", str(self.shop)]:
                out.stdout = ""; out.returncode = 128
            else:
                out.stdout = json.dumps([{"number": 12, "title": "Оплата картой " + "x" * 80, "headRefName": "pay", "author": {"login": "owner"}},
                                         {"number": 9, "title": "Тесты", "headRefName": "tests", "author": {}}, {"number": "bad"}])
            return out
        self.service.run = run
        prs = self.service.rpc("CLAUDE_PRS", {"project": str(self.crm), "limit": 10})
        self.assertEqual(prs["repo"], "fikra/crm")
        self.assertEqual([p["number"] for p in prs["items"]], [12, 9])
        self.assertEqual((len(prs["items"][0]["title"]), prs["items"][0]["author"], prs["items"][1]["branch"]), (60, "owner", "tests"))
        self.assertEqual(calls[-1][:6], ["gh", "pr", "list", "-R", "fikra/crm", "--state"])
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_PRS", {"project": str(self.shop)})
        review = next(p for p in self.service.rpc("CLAUDE_QUICK_LIST", {"limit": 10})["items"] if p["id"] == "review")
        self.assertEqual((review["label"], review["arg"]), ("Ревью PR", "pr"))
        self.service.rpc("CLAUDE_SEND", {"id": "4-5", "project": str(self.crm), "presetId": "review", "pr": 12})
        self.assertEqual(self.wait("4-5")["state"], "completed")
        text = self.service.rpc("CLAUDE_HISTORY_DETAIL", {"id": "4-5", "field": "text"})["content"]
        self.assertIn("pull request #12", text); self.assertIn("`gh pr diff 12`", text); self.assertNotIn("{pr}", text)
        for bad in ({"pr": "12"}, {"pr": 0}, {}):
            with self.assertRaises(ValueError):
                self.service.rpc("CLAUDE_SEND", {"id": "4-6", "project": str(self.crm), "presetId": "review", **bad})
        spoken = self.service.rpc("CLAUDE_SEND", {"id": "4-7", "textId": "4-7", "project": str(self.crm), "presetId": "review"},
                                  lambda _: "Проверь PR 9, пожалуйста")["job"]
        self.assertEqual(spoken["preset"], "review")
        self.assertIn("pull request #9", self.service.rpc("CLAUDE_HISTORY_DETAIL", {"id": "4-7", "field": "text"})["content"])
        with self.assertRaises(ValueError):
            self.service.rpc("CLAUDE_SEND", {"id": "4-8", "textId": "4-8", "project": str(self.crm), "presetId": "review"}, lambda _: "проверь пиар")

    def test_agent_questions_are_answered_one_choice_at_a_time(self):
        folder = Path(self.temp.name) / "state" / "permissions" / "5-7"
        request = {"id": "0123456789abcdef", "toolName": "AskUserQuestion", "created": time.time(), "input": {"questions": [
            {"question": "Какой цвет?", "header": "Цвет", "options": [{"label": "Красный", "description": ""}, {"label": "Синий", "description": ""}], "multiSelect": False},
            {"question": "Какой размер?", "options": [{"label": "S"}, {"label": "M"}, {"label": "L"}]}]}}
        self.process = PromptingProcess(folder, request=request)
        self.service.rpc("CLAUDE_SEND", {"id": "5-7", "textId": "5-7", "project": str(self.crm), "mode": "auto"}, lambda _: "Сделай кнопку")
        for _ in range(200):
            job = self.service.rpc("CLAUDE_JOB", {"id": "5-7"})["job"]
            if job["state"] == "approval":
                break
            time.sleep(0.01)
        self.assertEqual(job["approval"]["question"], "Какой цвет?")
        self.assertEqual((job["approval"]["options"], job["approval"]["step"]), (["Красный", "Синий"], "1/2"))
        self.assertEqual(job["approval"]["text"], "Вопрос:\nКакой цвет?\nВарианты: Красный / Синий")
        for _ in range(300):
            if any(key == "claude:5-7:approval:0123456789abcdef" for key, _ in self.notes):
                break
            time.sleep(0.01)
        self.assertIn("Вопрос:\nКакой цвет?", dict(self.notes)["claude:5-7:approval:0123456789abcdef"])
        for bad in ({"answer": "Жёлтый"}, {"answer": ""}, {"answer": "Синий", "allow": False}, {"answer": 5}):
            with self.assertRaises(ValueError):
                self.service.rpc("CLAUDE_APPROVE", {"id": "5-7", "approvalId": "0123456789abcdef", "allow": True, **bad})
        after_first = self.service.rpc("CLAUDE_APPROVE", {"id": "5-7", "approvalId": "0123456789abcdef", "allow": True, "answer": "Синий"})["job"]
        self.assertEqual((after_first["state"], after_first["approval"]["question"], after_first["approval"]["step"]), ("approval", "Какой размер?", "2/2"))
        self.assertFalse((folder / "0123456789abcdef.decision.json").exists())
        self.service.rpc("CLAUDE_APPROVE", {"id": "5-7", "approvalId": "0123456789abcdef", "allow": True, "answer": "M"})
        done = self.wait("5-7")
        self.assertEqual(done["state"], "completed")
        self.assertEqual(self.process.decision["answers"], {"Какой цвет?": "Синий", "Какой размер?": "M"})

    def test_restart_marks_unfinished_jobs_as_errors(self):
        self.service.rpc("CLAUDE_SEND", {"id": "4-1", "textId": "4-1", "project": str(self.shop)}, lambda _: "x")
        self.wait("4-1")
        # Simulate a bridge that died mid-run: the row is still 'running' on disk.
        with self.service.lock:
            self.service.db.execute("UPDATE jobs SET state='running' WHERE id='4-1'")
            self.service.db.commit()
        self.service.close()
        self.service = ClaudeService(Path(self.temp.name) / "state", executable="/fake/claude", projects_root=self.root,
                                     runner=lambda *a, **k: FakeProcess())
        job = self.service.rpc("CLAUDE_JOB", {"id": "4-1"})["job"]
        self.assertEqual(job["state"], "error")
        self.assertIn("перезапущен", job["error"])

if __name__ == "__main__":
    unittest.main()
