"""Durable, bounded adapter for supervising an existing Orca worker/reviewer pair.

The injected ``cli`` callable receives ``(argv, timeout=seconds)``.  It may return
an Orca JSON envelope or the envelope's ``result`` object.  Production calls use
``subprocess`` with an argv array and never invoke a shell.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid


ORCA = "/usr/local/bin/orca"
MAX_TEXT = 30_000
PAGE_MAX = 1_000
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
TERMINAL_RE = re.compile(r"^term_[A-Za-z0-9-]{8,80}$")
QUICK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
# Ready-made tasks for a pair: one tap on the watch instead of dictation.
# Override with "quickCommands": [{"id","label","text"}] in .local/config.json.
DEFAULT_QUICK_COMMANDS = (
    {"id": "continue", "label": "Продолжай",
     "text": "Продолжай работу с того места, где остановился, и доведи текущую задачу до результата."},
    {"id": "status", "label": "Статус",
     "text": "Кратко перечисли, что уже сделано, что осталось и что мешает. Ничего не меняй."},
    {"id": "tests", "label": "Тесты",
     "text": "Прогони тесты проекта и исправь падения. Не меняй поведение сверх необходимого."},
    {"id": "commit", "label": "Коммит",
     "text": "Сделай git commit всех текущих изменений с понятным сообщением. Ничего не пушь."},
    {"id": "review", "label": "Проверь себя",
     "text": "Перепроверь последние изменения на ошибки и незавершённые места и исправь найденное."},
)


def normalize_quick_commands(values):
    """Keep only well-formed entries; an empty or missing list falls back to the defaults."""
    if not isinstance(values, list):
        return [dict(item) for item in DEFAULT_QUICK_COMMANDS]
    answer, seen = [], set()
    for item in values:
        if not isinstance(item, dict):
            continue
        quick_id, label, text = item.get("id"), item.get("label"), item.get("text")
        if (not isinstance(quick_id, str) or not QUICK_ID_RE.fullmatch(quick_id) or quick_id in seen or
                not isinstance(label, str) or not 1 <= len(label.strip()) <= 24 or
                not isinstance(text, str) or not text.strip() or len(text) > 4000 or "\x00" in text):
            continue
        seen.add(quick_id)
        answer.append({"id": quick_id, "label": label.strip(), "text": text.strip()})
        if len(answer) == 20:
            break
    return answer or [dict(item) for item in DEFAULT_QUICK_COMMANDS]


class CliFailure(RuntimeError):
    def __init__(self, message, *, code="runtime_error", uncertain=False):
        super().__init__(message)
        self.code = code
        self.uncertain = uncertain


def _clean_id(value, label="ID"):
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise ValueError(f"Некорректный {label}")
    return value


def _text(value, label, maximum=MAX_TEXT):
    if (not isinstance(value, str) or not value.strip() or len(value) > maximum or
            "\x00" in value):
        raise ValueError(f"Некорректный {label}")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError(f"Некорректный {label}") from exc
    return value.strip()


def _offset(value):
    if value is None:
        return 0
    if isinstance(value, str) and value.isdigit():
        value = int(value)
    if type(value) is not int or value < 0:
        raise ValueError("Некорректный курсор")
    return value


def _limit(value, default=6, maximum=20):
    if value is None:
        return default
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError("Некорректный размер страницы")
    return value


def _find(data, *names):
    """Find a scalar under one of the named keys in a bounded JSON receipt."""
    if isinstance(data, dict):
        for name in names:
            value = data.get(name)
            if isinstance(value, (str, int)) and not isinstance(value, bool):
                return str(value)
        for value in data.values():
            found = _find(value, *names)
            if found is not None:
                return found
    elif isinstance(data, list):
        for value in data:
            found = _find(value, *names)
            if found is not None:
                return found
    return None


class OrcaService:
    """SQLite-backed Orca coordinator with a single bounded background ticker."""

    def __init__(self, state_dir, cli=None, notify=None, quick_commands=None):
        self.state = Path(state_dir)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.tasks = self.state / "orca-tasks"
        self.tasks.mkdir(exist_ok=True, mode=0o700)
        self.cli = cli
        self.notify = notify
        self.quick_commands = normalize_quick_commands(quick_commands)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.state / "orca.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS pairs (
              id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
              project_label TEXT NOT NULL, worker_id TEXT NOT NULL, reviewer_id TEXT NOT NULL,
              worker_title TEXT NOT NULL, reviewer_title TEXT NOT NULL,
              worker_agent TEXT NOT NULL, reviewer_agent TEXT NOT NULL,
              worker_incarnation TEXT NOT NULL, reviewer_incarnation TEXT NOT NULL,
              runtime_id TEXT NOT NULL, coordinator_id TEXT DEFAULT '',
              coordinator_incarnation TEXT DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
              created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY, pair_id TEXT NOT NULL, text_id TEXT NOT NULL,
              source_text TEXT NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL,
              summary TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '',
              error TEXT NOT NULL DEFAULT '', question_id TEXT NOT NULL DEFAULT '',
              question_text TEXT NOT NULL DEFAULT '', paused INTEGER NOT NULL DEFAULT 0,
              data TEXT NOT NULL DEFAULT '{}', created REAL NOT NULL, updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS operations (
              request_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL,
              argv TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT NOT NULL DEFAULT '',
              error TEXT NOT NULL DEFAULT '', created REAL NOT NULL, updated REAL NOT NULL);
        """)
        if "deleted_at" not in {row[1] for row in self.db.execute("PRAGMA table_info(jobs)")}:
            self.db.execute("ALTER TABLE jobs ADD COLUMN deleted_at REAL")
        # A process lost during a mutation has no safe automatic replay boundary here.
        uncertain = self.db.execute(
            "SELECT DISTINCT job_id FROM operations WHERE state='attempting'").fetchall()
        uncertain += self.db.execute("""SELECT DISTINCT j.id FROM jobs j
            JOIN operations o ON o.job_id=j.id
            WHERE j.state IN ('queued','running','question') AND o.state='completed'
              AND o.updated>j.updated""").fetchall()
        for row in uncertain:
            self.db.execute(
                "UPDATE jobs SET state='unknown',stage='unknown',"
                "error=?,updated=? WHERE id=? AND state!='completed'",
                ("Ответ Orca был потерян при перезапуске. Команда не повторена.",
                 time.time(), row[0]))
        self.db.execute("UPDATE operations SET state='unknown',updated=? WHERE state='attempting'",
                        (time.time(),))
        self.db.commit()
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = threading.Thread(target=self._loop, name="orca-coordinator", daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        self.wake.set()
        self.thread.join(timeout=25)
        with self.lock:
            self.db.close()

    def run_cli(self, argv, timeout=8, allow_timeout=False):
        """Return a normalized inner Orca result for a caller-owned operation.

        Callers using this for a mutation must durably record their own operation
        identity before invoking it; only coordinator mutations are recorded in
        this service's ``operations`` table.
        """
        result, _ = self._call(list(argv), timeout=timeout, allow_timeout=allow_timeout)
        return result

    # ---- public RPC -----------------------------------------------------

    def rpc(self, method, params, transcript_lookup=None):
        if not isinstance(method, str) or not isinstance(params, dict):
            raise ValueError("Некорректный запрос Orca")
        if method == "ORCA_LIST":
            return self._list_workspaces(params)
        if method == "ORCA_TERMINALS":
            return self._list_terminals(params)
        if method == "ORCA_PAIRS":
            return self._list_pairs(params)
        if method == "ORCA_BIND":
            return self._bind(params)
        if method == "ORCA_QUICK_LIST":
            self._only(params, "cursor", "limit")
            offset, limit = _offset(params.get("cursor")), _limit(params.get("limit"), default=3, maximum=6)
            items = [{"id": item["id"], "label": item["label"]} for item in self.quick_commands]
            return {"ok": True, "commands": items[offset:offset + limit],
                    **self._page(offset, limit, len(items))}
        if method == "ORCA_LATEST":
            self._only(params, "pairId", "cursor", "questionCursor")
            pair_id = _clean_id(params.get("pairId"), "пары")
            with self.lock:
                row = self.db.execute(
                    "SELECT * FROM jobs WHERE pair_id=? AND deleted_at IS NULL ORDER BY created DESC LIMIT 1",
                    (pair_id,)).fetchone()
            return {"ok": True, "job": self._public_job(row, params) if row else None}
        if method == "ORCA_HISTORY_LIST":
            return self._history_list(params)
        if method == "ORCA_HISTORY_DETAIL":
            return self._history_detail(params)
        if method == "ORCA_HISTORY_SET_DELETED":
            return self._history_set_deleted(params)
        if method == "ORCA_HISTORY_EMPTY_TRASH":
            return self._history_empty_trash(params)
        job_id = _clean_id(params.get("id"), "задачи")
        if method == "ORCA_JOB":
            self._only(params, "id", "cursor", "questionCursor")
            return {"ok": True, "job": self._public_job(self._job(job_id), params)}
        if method == "ORCA_SEND":
            return self._send(job_id, params, transcript_lookup)
        if method == "ORCA_REPLY":
            return self._reply(job_id, params, transcript_lookup)
        if method == "ORCA_PAUSE":
            return self._pause(job_id, params)
        if method == "ORCA_STOP":
            return self._stop(job_id, params)
        if method == "ORCA_ASK":
            return self._send(job_id, params, transcript_lookup, ask=True)
        if method == "ORCA_HANDOFF":
            return self._handoff(job_id, params)
        raise ValueError("Неизвестная команда Orca")

    def _list_workspaces(self, params):
        self._only(params, "cursor", "limit")
        offset, limit = _offset(params.get("cursor")), _limit(params.get("limit"))
        result, meta = self._call(["worktree", "ps", "--json"], timeout=8)
        rows = result.get("worktrees", []) if isinstance(result, dict) else []
        clean = []
        for row in rows:
            if not isinstance(row, dict) or row.get("isArchived"):
                continue
            workspace_id = row.get("worktreeId")
            path = row.get("path")
            if not isinstance(workspace_id, str) or not isinstance(path, str):
                continue
            clean.append({
                "id": workspace_id,
                "projectId": str(row.get("repoId") or ""),
                "projectLabel": str(row.get("repo") or row.get("displayName") or "Проект"),
                "name": str(row.get("displayName") or Path(path).name),
                "path": path,
                "kind": str(row.get("workspaceKind") or "git"),
            })
        return {"ok": True, "workspaces": clean[offset:offset + limit],
                **self._page(offset, limit, len(clean))}

    def _list_terminals(self, params):
        self._only(params, "workspaceId", "cursor", "limit")
        workspace_id = self._workspace(params.get("workspaceId"))
        offset, limit = _offset(params.get("cursor")), _limit(params.get("limit"))
        terminals, _ = self._call(
            ["terminal", "list", "--worktree", "id:" + workspace_id, "--json"], timeout=8)
        rows = terminals.get("terminals", []) if isinstance(terminals, dict) else []
        valid = []
        for row in rows:
            if not isinstance(row, dict) or row.get("worktreeId") != workspace_id:
                continue
            handle = row.get("handle")
            if not isinstance(handle, str) or not TERMINAL_RE.fullmatch(handle):
                continue
            try:
                term = self._terminal(handle, workspace_id, require_idle=False)
            except (ValueError, CliFailure):
                continue
            valid.append(self._public_terminal(term))
        return {"ok": True, "workspaceId": workspace_id,
                "terminals": valid[offset:offset + limit],
                **self._page(offset, limit, len(valid))}

    def _list_pairs(self, params):
        self._only(params, "workspaceId", "cursor", "limit")
        workspace = params.get("workspaceId")
        if workspace is not None:
            workspace = self._plain(workspace, "рабочего каталога", 2048)
        offset, limit = _offset(params.get("cursor")), _limit(params.get("limit"))
        with self.lock:
            if workspace:
                rows = self.db.execute(
                    "SELECT * FROM pairs WHERE workspace_id=? ORDER BY created DESC", (workspace,)).fetchall()
            else:
                rows = self.db.execute("SELECT * FROM pairs ORDER BY created DESC").fetchall()
        public = [self._public_pair(row) for row in rows]
        return {"ok": True, "pairs": public[offset:offset + limit],
                **self._page(offset, limit, len(public))}

    def _bind(self, params):
        self._only(params, "workspaceId", "workerId", "reviewerId")
        workspace_id = self._workspace(params.get("workspaceId"))
        worker_id = self._terminal_id(params.get("workerId"))
        reviewer_id = self._terminal_id(params.get("reviewerId"))
        if worker_id == reviewer_id:
            raise ValueError("Боевой и проверяющий должны быть разными сессиями")
        worker = self._terminal(worker_id, workspace_id, require_idle=True)
        reviewer = self._terminal(reviewer_id, workspace_id, require_idle=True)
        _, meta = self._runtime_ready()
        runtime = str(meta.get("runtimeId") or worker.get("runtimeId") or "")
        catalog, _ = self._call(["worktree", "ps", "--json"], timeout=8)
        workspace_row = next((row for row in catalog.get("worktrees", [])
                              if isinstance(row, dict) and row.get("worktreeId") == workspace_id), {})
        project_id = str(workspace_row.get("repoId") or workspace_id.split("::", 1)[0])
        project_label = str(workspace_row.get("repo") or workspace_row.get("displayName") or
                            Path(worker["worktreePath"]).name)
        with self.lock:
            existing = self.db.execute(
                "SELECT * FROM pairs WHERE workspace_id=? AND worker_id=? AND reviewer_id=?",
                (workspace_id, worker_id, reviewer_id)).fetchone()
            if existing:
                pair_id = existing["id"]
                self.db.execute("UPDATE pairs SET enabled=1,worker_title=?,reviewer_title=?,"
                                "worker_agent=?,reviewer_agent=?,worker_incarnation=?,"
                                "reviewer_incarnation=?,runtime_id=? WHERE id=?",
                                (worker["title"], reviewer["title"], worker["agentIdentity"],
                                 reviewer["agentIdentity"], worker["incarnationId"],
                                 reviewer["incarnationId"], runtime, pair_id))
            else:
                pair_id = "pair_" + uuid.uuid4().hex
                self.db.execute("""INSERT INTO pairs(
                    id,workspace_id,project_id,project_label,worker_id,reviewer_id,
                    worker_title,reviewer_title,worker_agent,reviewer_agent,
                    worker_incarnation,reviewer_incarnation,runtime_id,created)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (pair_id, workspace_id, project_id, project_label, worker_id,
                     reviewer_id, worker["title"], reviewer["title"],
                     worker["agentIdentity"], reviewer["agentIdentity"],
                     worker["incarnationId"], reviewer["incarnationId"], runtime, time.time()))
            self.db.commit()
            row = self.db.execute("SELECT * FROM pairs WHERE id=?", (pair_id,)).fetchone()
        return {"ok": True, "pair": self._public_pair(row)}

    def _send(self, job_id, params, transcript_lookup, ask=False):
        """A task for the pair, or (ask=True) a question to one role that only answers."""
        self._only(params, "id", "textId", "pairId", "presetId", *(["role"] if ask else []))
        pair_id = _clean_id(params.get("pairId"), "пары")
        role = params.get("role") if ask else None
        if ask and role not in ("worker", "reviewer"):
            raise ValueError("Некорректная роль агента")
        seed = {"mode": "ask", "askRole": role} if ask else {}
        preset = None
        if params.get("presetId") is not None:
            if params.get("textId") is not None:
                raise ValueError("Укажите расшифровку или быструю команду")
            preset = next((item for item in self.quick_commands if item["id"] == params["presetId"]), None)
            if preset is None:
                raise ValueError("Быстрая команда не найдена")
            text_id = "preset:" + preset["id"]
        else:
            text_id = _clean_id(params.get("textId"), "расшифровки")
        with self.lock:
            old = self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if old:
                if (old["pair_id"] != pair_id or old["text_id"] != text_id or
                        json.loads(old["data"]).get("askRole") != role):
                    raise ValueError("ID задачи уже использован с другими данными")
                return {"ok": True, "job": self._public_job(old, params)}
            pair = self.db.execute("SELECT * FROM pairs WHERE id=? AND enabled=1", (pair_id,)).fetchone()
            if not pair:
                raise ValueError("Связка не найдена")
            active = self.db.execute(
                """SELECT id FROM jobs WHERE state IN ('queued','running','question','unknown')
                   AND pair_id IN (SELECT id FROM pairs WHERE workspace_id=?) LIMIT 1""",
                (pair["workspace_id"],)).fetchone()
            if active:
                raise ValueError("В этом проекте уже есть незавершённая задача")
        if preset is not None:
            source = _text(preset["text"], "текст задачи")
        else:
            if not callable(transcript_lookup):
                raise ValueError("Источник расшифровки недоступен")
            source = _text(transcript_lookup(text_id), "текст задачи")
        now = time.time()
        with self.lock:
            # The transcript callback runs outside the lock. Recheck the two
            # uniqueness fences so concurrent different IDs cannot both land.
            old = self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if old:
                if (old["pair_id"] != pair_id or old["text_id"] != text_id or
                        json.loads(old["data"]).get("askRole") != role):
                    raise ValueError("ID задачи уже использован с другими данными")
                return {"ok": True, "job": self._public_job(old, params)}
            active = self.db.execute(
                """SELECT id FROM jobs WHERE state IN ('queued','running','question','unknown')
                   AND pair_id IN (SELECT id FROM pairs WHERE workspace_id=?) LIMIT 1""",
                (pair["workspace_id"],)).fetchone()
            if active:
                raise ValueError("В этом проекте уже есть незавершённая задача")
            self.db.execute("""INSERT INTO jobs(
                id,pair_id,text_id,source_text,state,stage,summary,data,created,updated)
                VALUES(?,?,?,?,'queued','queued',?,?,?,?)""",
                (job_id, pair_id, text_id, source, "Вопрос сохранён" if ask else "Задача сохранена",
                 json.dumps(seed, ensure_ascii=False, separators=(",", ":")), now, now))
            self.db.commit()
            row = self._job(job_id)
        self.wake.set()
        return {"ok": True, "job": self._public_job(row, params)}

    def _handoff(self, job_id, params):
        """Start the worker on the prompt an agent proposed in reply to a question."""
        self._only(params, "id", "newId")
        new_id = _clean_id(params.get("newId"), "задачи")
        with self.lock:
            source = self._job(job_id)
            data = json.loads(source["data"])
            prompt = data.get("proposedPrompt")
            if source["state"] != "completed" or data.get("mode") != "ask" or not prompt:
                raise ValueError("У этого ответа нет промпта для боевого")
            old = self.db.execute("SELECT * FROM jobs WHERE id=?", (new_id,)).fetchone()
            if old:
                if json.loads(old["data"]).get("handoffFrom") != job_id:
                    raise ValueError("ID задачи уже использован с другими данными")
                return {"ok": True, "job": self._public_job(old, params)}
            active = self.db.execute(
                """SELECT id FROM jobs WHERE state IN ('queued','running','question','unknown')
                   AND pair_id IN (SELECT id FROM pairs WHERE workspace_id=
                       (SELECT workspace_id FROM pairs WHERE id=?)) LIMIT 1""",
                (source["pair_id"],)).fetchone()
            if active:
                raise ValueError("В этом проекте уже есть незавершённая задача")
            now = time.time()
            seed = {"handoffFrom": job_id, "startRole": "worker", "nextPrompt": prompt}
            self.db.execute("""INSERT INTO jobs(
                id,pair_id,text_id,source_text,state,stage,summary,data,created,updated)
                VALUES(?,?,?,?,'queued','queued','Промпт передан боевому',?,?,?)""",
                (new_id, source["pair_id"], "handoff:" + job_id, prompt,
                 json.dumps(seed, ensure_ascii=False, separators=(",", ":")), now, now))
            self.db.commit()
            row = self._job(new_id)
        self.wake.set()
        return {"ok": True, "job": self._public_job(row, params)}

    def _reply(self, job_id, params, transcript_lookup):
        self._only(params, "id", "questionId", "textId")
        question_id = self._plain(params.get("questionId"), "вопроса", 256)
        text_id = _clean_id(params.get("textId"), "расшифровки")
        if not callable(transcript_lookup):
            raise ValueError("Источник расшифровки недоступен")
        answer = _text(transcript_lookup(text_id), "ответ")
        with self.lock:
            job = self._job(job_id)
            data = json.loads(job["data"])
            claim = data.get("replyClaim")
            if claim:
                if claim.get("questionId") == question_id and claim.get("textId") == text_id:
                    return {"ok": True, "job": self._public_job(job, params)}
                raise ValueError("Этот вопрос уже получает другой ответ")
            if job["state"] != "question" or job["question_id"] != question_id:
                raise ValueError("Этот вопрос больше не действует")
            data["replyClaim"] = {"questionId": question_id, "textId": text_id,
                                  "state": "pending"}
            self.db.execute("UPDATE jobs SET state='running',stage='reply_submitting',"
                            "data=?,updated=? WHERE id=?",
                            (json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                             time.time(), job_id))
            self.db.commit()
        coordinator = data.get("coordinatorId")
        run_id = data.get("runId")
        argv = ["orchestration", "reply", "--id", question_id, "--body", answer]
        if run_id:
            argv += ["--run", run_id]
        if coordinator:
            argv += ["--from", coordinator]
        argv += ["--json"]
        try:
            self._mutate(job_id, "reply", argv)
        except CliFailure as exc:
            self._fail(job_id, exc)
            return {"ok": True, "job": self._public_job(self._job(job_id), params)}
        with self.lock:
            current = self._job(job_id)
            data = json.loads(current["data"])
            data["replyClaim"]["state"] = "completed"
            if current["paused"]:
                next_stage = "paused"
            elif data.get("activeRole") == "worker":
                next_stage = "worker_working"
            elif data.get("round", 0):
                next_stage = "reviewer_checking"
            else:
                next_stage = "reviewer_working"
            self.db.execute("UPDATE jobs SET state='running',stage=?,question_id='',"
                            "question_text='',summary=?,data=?,updated=? WHERE id=?",
                            (next_stage,
                             "Ответ передан проверяющему",
                             json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                             time.time(), job_id))
            self.db.commit()
        self.wake.set()
        return {"ok": True, "job": self._public_job(self._job(job_id), params)}

    def _pause(self, job_id, params):
        self._only(params, "id", "paused", "cursor")
        paused = params.get("paused", True)
        if not isinstance(paused, bool):
            raise ValueError("Некорректное состояние паузы")
        with self.lock:
            job = self._job(job_id)
            if job["state"] in ("completed", "error", "unknown"):
                return {"ok": True, "job": self._public_job(job, params)}
            stage, data = job["stage"], json.loads(job["data"])
            if paused and stage != "paused":
                data["stageBeforePause"] = stage
                stage = "paused"
            elif not paused and stage == "paused":
                prior = data.pop("stageBeforePause", "")
                if job["state"] == "queued":
                    stage = "queued"
                elif data.get("nextAction"):
                    stage = "dispatch_ready"
                elif data.get("activeRole") == "worker":
                    stage = "worker_working"
                elif data.get("round", 0):
                    stage = "reviewer_checking"
                else:
                    stage = prior or "reviewer_working"
            self.db.execute("UPDATE jobs SET paused=?,stage=?,data=?,updated=? WHERE id=?",
                            (int(paused), stage, json.dumps(data, ensure_ascii=False,
                                                           separators=(",", ":")),
                             time.time(), job_id))
            self.db.commit()
        self.wake.set()
        return {"ok": True, "job": self._public_job(self._job(job_id), params)}

    # ---- history: Mac stays the source of truth, trash is reversible ----

    @staticmethod
    def _public_state(state):
        return {"completed": "completed", "error": "error", "unknown": "unknown",
                "question": "approval", "queued": "queued"}.get(state, "running")

    def _history_list(self, params):
        self._only(params, "pairId", "trash", "offset", "limit")
        pair_id = params.get("pairId")
        if pair_id is not None:
            pair_id = _clean_id(pair_id, "пары")
        trash, offset, limit = params.get("trash", False), params.get("offset", 0), params.get("limit", 3)
        if (type(trash) is not bool or type(offset) is not int or not 0 <= offset <= 2**53 - 1 or
                type(limit) is not int or not 1 <= limit <= 3):
            raise ValueError("Некорректная история")
        clause = "j.deleted_at IS NOT NULL" if trash else "j.deleted_at IS NULL"
        args = []
        if pair_id:
            clause += " AND j.pair_id=?"
            args.append(pair_id)
        with self.lock:
            rows = self.db.execute(f"""SELECT j.id,j.source_text,j.created,j.state,j.deleted_at,
                p.project_label FROM jobs j LEFT JOIN pairs p ON p.id=j.pair_id WHERE {clause}
                ORDER BY j.created DESC, j.id DESC LIMIT ? OFFSET ?""", (*args, limit + 1, offset)).fetchall()
        items = [{"id": row["id"], "text": row["source_text"][:70], "created": row["created"],
                  "state": self._public_state(row["state"]), "deleted": row["deleted_at"] is not None,
                  "projectLabel": row["project_label"] or ""} for row in rows[:limit]]
        return {"ok": True, "items": items, "hasMore": len(rows) > limit}

    def _history_detail(self, params):
        self._only(params, "id", "field", "offset", "limit")
        job_id = _clean_id(params.get("id"), "задачи")
        field, offset, limit = params.get("field"), params.get("offset", 0), params.get("limit", 600)
        if (field not in ("text", "result") or type(offset) is not int or offset < 0 or
                type(limit) is not int or not 1 <= limit <= 600):
            raise ValueError("Некорректная история")
        row = self._job(job_id)
        content = row["source_text"] if field == "text" else (row["result"] or row["error"] or row["summary"] or "")
        if offset > len(content):
            raise ValueError("Страница за пределами истории")
        page = content[offset:offset + limit]
        return {"ok": True, "id": job_id, "field": field, "content": page, "total": len(content),
                "offset": offset, "complete": offset + len(page) == len(content),
                "created": row["created"], "state": self._public_state(row["state"]),
                "deleted": row["deleted_at"] is not None}

    def _history_set_deleted(self, params):
        self._only(params, "id", "deleted")
        job_id = _clean_id(params.get("id"), "задачи")
        deleted = params.get("deleted")
        if type(deleted) is not bool:
            raise ValueError("Некорректная история")
        with self.lock:
            row = self._job(job_id)
            if deleted and row["state"] not in ("completed", "error"):
                raise ValueError("Активную задачу нельзя удалить")
            if deleted:
                self.db.execute("UPDATE jobs SET deleted_at=COALESCE(deleted_at,?) WHERE id=?",
                                (time.time(), job_id))
            else:
                self.db.execute("UPDATE jobs SET deleted_at=NULL WHERE id=?", (job_id,))
            self.db.commit()
        return {"ok": True, "id": job_id, "deleted": deleted}

    def _history_empty_trash(self, params):
        """Permanently drop trashed finished tasks, their receipts and agent reports."""
        self._only(params, "pairId")
        pair_id = params.get("pairId")
        if pair_id is not None:
            pair_id = _clean_id(pair_id, "пары")
        clause = "deleted_at IS NOT NULL AND state IN ('completed','error')"
        args = []
        if pair_id:
            clause += " AND pair_id=?"
            args.append(pair_id)
        with self.lock:
            ids = [row[0] for row in self.db.execute(f"SELECT id FROM jobs WHERE {clause}", args).fetchall()]
            for job_id in ids:
                self.db.execute("DELETE FROM operations WHERE job_id=?", (job_id,))
                self.db.execute("DELETE FROM jobs WHERE id=?", (job_id,))
            self.db.commit()
        for job_id in ids:
            folder = self.tasks / job_id
            if folder.is_dir() and not folder.is_symlink() and folder.resolve().parent == self.tasks.resolve():
                shutil.rmtree(folder, ignore_errors=True)
        return {"ok": True, "removed": len(ids)}

    def _stop(self, job_id, params):
        """Owner stop: fence the active dispatch, interrupt the agent's turn, close the task.

        worker-abandon performs no process action; the interrupt goes only to the
        pair terminal whose identity still matches the binding. A late settlement
        or failure can no longer change a stopped task (see _save).
        """
        self._only(params, "id")
        with self.lock:
            job = self._job(job_id)
            if job["state"] in ("completed", "error", "unknown"):
                return {"ok": True, "job": self._public_job(job, params)}
            data = json.loads(job["data"])
            data["stopRequested"] = True
            self.db.execute("UPDATE jobs SET stage='stopping',data=?,updated=? WHERE id=?",
                            (json.dumps(data, ensure_ascii=False, separators=(",", ":")), time.time(), job_id))
            self.db.commit()
        notes = []
        dispatch = data.get("activeDispatch")
        if dispatch:
            try:
                self._mutate(job_id, "worker-abandon", [
                    "orchestration", "worker-abandon", "--dispatch", dispatch, "--json"])
            except Exception as exc:
                notes.append("dispatch не отгорожен: " + str(exc)[:80])
            try:
                pair = self._pair(job["pair_id"])
                worker = data.get("activeRole") == "worker"
                handle = pair["worker_id"] if worker else pair["reviewer_id"]
                expected = pair["worker_incarnation"] if worker else pair["reviewer_incarnation"]
                term = self._terminal(handle, pair["workspace_id"], require_idle=False)
                if term["incarnationId"] != expected:
                    raise ValueError("сессия агента сменилась")
                self._mutate(job_id, "interrupt", [
                    "terminal", "send", "--terminal", handle, "--interrupt", "--json"])
            except Exception as exc:
                notes.append("агент не прерван: " + str(exc)[:80])
        message = "Остановлено с часов" + ("; " + "; ".join(notes) if notes else "")
        self._save(job_id, state="error", stage="stopped", summary="Остановлено с часов",
                   error=message[:1000], data=data)
        self.wake.set()
        return {"ok": True, "job": self._public_job(self._job(job_id), params)}

    # ---- background state machine --------------------------------------

    def _loop(self):
        while not self.stop.is_set():
            self.wake.wait(2.0)
            self.wake.clear()
            try:
                with self.lock:
                    rows = self.db.execute(
                        "SELECT id FROM jobs WHERE state IN ('queued','running','question') "
                        "ORDER BY created").fetchall()
                for row in rows:
                    if self.stop.is_set():
                        break
                    try:
                        self._tick(row[0])
                    except Exception as exc:  # the daemon must not silently die
                        self._fail(row[0], exc)
            except sqlite3.ProgrammingError:
                return

    def _tick(self, job_id):
        job = self._job(job_id)
        if job["state"] == "question":
            return
        data = json.loads(job["data"])
        if job["state"] == "queued":
            if job["paused"]:
                return
            self._save(job_id, stage="coordinator_starting",
                       summary="Координатор Orca запускается")
            pair = self._pair(job["pair_id"])
            self._verify_pair(pair, require_idle=True)
            coordinator = self._ensure_coordinator(job_id, pair)
            receipt = self._mutate(job_id, "run-create", [
                "orchestration", "run-create", "--objective", job["source_text"],
                "--from", coordinator, "--json"])
            run_id = _find(receipt, "runId") or _find(receipt.get("run", {}), "id")
            if not run_id:
                raise CliFailure("Orca не вернула ID запуска")
            data.update({"coordinatorId": coordinator, "runId": run_id,
                         "round": 0, "history": []})
            if data.get("mode") == "ask":
                data["nextAction"] = {"role": data.get("askRole") or "reviewer", "kind": "ask"}
                summary = "Агент готовит ответ"
            elif data.get("startRole") == "worker":
                data.update({"round": 1, "nextAction": {"role": "worker", "kind": "work"}})
                summary = "Боевой получает промпт"
            else:
                summary = "Проверяющий готовит задачу"
            self._save(job_id, state="running", stage="dispatch_ready", data=data, summary=summary)
            job = self._job(job_id)
        if job["state"] != "running":
            return
        data = json.loads(job["data"])
        if job["stage"] in ("dispatch_ready", "paused"):
            if job["paused"]:
                self._save(job_id, stage="paused")
                if data.get("activeDispatch") and not data.get("nextAction"):
                    self._poll(job_id)
                return
            action = data.pop("nextAction", None) or {"role": "reviewer", "kind": "initial"}
            self._dispatch(job_id, action["role"], action.get("kind", "followup"), data)
            return
        if job["stage"] in ("reviewer_working", "worker_working", "reviewer_checking"):
            self._poll(job_id)

    def _dispatch(self, job_id, role, kind, data):
        job, pair = self._job(job_id), self._pair(self._job(job_id)["pair_id"])
        self._verify_pair(pair, require_idle=True, role=role)
        round_no = int(data.get("round", 0))
        folder = self.tasks / job_id
        folder.mkdir(exist_ok=True, mode=0o700)
        report = folder / f"{role}-{round_no}-{uuid.uuid4().hex[:8]}.json"
        prompt = self._prompt(job, data, role, kind, report)
        terminal = pair["reviewer_id"] if role == "reviewer" else pair["worker_id"]
        receipt = self._mutate(job_id, "worker-start", [
            "orchestration", "worker-start", "--spec", prompt,
            "--worktree", "id:" + pair["workspace_id"], "--terminal", terminal,
            "--run", data["runId"], "--from", data["coordinatorId"],
            "--timeout-ms", "15000", "--json"])
        dispatch_id = _find(receipt, "dispatchId") or _find(receipt.get("dispatch", {}), "id")
        task_id = _find(receipt, "taskId") or _find(receipt.get("task", {}), "id")
        if not dispatch_id or not task_id:
            raise CliFailure("Orca не вернула точные Task/Dispatch ID")
        data.update({"activeDispatch": dispatch_id, "activeTask": task_id or "",
                     "activeRole": role, "reportPath": str(report)})
        stage = "worker_working" if role == "worker" else (
            "reviewer_checking" if kind == "review" else "reviewer_working")
        self._save(job_id, stage=stage, data=data,
                   summary="Боевой работает" if role == "worker" else "Проверяющий проверяет")
        self.wake.set()

    def _poll(self, job_id):
        job = self._job(job_id)
        data = json.loads(job["data"])
        buffered = data.pop("bufferedDelivery", None)
        argv = ["orchestration", "check", "--terminal", data["coordinatorId"],
                "--run", data["runId"]]
        pending_ack = data.pop("pendingAck", "")
        if pending_ack or buffered is not None:
            self._save(job_id, data=data)
        if pending_ack:
            argv += ["--ack", pending_ack]
            argv += ["--json"]
        else:
            argv += ["--wait", "--types", "worker_done,escalation,question",
                     "--timeout-ms", "100", "--json"]
        try:
            if buffered is not None:
                result = buffered
            elif pending_ack:
                result = self._mutate(job_id, "check-ack", argv)
            else:
                result, _ = self._call(argv, timeout=2, allow_timeout=True)
        except CliFailure as exc:
            if exc.code == "timeout":
                return
            raise
        delivery = result.get("delivery", result) if isinstance(result, dict) else {}
        delivery_id = _find(delivery, "deliveryId") or (
            str(delivery.get("id")) if isinstance(delivery, dict) and delivery.get("id") else "")
        messages = delivery.get("messages", []) if isinstance(delivery, dict) else []
        if not messages and isinstance(result, dict):
            messages = result.get("messages", result.get("items", []))
        recovered = False
        if pending_ack and not messages:
            # Older builds could acknowledge worker_done without decoding its
            # JSON payload. Recover that exact accepted event, never redispatch.
            history, _ = self._call([
                "orchestration", "check", "--terminal", data["coordinatorId"],
                "--run", data["runId"], "--all", "--types", "worker_done", "--json"
            ], timeout=8)
            messages = history.get("messages", [])
            recovered = True
        settled = None
        attention = None
        for message in messages if isinstance(messages, list) else []:
            if not isinstance(message, dict):
                continue
            payload = message.get("payload", {})
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except (ValueError, TypeError):
                    payload = {}
            if isinstance(payload, dict):
                message = {**message, **{key: payload[key] for key in
                           ("dispatchId", "taskId", "outcome") if key in payload}}
            kind = str(message.get("type") or message.get("kind") or "")
            dispatch = _find(message, "dispatchId")
            task = _find(message, "taskId")
            if kind == "question":
                if dispatch != data.get("activeDispatch"):
                    continue
                question_id = str(message.get("id") or message.get("messageId") or "")
                body = _find(message, "question", "body", "text") or ""
                if question_id and body:
                    body = _text(body, "вопрос")
                    data.pop("replyClaim", None)
                    self._save(job_id, state="question", stage="question",
                               summary="Нужен твой ответ", question_id=question_id,
                               question_text=body, data=data)
            elif kind == "escalation":
                if dispatch != data.get("activeDispatch"):
                    continue
                question_id = str(message.get("id") or message.get("messageId") or "")
                body = (_find(message, "body", "text", "summary") or
                        "Агент запросил внимание владельца")
                if question_id:
                    data.pop("replyClaim", None)
                    attention = (question_id, _text(body, "сообщение агента"))
            elif kind == "worker_done":
                outcome = str(message.get("outcome") or "")
                if (dispatch == data.get("activeDispatch") and
                        task == data.get("activeTask") and
                        outcome in ("succeeded", "failed") and
                        self._verify_worker_done(data, outcome)):
                    settled = message
        if delivery_id:
            data["pendingAck"] = delivery_id
            self._save(job_id, data=data)
            self.wake.set()
        if settled:
            if recovered:
                data["recoveredSettlement"] = settled.get("id") or True
                self._save(job_id, data=data)
            self._settle(job_id, settled)
        elif attention:
            self._save(job_id, state="question", stage="question",
                       summary="Агент запросил внимание", question_id=attention[0],
                       question_text=attention[1], data=data)

    def _verify_worker_done(self, data, outcome):
        result, _ = self._call([
            "orchestration", "worker-show", "--dispatch", data["activeDispatch"],
            "--json"], timeout=8)
        # Version 1.4.212 worker-show publishes the exact Dispatch/Task pair in
        # `dispatch` and the authoritative settled outcome in `worker.state`.
        dispatch = result.get("dispatch", {}) if isinstance(result, dict) else {}
        worker = result.get("worker", {}) if isinstance(result, dict) else {}
        return (isinstance(dispatch, dict) and isinstance(worker, dict) and
                dispatch.get("id") == data["activeDispatch"] and
                dispatch.get("taskId") == data["activeTask"] and
                worker.get("state") == outcome)

    def _retain_and_ack(self, job_id, data):
        self._mutate(job_id, "worker-retain", [
            "orchestration", "worker-retain", "--dispatch", data["activeDispatch"],
            "--json"])
        pending_ack = data.pop("pendingAck", "")
        if not pending_ack:
            if data.pop("recoveredSettlement", False):
                return
            raise CliFailure("Нет Delivery ID для подтверждения settlement")
        result = self._mutate(job_id, "check-ack", [
            "orchestration", "check", "--terminal", data["coordinatorId"],
            "--run", data["runId"], "--ack", pending_ack, "--json"])
        delivery = result.get("delivery", result) if isinstance(result, dict) else {}
        messages = delivery.get("messages", []) if isinstance(delivery, dict) else []
        if messages:
            data["bufferedDelivery"] = result

    def _settle(self, job_id, message):
        job = self._job(job_id)
        data = json.loads(job["data"])
        outcome = str(message.get("outcome") or "")
        self._retain_and_ack(job_id, data)
        if outcome == "failed":
            self._save(job_id, state="error", stage="error", data=data,
                       error="Агент завершил этап с ошибкой", summary="Ошибка агента")
            return
        report = self._read_report(Path(data["reportPath"]), job_id)
        entry = {"role": data["activeRole"], "round": data.get("round", 0),
                 "path": data["reportPath"], "decision": report["decision"],
                 "summary": report["summary"]}
        data.setdefault("history", []).append(entry)
        role = data["activeRole"]
        decision = report["decision"]
        if decision == "question":
            self._save(job_id, state="error", stage="error", data=data,
                       error="Агент не создал долговечный Orca ask с ID вопроса",
                       summary="Вопрос не удалось связать с Orca")
            return
        if data.get("mode") == "ask":
            # A question ends after one answer; a proposed prompt waits for the owner's tap.
            if decision == "work" and report["prompt"].strip():
                data["proposedPrompt"] = report["prompt"]
            self._save(job_id, state="completed", stage="completed", data=data,
                       summary=report["summary"], result=report["summary"])
            return
        if role == "reviewer" and decision == "done":
            if data.get("bufferedDelivery"):
                self._save(job_id, state="error", stage="error", data=data,
                           error="После settlement остались сообщения Orca, требующие внимания",
                           summary="Нужно проверить сообщения Orca")
                return
            self._save(job_id, state="completed", stage="completed", data=data,
                       summary=report["summary"], result=report["summary"])
            return
        if role == "reviewer" and decision != "work":
            raise ValueError("Проверяющий вернул недопустимое решение")
        if role == "worker" and decision not in ("done", "work"):
            raise ValueError("Боевой вернул недопустимое решение")
        if role == "reviewer":
            rounds = int(data.get("round", 0)) + 1
            if rounds > 3:
                self._save(job_id, state="error", stage="error", data=data,
                           error="Достигнут предел трёх раундов исправлений",
                           summary="Нужно решение владельца")
                return
            data["round"] = rounds
            data["nextPrompt"] = report["prompt"]
            data["nextAction"] = {"role": "worker", "kind": "work"}
        else:
            data["lastWorkerReport"] = data["reportPath"]
            data["nextAction"] = {"role": "reviewer", "kind": "review"}
        self._save(job_id, state="running", stage="paused" if job["paused"] else "dispatch_ready",
                   data=data, summary="Пауза" if job["paused"] else "Готовится следующий этап")
        self.wake.set()

    # ---- prompts and proof ---------------------------------------------

    def _prompt(self, job, data, role, kind, report):
        source = job["source_text"]
        workspace_id = self._pair(job["pair_id"])["workspace_id"]
        common = (
            "\n\nИсходная подтвержденная владельцем задача (граница полномочий):\n"
            + source +
            f"\n\nВыбранный workspace Orca: {workspace_id}. Проверь фактический target "
            "checkout из исходной задачи; не считай каталог панели и каталог изменяемого "
            "кода автоматически одинаковыми."
            "\n\nНе расширяй этот объём. Не выполняй destructive actions, commit, push, deploy, "
            "публикацию или изменение доступов, если этого прямо нет в исходной задаче. "
            "Следуй всем инструкциям проекта. Вопрос владельцу задавай только через "
            "Orca orchestration ask из активного Dispatch. Перед worker_done запиши UTF-8 JSON "
            f"строго в ORCA_REPORT_PATH={report} с ключами decision, prompt, summary. "
            "decision: work, done или question. prompt содержит полный следующий промпт либо пустую "
            "строку; summary содержит полный итог без искусственного усечения. Только затем отправь "
            "worker_done с точными Task/Dispatch ID из injected preamble. Сам JSON не доказывает "
            "завершение без принятого worker_done."
        )
        if kind == "ask":
            who = "боевой исполнитель" if role == "worker" else "проверяющий"
            return (f"Ты {who} этого проекта. Владелец задал вопрос голосом с часов и прочитает ответ "
                    "с маленького экрана. Ответь кратко и по делу в поле summary (до 1200 символов, "
                    "без таблиц и длинных списков). Ничего не меняй в коде и файлах. Если владелец просит "
                    "подготовить задание или промпт боевому, положи полный промпт в поле prompt и "
                    "decision \"work\"; иначе decision \"done\" и prompt \"\"." + common)
        if role == "worker":
            return ("Ты боевой исполнитель. Выполни только конкретный промпт проверяющего:\n" +
                    str(data.get("nextPrompt") or "") + common)
        if kind == "initial":
            return ("Ты проверяющий. Проанализируй исходную задачу, при необходимости задай "
                    "долговечный вопрос, иначе сформируй конкретный ограниченный промпт боевому. "
                    "Не изменяй код." + common)
        return ("Ты проверяющий. Независимо проверь работу и доказательства боевого. Полный отчёт "
                f"находится по пути {data.get('lastWorkerReport', '')}. Верни done, work с полным "
                "исправляющим промптом в прежнем объёме, либо задай Orca ask. Не изменяй код." + common)

    def _read_report(self, path, job_id):
        root = (self.tasks / job_id).resolve()
        if path.is_symlink() or path.parent.resolve() != root or not path.is_file():
            raise ValueError("Структурированный отчёт агента отсутствует")
        if path.stat().st_size > 256 * 1024:
            raise ValueError("Структурированный отчёт слишком большой")
        raw = path.read_bytes()
        if len(raw) > 256 * 1024:
            raise ValueError("Структурированный отчёт слишком большой")
        report = json.loads(raw.decode("utf-8"))
        if not isinstance(report, dict) or set(report) != {"decision", "prompt", "summary"}:
            raise ValueError("Некорректный формат отчёта агента")
        if report["decision"] not in ("work", "done", "question"):
            raise ValueError("Некорректное решение агента")
        if not isinstance(report["prompt"], str) or len(report["prompt"]) > MAX_TEXT:
            raise ValueError("Некорректный промпт агента")
        if report["decision"] == "work" and not report["prompt"].strip():
            raise ValueError("Проверяющий не вернул промпт боевому")
        report["summary"] = _text(report["summary"], "отчёт агента")
        return report

    # ---- Orca identity and CLI -----------------------------------------

    def _workspace(self, value):
        value = self._plain(value, "рабочего каталога", 4096)
        result, _ = self._read_call(["worktree", "ps", "--json"], timeout=8)
        rows = result.get("worktrees", []) if isinstance(result, dict) else []
        if not any(isinstance(row, dict) and row.get("worktreeId") == value and
                   not row.get("isArchived") for row in rows):
            raise ValueError("Рабочий каталог Orca не найден")
        return value

    def _terminal(self, handle, workspace_id, require_idle):
        result, meta = self._read_call(["terminal", "show", "--terminal", handle, "--json"], timeout=5)
        term = result.get("terminal", result) if isinstance(result, dict) else {}
        agent = term.get("agentIdentity")
        if (not isinstance(term, dict) or term.get("handle") != handle or
                term.get("worktreeId") != workspace_id or term.get("orphaned") or
                not term.get("connected") or not term.get("writable") or
                agent not in ("claude", "codex") or not term.get("incarnationId")):
            raise ValueError("Сессия Orca недоступна или изменила идентичность")
        idle = self._idle(term)
        if require_idle and idle is not True:
            raise ValueError("Сессия Orca занята или её состояние нельзя подтвердить")
        term = dict(term)
        term["idle"] = idle
        term["runtimeId"] = str(meta.get("runtimeId") or "")
        return term

    def _idle(self, term):
        # worktree ps exposes the agent state keyed by the exact tab/pane pair.
        tab_id, leaf_id = term.get("tabId"), term.get("leafId")
        if isinstance(tab_id, str) and isinstance(leaf_id, str):
            try:
                result, _ = self._read_call(["worktree", "ps", "--json"], timeout=8)
                pane_key = tab_id + ":" + leaf_id
                workspace = next((row for row in result.get("worktrees", [])
                                  if isinstance(row, dict) and
                                  row.get("worktreeId") == term.get("worktreeId")), {})
                agent = next((row for row in workspace.get("agents", [])
                              if isinstance(row, dict) and row.get("paneKey") == pane_key), None)
                if agent and agent.get("state") in ("done", "idle"):
                    return True
                if agent and agent.get("state") == "working":
                    return False
            except CliFailure:
                pass
        handle = term["handle"]
        try:
            result, _ = self._read_call([
                "terminal", "wait", "--terminal", handle, "--for", "tui-idle",
                "--timeout-ms", "50", "--json"], timeout=1, allow_timeout=True)
        except CliFailure:
            return None
        wait = result.get("wait", result) if isinstance(result, dict) else {}
        value = wait.get("satisfied") if isinstance(wait, dict) else None
        return value if isinstance(value, bool) else None

    def _verify_pair(self, pair, require_idle, role=None):
        targets = []
        if role in (None, "worker"):
            targets.append(("worker", pair["worker_id"], pair["worker_incarnation"], pair["worker_agent"]))
        if role in (None, "reviewer"):
            targets.append(("reviewer", pair["reviewer_id"], pair["reviewer_incarnation"], pair["reviewer_agent"]))
        for _, handle, incarnation, agent in targets:
            term = self._terminal(handle, pair["workspace_id"], require_idle=require_idle)
            if term["incarnationId"] != incarnation or term["agentIdentity"] != agent:
                raise ValueError("Сессия Orca была заменена; привяжите связку заново")
        _, meta = self._runtime_ready()
        if pair["runtime_id"] and meta.get("runtimeId") != pair["runtime_id"]:
            raise ValueError("Orca была перезапущена; привяжите живые сессии заново")

    def _runtime_ready(self):
        result, meta = self._read_call(["status", "--json"], timeout=5)
        runtime = result.get("runtime", {}) if isinstance(result, dict) else {}
        if (not isinstance(runtime, dict) or runtime.get("state") != "ready" or
                runtime.get("reachable") is False):
            raise CliFailure("Runtime Orca не готов", code="unverifiable", uncertain=True)
        return result, meta

    def _ensure_coordinator(self, job_id, pair):
        handle = pair["coordinator_id"]
        if handle:
            try:
                result, meta = self._read_call(["terminal", "show", "--terminal", handle, "--json"], timeout=5)
                term = result.get("terminal", result)
                if (term.get("worktreeId") == pair["workspace_id"] and term.get("connected") and
                        not term.get("orphaned") and term.get("incarnationId") == pair["coordinator_incarnation"] and
                        (not pair["runtime_id"] or meta.get("runtimeId") == pair["runtime_id"])):
                    return handle
            except CliFailure:
                # Failure to read an existing coordinator is not proof it vanished.
                raise
        result = self._mutate(job_id, "terminal-create", [
            "terminal", "create", "--worktree", "id:" + pair["workspace_id"],
            "--title", "Musafir watch coordinator", "--json"])
        handle = _find(result, "handle")
        incarnation = _find(result, "incarnationId") or ""
        if not handle or not TERMINAL_RE.fullmatch(handle):
            raise CliFailure("Orca не вернула handle координатора")
        # Terminal show is the authority for the created shell identity.
        shown, meta = self._read_call(["terminal", "show", "--terminal", handle, "--json"], timeout=5)
        term = shown.get("terminal", shown)
        if term.get("worktreeId") != pair["workspace_id"] or term.get("orphaned"):
            raise CliFailure("Координатор создан не в выбранном рабочем каталоге")
        incarnation = str(term.get("incarnationId") or incarnation)
        with self.lock:
            self.db.execute("UPDATE pairs SET coordinator_id=?,coordinator_incarnation=?,runtime_id=? WHERE id=?",
                            (handle, incarnation, str(meta.get("runtimeId") or pair["runtime_id"]), pair["id"]))
            self.db.commit()
        return handle

    def _read_call(self, argv, *, timeout, allow_timeout=False):
        # Only these read-only CLI commands may be retried. Mutation submissions
        # still use _call once and retain their durable uncertain receipts.
        if tuple(argv[:2]) not in (('terminal', 'show'), ('terminal', 'wait'),
                                  ('worktree', 'ps'), ('status', '--json')):
            raise ValueError('Not a read-only Orca command')
        for attempt in range(2):
            try:
                return self._call(argv, timeout=timeout, allow_timeout=allow_timeout)
            except CliFailure as exc:
                if exc.code not in ('timeout', 'transport_error') or allow_timeout:
                    raise
                if attempt:
                    raise CliFailure('Не удалось прочитать состояние Orca на Mac. Проверка связи не завершена.',
                                     code='read_unavailable') from exc

    def _call(self, argv, *, timeout, allow_timeout=False):
        if not isinstance(argv, list) or any(not isinstance(x, str) for x in argv):
            raise TypeError("CLI argv must be strings")
        try:
            if self.cli is None:
                completed = subprocess.run([ORCA, *argv], shell=False, text=True,
                                           capture_output=True, timeout=timeout, check=False)
                raw = completed.stdout.strip() or completed.stderr.strip()
                try:
                    value = json.loads(raw)
                except json.JSONDecodeError as exc:
                    raise CliFailure("Orca вернула некорректный JSON",
                                     uncertain=completed.returncode != 0) from exc
            else:
                runner = self.cli.run if hasattr(self.cli, "run") else self.cli
                try:
                    value = runner(list(argv), timeout=timeout)
                except TypeError:
                    value = runner(list(argv))
                if isinstance(value, subprocess.CompletedProcess):
                    value = json.loads(value.stdout)
                elif isinstance(value, str):
                    value = json.loads(value)
        except (subprocess.TimeoutExpired, TimeoutError) as exc:
            if allow_timeout:
                raise CliFailure("timeout", code="timeout") from exc
            raise CliFailure("Ответ Orca потерян", code="timeout", uncertain=True) from exc
        if not isinstance(value, dict):
            raise CliFailure("Orca вернула некорректный ответ")
        meta = value.get("_meta", {}) if isinstance(value.get("_meta", {}), dict) else {}
        if value.get("ok") is False:
            error = value.get("error", {})
            code = str(error.get("code") or "runtime_error") if isinstance(error, dict) else "runtime_error"
            if allow_timeout and code == "timeout":
                return {}, meta
            message = str(error.get("message") or code) if isinstance(error, dict) else str(error)
            raise CliFailure(message, code=code, uncertain=code in ("timeout", "transport_error", "unverifiable"))
        result = value.get("result", value)
        return (result if isinstance(result, dict) else {"value": result}), meta

    def _mutate(self, job_id, kind, argv):
        request_id = "watch_" + uuid.uuid4().hex
        call_argv = list(argv)
        # This is a first submission. Orca assigns the recovery UUID; our local
        # correlation ID is not an Orca --retry-request token. Unknown outcomes
        # remain durable and are never automatically resubmitted.
        now = time.time()
        with self.lock:
            self.db.execute("INSERT INTO operations(request_id,job_id,kind,argv,state,created,updated)"
                            " VALUES(?,?,?,?,?,?,?)",
                            (request_id, job_id, kind, json.dumps(call_argv, ensure_ascii=False),
                             "prepared", now, now))
            self.db.commit()
            self.db.execute("UPDATE operations SET state='attempting',updated=? WHERE request_id=?",
                            (time.time(), request_id))
            self.db.commit()
        try:
            result, _ = self._call(call_argv, timeout=20)
        except Exception as exc:
            state = "unknown" if isinstance(exc, CliFailure) and exc.uncertain else "rejected"
            with self.lock:
                self.db.execute("UPDATE operations SET state=?,error=?,updated=? WHERE request_id=?",
                                (state, str(exc)[:500], time.time(), request_id))
                self.db.commit()
            raise
        with self.lock:
            self.db.execute("UPDATE operations SET state='completed',receipt=?,updated=? WHERE request_id=?",
                            (json.dumps(result, ensure_ascii=False)[:100_000], time.time(), request_id))
            self.db.commit()
        return result

    # ---- persistence and presentation ----------------------------------

    def _save(self, job_id, **changes):
        if not changes:
            return
        if "data" in changes and not isinstance(changes["data"], str):
            changes["data"] = json.dumps(changes["data"], ensure_ascii=False, separators=(",", ":"))
        changes["updated"] = time.time()
        allowed = {"state", "stage", "summary", "result", "error", "question_id",
                   "question_text", "paused", "data", "updated"}
        if not set(changes) <= allowed:
            raise TypeError("invalid job field")
        with self.lock:
            if "state" in changes and changes.get("stage") != "stopped":
                stage = self.db.execute("SELECT stage FROM jobs WHERE id=?", (job_id,)).fetchone()
                if stage and stage[0] in ("stopping", "stopped"):
                    return  # an owner stop is final; late settlements or failures cannot reopen it
            sql = ",".join(f"{key}=?" for key in changes)
            self.db.execute(f"UPDATE jobs SET {sql} WHERE id=?", (*changes.values(), job_id))
            self.db.commit()
        if self.notify and ("state" in changes or "question_id" in changes):
            self._announce(job_id)

    def _announce(self, job_id):
        """Owner notification for one durable transition; never breaks the coordinator."""
        try:
            job = self._job(job_id)
            if job["stage"] == "stopped":
                return  # the owner stopped it from the watch; nothing to announce
            with self.lock:
                pair = self.db.execute("SELECT project_label FROM pairs WHERE id=?", (job["pair_id"],)).fetchone()
            label = pair["project_label"] if pair else "Orca"
            state = job["state"]
            if state == "question" and job["question_id"]:
                key = f"orca:{job_id}:question:{job['question_id']}"
                text = f"Orca · {label}\nВопрос агента:\n{job['question_text'][:300]}\nОтветь голосом на часах."
            elif state == "completed":
                key = f"orca:{job_id}:completed"
                asked = json.loads(job["data"] or "{}").get("mode") == "ask"
                text = (f"Orca · {label}\n" + ("Ответ агента:" if asked else "Задача готова.") +
                        f"\n{(job['result'] or job['summary'])[:300]}")
            elif state == "error":
                key = f"orca:{job_id}:error"
                text = f"Orca · {label}\nОшибка: {(job['error'] or job['summary'])[:300]}"
            elif state == "unknown":
                key = f"orca:{job_id}:unknown"
                text = f"Orca · {label}\nИтог не подтверждён. Нажми «Обновить» на часах."
            else:
                return
            self.notify(key, text)
        except Exception:
            pass

    def _fail(self, job_id, exc):
        uncertain = isinstance(exc, CliFailure) and exc.uncertain
        with self.lock:
            job = self._job(job_id)
            unsettled = self.db.execute("""SELECT 1 FROM operations WHERE job_id=? AND
                (state IN ('attempting','unknown') OR (state='completed' AND updated>?)) LIMIT 1""",
                (job_id, job['updated'])).fetchone()
            no_mutations = not self.db.execute('SELECT 1 FROM operations WHERE job_id=? LIMIT 1',
                                              (job_id,)).fetchone()
        uncertain = uncertain or bool(unsettled)
        message = str(exc)
        if no_mutations and isinstance(exc, CliFailure):
            uncertain = False
            message = 'Orca на Mac не ответила на проверку состояния. Задание агентам не отправлено. Текст сохранён.'
        self._save(job_id, state="unknown" if uncertain else "error",
                   stage="unknown" if uncertain else "error",
                   summary="Состояние Orca неизвестно" if uncertain else "Ошибка Orca",
                   error=("Ответ Orca потерян. Команда не повторена." if uncertain else message)[:1000])

    def _job(self, job_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise ValueError("Задача Orca не найдена")
        return row

    def _pair(self, pair_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM pairs WHERE id=? AND enabled=1", (pair_id,)).fetchone()
        if not row:
            raise ValueError("Связка Orca не найдена")
        return row

    def _public_job(self, row, params):
        state = row["state"]
        try:
            extra = json.loads(row["data"] or "{}")
        except ValueError:
            extra = {}
        public_state = {"completed": "completed", "error": "error", "unknown": "unknown",
                        "question": "question", "queued": "queued"}.get(state, "running")
        cursor = _offset(params.get("cursor"))
        question_cursor = _offset(params.get("questionCursor"))
        result_body = row["result"]
        if state in ("error", "unknown") and not result_body:
            result_body = row["error"]
        question_body = row["question_text"]
        if cursor > len(result_body) or question_cursor > len(question_body):
            raise ValueError("Страница за пределами результата")
        result_page = result_body[cursor:cursor + PAGE_MAX]
        question_page = question_body[question_cursor:question_cursor + PAGE_MAX]
        paging = self._page(cursor, PAGE_MAX, len(result_body))
        question_paging = self._page(question_cursor, PAGE_MAX, len(question_body))
        return {"id": row["id"], "pairId": row["pair_id"], "state": public_state,
                "stage": row["stage"], "summary": row["summary"],
                "questionId": row["question_id"] or None,
                "question": question_page if state == "question" else "",
                "questionLength": len(question_body),
                "questionComplete": state != "question" or not question_paging["hasMore"],
                "questionNextCursor": (question_paging["nextCursor"]
                                       if state == "question" else None),
                "questionHasMore": state == "question" and question_paging["hasMore"],
                "result": result_page,
                "resultLength": len(result_body),
                "resultComplete": not paging["hasMore"],
                "error": row["error"], "paused": bool(row["paused"]),
                "mode": "ask" if extra.get("mode") == "ask" else "task",
                "askRole": extra.get("askRole"),
                "handoff": state == "completed" and bool(extra.get("proposedPrompt")), **paging}

    @staticmethod
    def _public_pair(row):
        return {"id": row["id"], "workspaceId": row["workspace_id"],
                "projectId": row["project_id"], "projectLabel": row["project_label"],
                "workerId": row["worker_id"], "reviewerId": row["reviewer_id"],
                "workerTitle": row["worker_title"], "reviewerTitle": row["reviewer_title"],
                "workerAgent": row["worker_agent"], "reviewerAgent": row["reviewer_agent"],
                "workerRole": "Боевой", "reviewerRole": "Проверяющий",
                "enabled": bool(row["enabled"])}

    @staticmethod
    def _public_terminal(term):
        idle = term.get("idle")
        return {"id": term["handle"], "title": str(term.get("title") or ""),
                "agent": term["agentIdentity"], "sessionId": term["incarnationId"],
                "incarnation": term["incarnationId"],
                "status": "idle" if idle is True else "busy" if idle is False else "unverifiable",
                "busy": idle is not True, "orphaned": False}

    @staticmethod
    def _page(offset, limit, total):
        end = min(offset + limit, total)
        return {"nextCursor": str(end) if end < total else None, "hasMore": end < total}

    @staticmethod
    def _plain(value, label, maximum):
        if (not isinstance(value, str) or not value or len(value) > maximum or
                any(ord(char) < 32 or ord(char) == 127 for char in value)):
            raise ValueError(f"Некорректный ID {label}")
        return value

    def _terminal_id(self, value):
        value = self._plain(value, "сессии", 96)
        if not TERMINAL_RE.fullmatch(value):
            raise ValueError("Некорректный ID сессии")
        return value

    @staticmethod
    def _only(params, *allowed):
        if not set(params) <= set(allowed):
            raise ValueError("Некорректные поля запроса Orca")
