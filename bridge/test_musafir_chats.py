import sqlite3
import tempfile
import threading
import time
import unittest

from server import Bridge, Invalid, JOB_REPORT_MAX, JOB_RESULT_PREVIEW, LEGACY_CHAT_ID


class FakeHermes:
    def __init__(self):
        self.calls = []
        self.runs = {}
        self.counter = 0
        self.stop_response = {"status": "stopping"}
        self.stop_error = None

    def call(self, path, body=None, request_id=None, timeout=12, session_key=None):
        self.calls.append((path, body, request_id, timeout, session_key))
        if path == "/v1/runs":
            self.counter += 1
            run_id = f"run_{self.counter:032x}"
            self.runs[run_id] = {"status": "running"}
            return {"run_id": run_id}
        if path.endswith("/stop"):
            if self.stop_error:
                raise self.stop_error
            return self.stop_response
        run_id = path.rsplit("/", 1)[-1]
        return self.runs[run_id]


class ManualExecutor:
    def __init__(self):
        self.pending = []

    def submit(self, fn, *args):
        self.pending.append((fn, args))

    def shutdown(self, wait=True, cancel_futures=False):
        self.pending.clear()


class MusafirChatTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hermes = FakeHermes()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *args: "", "/tmp/model")

    def tearDown(self):
        self.bridge.close()
        self.tmp.cleanup()

    def settle(self, request_id):
        for _ in range(200):
            with self.bridge.lock:
                row = self.bridge._get("jobs", request_id)
            if row["run_id"] or row["state"] not in ("queued", "submitting"):
                return row
            time.sleep(.005)
        self.fail("worker did not settle")

    def complete(self, request_id, output="done"):
        row = self.settle(request_id)
        self.hermes.runs[row["run_id"]] = {"status": "completed", "output": output}
        return self.bridge.job_status(request_id)

    def submissions(self):
        return [call for call in self.hermes.calls if call[0] == "/v1/runs"]

    def test_new_topics_get_distinct_sessions_and_continuation_reuses_one(self):
        first = self.bridge.send("100-1", "Первая тема", chat_id=None)
        self.assertEqual(first["chatId"], "100-1")
        self.complete("100-1")

        continued = self.bridge.send("100-2", "Продолжи", chat_id="100-1", mode="research")
        self.assertEqual((continued["chatId"], continued["mode"]), ("100-1", "research"))
        self.complete("100-2")

        second = self.bridge.send("100-3", "Другая тема", chat_id=None)
        self.assertEqual(second["chatId"], "100-3")
        self.complete("100-3")

        calls = self.submissions()
        self.assertEqual(calls[0][4], "musafer-watch-chat-100-1")
        self.assertEqual(calls[1][4], calls[0][4])
        self.assertEqual(calls[2][4], "musafer-watch-chat-100-3")
        self.assertIn("исследование", calls[1][1]["instructions"])
        listed = self.bridge.rpc("CHAT_LIST", {})
        self.assertEqual({chat["id"] for chat in listed["chats"]}, {"100-1", "100-3"})
        detail = self.bridge.rpc("CHAT_DETAIL", {"chatId": "100-1"})
        self.assertEqual([job["id"] for job in detail["jobs"]], ["100-2", "100-1"])

    def test_missing_chat_id_keeps_the_original_legacy_session(self):
        accepted = self.bridge.rpc("SEND_TEXT", {"id": "100-9", "text": "Старый клиент"})
        self.assertEqual(accepted["chatId"], LEGACY_CHAT_ID)
        self.complete("100-9")
        self.assertEqual(self.submissions()[0][4], "musafer-watch")
        with self.bridge.lock:
            chat = self.bridge.db.execute(
                "SELECT session_key FROM chats WHERE id=?", (LEGACY_CHAT_ID,)).fetchone()
        self.assertEqual(chat["session_key"], "musafer-watch")

    def test_replay_is_idempotent_conflicts_are_rejected_and_gate_is_global(self):
        with self.assertRaises(Invalid):
            self.bridge.rpc("SEND_TEXT", {
                "id": "101-0", "text": "Герой не маршрутизирует чат",
                "chatId": None, "mode": "task", "hero": "hakim"})
        accepted = self.bridge.send("101-1", "Один", chat_id=None)
        replay = self.bridge.send("101-1", "Один", chat_id=None)
        self.assertEqual(replay["id"], accepted["id"])
        with self.assertRaises(Invalid):
            self.bridge.send("101-1", "Другой", chat_id=None)
        with self.assertRaises(Invalid):
            self.bridge.send("101-1", "Один")
        with self.assertRaises(Invalid):
            self.bridge.send("101-2", "Параллельно", chat_id=None)
        self.settle("101-1")
        self.assertEqual(len(self.submissions()), 1)

    def test_legacy_migration_is_idempotent_and_fresh_db_has_no_placeholder(self):
        with self.bridge.lock:
            self.assertEqual(self.bridge.db.execute("SELECT count(*) FROM chats").fetchone()[0], 0)

        old_tmp = tempfile.TemporaryDirectory()
        db = sqlite3.connect(old_tmp.name + "/state.sqlite3")
        db.execute("""
            CREATE TABLE jobs (
                id TEXT PRIMARY KEY, text TEXT, created REAL, state TEXT,
                run_id TEXT DEFAULT '', result TEXT DEFAULT '', error TEXT DEFAULT '',
                deleted_at REAL)
        """)
        old_output = "Старый ответ" + "я" * (JOB_RESULT_PREVIEW + 10)
        db.execute(
            "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)",
            ("102-1", "Старый вопрос", 123.0, "completed", "", old_output, "", 456.0))
        db.commit()
        db.close()

        migrated = Bridge(old_tmp.name, FakeHermes(), lambda *args: "", "/tmp/model")
        with migrated.lock:
            row = migrated._get("jobs", "102-1")
            self.assertEqual((row["chat_id"], row["full_result"], row["deleted_at"]),
                             (LEGACY_CHAT_ID, old_output, 456.0))
            self.assertEqual(len(row["result"]), JOB_RESULT_PREVIEW)
            self.assertEqual(migrated.db.execute("SELECT count(*) FROM chats").fetchone()[0], 1)
        history_parts = []
        offset = 0
        while True:
            page = migrated.rpc("HISTORY_DETAIL", {
                "id": "102-1", "field": "result", "offset": offset, "limit": 600})
            history_parts.append(page["content"])
            if page["complete"]:
                break
            offset += len(page["content"])
        report_parts = []
        offset = 0
        while True:
            page = migrated.rpc("JOB_REPORT", {"id": "102-1", "offset": offset, "limit": 1000})
            report_parts.append(page["text"])
            if page["nextOffset"] is None:
                break
            offset = page["nextOffset"]
        self.assertEqual("".join(history_parts), old_output)
        self.assertEqual("".join(report_parts), old_output)
        migrated.close()
        migrated = Bridge(old_tmp.name, FakeHermes(), lambda *args: "", "/tmp/model")
        with migrated.lock:
            self.assertEqual(migrated.db.execute("SELECT count(*) FROM chats").fetchone()[0], 1)
            self.assertEqual(migrated._get("jobs", "102-1")["deleted_at"], 456.0)
        migrated.close()
        old_tmp.cleanup()

    def test_full_report_is_paged_and_explicitly_truncated_at_storage_limit(self):
        self.bridge.send("103-1", "Отчёт", chat_id=None, mode="research")
        output = "абв" * 2500
        status = self.complete("103-1", output)
        self.assertEqual((len(status["result"]), status["reportLength"]),
                         (JOB_RESULT_PREVIEW, len(output)))
        pieces = []
        offset = 0
        while True:
            page = self.bridge.rpc("JOB_REPORT", {"id": "103-1", "offset": offset, "limit": 1000})
            pieces.append(page["text"])
            if page["nextOffset"] is None:
                break
            offset = page["nextOffset"]
        self.assertEqual("".join(pieces), output)

        self.bridge.send("103-2", "Очень длинный отчёт", chat_id=None, mode="research")
        long_output = "я" * (JOB_REPORT_MAX + 17)
        status = self.complete("103-2", long_output)
        self.assertEqual(status["reportLength"], JOB_REPORT_MAX)
        self.assertTrue(status["reportTruncated"])
        last = self.bridge.rpc("JOB_REPORT", {
            "id": "103-2", "offset": JOB_REPORT_MAX - 10, "limit": 1000})
        self.assertEqual((len(last["text"]), last["nextOffset"], last["truncated"]), (10, None, True))

    def test_watch_lists_and_brief_status_bound_payload_without_losing_metadata(self):
        prompt = "Длинный вопрос " + "я" * 300
        output = "Длинный отчёт " + "ю" * 7000
        self.bridge.send("103-3", prompt, chat_id=None, mode="research")
        legacy = self.complete("103-3", output)
        brief = self.bridge.rpc("JOB_STATUS", {"id": "103-3", "brief": True})

        self.assertEqual(len(legacy["result"]), JOB_RESULT_PREVIEW)
        self.assertEqual(brief["result"], legacy["summary"])
        self.assertLessEqual(len(brief["result"]), 500)
        self.assertLessEqual(len(brief["text"]), 160)
        self.assertEqual(brief["reportLength"], len(output))
        self.assertEqual(
            (brief["id"], brief["chatId"], brief["mode"], brief["state"]),
            (legacy["id"], legacy["chatId"], legacy["mode"], legacy["state"]),
        )

        listed = self.bridge.rpc("CHAT_LIST", {})["chats"][0]["latestJob"]
        self.assertLessEqual(len(listed["summary"]), 120)
        detail = self.bridge.rpc("CHAT_DETAIL", {"chatId": "103-3"})["jobs"][0]
        self.assertEqual(detail["result"], "")
        self.assertLessEqual(len(detail["text"]), 160)
        self.assertLessEqual(len(detail["summary"]), 160)
        self.assertEqual(detail["reportLength"], len(output))
        self.assertEqual(
            (detail["id"], detail["chatId"], detail["mode"], detail["state"]),
            (legacy["id"], legacy["chatId"], legacy["mode"], legacy["state"]),
        )

        with self.assertRaises(Invalid):
            self.bridge.rpc("JOB_STATUS", {"id": "103-3", "brief": 1})
        with self.assertRaises(Invalid):
            self.bridge.rpc("JOB_STATUS", {"id": "103-3", "extra": True})

        self.bridge.send("103-4", "Нужно подтверждение", chat_id=None)
        row = self.settle("103-4")
        approval_text = "publish " + "x" * 2000
        self.hermes.runs[row["run_id"]] = {
            "status": "waiting_for_approval",
            "approval": {"request_id": "approval-brief", "command": approval_text},
        }
        approval = self.bridge.rpc("JOB_STATUS", {"id": "103-4", "brief": True})
        self.assertEqual(approval["approval"]["text"], approval_text)

    def test_stop_is_idempotent_blocks_approval_and_poll_reaches_cancelled(self):
        self.bridge.send("104-1", "Работа", chat_id=None)
        row = self.settle("104-1")
        self.hermes.runs[row["run_id"]] = {
            "status": "waiting_for_approval",
            "approval": {"request_id": "approval-1", "command": "publish"},
        }
        self.assertEqual(self.bridge.job_status("104-1")["state"], "approval")
        stopped = self.bridge.rpc("JOB_STOP", {"id": "104-1"})
        self.assertEqual((stopped["state"], stopped["stopRequested"]), ("stopping", True))
        stop_count = len([call for call in self.hermes.calls if call[0].endswith("/stop")])
        self.bridge.rpc("JOB_STOP", {"id": "104-1"})
        self.assertEqual(len([call for call in self.hermes.calls if call[0].endswith("/stop")]), stop_count)
        fenced = self.bridge.job_status("104-1")
        self.assertEqual(fenced["state"], "stopping")
        self.assertNotIn("approval", fenced)
        with self.assertRaises(Invalid):
            self.bridge.rpc("JOB_APPROVE", {
                "id": "104-1", "approvalId": "approval-1", "allow": True})
        self.hermes.runs[row["run_id"]] = {"status": "cancelled"}
        self.assertEqual(self.bridge.job_status("104-1")["state"], "cancelled")

    def test_stop_between_approval_refresh_and_decision_blocks_approval_post(self):
        self.bridge.send("104-2", "Работа", chat_id=None)
        row = self.settle("104-2")
        self.hermes.runs[row["run_id"]] = {
            "status": "waiting_for_approval",
            "approval": {"request_id": "approval-race", "command": "publish"},
        }
        refreshed = threading.Event()
        release = threading.Event()
        original_status = self.bridge.job_status

        def delayed_status(request_id, timeout=8):
            result = original_status(request_id, timeout)
            if threading.current_thread().name == "approval-race":
                refreshed.set()
                release.wait(3)
            return result

        self.bridge.job_status = delayed_status
        outcome = []

        def approve():
            try:
                outcome.append(self.bridge.rpc("JOB_APPROVE", {
                    "id": "104-2", "approvalId": "approval-race", "allow": True}))
            except Exception as exc:
                outcome.append(exc)

        worker = threading.Thread(target=approve, name="approval-race")
        worker.start()
        self.assertTrue(refreshed.wait(3))
        self.bridge.rpc("JOB_STOP", {"id": "104-2"})
        release.set()
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(outcome), 1)
        self.assertIsInstance(outcome[0], Invalid)
        self.assertFalse(any(call[0].endswith("/approval") for call in self.hermes.calls))

    def test_stale_status_and_approval_receipt_cannot_overwrite_completion(self):
        self.bridge.send("104-3", "Работа", chat_id=None)
        row = self.settle("104-3")
        self.hermes.runs[row["run_id"]] = {
            "status": "waiting_for_approval",
            "approval": {"request_id": "approval-finish", "command": "publish"},
        }
        self.assertEqual(self.bridge.job_status("104-3")["state"], "approval")
        approval_started = threading.Event()
        release_approval = threading.Event()
        original_call = self.hermes.call

        def delayed_approval(path, body=None, request_id=None, timeout=12, session_key=None):
            if path.endswith("/approval"):
                self.hermes.calls.append((path, body, request_id, timeout, session_key))
                approval_started.set()
                release_approval.wait(3)
                return {"accepted": True}
            return original_call(path, body, request_id, timeout, session_key)

        self.hermes.call = delayed_approval
        outcome = []
        worker = threading.Thread(target=lambda: outcome.append(self.bridge.rpc("JOB_APPROVE", {
            "id": "104-3", "approvalId": "approval-finish", "allow": True})))
        worker.start()
        self.assertTrue(approval_started.wait(3))
        self.hermes.runs[row["run_id"]] = {"status": "completed", "output": "Финальный отчёт"}
        completed = self.bridge.job_status("104-3")
        self.assertEqual((completed["state"], completed["result"]),
                         ("completed", "Финальный отчёт"))
        release_approval.set()
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual((outcome[0]["state"], outcome[0]["result"]),
                         ("completed", "Финальный отчёт"))
        stale = self.bridge._apply_remote("104-3", {"status": "running"})
        self.assertEqual((stale["state"], stale["full_result"]),
                         ("completed", "Финальный отчёт"))

    def test_restart_preserves_accepted_queued_run_and_polls_it(self):
        self.bridge.send("104-4", "Принято Hermes", chat_id=None)
        row = self.settle("104-4")
        run_id = row["run_id"]
        submissions = len(self.submissions())
        self.bridge.close()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *args: "", "/tmp/model")
        with self.bridge.lock:
            restarted = self.bridge._get("jobs", "104-4")
        self.assertEqual((restarted["state"], restarted["run_id"]), ("queued", run_id))
        self.hermes.runs[run_id] = {"status": "completed", "output": "После перезапуска"}
        recovered = self.bridge.job_status("104-4")
        self.assertEqual((recovered["state"], recovered["result"]),
                         ("completed", "После перезапуска"))
        self.assertEqual(len(self.submissions()), submissions)

    def test_stop_handles_pre_submit_cancel_completion_race_and_timeout(self):
        self.bridge.worker.shutdown(wait=True)
        self.bridge.worker = ManualExecutor()
        self.bridge.send("105-1", "Не отправлять", chat_id=None)
        stopped = self.bridge.rpc("JOB_STOP", {"id": "105-1"})
        self.assertEqual(stopped["state"], "cancelled")
        self.assertEqual(self.submissions(), [])

        self.bridge.close()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *args: "", "/tmp/model")
        self.bridge.send("105-2", "Гонка", chat_id=None)
        self.settle("105-2")
        self.hermes.stop_response = {"status": "completed", "output": "Уже завершено"}
        stopped = self.bridge.rpc("JOB_STOP", {"id": "105-2"})
        self.assertEqual((stopped["state"], stopped["result"]), ("completed", "Уже завершено"))

        self.bridge.send("105-3", "Таймаут", chat_id=None)
        self.settle("105-3")
        self.hermes.stop_error = TimeoutError("lost receipt")
        stopped = self.bridge.rpc("JOB_STOP", {"id": "105-3"})
        self.assertEqual(stopped["state"], "stopping")
        self.assertTrue(stopped["stopRequested"])
        self.assertIn("Статус обновляется", stopped["error"])

    def test_archive_rejects_active_chat_and_prevents_continuation_until_restored(self):
        self.bridge.send("106-1", "Архив", chat_id=None)
        with self.assertRaises(Invalid):
            self.bridge.rpc("CHAT_ARCHIVE", {"chatId": "106-1", "archived": True})
        self.complete("106-1")
        self.assertTrue(self.bridge.rpc(
            "CHAT_ARCHIVE", {"chatId": "106-1", "archived": True})["archived"])
        with self.assertRaises(Invalid):
            self.bridge.send("106-2", "Продолжить", chat_id="106-1")
        self.bridge.rpc("CHAT_ARCHIVE", {"chatId": "106-1", "archived": False})
        self.assertEqual(self.bridge.send(
            "106-2", "Продолжить", chat_id="106-1")["chatId"], "106-1")


if __name__ == "__main__":
    unittest.main()
