"""Morning digest: one Telegram message a day about what the agents did and
what waits for the owner. Sent at the configured local time, or as soon as
the bridge is running after that time (a sleeping Mac catches up on wake).
Reads the bridge databases read-only; never touches coordinator state.
"""
from __future__ import annotations

from pathlib import Path
import sqlite3
import threading
import time

DEFAULT_TIME = "10:00"
WINDOW = 24 * 3600
ACTIVE_ORCA = ("queued", "running", "question", "unknown")
ACTIVE_HERMES = ("queued", "submitting", "running", "approval", "unknown", "stopping")


def parse_time(value):
    """'HH:MM' → (hour, minute); anything else disables the digest."""
    if not isinstance(value, str) or ":" not in value:
        return None
    try:
        hour, minute = (int(part) for part in value.strip().split(":", 1))
    except ValueError:
        return None
    return (hour, minute) if 0 <= hour < 24 and 0 <= minute < 60 else None


def due_today(now, hour, minute):
    local = time.localtime(now)
    return time.mktime((local.tm_year, local.tm_mon, local.tm_mday, hour, minute, 0, 0, 0, -1))


def _rows(path, sql, args=()):
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        return []
    try:
        connection.row_factory = sqlite3.Row
        return connection.execute(sql, args).fetchall()
    except sqlite3.Error:
        return []
    finally:
        connection.close()


def _short(text, limit=90):
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def compose(state_dir, now=None):
    now = time.time() if now is None else now
    since = now - WINDOW
    state = Path(state_dir)
    lines = [time.strftime("Дайджест Мусафира · %d.%m %H:%M", time.localtime(now))]
    quiet = True

    orca = _rows(state / "orca.sqlite3", """
        SELECT j.state, j.stage, j.summary, j.result, j.error, j.updated, p.project_label AS label
        FROM jobs j LEFT JOIN pairs p ON p.id = j.pair_id
        WHERE j.deleted_at IS NULL AND (j.updated >= ? OR j.state IN ('queued','running','question','unknown'))
        ORDER BY j.updated DESC""", (since,))
    done = [r for r in orca if r["state"] == "completed" and r["updated"] >= since]
    stopped = [r for r in orca if r["stage"] == "stopped" and r["updated"] >= since]
    failed = [r for r in orca if r["state"] == "error" and r["stage"] != "stopped" and r["updated"] >= since]
    waiting = sorted({r["label"] or "Orca" for r in orca if r["state"] == "question"})
    active = sorted({r["label"] or "Orca" for r in orca if r["state"] in ("queued", "running")})
    unknown = [r for r in orca if r["state"] == "unknown"]
    if done or failed or stopped or waiting or active or unknown:
        quiet = False
        lines.append(f"Orca за сутки: готово {len(done)}, ошибок {len(failed)}, остановлено {len(stopped)}")
        for r in done[:5]:
            lines.append(f"• {r['label'] or 'Orca'}: {_short(r['result'] or r['summary'])}")
        for r in failed[:3]:
            lines.append(f"✗ {r['label'] or 'Orca'}: {_short(r['error'] or r['summary'])}")
        if waiting:
            lines.append("Ждут твоего ответа: " + ", ".join(waiting))
        if active:
            lines.append("В работе сейчас: " + ", ".join(active))
        if unknown:
            lines.append(f"Неизвестный итог: {len(unknown)}, нажми «Обновить» на часах")

    pending = _rows(state / "orca-projects.sqlite3",
                    "SELECT count(*) AS n FROM operations WHERE state IN ('approval','clarification')")
    if pending and pending[0]["n"]:
        quiet = False
        lines.append(f"Новый проект ждёт решения на часах: {pending[0]['n']}")

    hermes = _rows(state / "state.sqlite3", """
        SELECT text, state, result, error, created FROM jobs
        WHERE deleted_at IS NULL AND (created >= ? OR state IN ('queued','submitting','running','approval','unknown','stopping'))
        ORDER BY created DESC""", (since,))
    answered = [r for r in hermes if r["state"] == "completed" and r["created"] >= since]
    errors = [r for r in hermes if r["state"] == "error" and r["created"] >= since]
    approvals = [r for r in hermes if r["state"] == "approval"]
    running = [r for r in hermes if r["state"] in ("queued", "submitting", "running", "stopping")]
    lost = [r for r in hermes if r["state"] == "unknown"]
    if answered or errors or approvals or running or lost:
        quiet = False
        lines.append(f"Hermes за сутки: ответов {len(answered)}, ошибок {len(errors)}")
        for r in answered[:3]:
            lines.append(f"• {_short(r['text'], 40)} → {_short(r['result'], 60)}")
        if approvals:
            lines.append("Hermes ждёт разрешения на часах")
        if running:
            lines.append(f"Hermes работает над {len(running)}")
        if lost:
            lines.append(f"Hermes: неизвестный итог {len(lost)}, проверь на часах")

    for label, name in (("Claude", "claude.sqlite3"), ("Codex", "codex.sqlite3")):
        jobs = _rows(state / name, """
            SELECT label, state, result, error, updated, night FROM jobs
            WHERE deleted_at IS NULL AND (updated >= ? OR state IN ('night','queued','running'))
            ORDER BY updated DESC""", (since,))
        finished = [r for r in jobs if r["state"] == "completed" and r["updated"] >= since]
        broken = [r for r in jobs if r["state"] == "error" and r["updated"] >= since]
        night = [r for r in jobs if r["state"] == "night"]
        busy = [r for r in jobs if r["state"] in ("queued", "running")]
        if finished or broken or night or busy:
            quiet = False
            at_night = sum(1 for r in finished + broken if r["night"])
            lines.append(f"{label} за сутки: готово {len(finished)}, ошибок {len(broken)}"
                         + (f", из них ночью {at_night}" if at_night else ""))
            for r in finished[:3]:
                lines.append(f"• {r['label']}: {_short(r['result'])}")
            for r in broken[:2]:
                lines.append(f"✗ {r['label']}: {_short(r['error'])}")
            if night:
                lines.append(f"{label}: в ночной смене ждут {len(night)}")
            if busy:
                lines.append(f"{label} работает над {len(busy)}")

    down = _rows(state / "watchdog.sqlite3", "SELECT label, detail FROM watches WHERE enabled=1 AND state='down'")
    if down:
        quiet = False
        lines.append("Дозор, лежит: " + "; ".join(f"{r['label']} ({_short(r['detail'], 40)})" for r in down[:5]))

    if quiet:
        lines.append("Тишина: агенты ничего не делали, решений не ждут.")
    return "\n".join(lines)


def summary(state_dir, now=None):
    """One line for the watch's home screen: what runs, what waits for the owner, what finished today."""
    now = time.time() if now is None else now
    since = now - WINDOW
    state = Path(state_dir)
    counts = {"working": 0, "waiting": 0, "done": 0, "night": 0, "errors": 0, "down": 0}
    hermes = _rows(state / "state.sqlite3", "SELECT state, created FROM jobs WHERE deleted_at IS NULL")
    counts["working"] += sum(1 for r in hermes if r["state"] in ("queued", "submitting", "running", "stopping"))
    counts["waiting"] += sum(1 for r in hermes if r["state"] == "approval")
    counts["done"] += sum(1 for r in hermes if r["state"] == "completed" and r["created"] >= since)
    counts["errors"] += sum(1 for r in hermes if r["state"] == "error" and r["created"] >= since)
    orca = _rows(state / "orca.sqlite3", "SELECT state, stage, updated FROM jobs WHERE deleted_at IS NULL")
    counts["working"] += sum(1 for r in orca if r["state"] in ("queued", "running"))
    counts["waiting"] += sum(1 for r in orca if r["state"] == "question")
    counts["done"] += sum(1 for r in orca if r["state"] == "completed" and r["updated"] >= since)
    counts["errors"] += sum(1 for r in orca if r["state"] == "error" and r["stage"] != "stopped" and r["updated"] >= since)
    pending = _rows(state / "orca-projects.sqlite3", "SELECT count(*) AS n FROM operations WHERE state IN ('approval','clarification')")
    counts["waiting"] += pending[0]["n"] if pending else 0
    for name in ("claude.sqlite3", "codex.sqlite3"):
        jobs = _rows(state / name, "SELECT state, updated FROM jobs WHERE deleted_at IS NULL")
        counts["working"] += sum(1 for r in jobs if r["state"] in ("queued", "running"))
        counts["night"] += sum(1 for r in jobs if r["state"] == "night")
        counts["done"] += sum(1 for r in jobs if r["state"] == "completed" and r["updated"] >= since)
        counts["errors"] += sum(1 for r in jobs if r["state"] == "error" and r["updated"] >= since)
    try:  # headless Claude prompts waiting for a tap: request files without a decision
        counts["waiting"] += sum(1 for path in (state / "permissions").glob("*/*.request.json")
                                 if not path.with_name(path.name.replace(".request.json", ".decision.json")).exists())
    except OSError:
        pass
    down = _rows(state / "watchdog.sqlite3", "SELECT count(*) AS n FROM watches WHERE enabled=1 AND state='down'")
    counts["down"] += down[0]["n"] if down else 0
    if not any(counts.values()):
        text = "Тишина: агенты свободны"
    else:
        parts = [f"Работают {counts['working']}", f"ждут решения {counts['waiting']}", f"готово {counts['done']}"]
        parts += [f"ночью {counts['night']}"] if counts["night"] else []
        parts += [f"ошибок {counts['errors']}"] if counts["errors"] else []
        parts += [f"упало {counts['down']}"] if counts["down"] else []
        text = " · ".join(parts)
    return {**counts, "text": text}


class Digest:
    def __init__(self, state_dir, notify, at=DEFAULT_TIME, event=None, now=time.time):
        self.state_dir = Path(state_dir)
        self.notify = notify
        self.at = parse_time(at)
        self.event = event or (lambda *args, **fields: None)
        self.now = now
        self.sent_date = None
        self.stop = threading.Event()
        self.thread = None

    @property
    def enabled(self):
        return bool(self.at and self.notify)

    def start(self):
        if self.enabled and self.thread is None:
            self.thread = threading.Thread(target=self._loop, name="digest", daemon=True)
            self.thread.start()

    def tick(self, now=None):
        """Send today's digest once its time has passed. Returns True when sent now."""
        if not self.enabled:
            return False
        now = self.now() if now is None else now
        date = time.strftime("%Y-%m-%d", time.localtime(now))
        if date == self.sent_date or now < due_today(now, *self.at):
            return False
        try:
            text = compose(self.state_dir, now)
        except Exception as exc:
            self.event("digest_error", error=type(exc).__name__)
            return False
        sent = self.notify("digest:" + date, text)
        self.sent_date = date  # the notifier already sent it earlier today when this is False
        self.event("digest_sent" if sent else "digest_skipped", date=date)
        return bool(sent)

    def _loop(self):
        while not self.stop.wait(60):
            try:
                self.tick()
            except Exception:
                pass

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=5)
