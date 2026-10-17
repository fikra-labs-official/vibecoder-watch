"""Usage limits of Claude Code and Codex for the watch.

Claude Code reports its windows in a tool-free, isolated stream-json probe.
Codex answers ``account/rateLimits/read`` over its app-server JSON-RPC.
Both run in the background; an HTTP request waits at most eight seconds, below
the phone's fourteen-second timeout. Failed refreshes retain the last good
reading and its timestamp. The watch polls while ``refreshing`` is true.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

CACHE_SECONDS = 600
CLAUDE_TIMEOUT = 25
CODEX_TIMEOUT = 15
RESPONSE_WAIT_SECONDS = 8
ERROR_RETRY_SECONDS = 30
WINDOWS = (("five_hour", "5 часов", 300), ("seven_day", "Неделя", 10080))


def _when(reset_at, now):
    """'14:30' today, '03.10 12:00' later, plus a 'через …' remainder."""
    if not isinstance(reset_at, (int, float)) or reset_at <= 0:
        return "", ""
    local, today = time.localtime(reset_at), time.localtime(now)
    stamp = time.strftime("%H:%M", local) if local[:3] == today[:3] else time.strftime("%d.%m %H:%M", local)
    left = int(reset_at - now)
    if left <= 0:
        return stamp, "сейчас"
    hours, minutes = divmod(left // 60, 60)
    days, hours = divmod(hours, 24)
    if days:
        return stamp, f"через {days} д {hours} ч"
    return stamp, f"через {hours} ч {minutes} мин" if hours else f"через {minutes} мин"


class Limits:
    def __init__(self, state_dir, claude_executable=None, codex_executable=None, run=None, popen=None,
                 now=time.time, cache_seconds=CACHE_SECONDS, event=None, response_wait=RESPONSE_WAIT_SECONDS):
        self.state = Path(state_dir)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.claude = claude_executable or shutil.which("claude") or str(Path.home() / ".local/bin/claude")
        self.codex = codex_executable or shutil.which("codex") or "codex"
        self.run = run or subprocess.run
        self.popen = popen or subprocess.Popen
        self.now = now
        self.cache_seconds = cache_seconds
        self.event = event or (lambda *args, **fields: None)
        self.lock = threading.Lock()
        self.refresh = None
        self.response_wait = response_wait
        self.path = self.state / "limits.json"
        try:
            self.cache = json.loads(self.path.read_text())
        except (OSError, ValueError):
            self.cache = {}
        if not isinstance(self.cache, dict):
            self.cache = {}
        # Older caches have one timestamp for both readings.
        for key in ("claude", "codex"):
            reading = self.cache.get(key)
            if isinstance(reading, dict) and reading.get("windows"):
                reading.setdefault("checked", self.cache.get("checked"))

    def rpc(self, method, params, transcript_lookup=None):
        if method != "LIMITS" or not isinstance(params, dict) or not set(params) <= {"force"}:
            raise ValueError("Некорректный запрос лимитов")
        force = params.get("force", False)
        if type(force) is not bool:
            raise ValueError("Некорректный запрос лимитов")
        return self.read(force)

    def read(self, force=False):
        started = None
        with self.lock:
            checked = self.cache.get("checked")
            failed = any(isinstance(self.cache.get(k), dict) and self.cache[k].get("error") for k in ("claude", "codex"))
            ttl = min(self.cache_seconds, ERROR_RETRY_SECONDS) if failed else self.cache_seconds
            stale = not isinstance(checked, (int, float)) or not 0 <= self.now() - checked < ttl
            if self.refresh is None and (force or stale):
                started = self.refresh = threading.Event()
                threading.Thread(target=self._refresh, args=(started,), daemon=True).start()
        # Do not hold the cache lock during a subprocess or wait. Concurrent taps
        # share the existing refresh and can immediately read its latest results.
        if started is not None:
            started.wait(self.response_wait)
        with self.lock:
            return self._public()

    def _refresh(self, done):
        workers = [threading.Thread(target=self._refresh_agent, args=(key,), daemon=True)
                   for key in ("claude", "codex")]
        try:
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join()
            with self.lock:
                self.cache["checked"] = self.now()
                temporary = self.path.with_suffix(".tmp")
                try:
                    with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output:
                        json.dump(self.cache, output, ensure_ascii=False)
                    os.replace(temporary, self.path)
                except OSError as exc:
                    self.event("limits_cache_error", error=type(exc).__name__)
        finally:
            with self.lock:
                self.refresh = None
                done.set()

    def _refresh_agent(self, key):
        started = time.monotonic()
        try:
            reading = self._claude() if key == "claude" else self._codex()
        except Exception as exc:
            self.event("limits_read_error", agent=key, error=type(exc).__name__)
            reading = {"error": "Не удалось прочитать лимиты"}
        with self.lock:
            previous = self.cache.get(key)
            if reading.get("error") and isinstance(previous, dict) and previous.get("windows"):
                reading = {**previous, "error": reading["error"]}
            elif reading.get("windows"):
                reading["checked"] = self.now()
            self.cache[key] = reading
        self.event("limits_read", agent=key, ms=round((time.monotonic() - started) * 1000), ok=not bool(reading.get("error")))

    # ---- readings ------------------------------------------------------------------

    def _claude(self):
        env = {key: value for key, value in os.environ.items() if not key.startswith("CLAUDE_CODE_")}
        # This quota probe needs no coding instructions, reasoning, or saved session.
        argv = [self.claude, "-p", "ok", "--safe-mode", "--effort", "low", "--system-prompt", "Reply only OK.",
                "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--no-chrome", "--strict-mcp-config",
                "--tools", "", "--max-turns", "1", "--permission-prompts", "none"]
        failure = ""
        try:
            out = self.run(argv, capture_output=True, text=True, timeout=CLAUDE_TIMEOUT, env=env, stdin=subprocess.DEVNULL)
            output = out.stdout or ""
            failure = "Claude не сообщил лимиты" if out.returncode == 0 else f"claude: код {out.returncode}"
            if "safe-mode" in (out.stderr or "") and "unknown option" in (out.stderr or ""):
                failure = "Обновите Claude Code на Mac"
        except subprocess.TimeoutExpired as exc:
            # The quota event may precede a slow final result. Do not discard it.
            output = exc.stdout or ""
            if isinstance(output, bytes):
                output = output.decode("utf-8", errors="replace")
            failure = "Claude не ответил вовремя"
        except (OSError, subprocess.SubprocessError):
            return {"error": "Не удалось запустить Claude на Mac"}
        windows, status = None, ""
        for line in output.split("\n"):
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and event.get("type") == "rate_limit_event":
                info = event.get("rate_limit_info") if isinstance(event.get("rate_limit_info"), dict) else {}
                if isinstance(info.get("unifiedWindows"), dict):
                    windows, status = info["unifiedWindows"], str(info.get("status") or "")
        if windows is None:
            return {"error": failure}
        reading = {"status": status, "windows": {}}
        for key, _, _ in WINDOWS:
            window = windows.get(key)
            if isinstance(window, dict) and isinstance(window.get("utilization"), (int, float)):
                reading["windows"][key] = {"used": int(round(window["utilization"] * 100)), "resetsAt": window.get("resetsAt")}
        return reading if reading["windows"] else {"error": "Claude не сообщил лимиты"}

    def _codex(self):
        try:
            proc = self.popen([self.codex, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, text=True, bufsize=1)
        except OSError as exc:
            return {"error": "Codex не запустился: " + type(exc).__name__}
        answer, deadline = None, time.monotonic() + CODEX_TIMEOUT
        expired = threading.Event()
        def stop():
            expired.set()
            try:
                proc.kill()
            except OSError:
                pass  # The process may have already exited.
        # A deadline checked before readline cannot interrupt a silent process.
        timer = threading.Timer(CODEX_TIMEOUT, stop)
        timer.daemon = True
        timer.start()
        try:
            def send(message):
                proc.stdin.write(json.dumps(message) + "\n")
                proc.stdin.flush()
            send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                  "params": {"clientInfo": {"name": "musafir-watch", "title": "Musafir", "version": "1"}}})
            while time.monotonic() < deadline:
                line = proc.stdout.readline()
                if not line:
                    break
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                if event.get("id") == 1:
                    send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
                    send({"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": {}})
                elif event.get("id") == 2:
                    answer = event
                    break
        except (OSError, ValueError):
            return {"error": "Codex не ответил вовремя" if expired.is_set() else "Не удалось прочитать лимиты Codex"}
        finally:
            timer.cancel()
            try:
                proc.kill()
            except OSError:
                pass
            proc.wait(timeout=1)
            for stream in (proc.stdin, proc.stdout):
                try:
                    stream.close()
                except OSError:
                    pass  # A killed child may leave a broken stdin pipe.
        if expired.is_set():
            return {"error": "Codex не ответил вовремя"}
        if not answer or not isinstance(answer.get("result"), dict):
            return {"error": "Codex не сообщил лимиты"}
        limits = answer["result"].get("rateLimits") if isinstance(answer["result"].get("rateLimits"), dict) else {}
        reading = {"plan": str(limits.get("planType") or ""), "windows": {}}
        for slot in ("primary", "secondary"):
            window = limits.get(slot)
            if not isinstance(window, dict) or not isinstance(window.get("usedPercent"), (int, float)):
                continue
            minutes = window.get("windowDurationMins")
            key = next((k for k, _, mins in WINDOWS if mins == minutes), None) or f"{slot}:{minutes}"
            reading["windows"][key] = {"used": int(window["usedPercent"]), "resetsAt": window.get("resetsAt")}
        return reading if reading["windows"] else {"error": "Codex не сообщил лимиты"}

    # ---- presentation ----------------------------------------------------------------

    def _public(self):
        now = self.now()
        agents = []
        for key, label in (("claude", "Claude Code"), ("codex", "Codex")):
            reading = self.cache.get(key) if isinstance(self.cache.get(key), dict) else {"error": "нет данных"}
            checked = reading.get("checked")
            stale = bool(reading.get("error")) or not isinstance(checked, (int, float)) or not 0 <= now - checked < self.cache_seconds
            windows = []
            for window_id, window_label, _ in WINDOWS:
                window = (reading.get("windows") or {}).get(window_id)
                if isinstance(window, dict):
                    stamp, left = _when(window.get("resetsAt"), now)
                    windows.append({"id": window_id, "label": window_label, "used": window["used"], "free": max(0, 100 - window["used"]),
                                    "resets": stamp, "left": left})
            for window_id, window in (reading.get("windows") or {}).items():  # windows we did not expect, still shown
                if not any(w["id"] == window_id for w in windows) and isinstance(window, dict):
                    stamp, left = _when(window.get("resetsAt"), now)
                    windows.append({"id": window_id, "label": "Окно", "used": window["used"], "free": max(0, 100 - window["used"]),
                                    "resets": stamp, "left": left})
            agents.append({"id": key, "label": label, "windows": windows, "error": str(reading.get("error") or ""),
                           "plan": str(reading.get("plan") or ""), "stale": stale,
                           "checked": checked,
                           "checkedAt": time.strftime("%H:%M" if time.localtime(checked)[:3] == time.localtime(now)[:3] else "%d.%m %H:%M",
                                                      time.localtime(checked)) if isinstance(checked, (int, float)) else ""})
        parts = []
        for agent in agents:
            if agent["windows"]:
                # The owner reads limits as "what is left"; Claude reports the used share, so it is inverted here.
                parts.append(agent["label"].split()[0] + " " + " · ".join(f"{w['label']}: осталось {w['free']} %" for w in agent["windows"]))
        checked = min((a["checked"] for a in agents if isinstance(a["checked"], (int, float))), default=None)
        return {"ok": True, "checked": checked if isinstance(checked, (int, float)) else None,
                "checkedAt": time.strftime("%H:%M", time.localtime(checked)) if isinstance(checked, (int, float)) else "",
                "agents": agents, "refreshing": self.refresh is not None,
                "text": " | ".join(parts) or "Лимиты пока не прочитаны"}
