"""Claude Code from the watch: headless turns inside the owner's own project folders.

Each task runs ``claude -p`` in the chosen project with an explicit permission
mode; prompts that would ask a human are denied (``--permission-prompts none``)
and reported. A watch task may continue a saved session by id; the session id
Claude returns is kept so the next dictation continues the same conversation.
The bridge owns the child process, so Stop is a real terminate.

Night shift: a task sent with ``night: true`` waits in state ``night`` and runs
with the others, one after another, inside the night window (``nightTime`` …
+6 h) or when the owner starts the shift from the watch. Night runs never wait
for a permission prompt; the morning digest and one Telegram summary report them.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from digest import due_today, parse_time
from watchdog import origin_repo

SESSION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
JOB_ID = re.compile(r"^[0-9]{1,16}-[0-9]{1,8}$")
MAX_TEXT = 30_000
PAGE_MAX = 1_000
SCAN_TTL = 20.0
HINT = ("Ответ прочитают с экрана часов: коротко и по делу, до 1500 символов, "
        "без таблиц и длинных списков.")
MODES = (
    ("auto", "Авто", ("--permission-mode", "auto")),
    ("acceptEdits", "Автоправки", ("--permission-mode", "acceptEdits")),
    ("plan", "План", ("--permission-mode", "plan")),
    ("bypass", "Без ограничений", ("--dangerously-skip-permissions",)),
    ("default", "Без правок", ()),  # headless prompts are denied, so only read-only tools run
)
STATES = ("night", "queued", "submitting", "running", "completed", "error", "unknown")
KINDS = ("task", "research", "deep")
RESEARCH_KINDS = ("research", "deep")
DEEP_TIMEOUT = 3600  # the bundled workflow spawns ~100 agents; 10–15 minutes is normal
DEEP_TOOLS = ("Workflow(deep-research)", "WebSearch", "WebFetch")
DEEP_HINT = ("Ты запустил встроенный workflow deep-research. Дождись уведомления о его завершении и только тогда напиши итог "
             "по-русски строго в формате: раздел «## Для часов» — до 1200 символов главных выводов простыми фразами, без ссылок; "
             "раздел «## Отчёт» — полный отчёт workflow: находки с датами, спорные и отброшенные утверждения, список источников "
             "название — URL. Пока workflow идёт, отвечай одной короткой фразой.")
QUICK_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
# Read-only investigation toolkit for presets: nothing here edits the project, pushes, merges or posts.
PRESET_TOOLS = ("Read", "Grep", "Glob",
                "Bash(git status*)", "Bash(git log*)", "Bash(git diff*)", "Bash(git show*)", "Bash(git branch*)",
                "Bash(git remote*)", "Bash(git blame*)", "Bash(git fetch*)",
                "Bash(gh pr view*)", "Bash(gh pr diff*)", "Bash(gh pr list*)", "Bash(gh pr checks*)",
                "Bash(gh run list*)", "Bash(gh run view*)", "Bash(gh issue list*)", "Bash(gh issue view*)",
                "Bash(ls *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
                "Bash(npm test*)", "Bash(npm run test*)", "Bash(pnpm test*)", "Bash(yarn test*)", "Bash(node --test*)",
                "Bash(pytest*)", "Bash(python3 -m pytest*)", "Bash(python3 -m unittest*)", "Bash(cargo test*)",
                "Bash(go test*)", "Bash(swift test*)", "Bash(xcodebuild test*)")
PRESET_ARGS = ("pr",)
PR_NUMBER = re.compile(r"(?<![\w.])(\d{1,8})(?![\w.])")
DEFAULT_PRESETS = (
    {"id": "broken", "label": "Что упало?", "text": (
        "Разберись, что сломалось в этом проекте, ничего не меняя. Посмотри `git status` и `git log -5 --oneline`; "
        "если есть GitHub Actions — `gh run list --limit 5`, для последнего упавшего прогона `gh run view <id> --log-failed | tail -80`; "
        "свежие логи и отчёты тестов в проекте; при необходимости прогони тесты командой проекта только ради результата. "
        "Ответь коротко: 1) что упало (одна строка), 2) где (файл или шаг), 3) вероятная причина, 4) что сделать. "
        "Если ничего не падало, так и скажи.")},
    {"id": "status", "label": "Статус проекта", "text": (
        "Коротко, 5–8 строк, ничего не меняя: что менялось в последние дни (`git log -10 --oneline`), незакоммиченные изменения "
        "(`git status`), открытые PR и последние прогоны CI (`gh pr list`, `gh run list --limit 3`, если репозиторий на GitHub), "
        "что ждёт внимания.")},
    {"id": "review", "label": "Ревью PR", "arg": "pr", "text": (
        "Сделай ревью pull request #{pr} этого репозитория, ничего не меняя и ничего не публикуя в GitHub. "
        "Прочитай описание и diff: `gh pr view {pr}` и `gh pr diff {pr}`; при необходимости открой затронутые файлы "
        "и прогони тесты проекта только ради результата. Ответь коротко: 1) что делает PR (одна строка); "
        "2) проблемы по убыванию важности, каждая с файлом и строкой — баги, безопасность, потеря данных, отсутствие тестов; "
        "3) вердикт: можно сливать / нужны правки / не сливать; 4) одной строкой, что проверить руками.")},
)


def normalize_presets(values):
    """Well-formed quick commands from config, else the defaults. Each may carry its own tool allowlist."""
    if not isinstance(values, list):
        return [dict(item, tools=list(PRESET_TOOLS)) for item in DEFAULT_PRESETS]
    answer, seen = [], set()
    for item in values:
        if not isinstance(item, dict):
            continue
        quick_id, label, text, tools = item.get("id"), item.get("label"), item.get("text"), item.get("tools", list(PRESET_TOOLS))
        arg = item.get("arg")
        if arg is not None and (arg not in PRESET_ARGS or "{" + arg + "}" not in str(text)):
            continue
        if (not isinstance(quick_id, str) or not QUICK_ID_RE.fullmatch(quick_id) or quick_id in seen or
                not isinstance(label, str) or not 1 <= len(label.strip()) <= 24 or
                not isinstance(text, str) or not text.strip() or len(text) > 4000 or "\x00" in text or
                not isinstance(tools, list) or not tools or len(tools) > 40 or
                not all(isinstance(t, str) and 1 <= len(t) <= 80 for t in tools)):
            continue
        seen.add(quick_id)
        answer.append({"id": quick_id, "label": label.strip(), "text": text.strip(), "tools": list(tools), **({"arg": arg} if arg else {})})
        if len(answer) == 20:
            break
    return answer or [dict(item, tools=list(PRESET_TOOLS)) for item in DEFAULT_PRESETS]
RESEARCH_ID = "research"  # the watch's name for "no project, the research folder"
GENERAL_ID = "general"    # a fresh task with no catalog project
RESEARCH_TOOLS = ("WebSearch", "WebFetch")
RESEARCH_PROMPT = """Проведи быстрое исследование по теме: «{topic}».
Порядок: 1) 3–5 первых запросов веб-поиска с разных углов (обзор, техника, свежее за последний год, критика и практика); \
2) прочитай 5–10 лучших источников целиком; 3) по прочитанному сформулируй 2–4 уточняющих запроса и прочитай ещё 3–5 источников; \
4) напиши отчёт. Всего не больше 20 поисков и 15 страниц.
Формат ответа строго такой:
## Для часов
До 1200 символов: 4–7 главных выводов простыми фразами, без ссылок и разметки.
## Отчёт
Markdown: контекст, находки по разделам с фактами и датами, спорные места и что не удалось проверить, рекомендации. \
Каждое существенное утверждение со ссылкой на источник в скобках. В конце список источников: название — URL.
Отвечай по-русски."""
NIGHT_TIME = "01:00"
NIGHT_WINDOW = 6 * 3600


def _clean_job_id(value):
    if not isinstance(value, str) or not JOB_ID.fullmatch(value):
        raise ValueError("Некорректный ID задачи")
    return value


def _text(value, label):
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_TEXT or "\x00" in value:
        raise ValueError(f"Некорректный {label}")
    return value


def _short(text, limit=80):
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


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


def _page(offset, limit, total):
    end = min(offset + limit, total)
    return {"nextCursor": str(end) if end < total else None, "hasMore": end < total}


def _first_records(path, limit=300):
    """Yield parsed JSON records from the head of a session file, bounded."""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as source:
            for index, line in enumerate(source):
                if index >= limit:
                    return
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record, dict):
                    yield record
    except OSError:
        return


class ClaudeService:
    """Base for headless agent sessions; CodexService overrides the hooks below."""

    PREFIX = "CLAUDE"
    LABEL = "Claude"
    KEY = "claude"
    DB_NAME = "claude.sqlite3"
    MODES = MODES
    DEFAULT_MODE = "auto"
    EXECUTABLE = "claude"
    EXECUTABLE_FALLBACK = str(Path.home() / ".local/bin/claude")
    PROJECTS_ROOT = Path.home() / ".claude/projects"
    PROMPT_TIMEOUT = 900  # seconds the owner has to answer a permission prompt on the watch
    PROMPTS = True        # Codex has no prompt hook; it runs with approvals disabled
    KINDS = KINDS
    KEEP_AWAKE = ("caffeinate", "-i", "-s")  # the Mac must not sleep while the shift runs
    STOP_WAIT = 2.0

    def __init__(self, state_dir, executable=None, projects_root=None, runner=None, notify=None, run=None,
                 timeout=1200, extra_projects=None, night_at=NIGHT_TIME, send_file=None, research_dir=None, presets=None):
        self.state = Path(state_dir)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.executable = executable or shutil.which(self.EXECUTABLE) or self.EXECUTABLE_FALLBACK
        self.projects_root = Path(projects_root or self.PROJECTS_ROOT)
        self.runner = runner or self._popen
        self.run = run or subprocess.run  # short gh/git calls
        self.notify = notify
        self.timeout = timeout if isinstance(timeout, (int, float)) and 30 <= timeout <= 7200 else 1200
        self.extra = [item for item in (extra_projects or []) if isinstance(item, str) and Path(item).is_dir()]
        self.night_at = parse_time(night_at)
        self.send_file = send_file
        self.presets = normalize_presets(presets)
        self.research_dir = Path(research_dir or self.state / "research")
        self.research_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.workspaces_dir = self.state / "workspaces"
        self.general_dir = self.workspaces_dir / self.KEY
        self.workspaces_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.general_dir.mkdir(exist_ok=True, mode=0o700)
        state_root = self.state.resolve()
        workspaces_root = self.workspaces_dir.resolve()
        general_root = self.general_dir.resolve()
        if (self.workspaces_dir.is_symlink() or self.general_dir.is_symlink() or
                workspaces_root.parent != state_root or general_root.parent != workspaces_root):
            raise RuntimeError(f"Некорректный каталог общей задачи {self.LABEL}")
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.state / self.DB_NAME, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS jobs(
              id TEXT PRIMARY KEY, project TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
              session_id TEXT NOT NULL DEFAULT '', result_session TEXT NOT NULL DEFAULT '',
              mode TEXT NOT NULL DEFAULT 'auto', source_text TEXT NOT NULL, state TEXT NOT NULL,
              result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
              created REAL NOT NULL, updated REAL NOT NULL, deleted_at REAL);
        """)
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(jobs)")}
        if "night" not in columns:
            self.db.execute("ALTER TABLE jobs ADD COLUMN night INTEGER NOT NULL DEFAULT 0")
        if "kind" not in columns:
            self.db.execute("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'")
        if "preset" not in columns:
            self.db.execute("ALTER TABLE jobs ADD COLUMN preset TEXT NOT NULL DEFAULT ''")
        if "text_id" not in columns:
            self.db.execute("ALTER TABLE jobs ADD COLUMN text_id TEXT NOT NULL DEFAULT ''")
        if "request_fingerprint" not in columns:
            self.db.execute("ALTER TABLE jobs ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''")
        # Legacy dictated tasks used the job id as their transcription id.
        # Presets have no transcription and keep the empty sentinel.
        self.db.execute("UPDATE jobs SET text_id=id WHERE text_id='' AND preset='' AND kind='task'")
        # The child died with the bridge: nothing was accepted elsewhere, so this is an honest error.
        self.db.execute("UPDATE jobs SET state='error',error='Мост перезапущен во время выполнения. Повторите запрос.',updated=? "
                        "WHERE state IN ('queued','submitting','running')", (time.time(),))
        self.db.commit()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix=self.KEY)
        self.processes = {}
        self.stopped = set()
        self.announced = set()
        self.permissions = self.state / "permissions"
        self.permissions.mkdir(exist_ok=True, mode=0o700)
        self._catalog = (0.0, [])
        self.shift, self.shift_stop, self.stop = None, threading.Event(), threading.Event()
        self.clock = threading.Thread(target=self._clock, name=self.KEY + "-clock", daemon=True)
        if self.night_at:
            self.clock.start()

    def close(self):
        self.stop.set()
        self.shift_stop.set()
        with self.lock:
            for process in list(self.processes.values()):
                try:
                    process.kill()
                except OSError:
                    pass
        self.worker.shutdown(wait=True)
        self.db.close()

    # ---- catalog -----------------------------------------------------------

    def _cwd_of(self, path):
        for record in _first_records(path):
            cwd = record.get("cwd")
            if isinstance(cwd, str) and cwd:
                return cwd
        return None

    def projects(self):
        now = time.monotonic()
        if now - self._catalog[0] < SCAN_TTL:
            return self._catalog[1]
        found = {}
        try:
            folders = [item for item in self.projects_root.iterdir() if item.is_dir()]
        except OSError:
            folders = []
        for folder in folders:
            files = sorted((f for f in folder.glob("*.jsonl") if SESSION_ID.fullmatch(f.stem)),
                           key=lambda f: f.stat().st_mtime, reverse=True)
            if not files:
                continue
            cwd = self._cwd_of(files[0])
            if not cwd or not Path(cwd).is_dir():
                continue
            if self._same_general_path(cwd):
                continue
            updated = files[0].stat().st_mtime
            if cwd not in found or found[cwd]["updated"] < updated:
                found[cwd] = {"id": cwd, "label": Path(cwd).name or cwd, "updated": updated, "dir": str(folder)}
        for extra in self.extra:
            if self._same_general_path(extra):
                continue
            found.setdefault(extra, {"id": extra, "label": Path(extra).name or extra, "updated": 0, "dir": ""})
        items = sorted(found.values(), key=lambda item: item["updated"], reverse=True)
        self._catalog = (now, items)
        return items

    def _project(self, value):
        if not isinstance(value, str) or not value or len(value) > 1000:
            raise ValueError("Некорректный проект")
        for item in self.projects():
            if item["id"] == value:
                return item
        raise ValueError(f"Проект не найден среди сессий {self.LABEL}")

    def _same_general_path(self, value):
        if not isinstance(value, str) or not value:
            return False
        try:
            return Path(value).resolve() == self.general_dir.resolve()
        except (OSError, RuntimeError):
            return False

    def _general_target(self, value):
        if value not in (GENERAL_ID, str(self.general_dir)):
            return None
        return {"id": str(self.general_dir), "label": "Общая задача",
                "updated": 0, "dir": "", "general": True}

    def _task_target(self, value):
        return self._general_target(value) or self._project(value)

    def _target(self, value):
        """A catalog project or one of the fixed bridge-owned workspaces."""
        general = self._general_target(value)
        if general:
            return general
        if value in (RESEARCH_ID, str(self.research_dir)):
            return {"id": str(self.research_dir), "label": "Исследование", "updated": 0, "dir": ""}
        return self._project(value)

    def sessions(self, project):
        folder = project.get("dir")
        if not folder and project.get("general"):
            try:
                files = sorted(
                    (path for path in self.projects_root.glob("*/*.jsonl")
                     if SESSION_ID.fullmatch(path.stem)),
                    key=lambda path: path.stat().st_mtime, reverse=True)[:400]
                files = [path for path in files if self._same_general_path(self._cwd_of(path))][:30]
            except OSError:
                files = []
        elif not folder:
            return []
        else:
            try:
                files = sorted((f for f in Path(folder).glob("*.jsonl") if SESSION_ID.fullmatch(f.stem)),
                               key=lambda f: f.stat().st_mtime, reverse=True)[:30]
            except OSError:
                files = []
        items = []
        for path in files:
            label = ""
            for record in _first_records(path):
                if record.get("type") == "summary" and isinstance(record.get("summary"), str):
                    label = record["summary"]
                    break
                if record.get("type") == "user" and not label:
                    message = record.get("message") or {}
                    content = message.get("content") if isinstance(message, dict) else None
                    if isinstance(content, str) and content.strip():
                        label = content.strip()
            items.append({"id": path.stem, "label": " ".join(label.split())[:60] or path.stem[:8],
                          "updated": path.stat().st_mtime})
        return items

    # ---- rpc -------------------------------------------------------------------

    def rpc(self, method, params, transcript_lookup=None):
        if not isinstance(method, str) or not isinstance(params, dict) or not method.startswith(self.PREFIX + "_"):
            raise ValueError(f"Некорректный запрос {self.LABEL}")
        method = method[len(self.PREFIX):]
        if method == "_PROJECTS":
            self._only(params, "cursor", "limit")
            offset, limit = _offset(params.get("cursor")), _limit(params.get("limit"), 3, 10)
            items = [{"id": p["id"], "label": p["label"]} for p in self.projects()]
            return {"ok": True, "projects": items[offset:offset + limit], **_page(offset, limit, len(items))}
        if method == "_SESSIONS":
            self._only(params, "project", "cursor", "limit")
            project = self._task_target(params.get("project"))
            offset, limit = _offset(params.get("cursor")), _limit(params.get("limit"), 3, 10)
            items = self.sessions(project)
            return {"ok": True, "sessions": items[offset:offset + limit], **_page(offset, limit, len(items))}
        if method == "_MODES":
            self._only(params, "cursor", "limit")
            offset, limit = _offset(params.get("cursor")), _limit(params.get("limit"), 3, 10)
            items = [{"id": mode_id, "label": label} for mode_id, label, _ in self.MODES]
            return {"ok": True, "modes": items[offset:offset + limit], **_page(offset, limit, len(items))}
        if method == "_QUICK_LIST":
            self._only(params, "cursor", "limit")
            offset, limit = _offset(params.get("cursor")), _limit(params.get("limit"), 3, 10)
            items = [{"id": p["id"], "label": p["label"], **({"arg": p["arg"]} if p.get("arg") else {})} for p in self.presets]
            return {"ok": True, "items": items[offset:offset + limit], **_page(offset, limit, len(items))}
        if method == "_PRS":
            return self._prs(params)
        if method == "_LATEST":
            self._only(params, "project", "cursor")
            project = params.get("project")
            with self.lock:
                if project is None:
                    row = self.db.execute("SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY created DESC LIMIT 1").fetchone()
                else:
                    row = self.db.execute("SELECT * FROM jobs WHERE deleted_at IS NULL AND project=? ORDER BY created DESC LIMIT 1",
                                          (self._target(project)["id"],)).fetchone()
            return {"ok": True, "job": self._public(row, params) if row else None}
        if method == "_HISTORY_LIST":
            return self._history_list(params)
        if method == "_HISTORY_DETAIL":
            return self._history_detail(params)
        if method == "_HISTORY_SET_DELETED":
            return self._history_set_deleted(params)
        if method == "_HISTORY_EMPTY_TRASH":
            return self._history_empty_trash(params)
        if method == "_NIGHT":
            return self._night_status(params)
        if method == "_NIGHT_RUN":
            self._only(params)
            started = self.night_run()
            return {**self._night_status({}), "started": started}
        if method == "_NIGHT_STOP":
            self._only(params)
            self.night_stop()
            return self._night_status({})
        job_id = _clean_job_id(params.get("id"))
        if method == "_JOB":
            self._only(params, "id", "cursor")
            return {"ok": True, "job": self._public(self._job(job_id), params)}
        if method == "_SEND":
            return self._send(job_id, params, transcript_lookup)
        if method == "_STOP":
            return self._stop(job_id, params)
        if method == "_APPROVE":
            return self._approve(job_id, params)
        raise ValueError(f"Неизвестная команда {self.LABEL}")

    def _send(self, job_id, params, transcript_lookup):
        self._only(params, "id", "textId", "project", "sessionId", "mode", "night", "kind", "presetId", "pr",
                   "startFresh")
        kind = params.get("kind", "task")
        if kind not in self.KINDS:
            raise ValueError("Некорректный вид задачи" if kind not in KINDS else "Большое исследование умеет только Claude")
        preset = None
        if params.get("presetId") is not None:
            preset = next((p for p in self.presets if p["id"] == params["presetId"]), None)
            if preset is None or kind != "task":
                raise ValueError("Быстрая команда не найдена")
        project = self._target(params.get("project")) if kind in RESEARCH_KINDS else self._task_target(params.get("project"))
        mode = params.get("mode") or self.DEFAULT_MODE
        if mode not in {item[0] for item in self.MODES}:
            raise ValueError("Режим недоступен")
        night = params.get("night", False)
        if type(night) is not bool:
            raise ValueError("Некорректный флаг ночной смены")
        session = params.get("sessionId") or ""
        if session and (not isinstance(session, str) or not SESSION_ID.fullmatch(session)):
            raise ValueError("Некорректный ID сессии")
        start_fresh = params.get("startFresh")
        if start_fresh is not None and type(start_fresh) is not bool:
            raise ValueError("Некорректный флаг новой задачи")
        if start_fresh is True and session:
            raise ValueError("Новая задача не может продолжать сессию")
        text_id = params.get("textId")
        if preset is None and (not isinstance(text_id, str) or not JOB_ID.fullmatch(text_id)):
            raise ValueError("Некорректный ID расшифровки")
        preset_id = preset["id"] if preset else ""
        identity = {
            "kind": kind, "mode": mode, "night": night, "pr": params.get("pr"),
            "presetId": preset_id, "project": project["id"], "sessionId": session,
            "textId": text_id or "",
        }
        fingerprint = hashlib.sha256(json.dumps(
            identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")).hexdigest()

        def same_request(row, source_text=None):
            if (row["project"] != project["id"] or row["session_id"] != session or
                    row["mode"] != mode or bool(row["night"]) != night or
                    row["kind"] != kind or row["preset"] != preset_id):
                return False
            if row["request_fingerprint"]:
                if row["request_fingerprint"] != fingerprint:
                    return False
            elif row["text_id"] and row["text_id"] != (text_id or ""):
                return False
            if source_text is not None and row["source_text"] != source_text:
                return False
            return True

        with self.lock:
            old = self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if old:
            if not same_request(old):
                raise ValueError("ID задачи уже использован с другими данными")
            return {"ok": True, "job": self._public(old, params)}
        if preset is not None and preset.get("arg") == "pr":
            # The number comes from the watch's PR picker or is heard in the dictation («проверь PR 12»).
            pr = params.get("pr")
            if pr is None and isinstance(text_id, str) and callable(transcript_lookup):
                spoken = transcript_lookup(text_id)
                found = PR_NUMBER.search(spoken if isinstance(spoken, str) else "")
                pr = int(found.group(1)) if found else None
            if type(pr) is not int or not 1 <= pr <= 99_999_999:
                raise ValueError("Не расслышал номер PR. Скажи, например: «проверь PR 12»")
            text = preset["text"].replace("{pr}", str(pr))
        elif preset is not None:
            text = preset["text"]
        else:
            if not callable(transcript_lookup):
                raise ValueError("Источник расшифровки недоступен")
            text = _text(transcript_lookup(text_id), "текст задачи")
        now = time.time()
        with self.lock:
            old = self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if old:
                if not same_request(old, text):
                    raise ValueError("ID задачи уже использован с другими данными")
                return {"ok": True, "job": self._public(old, params)}
            active = self.db.execute("SELECT id FROM jobs WHERE state IN ('queued','submitting','running') AND project=? LIMIT 1",
                                     (project["id"],)).fetchone()
            if active and not night:
                raise ValueError("В этом проекте уже выполняется задача")
            self.db.execute("""INSERT INTO jobs(
                id,project,label,session_id,mode,source_text,state,created,updated,night,kind,preset,text_id,request_fingerprint)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (job_id, project["id"], project["label"], session, mode, text, "night" if night else "queued", now, now,
                 int(night), kind, preset_id, text_id or "", fingerprint))
            self.db.commit()
            row = self._job(job_id)
        if not night:
            self.worker.submit(self._run, job_id)
        return {"ok": True, "job": self._public(row, params)}

    def _stop(self, job_id, params):
        self._only(params, "id")
        with self.lock:
            job = self._job(job_id)
            if job["state"] not in ("queued", "submitting", "running"):
                return {"ok": True, "job": self._public(job, params)}
            self.stopped.add(job_id)
            process = self.processes.get(job_id)
            for pending in self._pending(job_id):
                self._decide(job_id, pending["id"], False, "Задача остановлена с часов")
            if process is None and job["state"] == "queued":
                self._save(job_id, state="error", error="Остановлено с часов")
            elif process is None:
                self._save(job_id, state="unknown",
                           error="Остановка запрошена, но активный процесс недоступен для подтверждения.")
        if process is not None:
            confirmed, reason = self._terminate_process(process)
            with self.lock:
                self._save(job_id, state="error" if confirmed else "unknown",
                           error="Остановлено с часов" if confirmed else reason)
        return {"ok": True, "job": self._public(self._job(job_id), params)}

    def _terminate_process(self, process):
        errors = []
        try:
            process.terminate()
        except Exception as exc:
            errors.append("terminate: " + type(exc).__name__)
        wait = getattr(process, "wait", None)
        if callable(wait):
            try:
                wait(timeout=self.STOP_WAIT)
                return True, ""
            except subprocess.TimeoutExpired:
                pass
            except Exception as exc:
                errors.append("wait: " + type(exc).__name__)
            try:
                process.kill()
            except Exception as exc:
                errors.append("kill: " + type(exc).__name__)
            else:
                try:
                    wait(timeout=self.STOP_WAIT)
                    return True, ""
                except Exception as exc:
                    errors.append("kill wait: " + type(exc).__name__)
        else:
            poll = getattr(process, "poll", None)
            try:
                if callable(poll) and poll() is not None:
                    return True, ""
            except Exception as exc:
                errors.append("poll: " + type(exc).__name__)
        detail = "; ".join(errors[:3])
        return False, ("Остановка отправлена, но завершение процесса не подтверждено" +
                       ((": " + detail) if detail else "."))[:1000]

    # ---- execution ---------------------------------------------------------------

    @staticmethod
    def _popen(argv, cwd, env):
        return subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def _run(self, job_id):
        with self.lock:
            job = self._job(job_id)
            if job["state"] != "queued" or job_id in self.stopped:
                return
            self._save(job_id, state="submitting")
        argv = self._launch_argv(job)
        env = {key: value for key, value in os.environ.items() if not key.startswith("CLAUDE_CODE_")}
        try:
            process = self.runner(argv, cwd=job["project"], env=env)
        except OSError as exc:
            self._finish(job_id, error=f"{self.LABEL} не запустился: " + type(exc).__name__)
            return
        with self.lock:
            current = self._job(job_id)
            if current["state"] != "submitting" or job_id in self.stopped:
                stopped_before_registration = True
            else:
                stopped_before_registration = False
                self.processes[job_id] = process
                self._save(job_id, state="running")
        if stopped_before_registration:
            confirmed, reason = self._terminate_process(process)
            with self.lock:
                self._save(job_id, state="error" if confirmed else "unknown",
                           error="Остановлено с часов" if confirmed else reason)
            return
        if self.PROMPTS and hasattr(process, "poll") and not job["night"]:
            threading.Thread(target=self._watch_prompts, args=(job_id, process), name="prompts", daemon=True).start()
        try:
            out, err = process.communicate(timeout=self._timeout_for(job))
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.communicate(timeout=5)
            except Exception:
                pass
            self._finish(job_id, error=f"{self.LABEL} не уложился в {int(self._timeout_for(job) // 60)} мин. Задача прервана.")
            return
        finally:
            with self.lock:
                self.processes.pop(job_id, None)
        if job_id in self.stopped:
            return
        try:
            result, session = self._parse_output(out or "", err or "", process.returncode, denials_note=job["kind"] == "task")
        except ValueError as exc:
            self._finish(job_id, error=(f"{self.LABEL} вернул ошибку: " + str(exc))[:1000])
            return
        self._finish(job_id, result=result, result_session=session)

    def _prompt(self, job):
        if job["kind"] == "research":
            return RESEARCH_PROMPT.format(topic=job["source_text"])
        if job["kind"] == "deep":
            return "/deep-research " + " ".join(job["source_text"].split())
        return job["source_text"]

    def _timeout_for(self, job):
        return max(self.timeout, DEEP_TIMEOUT) if job["kind"] == "deep" else self.timeout

    @staticmethod
    def _summary(result):
        """The «Для часов» section of a research report, or the head of the text."""
        match = re.search(r"##\s*Для часов\s*\n(.*?)(?:\n##\s|\Z)", result or "", re.S)
        return (match.group(1) if match else result or "").strip()[:1500]

    def _store_report(self, job):
        slug = re.sub(r"[^\w-]+", "-", job["source_text"][:40]).strip("-").lower() or "research"
        path = self.research_dir / f"{time.strftime('%Y-%m-%d-%H%M')}-{self.KEY}-{slug}.md"
        try:
            path.write_text(f"# {job['source_text']}\n\n{self.LABEL}, {time.strftime('%d.%m.%Y %H:%M')}\n\n{job['result']}\n",
                            encoding="utf-8")
        except OSError:
            return None
        return path

    def _launch_argv(self, job):
        if job["kind"] == "deep":
            # Bundled /deep-research workflow: the headless turn ends, the process waits for the workflow,
            # then a second turn writes the report; the last result line is the one that counts.
            return [self.executable, "-p", self._prompt(job), "--output-format", "stream-json", "--verbose", "--no-chrome",
                    "--strict-mcp-config", "--allowedTools", *DEEP_TOOLS, "--permission-prompts", "none",
                    "--append-system-prompt", DEEP_HINT]
        if job["kind"] == "research":
            # Web only, no edits, no MCP servers, nothing to approve.
            return [self.executable, "-p", self._prompt(job), "--output-format", "json", "--no-chrome",
                    "--strict-mcp-config", "--tools", ",".join(RESEARCH_TOOLS), "--allowedTools", *RESEARCH_TOOLS,
                    "--permission-prompts", "none"]
        if job["preset"]:
            # Investigation preset: its own read-only allowlist is the whole policy, whatever the project's mode.
            preset = next((p for p in self.presets if p["id"] == job["preset"]), None)
            tools = preset["tools"] if preset else list(PRESET_TOOLS)
            return [self.executable, "-p", job["source_text"], "--output-format", "json", "--no-chrome",
                    "--append-system-prompt", HINT, "--strict-mcp-config", "--allowedTools", *tools,
                    "--permission-prompts", "none"]
        flags = next(flags for mode_id, _, flags in self.MODES if mode_id == job["mode"])
        argv = [self.executable, "-p", job["source_text"], "--output-format", "json",
                "--no-chrome", "--append-system-prompt", HINT, *flags]
        if self.PROMPTS and job["mode"] != "bypass" and not job["night"]:
            # Prompts that would ask a human go to the watch through the permission tool; nobody answers at night.
            config = {"mcpServers": {"musafir": {
                "command": sys.executable,
                "args": [str(Path(__file__).with_name("permission_tool.py"))],
                "env": {"MUSAFIR_PERMISSION_DIR": str(self._permission_dir(job["id"])),
                        "MUSAFIR_PERMISSION_TIMEOUT": str(int(self.PROMPT_TIMEOUT))}}}}
            argv += ["--permission-prompts", "host", "--permission-prompt-tool", "mcp__musafir__approve",
                     "--mcp-config", json.dumps(config, ensure_ascii=False)]
        else:
            argv += ["--permission-prompts", "none"]
        if job["session_id"]:
            argv += ["--resume", job["session_id"]]
        return argv

    # ---- permission prompts from the watch ------------------------------------------

    def _permission_dir(self, job_id):
        return self.permissions / job_id

    def _pending(self, job_id):
        folder = self._permission_dir(job_id)
        items = []
        try:
            for path in folder.glob("*.request.json"):
                if path.with_name(path.name.replace(".request.json", ".decision.json")).exists():
                    continue
                try:
                    request = json.loads(path.read_text())
                except (OSError, ValueError):
                    continue
                if isinstance(request, dict) and re.fullmatch(r"[0-9a-f]{16}", str(request.get("id") or "")):
                    items.append(request)
        except OSError:
            return []
        return sorted(items, key=lambda item: item.get("created") or 0)

    @staticmethod
    def _questions(request):
        """Well-formed AskUserQuestion questions: [(text, [labels])]."""
        data = request.get("input") if isinstance(request.get("input"), dict) else {}
        items = []
        for q in data.get("questions") if isinstance(data.get("questions"), list) else []:
            if not isinstance(q, dict) or not isinstance(q.get("question"), str) or not q["question"].strip():
                continue
            labels = [o["label"].strip() for o in q.get("options") or [] if isinstance(o, dict) and isinstance(o.get("label"), str) and o["label"].strip()]
            if labels:
                items.append((q["question"].strip(), labels[:6]))
        return items

    def _answers(self, job_id, approval_id):
        path = self._permission_dir(job_id) / f"{approval_id}.answers.json"
        try:
            saved = json.loads(path.read_text())
        except (OSError, ValueError):
            return {}
        return saved if isinstance(saved, dict) else {}

    def _next_question(self, job_id, request):
        """(question, labels, step) still unanswered, or None when this is not a question or all are answered."""
        if request.get("toolName") != "AskUserQuestion":
            return None
        questions = self._questions(request)
        answered = self._answers(job_id, request["id"])
        for index, (question, labels) in enumerate(questions):
            if question not in answered:
                return question, labels, f"{index + 1}/{len(questions)}"
        return None

    def _describe(self, request):
        tool = str(request.get("toolName") or "инструмент")
        data = request.get("input") if isinstance(request.get("input"), dict) else {}
        if tool == "AskUserQuestion":
            questions = self._questions(request)
            if questions:
                question, labels = questions[0]
                return (f"Вопрос:\n{question}\nВарианты: " + " / ".join(labels))[:600]
        if tool == "Bash" and isinstance(data.get("command"), str):
            detail = data["command"]
        elif isinstance(data.get("file_path"), str):
            detail = data["file_path"]
        else:
            detail = json.dumps(data, ensure_ascii=False)
        return (f"{tool}:\n" + " ".join(detail.split()))[:600]

    def _decide(self, job_id, approval_id, allow, message=None, answers=None):
        folder = self._permission_dir(job_id)
        decision = {"allow": bool(allow), "decided": time.time(), "message": message or ""}
        if answers:
            decision["answers"] = answers
        tmp = folder / f"{approval_id}.decision.tmp"
        tmp.write_text(json.dumps(decision, ensure_ascii=False))
        os.replace(tmp, folder / f"{approval_id}.decision.json")

    def _approve(self, job_id, params):
        self._only(params, "id", "approvalId", "allow", "answer")
        approval_id, allow, answer = params.get("approvalId"), params.get("allow"), params.get("answer")
        if not isinstance(approval_id, str) or not re.fullmatch(r"[0-9a-f]{16}", approval_id) or type(allow) is not bool:
            raise ValueError("Некорректное решение")
        if answer is not None and (not isinstance(answer, str) or not answer.strip() or len(answer) > 300 or not allow):
            raise ValueError("Некорректный ответ на вопрос")
        with self.lock:
            job = self._job(job_id)
            folder = self._permission_dir(job_id)
            if not (folder / f"{approval_id}.request.json").exists():
                raise ValueError("Этот запрос разрешения больше не действует")
            if answer is not None:
                # One choice per tap; the decision file is written when every question has an answer.
                try:
                    request = json.loads((folder / f"{approval_id}.request.json").read_text())
                except (OSError, ValueError):
                    raise ValueError("Этот запрос разрешения больше не действует")
                pending = self._next_question(job_id, request)
                if pending is None or job["state"] != "running":
                    raise ValueError("Вопрос уже закрыт")
                question, labels, _ = pending
                if answer.strip() not in labels:
                    raise ValueError("Такого варианта нет")
                answers = {**self._answers(job_id, approval_id), question: answer.strip()}
                tmp = folder / f"{approval_id}.answers.tmp"
                tmp.write_text(json.dumps(answers, ensure_ascii=False))
                os.replace(tmp, folder / f"{approval_id}.answers.json")
                if self._next_question(job_id, request) is None:
                    self._decide(job_id, approval_id, True, answers=answers)
                return {"ok": True, "job": self._public(self._job(job_id), params)}
            decision_path = folder / f"{approval_id}.decision.json"
            if decision_path.exists():
                try:
                    previous = json.loads(decision_path.read_text()).get("allow")
                except (OSError, ValueError):
                    previous = None
                if previous is not None and previous != allow:
                    raise ValueError("Для этого запроса уже принято другое решение")
            elif job["state"] != "running":
                raise ValueError("Задача уже завершена")
            else:
                self._decide(job_id, approval_id, allow)
        return {"ok": True, "job": self._public(self._job(job_id), params)}

    def _watch_prompts(self, job_id, process):
        """Announce new prompts to Telegram while the child runs; the watch polls on its own."""
        while process.poll() is None:
            if self.notify:
                for request in self._pending(job_id):
                    key = f"{self.KEY}:{job_id}:approval:{request['id']}"
                    if key in self.announced:
                        continue
                    self.announced.add(key)
                    try:
                        job = self._job(job_id)
                        self.notify(key, f"{self.LABEL} · {job['label']}\nПросит разрешение:\n"
                                         f"{self._describe(request)[:300]}\nРазреши или откажи на часах.")
                    except Exception:
                        pass
            time.sleep(1.0)

    def _parse_output(self, out, err, returncode, denials_note=True):
        """Return (result, session_id) or raise ValueError with a short reason."""
        answer = None
        for line in reversed(out.strip().split("\n")):
            try:
                candidate = json.loads(line)
            except ValueError:
                continue
            if isinstance(candidate, dict) and "result" in candidate:
                answer = candidate
                break
        if returncode != 0 or not isinstance(answer, dict) or answer.get("is_error"):
            raise ValueError(str(answer.get("result")) if isinstance(answer, dict) and answer.get("result")
                             else " ".join(err.split())[-300:] or f"код {returncode}")
        result = str(answer.get("result") or "").strip() or "Готово"
        denials = answer.get("permission_denials")
        if denials_note and isinstance(denials, list) and denials:
            result += f"\n\nОтклонено запросов разрешений: {len(denials)}. Для таких действий выбери режим Авто или Без ограничений."
        session = answer.get("session_id")
        return result, (session if isinstance(session, str) and SESSION_ID.fullmatch(session) else "")

    def _finish(self, job_id, result=None, error=None, result_session=""):
        shutil.rmtree(self._permission_dir(job_id), ignore_errors=True)
        with self.lock:
            if job_id in self.stopped:
                return
            if error is not None:
                self._save(job_id, state="error", error=error)
            else:
                self._save(job_id, state="completed", result=result, result_session=result_session)
            job = self._job(job_id)
        report = self._store_report(job) if error is None and job["kind"] in RESEARCH_KINDS else None
        if self.notify:
            try:
                if error is not None:
                    self.notify(f"{self.KEY}:{job_id}:error", f"{self.LABEL} · {job['label']}\nОшибка: {error[:300]}")
                elif job["kind"] in RESEARCH_KINDS:
                    self.notify(f"{self.KEY}:{job_id}:completed", f"{self.LABEL} · Исследование\n{self._summary(result)}")
                    if report is not None and self.send_file:
                        self.send_file(f"{self.KEY}:{job_id}:report", report.name, report.read_bytes(),
                                       f"{self.LABEL} · исследование: {_short(job['source_text'], 120)}")
                else:
                    self.notify(f"{self.KEY}:{job_id}:completed", f"{self.LABEL} · {job['label']}\nОтвет готов:\n{result[:300]}")
            except Exception:
                pass

    def _prs(self, params):
        """Open pull requests of the project's GitHub origin, newest first."""
        self._only(params, "project", "cursor", "limit")
        project = self._project(params.get("project"))
        offset, limit = _offset(params.get("cursor")), _limit(params.get("limit"), 3, 10)
        repo = origin_repo(project["id"], self.run)
        if not repo:
            raise ValueError("У проекта нет GitHub-репозитория origin")
        try:
            out = self.run(["gh", "pr", "list", "-R", repo, "--state", "open", "--limit", "20", "--json",
                            "number,title,headRefName,author,updatedAt"], capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError) as exc:
            raise ValueError("gh не ответил: " + type(exc).__name__)
        if out.returncode != 0:
            raise ValueError("gh: " + (" ".join((out.stderr or "").split())[:120] or f"код {out.returncode}"))
        try:
            rows = json.loads(out.stdout or "[]")
        except ValueError:
            raise ValueError("gh вернул не JSON")
        items = []
        for row in rows if isinstance(rows, list) else []:
            number = row.get("number") if isinstance(row, dict) else None
            if type(number) is not int:
                continue
            author = row.get("author") if isinstance(row.get("author"), dict) else {}
            items.append({"number": number, "title": " ".join(str(row.get("title") or "").split())[:60],
                          "branch": str(row.get("headRefName") or "")[:60], "author": str(author.get("login") or "")[:40]})
        return {"ok": True, "repo": repo, "items": items[offset:offset + limit], **_page(offset, limit, len(items))}

    # ---- night shift -----------------------------------------------------------------

    def _night_label(self):
        return "%02d:%02d" % self.night_at if self.night_at else ""

    def _night_note(self):
        when = f"Старт в {self._night_label()}" if self.night_at else "Старт из меню «Ночная смена»"
        return f"Задача ждёт ночной смены. {when}. Убрать её можно через Историю."

    def _night_jobs(self):
        with self.lock:
            return self.db.execute("SELECT * FROM jobs WHERE state='night' AND deleted_at IS NULL "
                                   "ORDER BY created, id").fetchall()

    def shift_active(self):
        return self.shift is not None and self.shift.is_alive()

    def _night_status(self, params):
        self._only(params, "cursor", "limit")
        offset, limit = _offset(params.get("cursor")), _limit(params.get("limit"), 3, 10)
        items = [{"id": j["id"], "text": j["source_text"][:70], "projectLabel": j["label"]} for j in self._night_jobs()]
        return {"ok": True, "active": self.shift_active(), "at": self._night_label(), "count": len(items),
                "jobs": items[offset:offset + limit], **_page(offset, limit, len(items))}

    def night_run(self):
        """Start the shift now; False when it already runs or nothing waits."""
        with self.lock:
            if self.shift_active() or not self._night_jobs():
                return False
            self.shift_stop.clear()
            self.shift = threading.Thread(target=self._shift, name=self.KEY + "-night", daemon=True)
            self.shift.start()
            return True

    def night_stop(self):
        """Stop the current night task; the rest stay queued for the next start."""
        self.shift_stop.set()
        with self.lock:
            row = self.db.execute("SELECT id FROM jobs WHERE night=1 AND state IN ('queued','submitting','running') LIMIT 1").fetchone()
        if row:
            self._stop(row["id"], {"id": row["id"]})

    def _shift(self):
        awake = None
        if self.KEEP_AWAKE:
            try:
                awake = subprocess.Popen(self.KEEP_AWAKE, stdin=subprocess.DEVNULL,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except OSError:
                awake = None
        started, done, failed = time.time(), [], []
        try:
            while not self.shift_stop.is_set():
                jobs = self._night_jobs()
                if not jobs:
                    break
                job_id = jobs[0]["id"]
                self._save(job_id, state="queued")
                try:
                    self.worker.submit(self._run, job_id).result()  # one task at a time, in dictation order
                except Exception as exc:
                    self._finish(job_id, error=f"{self.LABEL} не отработал: {type(exc).__name__}")
                job = self._job(job_id)
                (done if job["state"] == "completed" else failed).append(job)
        finally:
            if awake is not None:
                awake.terminate()
        if self.notify and (done or failed):
            lines = [f"Ночная смена {self.LABEL}: готово {len(done)}, ошибок {len(failed)}"]
            lines += [f"• {j['label']}: {_short(j['result'])}" for j in done[:5]]
            lines += [f"✗ {j['label']}: {_short(j['error'])}" for j in failed[:3]]
            try:
                self.notify(f"{self.KEY}:night:{int(started)}", "\n".join(lines))
            except Exception:
                pass

    def tick(self, now=None):
        """Auto-start the shift inside the night window (nightTime … +6 h). True when started now."""
        if not self.night_at:
            return False
        now = time.time() if now is None else now
        due = due_today(now, *self.night_at)
        if now < due:
            due -= 86400
        return due <= now < due + NIGHT_WINDOW and self.night_run()

    def _clock(self):
        while not self.stop.wait(30):
            try:
                self.tick()
            except Exception:
                pass

    # ---- history -----------------------------------------------------------------

    def _history_list(self, params):
        self._only(params, "project", "trash", "offset", "limit")
        trash, offset, limit = params.get("trash", False), params.get("offset", 0), params.get("limit", 3)
        if (type(trash) is not bool or type(offset) is not int or not 0 <= offset <= 2**53 - 1 or
                type(limit) is not int or not 1 <= limit <= 3):
            raise ValueError("Некорректная история")
        clause = "deleted_at IS NOT NULL" if trash else "deleted_at IS NULL"
        args = []
        if params.get("project") is not None:
            clause += " AND project=?"
            args.append(self._target(params["project"])["id"])
        with self.lock:
            rows = self.db.execute(f"SELECT id,source_text,created,state,deleted_at,label FROM jobs WHERE {clause} "
                                   "ORDER BY created DESC, id DESC LIMIT ? OFFSET ?", (*args, limit + 1, offset)).fetchall()
        items = [{"id": r["id"], "text": r["source_text"][:70], "created": r["created"], "state": r["state"],
                  "deleted": r["deleted_at"] is not None, "projectLabel": r["label"]} for r in rows[:limit]]
        return {"ok": True, "items": items, "hasMore": len(rows) > limit}

    def _history_detail(self, params):
        self._only(params, "id", "field", "offset", "limit")
        job_id = _clean_job_id(params.get("id"))
        field, offset, limit = params.get("field"), params.get("offset", 0), params.get("limit", 600)
        if field not in ("text", "result") or type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 600:
            raise ValueError("Некорректная история")
        row = self._job(job_id)
        content = row["source_text"] if field == "text" else (row["result"] or row["error"] or "")
        if offset > len(content):
            raise ValueError("Страница за пределами истории")
        page = content[offset:offset + limit]
        context = {
            "target": self.KEY,
            "project": GENERAL_ID if self._same_general_path(row["project"]) else row["project"],
            "jobId": row["id"],
            "openJob": True, "resumeJob": True, "autoRecord": False,
        }
        if row["label"]:
            context["label"] = row["label"]
        session_id = row["result_session"] or row["session_id"]
        if session_id:
            context["sessionId"] = session_id
        if row["mode"]:
            context["mode"] = row["mode"]
        return {"ok": True, "id": job_id, "field": field, "content": page, "total": len(content), "offset": offset,
                "complete": offset + len(page) == len(content), "created": row["created"], "state": row["state"],
                "deleted": row["deleted_at"] is not None, "context": context}

    def _history_set_deleted(self, params):
        self._only(params, "id", "deleted")
        job_id = _clean_job_id(params.get("id"))
        deleted = params.get("deleted")
        if type(deleted) is not bool:
            raise ValueError("Некорректная история")
        with self.lock:
            row = self._job(job_id)
            if deleted and row["state"] not in ("completed", "error", "night"):
                raise ValueError("Активную задачу нельзя удалить")
            if deleted:
                self.db.execute("UPDATE jobs SET deleted_at=COALESCE(deleted_at,?) WHERE id=?", (time.time(), job_id))
            else:
                self.db.execute("UPDATE jobs SET deleted_at=NULL WHERE id=?", (job_id,))
            self.db.commit()
        return {"ok": True, "id": job_id, "deleted": deleted}

    def _history_empty_trash(self, params):
        self._only(params, "project")
        clause, args = "deleted_at IS NOT NULL AND state IN ('completed','error','night')", []
        if params.get("project") is not None:
            clause += " AND project=?"
            args.append(self._target(params["project"])["id"])
        with self.lock:
            cursor = self.db.execute(f"DELETE FROM jobs WHERE {clause}", args)
            self.db.commit()
        return {"ok": True, "removed": cursor.rowcount}

    # ---- persistence -----------------------------------------------------------------

    def _job(self, job_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise ValueError(f"Задача {self.LABEL} не найдена")
        return row

    def _save(self, job_id, **changes):
        allowed = {"state", "result", "error", "result_session"}
        if not set(changes) <= allowed:
            raise TypeError("invalid job field")
        changes["updated"] = time.time()
        with self.lock:
            sql = ",".join(f"{key}=?" for key in changes)
            self.db.execute(f"UPDATE jobs SET {sql} WHERE id=?", (*changes.values(), job_id))
            self.db.commit()

    def _public(self, row, params):
        cursor = _offset(params.get("cursor"))
        if row["state"] == "completed":
            body = row["result"] if row["kind"] not in RESEARCH_KINDS else (
                self._summary(row["result"]) + "\n\nПолный отчёт: файл в Telegram и в Истории.")
        else:
            body = (row["error"] if row["state"] in ("error", "unknown") else
                    self._night_note() if row["state"] == "night" else "")
        if cursor > len(body):
            raise ValueError("Страница за пределами результата")
        page = body[cursor:cursor + PAGE_MAX]
        approval = None
        state = row["state"]
        if state == "running":
            pending = self._pending(row["id"])
            if pending:
                state = "approval"
                approval = {"id": pending[0]["id"], "text": self._describe(pending[0])}
                question = self._next_question(row["id"], pending[0])
                if question:
                    approval.update({"question": question[0], "options": question[1], "step": question[2]})
        return {"id": row["id"], "project": row["project"], "projectLabel": row["label"], "state": state,
                "approval": approval, "night": bool(row["night"]), "kind": row["kind"], "preset": row["preset"],
                "mode": row["mode"], "sessionId": row["result_session"] or row["session_id"] or None,
                "result": page, "resultLength": len(body), "error": row["error"],
                **_page(cursor, PAGE_MAX, len(body))}

    def _only(self, params, *allowed):
        if not set(params) <= set(allowed):
            raise ValueError(f"Некорректные поля запроса {self.LABEL}")
