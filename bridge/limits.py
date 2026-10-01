"""Usage limits of Claude Code and Codex for the watch.

Claude Code reports its unified rate-limit windows in every stream-json run, so
a one-turn probe with no tools (about 100 tokens, ~5 s) is the cheapest fresh
reading. Codex answers ``account/rateLimits/read`` over its app-server JSON-RPC
in about a second. Readings are cached for ten minutes; the watch may force a
refresh. Nothing here is documented by either vendor, so a failed reading is
reported as text, never raised.
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
                 now=time.time, cache_seconds=CACHE_SECONDS, event=None):
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
        self.path = self.state / "limits.json"
        try:
            self.cache = json.loads(self.path.read_text())
        except (OSError, ValueError):
            self.cache = {}
        if not isinstance(self.cache, dict):
            self.cache = {}

    def rpc(self, method, params, transcript_lookup=None):
        if method != "LIMITS" or not isinstance(params, dict) or not set(params) <= {"force"}:
            raise ValueError("Некорректный запрос лимитов")
        force = params.get("force", False)
        if type(force) is not bool:
            raise ValueError("Некорректный запрос лимитов")
        return self.read(force)

    def read(self, force=False):
        with self.lock:
            checked = self.cache.get("checked")
            stale = not isinstance(checked, (int, float)) or self.now() - checked >= self.cache_seconds
            if force or stale:
                self.cache = {"checked": self.now(), "claude": self._claude(), "codex": self._codex()}
                try:
                    self.path.write_text(json.dumps(self.cache, ensure_ascii=False))
                except OSError:
                    pass
            return self._public()

    # ---- readings ------------------------------------------------------------------

    def _claude(self):
        env = {key: value for key, value in os.environ.items() if not key.startswith("CLAUDE_CODE_")}
        argv = [self.claude, "-p", "ok", "--output-format", "stream-json", "--verbose", "--no-chrome", "--strict-mcp-config",
                "--tools", "", "--max-turns", "1", "--permission-prompts", "none"]
        try:
            out = self.run(argv, capture_output=True, text=True, timeout=CLAUDE_TIMEOUT, env=env, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError) as exc:
            return {"error": "Claude не ответил: " + type(exc).__name__}
        windows, status = None, ""
        for line in (out.stdout or "").split("\n"):
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and event.get("type") == "rate_limit_event":
                info = event.get("rate_limit_info") if isinstance(event.get("rate_limit_info"), dict) else {}
                if isinstance(info.get("unifiedWindows"), dict):
                    windows, status = info["unifiedWindows"], str(info.get("status") or "")
        if windows is None:
            return {"error": "Claude не сообщил лимиты" if out.returncode == 0 else f"claude: код {out.returncode}"}
        reading = {"status": status, "windows": {}}
        for key, _, _ in WINDOWS:
            window = windows.get(key)
            if isinstance(window, dict) and isinstance(window.get("utilization"), (int, float)):
                reading["windows"][key] = {"used": int(round(window["utilization"] * 100)), "resetsAt": window.get("resetsAt")}
        return reading

    def _codex(self):
        try:
            proc = self.popen([self.codex, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, text=True, bufsize=1)
        except OSError as exc:
            return {"error": "Codex не запустился: " + type(exc).__name__}
        answer, deadline = None, time.monotonic() + CODEX_TIMEOUT
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
        except (OSError, ValueError) as exc:
            return {"error": "Codex не ответил: " + type(exc).__name__}
        finally:
            try:
                proc.kill()
            except OSError:
                pass
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
        return reading

    # ---- presentation ----------------------------------------------------------------

    def _public(self):
        now = self.now()
        agents = []
        for key, label in (("claude", "Claude Code"), ("codex", "Codex")):
            reading = self.cache.get(key) if isinstance(self.cache.get(key), dict) else {"error": "нет данных"}
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
                           "plan": str(reading.get("plan") or "")})
        parts = []
        for agent in agents:
            if agent["windows"]:
                # The owner reads limits as "what is left"; Claude reports the used share, so it is inverted here.
                parts.append(agent["label"].split()[0] + " " + " · ".join(f"{w['label']}: осталось {w['free']} %" for w in agent["windows"]))
        checked = self.cache.get("checked")
        return {"ok": True, "checked": checked if isinstance(checked, (int, float)) else None,
                "checkedAt": time.strftime("%H:%M", time.localtime(checked)) if isinstance(checked, (int, float)) else "",
                "agents": agents, "text": " | ".join(parts) or "Лимиты пока не прочитаны"}
