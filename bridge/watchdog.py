"""Watchdog: standing checks the owner sets from the watch.

Two kinds. ``url`` fetches a page and expects a non-error status; ``ci`` reads
the latest finished GitHub Actions run of a project's origin repository via
``gh``. Every check runs on its own interval from one background thread; only
a change of state (up → down, down → up) reaches Telegram, once per change.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import sqlite3
import subprocess
import threading
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

KINDS = ("url", "ci")
DEFAULT_INTERVAL = 300
MIN_INTERVAL, MAX_INTERVAL = 60, 86400
HOST_RE = re.compile(r"^[a-zа-яё0-9]([a-zа-яё0-9-]{0,61}[a-zа-яё0-9])?(\.[a-zа-яё0-9]([a-zа-яё0-9-]{0,61}[a-zа-яё0-9])?)+$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
FAILED = ("failure", "timed_out", "startup_failure", "action_required")
SPOKEN = (("точка", "."), ("слэш", "/"), ("слеш", "/"), ("дефис", "-"), ("тире", "-"), ("минус", "-"))
STATE_LABEL = {"ok": "в порядке", "down": "упало", "unknown": "не проверено"}


def spoken_url(text):
    """'фикра лабс точка ру' → https://фикралабс.ру; None when no hostname survives."""
    if not isinstance(text, str):
        return None
    lowered = text.strip().lower()
    for word, char in SPOKEN:
        lowered = re.sub(rf"\s*{word}\s*", char, lowered)
    lowered = re.sub(r"\s+", "", lowered).rstrip(".")
    lowered = re.sub(r"^(https?://)?(www\.)?", "", lowered)
    host, _, path = lowered.partition("/")
    if not HOST_RE.fullmatch(host):
        return None
    return f"https://{host}" + (f"/{path}" if path else "")


def origin_repo(path, runner=subprocess.run):
    """owner/repo of the folder's GitHub origin, else None."""
    try:
        out = runner(["git", "-C", str(path), "remote", "get-url", "origin"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", out.stdout.strip() if out.returncode == 0 else "")
    return f"{match.group(1)}/{match.group(2)}" if match else None


def _fetch(url):
    """(state, detail) for one GET."""
    request = Request(url, headers={"User-Agent": "MusafirWatchdog/1"})
    try:
        with urlopen(request, timeout=10) as response:
            return ("ok" if response.status < 400 else "down"), f"HTTP {response.status}"
    except HTTPError as exc:
        return "down", f"HTTP {exc.code}"
    except (URLError, OSError, ValueError) as exc:
        return "down", "нет ответа: " + (str(getattr(exc, "reason", exc))[:80] or type(exc).__name__)


class Watchdog:
    def __init__(self, state_dir, notify=None, runner=None, fetch=None, event=None, now=time.time):
        self.notify = notify
        self.runner = runner or subprocess.run
        self.fetch = fetch or _fetch
        self.event = event or (lambda *args, **fields: None)
        self.now = now
        self.lock = threading.RLock()
        state = Path(state_dir)
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(state / "watchdog.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS watches(
              id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, label TEXT NOT NULL,
              interval INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'unknown', detail TEXT NOT NULL DEFAULT '',
              checked REAL NOT NULL DEFAULT 0, changed REAL NOT NULL DEFAULT 0, created REAL NOT NULL,
              enabled INTEGER NOT NULL DEFAULT 1);
        """)
        self.db.commit()
        self.stop = threading.Event()
        self.thread = None

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self._loop, name="watchdog", daemon=True)
            self.thread.start()

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=15)
        with self.lock:
            self.db.close()

    # ---- rpc -----------------------------------------------------------------------

    def rpc(self, method, params, transcript_lookup=None):
        if not isinstance(method, str) or not isinstance(params, dict):
            raise ValueError("Некорректный запрос Дозора")
        if method == "WATCH_LIST":
            self._only(params, "cursor", "limit")
            offset, limit = _offset(params.get("cursor")), _limit(params.get("limit"), 3, 10)
            with self.lock:
                rows = self.db.execute("SELECT * FROM watches WHERE enabled=1 ORDER BY created, id").fetchall()
            items = [self._public(r) for r in rows]
            return {"ok": True, "items": items[offset:offset + limit], "count": len(items),
                    "nextCursor": str(offset + limit) if offset + limit < len(items) else None}
        if method == "WATCH_ADD":
            return self._add(params, transcript_lookup)
        watch_id = params.get("id")
        if not isinstance(watch_id, str) or not re.fullmatch(r"[0-9a-f]{12}", watch_id):
            raise ValueError("Некорректный ID проверки")
        if method == "WATCH_REMOVE":
            self._only(params, "id")
            with self.lock:
                self.db.execute("UPDATE watches SET enabled=0 WHERE id=?", (watch_id,))
                self.db.commit()
            return {"ok": True, "id": watch_id}
        if method == "WATCH_CHECK":
            self._only(params, "id")
            row = self._row(watch_id)
            self._check(row)
            return {"ok": True, "watch": self._public(self._row(watch_id))}
        raise ValueError("Неизвестная команда Дозора")

    def _add(self, params, transcript_lookup):
        self._only(params, "kind", "target", "textId", "label", "project", "interval")
        kind = params.get("kind")
        if kind not in KINDS:
            raise ValueError("Некорректный вид проверки")
        interval = params.get("interval", DEFAULT_INTERVAL)
        if type(interval) is not int or not MIN_INTERVAL <= interval <= MAX_INTERVAL:
            raise ValueError("Некорректный интервал")
        if kind == "url":
            text = params.get("target")
            if text is None and params.get("textId") is not None:
                if not callable(transcript_lookup):
                    raise ValueError("Источник расшифровки недоступен")
                text = transcript_lookup(params["textId"])
            target = spoken_url(text)
            if not target:
                raise ValueError("Не разобрал адрес сайта. Скажи, например: «фикра лабс точка ру»")
            label = params.get("label") if isinstance(params.get("label"), str) and params["label"].strip() else target[len("https://"):]
        else:
            project = params.get("project")
            if isinstance(project, str) and project and Path(project).is_dir():
                target = origin_repo(project, self.runner)
                if not target:
                    raise ValueError("У проекта нет GitHub-репозитория origin")
                default_label = Path(project).name
            elif isinstance(params.get("target"), str) and REPO_RE.fullmatch(params["target"]):
                target, default_label = params["target"], params["target"].split("/")[1]
            else:
                raise ValueError("Нужен проект с GitHub-репозиторием")
            label = params.get("label") if isinstance(params.get("label"), str) and params["label"].strip() else default_label
        label = " ".join(label.split())[:60]
        with self.lock:
            existing = self.db.execute("SELECT * FROM watches WHERE kind=? AND target=? AND enabled=1", (kind, target)).fetchone()
            if existing is None:
                watch_id = uuid.uuid4().hex[:12]
                self.db.execute("INSERT INTO watches(id,kind,target,label,interval,created) VALUES(?,?,?,?,?,?)",
                                (watch_id, kind, target, label, interval, self.now()))
                self.db.commit()
            else:
                watch_id = existing["id"]
        self._check(self._row(watch_id), announce=False)
        watch = self._public(self._row(watch_id))
        noun = "сайтом" if kind == "url" else "CI"
        return {"ok": True, "watch": watch, "existing": existing is not None,
                "message": f"Дозор: слежу за {noun} {watch['label']}. Сейчас: {STATE_LABEL[watch['state']]}, {watch['detail']}"}

    # ---- checks ----------------------------------------------------------------------

    def tick(self, now=None):
        """Check every watch whose interval has passed. Returns how many were checked."""
        now = self.now() if now is None else now
        with self.lock:
            rows = self.db.execute("SELECT * FROM watches WHERE enabled=1 AND checked + interval <= ?", (now,)).fetchall()
        for row in rows:
            if self.stop.is_set():
                break
            self._check(row)
        return len(rows)

    def _check(self, row, announce=True):
        try:
            state, detail = self._check_url(row["target"]) if row["kind"] == "url" else self._check_ci(row["target"])
        except Exception as exc:
            state, detail = None, "проверка не удалась: " + type(exc).__name__
        now = self.now()
        previous = row["state"]
        if state is None:
            state = previous
        changed = row["changed"] if state == previous else now
        with self.lock:
            self.db.execute("UPDATE watches SET state=?, detail=?, checked=?, changed=? WHERE id=?",
                            (state, detail[:300], now, changed, row["id"]))
            self.db.commit()
        self.event("watch_checked", id=row["id"], kind=row["kind"], state=state)
        if announce and self.notify and state != previous and (state == "down" or previous == "down"):
            noun = "Сайт" if row["kind"] == "url" else "CI"
            text = (f"Дозор · {row['label']}\n{noun} упал: {detail}" if state == "down"
                    else f"Дозор · {row['label']}\n{noun} снова в порядке: {detail}")
            try:
                self.notify(f"watch:{row['id']}:{state}:{int(now)}", text)
            except Exception:
                pass

    def _check_url(self, url):
        return self.fetch(url)

    def _check_ci(self, repo):
        out = self.runner(["gh", "run", "list", "-R", repo, "--limit", "10", "--json",
                           "name,status,conclusion,headBranch,url,updatedAt"], capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            reason = " ".join((out.stderr or "").split())[:120] or f"код {out.returncode}"
            return None, reason if reason.startswith("gh") else "gh: " + reason
        runs = json.loads(out.stdout or "[]")
        for run in runs:
            if not isinstance(run, dict) or run.get("status") != "completed" or run.get("conclusion") in ("cancelled", "skipped", None):
                continue
            where = f"{run.get('name') or 'workflow'} · {run.get('headBranch') or ''}".strip(" ·")
            if run.get("conclusion") == "success":
                return "ok", f"{where}: success"
            return "down", f"{where}: {run.get('conclusion')}\n{run.get('url') or ''}".strip()
        return None, "завершённых прогонов нет"

    # ---- helpers ---------------------------------------------------------------------

    def _loop(self):
        while not self.stop.wait(30):
            try:
                self.tick()
            except Exception:
                pass

    def _row(self, watch_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM watches WHERE id=? AND enabled=1", (watch_id,)).fetchone()
        if row is None:
            raise ValueError("Проверка не найдена")
        return row

    @staticmethod
    def _public(row):
        return {"id": row["id"], "kind": row["kind"], "target": row["target"], "label": row["label"],
                "state": row["state"], "detail": row["detail"], "checked": row["checked"], "interval": row["interval"]}

    @staticmethod
    def _only(params, *allowed):
        if not set(params) <= set(allowed):
            raise ValueError("Некорректные поля запроса Дозора")


def _offset(value):
    if value in (None, ""):
        return 0
    if isinstance(value, str) and value.isdigit():
        value = int(value)
    if type(value) is not int or value < 0:
        raise ValueError("Некорректный курсор")
    return value


def _limit(value, default, maximum):
    if value is None:
        return default
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError("Некорректный размер страницы")
    return value
