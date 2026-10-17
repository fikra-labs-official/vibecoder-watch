import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path

from limits import Limits, _when


def rate_line(five=0.43, week=0.51, reset5=None, reset7=None):
    return json.dumps({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "unifiedWindows": {
        "five_hour": {"utilization": five, "resetsAt": reset5}, "seven_day": {"utilization": week, "resetsAt": reset7}}}})


class Completed:
    def __init__(self, stdout="", returncode=0):
        self.stdout, self.returncode, self.stderr = stdout, returncode, ""


class FakeCodex:
    """codex app-server over stdio: answers initialize, then rateLimits/read."""

    def __init__(self, reply):
        self.reply, self.lines, self.killed = reply, [], False
        self.stdin, self.stdout = self, self

    def write(self, text):
        message = json.loads(text)
        if message.get("id") == 1:
            self.lines.append(json.dumps({"id": 1, "result": {"userAgent": "x"}}) + "\n")
            self.lines.append(json.dumps({"method": "remoteControl/status/changed", "params": {}}) + "\n")
        if message.get("id") == 2:
            self.lines.append(json.dumps({"id": 2, "result": self.reply}) + "\n" if self.reply is not None else "")

    def flush(self):
        pass

    def readline(self):
        return self.lines.pop(0) if self.lines else ""

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        return 0

    def close(self):
        pass


class LimitsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = [time.mktime((2026, 9, 28, 12, 0, 0, 0, 0, -1))]
        self.reset5 = self.clock[0] + 2 * 3600 + 15 * 60
        self.reset7 = self.clock[0] + 5 * 86400 + 8 * 3600
        self.runs, self.claude_out = [], Completed(rate_line(reset5=self.reset5, reset7=self.reset7) + "\n" + json.dumps({"type": "result", "result": "ok"}) + "\n")
        self.codex_reply = {"rateLimits": {"planType": "pro", "primary": {"usedPercent": 37, "windowDurationMins": 10080, "resetsAt": self.reset7},
                                           "secondary": {"usedPercent": 12, "windowDurationMins": 300, "resetsAt": self.reset5}}}
        self.processes = []
        def run(argv, **kwargs):
            self.runs.append(argv)
            if isinstance(self.claude_out, Exception):
                raise self.claude_out
            return self.claude_out
        def popen(argv, **kwargs):
            process = FakeCodex(self.codex_reply)
            self.processes.append(process)
            return process
        self.limits = Limits(self.temp.name, claude_executable="/fake/claude", codex_executable="/fake/codex",
                             run=run, popen=popen, now=lambda: self.clock[0], cache_seconds=600)

    def tearDown(self):
        self.temp.cleanup()

    def test_reads_both_agents_formats_resets_and_caches_for_ten_minutes(self):
        reply = self.limits.rpc("LIMITS", {})
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["checkedAt"], "12:00")
        claude, codex = reply["agents"]
        self.assertEqual(claude["label"], "Claude Code")
        self.assertEqual([(w["label"], w["used"], w["free"], w["resets"], w["left"]) for w in claude["windows"]],
                         [("5 часов", 43, 57, "14:15", "через 2 ч 15 мин"), ("Неделя", 51, 49, "03.10 20:00", "через 5 д 8 ч")])
        self.assertEqual([(w["id"], w["used"]) for w in codex["windows"]], [("five_hour", 12), ("seven_day", 37)])
        self.assertEqual(codex["plan"], "pro")
        self.assertEqual(reply["text"], "Claude 5 часов: осталось 57 % · Неделя: осталось 49 % | Codex 5 часов: осталось 88 % · Неделя: осталось 63 %")
        argv = self.runs[0]
        self.assertEqual(argv[:3], ["/fake/claude", "-p", "ok"])
        self.assertIn("--max-turns", argv); self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertTrue(self.processes[0].killed)
        self.clock[0] += 300
        self.limits.rpc("LIMITS", {})
        self.assertEqual((len(self.runs), len(self.processes)), (1, 1))       # cached
        self.limits.rpc("LIMITS", {"force": True})
        self.assertEqual((len(self.runs), len(self.processes)), (2, 2))       # forced
        self.clock[0] += 601
        self.limits.rpc("LIMITS", {})
        self.assertEqual(len(self.runs), 3)                                   # stale
        # the reading survives a restart
        again = Limits(self.temp.name, run=lambda *a, **k: self.fail("must not run"), popen=lambda *a, **k: self.fail("must not spawn"),
                       now=lambda: self.clock[0], cache_seconds=600)
        self.assertEqual(again.read()["agents"][0]["windows"][0]["used"], 43)
        for bad in ({"force": "yes"}, {"x": 1}):
            with self.assertRaises(ValueError):
                self.limits.rpc("LIMITS", bad)

    def test_failures_become_text_not_exceptions(self):
        self.claude_out = Completed("no events\n", returncode=1)
        self.codex_reply = None
        reply = self.limits.read(force=True)
        self.assertEqual(reply["agents"][0]["windows"], [])
        self.assertEqual(reply["agents"][0]["error"], "claude: код 1")
        self.assertEqual(reply["agents"][1]["error"], "Codex не сообщил лимиты")
        self.assertEqual(reply["text"], "Лимиты пока не прочитаны")
        self.claude_out = subprocess.TimeoutExpired("claude", 25)
        reply = self.limits.read(force=True)
        self.assertEqual(reply["agents"][0]["error"], "Claude не ответил вовремя")

    def test_slow_refresh_returns_cached_data_and_coalesces_repeated_requests(self):
        self.limits.read()
        entered, release = threading.Event(), threading.Event()
        runs = []
        def slow_run(argv, **kwargs):
            runs.append(argv)
            entered.set()
            release.wait(.6)
            return self.claude_out
        self.limits.run = slow_run
        self.limits.response_wait = .02
        started = time.monotonic()
        try:
            reply = self.limits.read(force=True)
            self.assertLess(time.monotonic() - started, .3, "HTTP reply must not wait for Claude")
            self.assertTrue(entered.wait(.2))
            self.assertTrue(reply["refreshing"])
            self.assertEqual(reply["agents"][0]["windows"][0]["used"], 43)
            for _ in range(3):
                self.assertTrue(self.limits.read(force=True)["refreshing"])
            self.assertEqual(len(runs), 1, "repeated refreshes must share the running probe")
        finally:
            release.set()
            if getattr(self.limits, "refresh", None):
                self.limits.refresh.wait(1)
        self.assertFalse(self.limits.read()["refreshing"])

    def test_failed_refresh_keeps_last_good_windows_and_their_original_time(self):
        good = self.limits.read()["agents"][0]
        self.clock[0] += 120
        self.claude_out = subprocess.TimeoutExpired("claude", 25)
        reply = self.limits.read(force=True)
        old = reply["agents"][0]
        self.assertEqual([w["used"] for w in old["windows"]], [43, 51])
        self.assertEqual(old["checkedAt"], good["checkedAt"])
        self.assertTrue(old["stale"])
        self.assertEqual(old["error"], "Claude не ответил вовремя")
        self.assertFalse(reply["agents"][1]["stale"])
        again = Limits(self.temp.name, now=lambda: self.clock[0])
        self.assertEqual(again.read()["agents"][0]["checkedAt"], good["checkedAt"])
        self.assertTrue(again.read()["agents"][0]["stale"])

    def test_claude_probe_is_isolated_and_uses_quota_events_received_before_timeout(self):
        self.claude_out = subprocess.TimeoutExpired("claude", 25, output=(rate_line() + "\n").encode())
        reading = self.limits._claude()
        self.assertEqual(reading["windows"]["five_hour"]["used"], 43)
        self.assertIn("--safe-mode", self.runs[-1])
        self.assertNotIn("--bare", self.runs[-1], "bare mode cannot use subscription OAuth")

    def test_cold_cache_can_return_codex_while_claude_is_still_running(self):
        entered, release = threading.Event(), threading.Event()
        def slow_run(*args, **kwargs):
            entered.set()
            release.wait(.6)
            return self.claude_out
        self.limits.run = slow_run
        self.limits.response_wait = .02
        try:
            reply = self.limits.read()
            self.assertTrue(reply["refreshing"])
            self.assertTrue(entered.wait(.2))
            self.assertEqual(reply["agents"][0]["windows"], [])
            self.assertTrue(reply["agents"][1]["windows"], "Codex must not wait behind Claude")
        finally:
            release.set()
            if self.limits.refresh:
                self.limits.refresh.wait(1)

    def test_old_cache_timestamp_is_preserved_and_failed_readings_retry_after_backoff(self):
        self.limits.read()
        data = json.loads(self.limits.path.read_text())
        data["claude"].pop("checked")
        self.limits.path.write_text(json.dumps(data))
        migrated = Limits(self.temp.name, now=lambda: self.clock[0])
        self.assertEqual(migrated.read()["agents"][0]["checkedAt"], "12:00")
        self.claude_out = subprocess.TimeoutExpired("claude", 25)
        self.limits.read(force=True)
        count = len(self.runs)
        self.clock[0] += 20
        self.limits.read()
        self.assertEqual(len(self.runs), count)
        self.clock[0] += 11
        self.claude_out = Completed(rate_line())
        self.assertFalse(self.limits.read()["agents"][0]["stale"])
        self.assertEqual(len(self.runs), count + 1)
        self.assertEqual(self.limits.path.stat().st_mode & 0o777, 0o600)

    def test_silent_codex_has_a_real_deadline_and_is_reaped(self):
        processes, result = [], []
        def silent(*args, **kwargs):
            proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
            processes.append(proc)
            return proc
        self.limits.popen = silent
        with patch("limits.CODEX_TIMEOUT", .05):
            worker = threading.Thread(target=lambda: result.append(self.limits._codex()), daemon=True)
            worker.start()
            worker.join(.5)
            finished = not worker.is_alive()
            # Clean up the deliberately broken pre-fix implementation as well.
            for proc in processes:
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=1)
            worker.join(1)
        self.assertTrue(finished, "a blocking readline must not bypass the deadline")
        self.assertEqual(result[0]["error"], "Codex не ответил вовремя")

    def test_when_formats_today_and_later(self):
        now = self.clock[0]
        self.assertEqual(_when(now + 90 * 60, now), ("13:30", "через 1 ч 30 мин"))
        self.assertEqual(_when(now + 20 * 60, now), ("12:20", "через 20 мин"))
        self.assertEqual(_when(now - 5, now), ("11:59", "сейчас"))
        self.assertEqual(_when(None, now), ("", ""))


if __name__ == "__main__":
    unittest.main()
