import json
from pathlib import Path
import re
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from orca_service import OrcaService, CliFailure


WORKSPACE = "repo-1::/tmp/project"
WORKER = "term_11111111-1111-1111-1111-111111111111"
REVIEWER = "term_22222222-2222-2222-2222-222222222222"
COORDINATOR = "term_33333333-3333-3333-3333-333333333333"


class FakeCli:
    def __init__(self, plans=None):
        self.calls = []
        self.runtime = "runtime-1"
        self.incarnations = {WORKER: "inc-worker", REVIEWER: "inc-reviewer",
                             COORDINATOR: "inc-coordinator"}
        self.idle = {WORKER: True, REVIEWER: True}
        self.plans = list(plans or [
            ("reviewer", {"decision": "work", "prompt": "Исправь один файл", "summary": "План"}),
            ("worker", {"decision": "done", "prompt": "", "summary": "Исправлено"}),
            ("reviewer", {"decision": "done", "prompt": "", "summary": "Проверено " + "я" * 1400}),
        ])
        self.messages = []
        self.history = []
        self.legacy_drop_once = False
        self.delivery = 0
        self.dispatch = 0
        self.unknown_create = False
        self.question_first = False
        self.question_sent = False
        self.pending_report = None
        self.forged_first = False
        self.question_text = "Какой вариант выбрать?"
        self.dispatches = {}
        self.malformed_first = None
        self.fail_on_dispatch = None
        self.reply_delay = 0
        self.abandon_confirmed = True
        self.interrupt_accepted = True
        self.worker_start_entered = None
        self.worker_start_release = None

    def run(self, argv, timeout=None):
        self.calls.append(tuple(argv))
        if "--retry-request" in argv:
            raise AssertionError("First submissions must not invent an Orca recovery UUID")
        if argv[:2] == ["worktree", "ps"]:
            return self._env({"worktrees": [{"worktreeId": WORKSPACE, "repoId": "repo-1",
                "repo": "Project", "path": "/tmp/project", "displayName": "main",
                "workspaceKind": "git", "isArchived": False}]})
        if argv[:2] == ["terminal", "list"]:
            return self._env({"terminals": [self._term(WORKER, "Worker", "codex"),
                                             self._term(REVIEWER, "Reviewer", "claude")]})
        if argv[:2] == ["terminal", "show"]:
            handle = argv[argv.index("--terminal") + 1]
            agent = "codex" if handle == WORKER else "claude" if handle == REVIEWER else None
            return self._env({"terminal": self._term(handle, "Coordinator" if not agent else agent, agent)})
        if argv[:2] == ["terminal", "wait"]:
            handle = argv[argv.index("--terminal") + 1]
            return self._env({"wait": {"satisfied": self.idle.get(handle, False)}})
        if argv[:1] == ["status"]:
            return self._env({"runtime": {"state": "ready"}})
        if argv[:2] == ["terminal", "create"]:
            if self.unknown_create:
                raise TimeoutError()
            return self._env({"terminal": self._term(COORDINATOR, "Coordinator", None)})
        if argv[:2] == ["orchestration", "run-create"]:
            return self._env({"run": {"id": "run-1"}})
        if argv[:2] == ["orchestration", "worker-start"]:
            if self.worker_start_entered is not None:
                self.worker_start_entered.set()
                self.worker_start_release.wait(3)
            terminal = argv[argv.index("--terminal") + 1]
            role = "worker" if terminal == WORKER else "reviewer"
            expected_role, report = self.plans.pop(0)
            assert role == expected_role
            spec = argv[argv.index("--spec") + 1]
            match = re.search(r"ORCA_REPORT_PATH=([^ ]+)", spec)
            assert match
            path = Path(match.group(1))
            self.dispatch += 1
            dispatch = f"dispatch-{self.dispatch}"
            task = f"task-{self.dispatch}"
            outcome = "failed" if self.fail_on_dispatch == self.dispatch else "succeeded"
            self.dispatches[dispatch] = {"task": task, "outcome": outcome}
            if self.question_first and not self.question_sent:
                self.question_sent = True
                self.pending_report = (path, report, dispatch)
                self._message({"id": "question-1", "type": "question",
                               "dispatchId": dispatch, "question": self.question_text})
            else:
                path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
                if self.forged_first:
                    self.forged_first = False
                    self._message({"id": "forged", "type": "worker_done",
                                   "dispatchId": "dispatch-forged", "outcome": "succeeded"})
                if self.malformed_first:
                    malformed = {"id": "malformed", "type": "worker_done",
                                 "dispatchId": dispatch, "taskId": task,
                                 "outcome": outcome}
                    malformed.pop(self.malformed_first)
                    self._message(malformed)
                    self.malformed_first = None
                self._message({"id": f"done-{self.dispatch}", "type": "worker_done",
                               "dispatchId": dispatch, "taskId": task, "outcome": outcome})
            return self._env({"dispatch": {"id": dispatch}, "task": {"id": task}})
        if argv[:2] == ["orchestration", "check"]:
            if "--all" in argv:
                return self._env({"messages": list(self.history)})
            if "--ack" in argv and self.messages:
                self.messages.pop(0)
            if self.legacy_drop_once and self.messages:
                self.legacy_drop_once = False
                result = json.loads(json.dumps(self.messages[0]))
                result["delivery"]["messages"][0]["payload"] = "{}"
                return self._env(result)
            return self._env(self.messages[0] if self.messages else {})
        if argv[:2] == ["orchestration", "reply"]:
            if self.reply_delay:
                time.sleep(self.reply_delay)
            path, report, dispatch = self.pending_report
            path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
            self._message({"id": "done-after-reply", "type": "worker_done",
                           "dispatchId": dispatch,
                           "taskId": self.dispatches[dispatch]["task"],
                           "outcome": "succeeded"})
            self.pending_report = None
            return self._env({"accepted": True})
        if argv[:2] == ["orchestration", "worker-show"]:
            dispatch = argv[argv.index("--dispatch") + 1]
            item = self.dispatches[dispatch]
            task_status = "completed" if item["outcome"] == "succeeded" else "failed"
            return self._env({"dispatch": {"id": dispatch, "taskId": item["task"],
                "status": item["outcome"], "outcome": item["outcome"]},
                "task": {"id": item["task"], "status": task_status},
                "worker": {"state": item["outcome"], "stage": "settled"}})
        if argv[:2] == ["orchestration", "worker-retain"]:
            return self._env({"retained": True})
        if argv[:2] == ["orchestration", "worker-abandon"]:
            return self._env({"abandoned": self.abandon_confirmed,
                              "dispatchId": argv[argv.index("--dispatch") + 1]})
        if argv[:2] == ["terminal", "send"]:
            return self._env({"send": {"accepted": self.interrupt_accepted,
                                        "handle": argv[argv.index("--terminal") + 1]}})
        raise AssertionError(argv)

    def _message(self, message):
        message = dict(message)
        payload = {key: message.pop(key) for key in ("taskId", "dispatchId", "outcome") if key in message}
        message["payload"] = json.dumps(payload)
        self.history.append(message)
        self.delivery += 1
        self.messages.append({"delivery": {"id": f"delivery-{self.delivery}",
                                            "messages": [message]}})

    def _term(self, handle, title, agent):
        return {"handle": handle, "incarnationId": self.incarnations[handle],
                "orphaned": False, "worktreeId": WORKSPACE, "worktreePath": "/tmp/project",
                "title": title, "connected": True, "writable": True,
                "agentIdentity": agent}

    def _env(self, result):
        return {"ok": True, "result": result, "_meta": {"runtimeId": self.runtime}}


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class TimedCli(FakeCli):
    def __init__(self, clock, durations):
        super().__init__()
        self.clock = clock
        self.durations = {key: list(values) for key, values in durations.items()}
        self.timed_calls = []

    def run(self, argv, timeout=None):
        key = tuple(argv[:2])
        duration = self.durations.get(key, [0]).pop(0) if self.durations.get(key) else 0
        self.timed_calls.append((tuple(argv), timeout))
        if timeout is not None and duration > timeout:
            self.clock.advance(timeout)
            raise TimeoutError()
        self.clock.advance(duration)
        return super().run(argv, timeout)


class OrcaServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake = FakeCli()
        self.service = OrcaService(self.tmp.name, self.fake)

    def tearDown(self):
        self.service.close()
        self.tmp.cleanup()

    def bind(self):
        return self.service.rpc("ORCA_BIND", {"workspaceId": WORKSPACE,
            "workerId": WORKER, "reviewerId": REVIEWER})["pair"]

    def wait(self, job_id, states=("completed", "error", "unknown")):
        for _ in range(400):
            job = self.service.rpc("ORCA_JOB", {"id": job_id})["job"]
            if job["state"] in states:
                return job
            time.sleep(.01)
        self.fail(f"job did not settle: {job}")

    def test_read_timeout_retries_without_repeating_mutations(self):
        original = self.fake.run
        calls = []
        def flaky(argv, timeout=None):
            if argv[:2] == ['terminal', 'show']:
                calls.append(argv)
                if len(calls) == 1:
                    raise TimeoutError()
            return original(argv, timeout)
        self.fake.run = flaky
        term = self.service._terminal(WORKER, WORKSPACE, require_idle=False)
        self.assertEqual(term['handle'], WORKER)
        self.assertEqual(len(calls), 2)
        self.assertFalse(any(c[:2] == ('terminal', 'create') for c in self.fake.calls))

    def test_terminal_discovery_has_one_total_budget_and_never_returns_partial_success(self):
        clock = FakeClock()
        cli = TimedCli(clock, {
            ("worktree", "ps"): [1],
            ("terminal", "list"): [1],
            ("terminal", "show"): [10, 10],
        })
        self.service.close()
        self.service = OrcaService(self.tmp.name, cli)
        with patch("orca_service.time.monotonic", clock.monotonic):
            with self.assertRaises(CliFailure) as raised:
                self.service.rpc("ORCA_TERMINALS", {"workspaceId": WORKSPACE})
        self.assertEqual(raised.exception.code, "request_deadline")
        self.assertEqual(clock.now, 8)
        self.assertEqual([round(timeout, 3) for _, timeout in cli.timed_calls], [8, 7, 5, 1])
        self.assertEqual(len([call for call, _ in cli.timed_calls
                              if call[:2] == ("terminal", "show")]), 2)

    def test_bind_reuses_catalog_snapshot_and_clips_each_call_to_remaining_budget(self):
        clock = FakeClock()
        cli = TimedCli(clock, {
            ("worktree", "ps"): [1],
            ("terminal", "show"): [1, 1],
            ("terminal", "wait"): [1, 1],
            ("status", "--json"): [1],
        })
        self.service.close()
        self.service = OrcaService(self.tmp.name, cli)
        with patch("orca_service.time.monotonic", clock.monotonic):
            pair = self.bind()
        self.assertEqual(pair["workspaceId"], WORKSPACE)
        catalogs = [call for call, _ in cli.timed_calls if call[:2] == ("worktree", "ps")]
        self.assertEqual(len(catalogs), 1)
        self.assertEqual([round(timeout, 3) for _, timeout in cli.timed_calls],
                         [8, 5, 1, 5, 1, 3])

    def test_bind_deadline_does_not_persist_pair(self):
        clock = FakeClock()
        cli = TimedCli(clock, {
            ("worktree", "ps"): [1],
            ("terminal", "show"): [1, 1],
            ("terminal", "wait"): [1, 1],
            ("status", "--json"): [10],
        })
        self.service.close()
        self.service = OrcaService(self.tmp.name, cli)
        with patch("orca_service.time.monotonic", clock.monotonic):
            with self.assertRaises(CliFailure) as raised:
                self.bind()
        self.assertEqual(raised.exception.code, "request_deadline")
        self.assertEqual(clock.now, 8)
        self.assertEqual(self.service.db.execute("SELECT count(*) FROM pairs").fetchone()[0], 0)
        self.assertEqual(len([call for call, _ in cli.timed_calls
                              if call[:2] == ("status", "--json")]), 1)

    def test_late_cli_success_cannot_escape_menu_deadline(self):
        clock = FakeClock()
        timeouts = []

        def late_success(argv, timeout=None):
            timeouts.append(timeout)
            clock.advance(9)
            return self.fake.run(argv, timeout)

        self.service.cli = late_success
        with patch("orca_service.time.monotonic", clock.monotonic):
            with self.assertRaises(CliFailure) as raised:
                self.service.rpc("ORCA_LIST", {})
        self.assertEqual(raised.exception.code, "request_deadline")
        self.assertEqual(timeouts, [8])

    def test_menu_budget_is_thread_local_and_cleared_after_rpc(self):
        timeouts = []
        background = []
        started = False

        def runner(argv, timeout=None):
            nonlocal started
            timeouts.append((tuple(argv), timeout, threading.current_thread().name))
            if argv[:2] == ["worktree", "ps"] and not started:
                started = True
                thread = threading.Thread(
                    target=lambda: background.append(
                        self.service._call(["status", "--json"], timeout=20)[0]))
                thread.start()
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())
            return self.fake.run(argv, timeout)

        self.service.cli = runner
        self.service.rpc("ORCA_LIST", {})
        self.service._call(["status", "--json"], timeout=5)
        self.assertEqual(background[0]["runtime"]["state"], "ready")
        status_timeouts = [timeout for argv, timeout, _ in timeouts
                           if argv[:2] == ("status", "--json")]
        self.assertEqual(status_timeouts, [20, 5])

    def test_unreadable_saved_coordinator_is_not_recreated(self):
        pair = self.bind()
        row = dict(self.service._pair(pair['id']))
        row.update(coordinator_id=COORDINATOR, coordinator_incarnation='inc-coordinator')
        original = self.fake.run
        def unavailable(argv, timeout=None):
            if argv[:2] == ['terminal', 'show']:
                raise TimeoutError()
            return original(argv, timeout)
        self.fake.run = unavailable
        with self.assertRaises(CliFailure) as raised:
            self.service._ensure_coordinator('not-created', row)
        self.assertEqual(raised.exception.code, 'read_unavailable')
        self.assertFalse(any(c[:2] == ('terminal', 'create') for c in self.fake.calls))

    def test_preflight_timeout_reports_not_sent_instead_of_unknown(self):
        pair = self.bind()
        original = self.fake.run
        def unavailable(argv, timeout=None):
            if argv[:2] == ['terminal', 'show']:
                raise TimeoutError()
            return original(argv, timeout)
        self.fake.run = unavailable
        self.service.rpc('ORCA_SEND', {'id':'preflight-1','textId':'text-1','pairId':pair['id']}, lambda _: 'Проверь файл')
        job = self.wait('preflight-1')
        self.assertEqual(job['state'], 'error')
        self.assertIn('не отправлено', job['error'])
        self.assertEqual(self.fake.dispatch, 0)
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM operations WHERE job_id=?', ('preflight-1',)).fetchone()[0], 0)

    def test_catalog_binding_and_whole_loop_with_paged_result(self):
        listing = self.service.rpc("ORCA_LIST", {"limit": 3})
        self.assertEqual(listing["workspaces"][0]["id"], WORKSPACE)
        terminals = self.service.rpc("ORCA_TERMINALS", {"workspaceId": WORKSPACE})
        self.assertEqual({t["status"] for t in terminals["terminals"]}, {"idle"})
        pair = self.bind()
        self.assertEqual(pair["workerRole"], "Боевой")
        queued = self.service.rpc("ORCA_SEND", {"id": "job-1", "textId": "text-1",
                                                 "pairId": pair["id"]}, lambda _: "Сделай задачу")
        self.assertEqual(queued["job"]["state"], "queued")
        done = self.wait("job-1")
        self.assertEqual(done["state"], "completed")
        self.assertTrue(done["hasMore"])
        second = self.service.rpc("ORCA_JOB", {"id": "job-1", "cursor": done["nextCursor"]})["job"]
        self.assertGreater(len(done["result"] + second["result"]), 1400)
        starts = [c for c in self.fake.calls if c[:2] == ("orchestration", "worker-start")]
        self.assertEqual(len(starts), 3)
        retains = [c for c in self.fake.calls if c[:2] == ("orchestration", "worker-retain")]
        acknowledgements = [c for c in self.fake.calls
                            if c[:2] == ("orchestration", "check") and "--ack" in c]
        self.assertEqual(len(retains), 3)
        self.assertEqual(len(acknowledgements), 3)

    def test_busy_terminal_is_not_bindable(self):
        self.fake.idle[WORKER] = False
        with self.assertRaises(ValueError):
            self.bind()

    def test_acknowledged_json_payload_settlement_recovers_without_redispatch(self):
        self.fake.legacy_drop_once = True
        pair = self.bind()
        self.service.rpc("ORCA_SEND", {"id": "job-recover-json", "textId": "text-json",
                         "pairId": pair["id"]}, lambda _: "Test task")
        done = self.wait("job-recover-json")
        self.assertEqual(done["state"], "completed")
        self.assertEqual(self.fake.dispatch, 3)
        acknowledgements = [c[c.index("--ack") + 1] for c in self.fake.calls if "--ack" in c]
        self.assertEqual(len(acknowledgements), len(set(acknowledgements)))

    def test_duplicate_job_id_is_idempotent_and_conflict_rejected(self):
        pair = self.bind()
        lookup_calls = []
        lookup = lambda value: lookup_calls.append(value) or "Задача"
        params = {"id": "job-2", "textId": "text-2", "pairId": pair["id"]}
        self.service.rpc("ORCA_SEND", params, lookup)
        self.service.rpc("ORCA_SEND", params, lookup)
        self.assertEqual(lookup_calls, ["text-2"])
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_SEND", {**params, "textId": "other"}, lookup)

    def test_changed_identity_stops_before_dispatch(self):
        pair = self.bind()
        self.fake.incarnations[REVIEWER] = "replaced"
        self.service.rpc("ORCA_SEND", {"id": "job-3", "textId": "text-3",
            "pairId": pair["id"]}, lambda _: "Задача")
        failed = self.wait("job-3")
        self.assertEqual(failed["state"], "error")
        self.assertFalse(any(c[:2] == ("orchestration", "worker-start") for c in self.fake.calls))

    def test_unknown_create_is_durable_and_never_retried_after_restart(self):
        pair = self.bind()
        self.fake.unknown_create = True
        params = {"id": "job-4", "textId": "text-4", "pairId": pair["id"]}
        self.service.rpc("ORCA_SEND", params, lambda _: "Задача")
        self.assertEqual(self.wait("job-4")["state"], "unknown")
        creates = len([c for c in self.fake.calls if c[:2] == ("terminal", "create")])
        self.service.close()
        self.service = OrcaService(self.tmp.name, self.fake)
        same = self.service.rpc("ORCA_SEND", params, lambda _: "Задача")["job"]
        self.assertEqual(same["state"], "unknown")
        self.assertEqual(len([c for c in self.fake.calls if c[:2] == ("terminal", "create")]), creates)

    def test_durable_question_reply_uses_exact_id(self):
        self.fake.question_first = True
        self.fake.question_text = "Какой вариант? " + "я" * 1200
        pair = self.bind()
        self.service.rpc("ORCA_SEND", {"id": "job-5", "textId": "text-5",
            "pairId": pair["id"]}, lambda _: "Задача")
        question = self.wait("job-5", states=("question",))
        self.assertEqual(question["questionId"], "question-1")
        self.assertEqual(len(question["question"]), 1000)
        self.assertIsNotNone(question["questionNextCursor"])
        rest = self.service.rpc("ORCA_JOB", {"id": "job-5",
            "questionCursor": question["questionNextCursor"]})["job"]
        self.assertEqual(question["question"] + rest["question"], self.fake.question_text)
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_REPLY", {"id": "job-5", "questionId": "old",
                "textId": "answer-1"}, lambda _: "Ответ")
        self.service.rpc("ORCA_REPLY", {"id": "job-5", "questionId": "question-1",
            "textId": "answer-1"}, lambda _: "Ответ")
        self.assertEqual(self.wait("job-5")["state"], "completed")
        reply = next(c for c in self.fake.calls if c[:2] == ("orchestration", "reply"))
        self.assertEqual(reply[reply.index("--id") + 1], "question-1")

    def test_owner_is_notified_once_per_question_and_final_state(self):
        self.service.close()
        notes = []
        self.service = OrcaService(self.tmp.name, self.fake,
                                   notify=lambda key, text: notes.append((key, text)) or True)
        self.fake.question_first = True
        pair = self.bind()
        self.service.rpc("ORCA_SEND", {"id": "job-9", "textId": "text-9",
                                       "pairId": pair["id"]}, lambda _: "Задача")
        self.wait("job-9", states=("question",))
        self.assertEqual([key for key, _ in notes], ["orca:job-9:question:question-1"])
        self.assertIn("Какой вариант выбрать?", notes[0][1])
        self.assertIn("Project", notes[0][1])
        self.service.rpc("ORCA_JOB", {"id": "job-9"})
        self.service.rpc("ORCA_REPLY", {"id": "job-9", "questionId": "question-1",
                                        "textId": "answer-9"}, lambda _: "Ответ")
        self.assertEqual(self.wait("job-9")["state"], "completed")
        self.assertEqual([key for key, _ in notes],
                         ["orca:job-9:question:question-1", "orca:job-9:completed"])
        self.assertIn("Задача готова", notes[1][1])

    def test_quick_command_runs_the_pair_without_dictation(self):
        listing = self.service.rpc("ORCA_QUICK_LIST", {"limit": 3})
        self.assertEqual([c["id"] for c in listing["commands"]], ["continue", "status", "tests"])
        self.assertTrue(listing["hasMore"])
        more = self.service.rpc("ORCA_QUICK_LIST", {"cursor": listing["nextCursor"], "limit": 3})
        self.assertEqual([c["id"] for c in more["commands"]], ["commit", "review"])
        pair = self.bind()
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_SEND", {"id": "job-q", "pairId": pair["id"], "presetId": "nope"})
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_SEND", {"id": "job-q", "pairId": pair["id"], "presetId": "tests", "textId": "t"})
        queued = self.service.rpc("ORCA_SEND", {"id": "job-q", "pairId": pair["id"], "presetId": "tests"})
        self.assertEqual(queued["job"]["state"], "queued")
        self.assertEqual(self.wait("job-q")["state"], "completed")
        spec = next(c for c in self.fake.calls if c[:2] == ("orchestration", "worker-start"))
        self.assertIn("Прогони тесты проекта", spec[spec.index("--spec") + 1])
        again = self.service.rpc("ORCA_SEND", {"id": "job-q", "pairId": pair["id"], "presetId": "tests"})
        self.assertEqual(again["job"]["state"], "completed")
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_SEND", {"id": "job-q", "pairId": pair["id"], "presetId": "commit"})
        self.assertEqual(self.service._job("job-q")["text_id"], "preset:tests")

    def test_quick_commands_come_from_config_when_valid(self):
        from orca_service import normalize_quick_commands, DEFAULT_QUICK_COMMANDS
        custom = normalize_quick_commands([
            {"id": "deploy", "label": "Деплой", "text": "Задеплой на стейджинг."},
            {"id": "BAD ID", "label": "x", "text": "y"},
            {"id": "deploy", "label": "дубль", "text": "z"},
            {"id": "empty", "label": "Пусто", "text": "   "},
            "junk",
        ])
        self.assertEqual(custom, [{"id": "deploy", "label": "Деплой", "text": "Задеплой на стейджинг."}])
        self.assertEqual(normalize_quick_commands(None), list(DEFAULT_QUICK_COMMANDS))
        self.assertEqual(normalize_quick_commands([{"id": "BAD ID"}]), list(DEFAULT_QUICK_COMMANDS))

    def test_stop_fences_dispatch_interrupts_agent_and_is_final(self):
        self.service.close()
        notes = []
        self.service = OrcaService(self.tmp.name, self.fake, notify=lambda key, text: notes.append(key) or True)
        self.fake.question_first = True
        pair = self.bind()
        self.service.rpc("ORCA_SEND", {"id": "job-s", "textId": "text-s", "pairId": pair["id"]}, lambda _: "Задача")
        self.wait("job-s", states=("question",))
        stopped = self.service.rpc("ORCA_STOP", {"id": "job-s"})["job"]
        self.assertEqual((stopped["state"], stopped["stage"], stopped["error"]), ("error", "stopped", "Остановлено с часов"))
        abandon = next(c for c in self.fake.calls if c[:2] == ("orchestration", "worker-abandon"))
        self.assertEqual(abandon[abandon.index("--dispatch") + 1], "dispatch-1")
        interrupt = next(c for c in self.fake.calls if c[:2] == ("terminal", "send"))
        self.assertEqual(interrupt[interrupt.index("--terminal") + 1], REVIEWER)
        self.assertIn("--interrupt", interrupt)
        self.assertFalse(any(c[:2] == ("orchestration", "worker-stop") for c in self.fake.calls))
        # Idempotent, silent for the owner, and final against late settlements.
        again = self.service.rpc("ORCA_STOP", {"id": "job-s"})["job"]
        self.assertEqual(again["state"], "error")
        self.assertEqual(len([c for c in self.fake.calls if c[:2] == ("terminal", "send")]), 1)
        self.assertEqual([k for k in notes if k.startswith("orca:job-s:")], ["orca:job-s:question:question-1"])
        self.service._save("job-s", state="completed", stage="completed", result="late")
        self.assertEqual(self.service._job("job-s")["state"], "error")
        self.service._fail("job-s", CliFailure("late failure"))
        self.assertEqual(self.service._job("job-s")["stage"], "stopped")
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_REPLY", {"id": "job-s", "questionId": "question-1", "textId": "a"}, lambda _: "x")
        self.assertEqual(self.service.rpc("ORCA_PAUSE", {"id": "job-s", "paused": True})["job"]["state"], "error")
        self.assertEqual(self.service.rpc("ORCA_LATEST", {"pairId": pair["id"]})["job"]["state"], "error")
        self.assertEqual(self.service.rpc("ORCA_HISTORY_LIST", {"pairId": pair["id"]})["items"][0]["state"], "error")
        # A stopped pair accepts a new task; the fake gets a fresh plan sequence.
        self.fake.plans = [
            ("reviewer", {"decision": "work", "prompt": "Сделай", "summary": "План"}),
            ("worker", {"decision": "done", "prompt": "", "summary": "Сделано"}),
            ("reviewer", {"decision": "done", "prompt": "", "summary": "Принято"}),
        ]
        self.service.rpc("ORCA_SEND", {"id": "job-t", "textId": "text-t", "pairId": pair["id"]}, lambda _: "Новая")
        self.assertEqual(self.wait("job-t")["state"], "completed")

    def test_stop_with_rejected_interrupt_is_unknown_and_fences_late_completion(self):
        self.fake.question_first = True
        self.fake.interrupt_accepted = False
        pair = self.bind()
        self.service.rpc("ORCA_SEND", {
            "id": "job-u", "textId": "text-u", "pairId": pair["id"]}, lambda _: "Задача")
        self.wait("job-u", states=("question",))
        stopped = self.service.rpc("ORCA_STOP", {"id": "job-u"})["job"]
        self.assertEqual((stopped["state"], stopped["stage"]), ("unknown", "stop_unconfirmed"))
        self.assertNotEqual(stopped["error"], "Остановлено с часов")
        self.assertIn("не подтвердила прерывание", stopped["error"])
        self.service._save("job-u", state="completed", stage="completed", result="late")
        self.assertEqual(self.service._job("job-u")["state"], "unknown")
        self.assertEqual(self.service._job("job-u")["stage"], "stop_unconfirmed")

    def test_stop_with_unconfirmed_abandon_or_active_terminal_is_unknown(self):
        self.fake.question_first = True
        self.fake.abandon_confirmed = False
        pair = self.bind()
        self.service.rpc("ORCA_SEND", {
            "id": "job-v", "textId": "text-v", "pairId": pair["id"]}, lambda _: "Задача")
        self.wait("job-v", states=("question",))
        self.fake.idle[REVIEWER] = False
        stopped = self.service.rpc("ORCA_STOP", {"id": "job-v"})["job"]
        self.assertEqual((stopped["state"], stopped["stage"]), ("unknown", "stop_unconfirmed"))
        self.assertIn("dispatch не отгорожен", stopped["error"])
        self.assertIn("всё ещё активен", stopped["error"])

    def test_stop_during_worker_start_is_unknown_and_late_dispatch_cannot_reopen_job(self):
        entered, release = threading.Event(), threading.Event()
        self.fake.worker_start_entered = entered
        self.fake.worker_start_release = release
        pair = self.bind()
        self.service.rpc("ORCA_SEND", {
            "id": "job-race", "textId": "text-race", "pairId": pair["id"]}, lambda _: "Задача")
        self.assertTrue(entered.wait(2))
        stopped = self.service.rpc("ORCA_STOP", {"id": "job-race"})["job"]
        self.assertEqual((stopped["state"], stopped["stage"]), ("unknown", "stop_unconfirmed"))
        self.assertIn("до сохранения dispatch ID", stopped["error"])
        self.assertFalse(any(call[:2] == ("terminal", "send") for call in self.fake.calls))
        release.set()
        for _ in range(200):
            if self.fake.dispatches and "job-race" not in self.service.dispatching:
                break
            time.sleep(0.005)
        row = self.service._job("job-race")
        self.assertEqual((row["state"], row["stage"]), ("unknown", "stop_unconfirmed"))
        self.assertFalse(json.loads(row["data"]).get("activeDispatch"))

    def test_stop_before_dispatch_needs_no_orca_calls(self):
        pair = self.bind()
        self.service.rpc("ORCA_PAUSE", {"id": "job-p", "paused": True}) if False else None
        before = len(self.fake.calls)
        with self.service.lock:
            self.service.db.execute("""INSERT INTO jobs(id,pair_id,text_id,source_text,state,stage,summary,data,created,updated)
                VALUES ('job-q','%s','t','Текст','queued','queued','Задача сохранена','{}',1,1)""" % pair["id"])
            self.service.db.commit()
        stopped = self.service.rpc("ORCA_STOP", {"id": "job-q"})["job"]
        self.assertEqual(stopped["state"], "error")
        self.assertEqual(len(self.fake.calls), before)

    def test_question_to_one_role_answers_once_and_hands_prompt_to_worker(self):
        self.fake.plans = [("reviewer", {"decision": "work", "prompt": "Добавь тесты для api/orders", "summary": "Мы на этапе 2: API готово, тестов нет."})]
        pair = self.bind()
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_ASK", {"id": "ask-1", "textId": "q-1", "pairId": pair["id"], "role": "boss"}, lambda _: "?")
        asked = self.service.rpc("ORCA_ASK", {"id": "ask-1", "textId": "q-1", "pairId": pair["id"], "role": "reviewer"},
                                 lambda _: "На каком этапе мы и что дальше? Подготовь промпт боевому.")["job"]
        self.assertEqual((asked["state"], asked["mode"], asked["askRole"]), ("queued", "ask", "reviewer"))
        done = self.wait("ask-1")
        self.assertEqual((done["state"], done["handoff"]), ("completed", True))
        self.assertEqual(done["result"], "Мы на этапе 2: API готово, тестов нет.")
        starts = [c for c in self.fake.calls if c[:2] == ("orchestration", "worker-start")]
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0][starts[0].index("--terminal") + 1], REVIEWER)
        spec = starts[0][starts[0].index("--spec") + 1]
        self.assertIn("Владелец задал вопрос", spec)
        self.assertIn("На каком этапе мы", spec)
        self.assertIn("Ничего не меняй", spec)
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_ASK", {"id": "ask-1", "textId": "q-1", "pairId": pair["id"], "role": "worker"}, lambda _: "x")
        # Hand the proposed prompt to the worker: worker executes it, reviewer checks, done.
        self.fake.plans = [("worker", {"decision": "done", "prompt": "", "summary": "Тесты добавлены"}),
                           ("reviewer", {"decision": "done", "prompt": "", "summary": "Проверено, тесты зелёные"})]
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_HANDOFF", {"id": "missing", "newId": "work-1"})
        handed = self.service.rpc("ORCA_HANDOFF", {"id": "ask-1", "newId": "work-1"})["job"]
        self.assertEqual((handed["state"], handed["mode"]), ("queued", "task"))
        self.assertEqual(self.service.rpc("ORCA_HANDOFF", {"id": "ask-1", "newId": "work-1"})["job"]["id"], "work-1")
        finished = self.wait("work-1")
        self.assertEqual((finished["state"], finished["result"]), ("completed", "Проверено, тесты зелёные"))
        starts = [c for c in self.fake.calls if c[:2] == ("orchestration", "worker-start")]
        self.assertEqual([s[s.index("--terminal") + 1] for s in starts], [REVIEWER, WORKER, REVIEWER])
        self.assertIn("Добавь тесты для api/orders", starts[1][starts[1].index("--spec") + 1])
        self.assertEqual(self.service._job("work-1")["text_id"], "handoff:ask-1")
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_HANDOFF", {"id": "work-1", "newId": "work-2"})

    def test_question_to_worker_without_prompt_has_no_handoff(self):
        self.fake.plans = [("worker", {"decision": "done", "prompt": "", "summary": "Сейчас правлю миграцию."})]
        pair = self.bind()
        self.service.rpc("ORCA_ASK", {"id": "ask-2", "textId": "q-2", "pairId": pair["id"], "role": "worker"}, lambda _: "Что делаешь?")
        done = self.wait("ask-2")
        self.assertEqual((done["state"], done["handoff"], done["result"]), ("completed", False, "Сейчас правлю миграцию."))
        starts = [c for c in self.fake.calls if c[:2] == ("orchestration", "worker-start")]
        self.assertEqual(starts[0][starts[0].index("--terminal") + 1], WORKER)
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_HANDOFF", {"id": "ask-2", "newId": "work-3"})

    def test_pause_blocks_initial_dispatch_until_resume(self):
        pair = self.bind()
        self.service.rpc("ORCA_SEND", {"id": "job-6", "textId": "text-6",
            "pairId": pair["id"]}, lambda _: "Задача")
        self.service.rpc("ORCA_PAUSE", {"id": "job-6", "paused": True})
        time.sleep(.1)
        self.assertFalse(any(c[:2] == ("orchestration", "worker-start") for c in self.fake.calls))
        self.service.rpc("ORCA_PAUSE", {"id": "job-6", "paused": False})
        self.assertEqual(self.wait("job-6")["state"], "completed")

    def test_forged_worker_done_does_not_settle_active_dispatch(self):
        self.fake.forged_first = True
        pair = self.bind()
        self.service.rpc("ORCA_SEND", {"id": "job-7", "textId": "text-7",
            "pairId": pair["id"]}, lambda _: "Задача")
        self.assertEqual(self.wait("job-7")["state"], "completed")
        starts = [c for c in self.fake.calls if c[:2] == ("orchestration", "worker-start")]
        self.assertEqual(len(starts), 3)

    def test_restart_fences_completed_mutation_without_saved_transition(self):
        pair = self.bind()
        self.service.rpc("ORCA_SEND", {"id": "job-8", "textId": "text-8",
            "pairId": pair["id"]}, lambda _: "Задача")
        self.service.rpc("ORCA_PAUSE", {"id": "job-8", "paused": True})
        with self.service.lock:
            updated = self.service.db.execute(
                "SELECT updated FROM jobs WHERE id='job-8'").fetchone()[0]
            self.service.db.execute("""INSERT INTO operations(
                request_id,job_id,kind,argv,state,receipt,created,updated)
                VALUES('lost','job-8','worker-start','[]','completed','{}',?,?)""",
                (updated + 1, updated + 1))
            self.service.db.commit()
        self.service.close()
        self.service = OrcaService(self.tmp.name, self.fake)
        job = self.service.rpc("ORCA_JOB", {"id": "job-8"})["job"]
        self.assertEqual(job["state"], "unknown")

    def test_missing_dispatch_task_or_outcome_never_settles(self):
        for index, missing in enumerate(("dispatchId", "taskId", "outcome"), 1):
            with self.subTest(missing=missing):
                self.service.close()
                self.tmp.cleanup()
                self.tmp = tempfile.TemporaryDirectory()
                self.fake = FakeCli()
                self.fake.malformed_first = missing
                self.service = OrcaService(self.tmp.name, self.fake)
                pair = self.bind()
                job_id = f"missing-{index}"
                self.service.rpc("ORCA_SEND", {"id": job_id, "textId": f"text-{index}",
                    "pairId": pair["id"]}, lambda _: "Задача")
                self.assertEqual(self.wait(job_id)["state"], "completed")
                shows = [c for c in self.fake.calls
                         if c[:2] == ("orchestration", "worker-show")]
                self.assertEqual(len(shows), 3)

    def test_failed_settlement_is_retained_and_delivery_acknowledged(self):
        self.fake.fail_on_dispatch = 1
        pair = self.bind()
        self.service.rpc("ORCA_SEND", {"id": "job-9", "textId": "text-9",
            "pairId": pair["id"]}, lambda _: "Задача")
        failed = self.wait("job-9")
        self.assertEqual(failed["state"], "error")
        self.assertTrue(any(c[:2] == ("orchestration", "worker-retain")
                            for c in self.fake.calls))
        self.assertTrue(any(c[:2] == ("orchestration", "check") and "--ack" in c
                            for c in self.fake.calls))

    def test_concurrent_different_jobs_leave_only_one_active(self):
        pair = self.bind()
        barrier = threading.Barrier(2)
        results = []

        def send(number):
            try:
                def lookup(_):
                    barrier.wait(timeout=2)
                    return "Задача"

                self.service.rpc("ORCA_SEND", {"id": f"race-{number}",
                    "textId": f"race-text-{number}", "pairId": pair["id"]},
                    lookup)
                results.append("ok")
            except ValueError:
                results.append("rejected")

        threads = [threading.Thread(target=send, args=(number,)) for number in (1, 2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(3)
        self.assertCountEqual(results, ["ok", "rejected"])

    def test_concurrent_duplicate_reply_mutates_orca_once(self):
        self.fake.question_first = True
        self.fake.reply_delay = .1
        pair = self.bind()
        self.service.rpc("ORCA_SEND", {"id": "job-10", "textId": "text-10",
            "pairId": pair["id"]}, lambda _: "Задача")
        self.wait("job-10", states=("question",))
        params = {"id": "job-10", "questionId": "question-1", "textId": "answer-10"}
        replies = []

        def reply():
            replies.append(self.service.rpc("ORCA_REPLY", params, lambda _: "Ответ"))

        threads = [threading.Thread(target=reply) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(3)
        self.assertEqual(len(replies), 2)
        calls = [c for c in self.fake.calls if c[:2] == ("orchestration", "reply")]
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.wait("job-10")["state"], "completed")



class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.service = OrcaService(self.temp.name, cli=FakeCli())
        now = time.time()
        with self.service.lock:
            self.service.db.execute("""INSERT INTO pairs(id,workspace_id,project_id,project_label,worker_id,
                reviewer_id,worker_title,reviewer_title,worker_agent,reviewer_agent,worker_incarnation,
                reviewer_incarnation,runtime_id,created) VALUES ('pair_a',?,'repo-1','Проект',?,?,'w','r',
                'codex','claude','i1','i2','runtime-1',?)""", (WORKSPACE, WORKER, REVIEWER, now))
            for job_id, state, text, result, created in (
                    ("j1", "completed", "Первая задача", "Отчёт один " + "я" * 700, now - 30),
                    ("j2", "error", "Вторая задача", "", now - 20),
                    ("j3", "running", "Третья задача", "", now - 10),
                    ("j4", "completed", "Четвёртая задача", "Отчёт четыре", now)):
                self.service.db.execute("""INSERT INTO jobs(id,pair_id,text_id,source_text,state,stage,summary,
                    result,error,data,created,updated) VALUES (?,?,?,?,?,?,'Итог',?,?,'{}',?,?)""",
                    (job_id, "pair_a", "t-" + job_id, text, state, state, result,
                     "Ошибка агента" if state == "error" else "", created, created))
            self.service.db.commit()

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def rpc(self, method, **params):
        return self.service.rpc(method, params)

    def test_migration_is_idempotent_across_restart(self):
        again = OrcaService(self.temp.name, cli=FakeCli())
        columns = {row[1] for row in again.db.execute("PRAGMA table_info(jobs)")}
        again.close()
        self.assertIn("deleted_at", columns)

    def test_list_orders_pages_and_maps_states(self):
        first = self.rpc("ORCA_HISTORY_LIST", pairId="pair_a", limit=3)
        self.assertEqual([x["id"] for x in first["items"]], ["j4", "j3", "j2"])
        self.assertEqual([x["state"] for x in first["items"]], ["completed", "running", "error"])
        self.assertEqual(first["items"][0]["projectLabel"], "Проект")
        self.assertTrue(first["hasMore"])
        second = self.rpc("ORCA_HISTORY_LIST", pairId="pair_a", offset=3, limit=3)
        self.assertEqual([x["id"] for x in second["items"]], ["j1"])
        self.assertFalse(second["hasMore"])
        self.assertEqual(self.rpc("ORCA_HISTORY_LIST", trash=True)["items"], [])

    def test_trash_is_reversible_idempotent_and_hidden_from_latest(self):
        self.assertEqual(self.rpc("ORCA_LATEST", pairId="pair_a")["job"]["id"], "j4")
        self.assertEqual(self.rpc("ORCA_HISTORY_SET_DELETED", id="j4", deleted=True), {"ok": True, "id": "j4", "deleted": True})
        stamp = self.service._job("j4")["deleted_at"]
        self.rpc("ORCA_HISTORY_SET_DELETED", id="j4", deleted=True)
        self.assertEqual(self.service._job("j4")["deleted_at"], stamp)
        self.assertEqual(self.rpc("ORCA_LATEST", pairId="pair_a")["job"]["id"], "j3")
        self.assertEqual([x["id"] for x in self.rpc("ORCA_HISTORY_LIST", trash=True)["items"]], ["j4"])
        self.assertEqual([x["id"] for x in self.rpc("ORCA_HISTORY_LIST", pairId="pair_a")["items"]], ["j3", "j2", "j1"])
        self.assertEqual(self.rpc("ORCA_JOB", id="j4")["job"]["state"], "completed")
        self.rpc("ORCA_HISTORY_SET_DELETED", id="j4", deleted=False)
        self.assertEqual(self.rpc("ORCA_LATEST", pairId="pair_a")["job"]["id"], "j4")
        self.assertTrue(self.rpc("ORCA_HISTORY_DETAIL", id="j4", field="result")["complete"])

    def test_active_or_unknown_tasks_cannot_be_trashed(self):
        with self.assertRaises(ValueError):
            self.rpc("ORCA_HISTORY_SET_DELETED", id="j3", deleted=True)
        self.service._save("j3", state="unknown", stage="unknown")
        with self.assertRaises(ValueError):
            self.rpc("ORCA_HISTORY_SET_DELETED", id="j3", deleted=True)
        self.assertIsNone(self.service._job("j3")["deleted_at"])

    def test_detail_pages_exactly_and_falls_back_to_error_text(self):
        page = self.rpc("ORCA_HISTORY_DETAIL", id="j1", field="result", offset=0, limit=600)
        self.assertEqual(len(page["content"]), 600)
        self.assertFalse(page["complete"])
        rest = self.rpc("ORCA_HISTORY_DETAIL", id="j1", field="result", offset=600, limit=600)
        self.assertTrue(rest["complete"])
        self.assertEqual(page["content"] + rest["content"], self.service._job("j1")["result"])
        self.assertEqual(page["total"], rest["total"])
        self.assertEqual(page["context"], {"target": "orca", "pairId": "pair_a", "label": "Проект",
                          "jobId": "j1", "resumeJob": True, "autoRecord": False})
        self.assertEqual(self.rpc("ORCA_HISTORY_DETAIL", id="j1", field="text")["content"], "Первая задача")
        self.assertEqual(self.rpc("ORCA_HISTORY_DETAIL", id="j2", field="result")["content"], "Ошибка агента")
        with self.assertRaises(ValueError):
            self.rpc("ORCA_HISTORY_DETAIL", id="j1", field="result", offset=5000)

    def test_empty_trash_removes_trashed_tasks_receipts_and_reports(self):
        with self.service.lock:
            self.service.db.execute("INSERT INTO operations(request_id,job_id,kind,argv,state,created,updated) VALUES ('op-j1','j1','run-create','[]','completed',1,1)")
            self.service.db.commit()
        report = self.service.tasks / "j1"
        report.mkdir()
        (report / "reviewer-0.json").write_text("{}")
        self.rpc("ORCA_HISTORY_SET_DELETED", id="j1", deleted=True)
        self.rpc("ORCA_HISTORY_SET_DELETED", id="j2", deleted=True)
        self.assertEqual(self.rpc("ORCA_HISTORY_EMPTY_TRASH", pairId="pair_other"), {"ok": True, "removed": 0})
        self.assertEqual(self.rpc("ORCA_HISTORY_EMPTY_TRASH", pairId="pair_a"), {"ok": True, "removed": 2})
        self.assertFalse(report.exists())
        with self.service.lock:
            self.assertEqual(self.service.db.execute("SELECT count(*) FROM operations WHERE job_id='j1'").fetchone()[0], 0)
            self.assertEqual(sorted(r[0] for r in self.service.db.execute("SELECT id FROM jobs")), ["j3", "j4"])
        self.assertEqual(self.rpc("ORCA_HISTORY_EMPTY_TRASH"), {"ok": True, "removed": 0})
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_HISTORY_EMPTY_TRASH", {"all": True})
        self.assertEqual(self.rpc("ORCA_LATEST", pairId="pair_a")["job"]["id"], "j4")

    def test_history_rejects_unknown_fields_and_bad_pages(self):
        for params in ({"limit": 4}, {"trash": "yes"}, {"pairId": "pair_a", "extra": 1}, {"offset": -1}):
            with self.assertRaises(ValueError):
                self.service.rpc("ORCA_HISTORY_LIST", params)
        for params in ({"id": "j1", "field": "summary"}, {"id": "j1", "field": "result", "limit": 601}):
            with self.assertRaises(ValueError):
                self.service.rpc("ORCA_HISTORY_DETAIL", params)
        with self.assertRaises(ValueError):
            self.service.rpc("ORCA_HISTORY_SET_DELETED", {"id": "j1", "deleted": 1})

if __name__ == "__main__":
    unittest.main()
