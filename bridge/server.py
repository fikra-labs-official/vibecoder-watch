"""Private, single-device bridge. Hermes and its credentials stay on loopback."""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import shlex
import sqlite3
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from lexicon import compile_rules, normalize
from orca_service import CliFailure

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.10.0"
ID = re.compile(r"^[0-9]{1,16}-[0-9]{1,8}$")
MAX_AUDIO = 8 * 1024 * 1024
MAX_TEXT_CHARS = 30_000
MAX_TEXT_PART_CHARS = 1_000
MAX_DRAFTS_PER_SOURCE = 8
MAX_RECENT_DRAFTS = 32
TEXT_DRAFT_RETENTION = 86400
TEXT_PAGE_DEFAULT = 1_000
TEXT_PAGE_MAX = 2_000
JOB_TEXT_PREVIEW = 1_000
JOB_RESULT_PREVIEW = 6_000
JOB_SUMMARY = 500
JOB_REPORT_MAX = 200_000
APPROVAL_TEXT_MAX = 12_000
MAX_REQUEST_BYTES = 512 * 1024
ACTIVE_JOB_STATES = ("queued", "submitting", "running", "approval", "unknown", "stopping")
TERMINAL_JOB_STATES = ("completed", "error", "cancelled")
JOB_MODES = ("task", "research")
LEGACY_CHAT_ID = "legacy"
LEGACY_SESSION_KEY = "musafer-watch"
DIAGNOSTIC_STAGES = {
    "recorder_create", "recorder_format", "recorder_start",
    "recorder_stop", "recorder_file", "recorder_open",
}
INSTRUCTIONS = (
    "Сообщение владельца с его часов, текст подтверждён им перед отправкой. "
    "Отвечай по-русски, кратко, в пределах 1200 символов, без Markdown-таблиц. "
    "Не отправляй сообщения другим людям и не публикуй ничего без явного указания "
    "в самой команде. Для удаления данных, платежей, изменения доступа или публикации "
    "сначала опиши точное действие и запроси отдельное подтверждение. "
    "Сохраняй действующие правила и профиль Мусафира."
)
RESEARCH_INSTRUCTIONS = (
    "Сообщение владельца с его часов, текст подтверждён им перед отправкой. "
    "Проведи тщательное исследование по запросу и начни ответ с краткого вывода, "
    "удобного для экрана часов. Затем дай полный структурированный отчёт. "
    "Ссылайся только на источники, которые действительно использовал, и явно отделяй "
    "проверенные факты от выводов. Не отправляй результат другим людям и не публикуй "
    "ничего без явного указания в самой команде. Для удаления данных, платежей, "
    "изменения доступа или публикации сначала запроси отдельное подтверждение. "
    "Сохраняй действующие правила и профиль Мусафира."
)

_MISSING = object()


class Invalid(ValueError):
    pass


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise Invalid("Некорректный ID")
    return value


def chat_identifier(value):
    if value == LEGACY_CHAT_ID:
        return value
    return identifier(value)


def chat_title(text):
    title = " ".join(str(text or "").split())
    return title[:48] or "Новая задача"


def request_fingerprint(text, text_id, requested_chat, mode):
    payload = json.dumps({
        "text": text,
        "textId": text_id,
        "chatId": requested_chat,
        "mode": mode,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class Hermes:
    def __init__(self, env_path):
        self.env_path = Path(env_path)

    def call(self, path, body=None, request_id=None, timeout=12, session_key=None):
        key = ""
        for line in self.env_path.read_text().splitlines():
            if line.startswith("API_SERVER_KEY="):
                values = shlex.split(line.split("=", 1)[1])
                key = values[0] if values else ""
        if not key:
            raise RuntimeError("Ключ локального Hermes не настроен")
        headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
        if request_id:
            headers["Idempotency-Key"] = "musafer-watch-" + request_id
            headers["X-Hermes-Session-Key"] = session_key or LEGACY_SESSION_KEY
        req = Request("http://127.0.0.1:8642" + path,
                      data=None if body is None else json.dumps(body).encode(), headers=headers)
        with urlopen(req, timeout=timeout) as response:
            return json.load(response)


class Bridge:
    POLL_SECONDS = 5

    def __init__(self, state_dir, hermes, transcriber, model, orca=None, projects=None, speech_status=None, notify=None, lexicon=None, claude=None, codex=None, watchdog=None, limits=None):
        self.state = Path(state_dir)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.hermes, self.transcriber, self.model = hermes, transcriber, Path(model)
        self.orca, self.projects = orca, projects
        self.claude = claude
        self.codex = codex
        self.watchdog = watchdog
        self.limits = limits
        self.speech_status = speech_status or (lambda: {})
        self.events = logging.Logger("watch-events")
        event_path = self.state / "events.jsonl"
        fd = os.open(event_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        os.close(fd)
        event_path.chmod(0o600)
        handler = RotatingFileHandler(event_path, maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(message)s"))
        self.events.addHandler(handler)
        self.expired_approvals = {}
        self.orca_observed = {}
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.state / "state.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS uploads (
                id TEXT PRIMARY KEY, total INTEGER, data BLOB, created REAL,
                state TEXT, text TEXT DEFAULT '', error TEXT DEFAULT '');
            CREATE TABLE IF NOT EXISTS text_drafts (
                id TEXT PRIMARY KEY, source_id TEXT NOT NULL, text_length INTEGER NOT NULL,
                text TEXT NOT NULL DEFAULT '', state TEXT NOT NULL,
                created REAL NOT NULL, updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, session_key TEXT NOT NULL UNIQUE,
                created REAL NOT NULL, updated REAL NOT NULL, archived_at REAL);
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, text TEXT, created REAL, state TEXT,
                run_id TEXT DEFAULT '', result TEXT DEFAULT '', error TEXT DEFAULT '',
                decision_id TEXT DEFAULT '');
        """)
        job_columns = {row[1] for row in self.db.execute("PRAGMA table_info(jobs)")}
        migrations = {
            "deleted_at": "REAL",
            "decision_id": "TEXT DEFAULT ''",
            "chat_id": "TEXT DEFAULT ''",
            "mode": "TEXT NOT NULL DEFAULT 'task'",
            "full_result": "TEXT NOT NULL DEFAULT ''",
            "report_truncated": "INTEGER NOT NULL DEFAULT 0",
            "stop_requested": "INTEGER NOT NULL DEFAULT 0",
            "source_text_id": "TEXT NOT NULL DEFAULT ''",
            "request_fingerprint": "TEXT NOT NULL DEFAULT ''",
        }
        for column, ddl in migrations.items():
            if column not in job_columns:
                self.db.execute(f"ALTER TABLE jobs ADD COLUMN {column} {ddl}")
        # Old watch packages used one fixed Hermes conversation. Preserve that exact
        # continuity, but do not create an empty placeholder in a fresh installation.
        legacy = self.db.execute(
            "SELECT id,text,created FROM jobs WHERE COALESCE(chat_id,'')='' ORDER BY created,id LIMIT 1"
        ).fetchone()
        if legacy is not None:
            bounds = self.db.execute(
                "SELECT MIN(created),MAX(created) FROM jobs WHERE COALESCE(chat_id,'')=''"
            ).fetchone()
            self.db.execute(
                "INSERT OR IGNORE INTO chats(id,title,session_key,created,updated) VALUES (?,?,?,?,?)",
                (LEGACY_CHAT_ID, chat_title(legacy["text"]), LEGACY_SESSION_KEY,
                 bounds[0] or time.time(), bounds[1] or bounds[0] or time.time()))
            self.db.execute(
                "UPDATE jobs SET chat_id=?, mode=COALESCE(NULLIF(mode,''),'task'), "
                "full_result=CASE WHEN full_result='' THEN COALESCE(result,'') ELSE full_result END "
                "WHERE COALESCE(chat_id,'')=''",
                (LEGACY_CHAT_ID,))
        # Old rows kept the whole answer in result. Move it into the paged
        # report field and bound both persisted and watch-facing payloads.
        self.db.execute(
            "UPDATE jobs SET "
            "report_truncated=CASE WHEN report_truncated=1 OR "
            "length(CASE WHEN full_result='' THEN COALESCE(result,'') ELSE full_result END)>? "
            "THEN 1 ELSE 0 END, "
            "full_result=substr(CASE WHEN full_result='' THEN COALESCE(result,'') ELSE full_result END,1,?), "
            "result=substr(COALESCE(result,''),1,?)",
            (JOB_REPORT_MAX, JOB_REPORT_MAX, JOB_RESULT_PREVIEW))
        self.db.execute("CREATE INDEX IF NOT EXISTS jobs_chat_created ON jobs(chat_id,created DESC,id DESC)")
        self.db.execute("CREATE INDEX IF NOT EXISTS chats_updated ON chats(archived_at,updated DESC,id DESC)")
        self.db.execute("UPDATE jobs SET state='unknown', error='Мост был перезапущен во время отправки. Не повторяйте команду.' WHERE state='submitting'")
        self.db.execute(
            "UPDATE jobs SET state='error', error='Перезапуск до отправки. Команда не отправлена.' "
            "WHERE state='queued' AND COALESCE(run_id,'')=''"
        )
        self.db.execute("UPDATE jobs SET state='unknown', error='Мост был перезапущен во время остановки. Проверьте итог Hermes.' WHERE state='stopping' AND run_id=''")
        self.db.execute("UPDATE uploads SET state='error', error='Распознавание прервано перезапуском. Нажмите повтор, чтобы продолжить.' WHERE state='transcribing'")
        self.db.commit()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="musafer")
        self.speech = ThreadPoolExecutor(max_workers=1, thread_name_prefix="speech")
        self.notify = notify
        self.lexicon = compile_rules(lexicon) if lexicon is not False else []
        self.stop = threading.Event()
        self.poller = None
        if notify:
            # With the watch app closed nobody polls Hermes; keep transitions observable.
            self.poller = threading.Thread(target=self._poll_loop, name="hermes-poll", daemon=True)
            self.poller.start()

    def close(self):
        self.stop.set()
        if self.poller:
            self.poller.join(timeout=15)
        if self.claude:
            self.claude.close()
        if self.codex:
            self.codex.close()
        if self.watchdog:
            self.watchdog.close()
        if self.projects:
            self.projects.close()
        if self.orca:
            self.orca.close()
        self.worker.shutdown(wait=True)
        self.speech.shutdown(wait=True)
        self.db.close()
        for handler in self.events.handlers:
            handler.close()

    def _poll_loop(self):
        while not self.stop.wait(self.POLL_SECONDS):
            try:
                with self.lock:
                    rows = self.db.execute(
                        "SELECT id FROM jobs WHERE state IN ('queued','submitting','running','approval','unknown','stopping') AND run_id!=''").fetchall()
                for row in rows:
                    if self.stop.is_set():
                        break
                    self.job_status(row[0])
            except Exception:
                pass

    def _announce(self, request_id, state, approval=None, result="", error=""):
        if not self.notify:
            return
        try:
            if state == "approval" and approval:
                key = f"hermes:{request_id}:approval:{approval['id']}"
                text = f"Мусафир\nHermes просит разрешение:\n{approval['text'][:300]}\nРазреши или откажи на часах."
            elif state == "completed":
                key, text = f"hermes:{request_id}:completed", f"Мусафир\nОтвет готов:\n{(result or 'Готово')[:300]}"
            elif state == "error":
                key, text = f"hermes:{request_id}:error", f"Мусафир\nОшибка: {(error or 'задача не выполнена')[:300]}"
            elif state == "unknown":
                key, text = f"hermes:{request_id}:unknown", "Мусафир\nОтвет о приёме потерян. Нажми «Обновить» на часах."
            else:
                return
            self.notify(key, text)
        except Exception:
            pass

    def event(self, event, **fields):
        # Only caller-selected metadata: never transcripts, audio, commands or credentials.
        self.events.info(json.dumps({"time": time.time(), "event": event, **fields}, ensure_ascii=False))

    def _get(self, table, request_id):
        row = self.db.execute(f"SELECT * FROM {table} WHERE id=?", (request_id,)).fetchone()
        if row is None:
            raise Invalid("Запрос не найден")
        return dict(row)

    def rpc(self, method, params):
        started = time.monotonic()
        request_id = params.get("id") if isinstance(params, dict) else None
        request_id = request_id if isinstance(request_id, str) and ID.fullmatch(request_id) else None
        try:
            result = self._rpc(method, params)
            if isinstance(method, str) and method.startswith("ORCA_"):
                item = result.get("job") or result.get("operation")
                if isinstance(item, dict):
                    metadata = {key: item.get(key) for key in ("id", "state", "stage", "questionId")}
                    metadata = {key: value for key, value in metadata.items()
                                if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,256}", value)}
                    key = metadata.get("id")
                    with self.lock:
                        if key and self.orca_observed.get(key) != metadata:
                            self.orca_observed[key] = metadata
                            if len(self.orca_observed) > 128:
                                self.orca_observed.pop(next(iter(self.orca_observed)))
                            self.event("orca_state", **metadata)
            if method in ("AUDIO_BEGIN", "AUDIO_FINISH", "AUDIO_CANCEL", "JOB_APPROVE", "JOB_STOP", "SEND_TEXT", "CLAUDE_SEND", "CLAUDE_STOP", "CODEX_SEND", "CODEX_STOP") or (
                isinstance(method, str) and method.startswith("ORCA_") and method not in ("ORCA_JOB", "ORCA_LATEST", "ORCA_OPERATION", "ORCA_HISTORY_LIST", "ORCA_HISTORY_DETAIL")):
                self.event("rpc", method=method, id=request_id, ms=round((time.monotonic() - started) * 1000), state=result.get("state"))
            return result
        except Exception as exc:
            safe_method = method if isinstance(method, str) and re.fullmatch(r"[A-Z_]{1,40}", method) else "invalid"
            self.event("rpc_error", method=safe_method, id=request_id, ms=round((time.monotonic() - started) * 1000), error=type(exc).__name__)
            raise

    def _rpc(self, method, params):
        if not isinstance(params, dict):
            raise Invalid("Некорректный запрос")
        for prefix, service_name, label in (("CLAUDE_", "claude", "Claude"), ("CODEX_", "codex", "Codex")):
            if isinstance(method, str) and method.startswith(prefix):
                service = getattr(self, service_name)
                if service is None:
                    raise Invalid(f"Обновите мост на Mac для подключения {label}")
                both = params.pop("both", None) if method == prefix + "SEND" else None
                if both not in (None, False, True) or (both and params.get("kind") != "research"):
                    raise Invalid("Оба агента доступны только для исследования")
                try:
                    answer = service.rpc(method, params, self.transcript)
                except ValueError as exc:
                    raise Invalid(str(exc)) from exc
                other = self.codex if service_name == "claude" else self.claude
                if both and other is not None:
                    # Same job id in the other agent's own database: the topic is researched twice, independently.
                    try:
                        other.rpc(other.PREFIX + "_SEND", params, self.transcript)
                    except ValueError as exc:
                        self.event("rpc_mirror_error", method=method, error=type(exc).__name__)
                return answer
        if isinstance(method, str) and method.startswith("WATCH_"):
            if self.watchdog is None:
                raise Invalid("Обновите мост на Mac для подключения Дозора")
            try:
                return self.watchdog.rpc(method, params, self.transcript)
            except ValueError as exc:
                raise Invalid(str(exc)) from exc
        if isinstance(method, str) and method.startswith("ORCA_"):
            service = self.projects if method in {
                "ORCA_ROOTS", "ORCA_PRESETS", "ORCA_AGENTS", "ORCA_MODELS", "ORCA_MODES", "ORCA_GITHUB_CREATE", "ORCA_PROJECT_CREATE",
                "ORCA_PAIR_CREATE", "ORCA_AGENT_CREATE", "ORCA_OPERATION",
                "ORCA_PROJECT_PLAN", "ORCA_PROJECT_DECIDE", "ORCA_PROJECT_RESUME"
            } else self.orca
            if service is None:
                raise Invalid("Обновите мост на Mac для подключения Orca")
            try:
                return service.rpc(method, params, self.transcript)
            except ValueError as exc:
                raise Invalid(str(exc)) from exc
        if method == "LIMITS":
            if self.limits is None:
                raise Invalid("Обновите мост на Mac для лимитов")
            try:
                return self.limits.rpc(method, params)
            except ValueError as exc:
                raise Invalid(str(exc)) from exc
        if method == "SUMMARY":
            from digest import summary
            return {"ok": True, **summary(self.state)}
        if method == "STATUS":
            self.hermes.call("/health", timeout=8)
            return {"ok": True, "agent": "Мусафир", "voice": self.model.exists(), "version": VERSION, "asr": self.speech_status()}
        if method == "LATEST_JOB":
            with self.lock:
                row = self.db.execute("""
                    SELECT id FROM jobs WHERE deleted_at IS NULL
                    ORDER BY CASE WHEN state IN ('queued','submitting','running','approval','unknown','stopping')
                                  THEN 0 ELSE 1 END,
                             created DESC, id DESC LIMIT 1
                """).fetchone()
            return {"ok": True, "job": self.job_status(row[0]) if row else None}
        if method == "CHAT_LIST":
            return self.chat_list(params)
        if method == "CHAT_DETAIL":
            return self.chat_detail(params)
        if method == "CHAT_ARCHIVE":
            return self.chat_archive(params)
        if method == "HISTORY_LIST":
            return self.history_list(params)
        if method == "HISTORY_DETAIL":
            return self.history_detail(params)
        if method == "HISTORY_SET_DELETED":
            return self.history_set_deleted(params)
        if method == "HISTORY_CURRENT":
            return self.history_current(params)
        if method == "HISTORY_EMPTY_TRASH":
            return self.history_empty_trash(params)
        if method == "DIAGNOSTIC":
            return self.save_diagnostic(params)
        if method == "TEXT_BEGIN":
            return self.text_begin(params)
        if method == "TEXT_PART":
            return self.text_part(params)
        if method == "TEXT_FINISH":
            return self.text_finish(params)
        request_id = identifier(params.get("id"))
        if method == "JOB_STATUS":
            if set(params) - {"id", "brief"} or type(params.get("brief", False)) is not bool:
                raise Invalid("Некорректный статус")
            return self.job_status(request_id, brief=params.get("brief", False))
        if method == "JOB_REPORT":
            return self.job_report(request_id, params)
        if method == "JOB_STOP":
            return self.job_stop(request_id, params)
        if method == "JOB_APPROVE":
            approval_id, allow = params.get("approvalId"), params.get("allow")
            if not isinstance(approval_id, str) or not isinstance(allow, bool):
                raise Invalid("Некорректное подтверждение")
            # Keep the stale-approval guard, but fit the read and decision into
            # the watch request deadline. The result is observed by later polls.
            with self.lock:
                pending = self._get("jobs", request_id)
            if pending.get("stop_requested") or pending["state"] == "stopping":
                raise Invalid("Остановка уже запрошена")
            current = self.job_status(request_id, timeout=4)
            if current["state"] != "approval" or current.get("approval", {}).get("id") != approval_id:
                raise Invalid("Это подтверждение больше не действует")
            with self.lock:
                row = self._get("jobs", request_id)
                if row["stop_requested"]:
                    raise Invalid("Остановка уже запрошена")
                if row["state"] != "approval" or row["decision_id"] == approval_id:
                    raise Invalid("Это подтверждение больше не действует")
                run_id = row["run_id"]
                # Record the attempt before I/O. A lost receipt must never let
                # the same approval be posted twice. This is also the decision's
                # linearization point relative to a concurrent stop request.
                self.db.execute(
                    "UPDATE jobs SET decision_id=?,state='submitting',result=?,error='' WHERE id=?",
                    (approval_id, "Решение передаётся Hermes.", request_id))
                self.db.commit()
            state, result, error = "submitting", "Решение передано Hermes.", ""
            try:
                self.hermes.call(f"/v1/runs/{run_id}/approval", {
                    "choice": "once" if allow else "deny", "request_id": approval_id}, timeout=4)
            except HTTPError as exc:
                if exc.code == 409:
                    with self.lock:
                        self.expired_approvals[run_id] = approval_id
                        if len(self.expired_approvals) > 128:
                            self.expired_approvals.pop(next(iter(self.expired_approvals)))
                    result = "Срок разрешения истёк. Ожидаем итог Hermes."
                    self.event("approval_expired", id=request_id)
                elif 400 <= exc.code < 500:
                    state, result, error = "error", "", "Hermes отклонил решение"
                else:
                    state, result, error = "unknown", "", "Ответ о приёме решения потерян. Не повторяйте его."
            except (OSError, ValueError, RuntimeError):
                state, result, error = "unknown", "", "Ответ о приёме решения потерян. Не повторяйте его."
            with self.lock:
                row = self._get("jobs", request_id)
                # A status/stop request may have completed while the approval
                # POST was in flight. Never overwrite that newer observation.
                if (row["state"] not in TERMINAL_JOB_STATES and not row["stop_requested"] and
                        row["state"] == "submitting" and row["decision_id"] == approval_id):
                    self.db.execute("UPDATE jobs SET state=?,result=?,error=? WHERE id=?",
                                    (state, result, error, request_id))
                    self.db.commit()
                    row = self._get("jobs", request_id)
            return self._public(row)
        if method == "SEND_TEXT":
            if set(params) - {"id", "text", "textId", "chatId", "mode"}:
                raise Invalid("Некорректная команда")
            text, text_id = params.get("text"), params.get("textId")
            if text is not None and text_id is not None:
                raise Invalid("Укажите текст или ID расшифровки")
            if text_id is not None:
                text_id = identifier(text_id)
                text = self.transcript(text_id)
            chat_id = params["chatId"] if "chatId" in params else _MISSING
            return self.send(request_id, text, text_id, chat_id=chat_id, mode=params.get("mode", "task"))
        with self.lock:
            # Unsubmitted speech is ephemeral. Accepted jobs are retained independently.
            self.db.execute("DELETE FROM uploads WHERE created<? AND state!='transcribing'", (time.time() - 86400,))
            if method == "AUDIO_CANCEL":
                if set(params) != {"id"}:
                    raise Invalid("Некорректная отмена записи")
                old = self.db.execute("SELECT state FROM uploads WHERE id=?", (request_id,)).fetchone()
                if old is None:
                    self.db.execute(
                        "INSERT INTO uploads(id,total,data,created,state,text,error) "
                        "VALUES (?,0,X'',?,'cancelled','','')",
                        (request_id, time.time()))
                elif old["state"] != "cancelled":
                    self.db.execute(
                        "UPDATE uploads SET total=0,data=X'',created=?,state='cancelled',text='',error='' WHERE id=?",
                        (time.time(), request_id))
                self.db.execute("DELETE FROM text_drafts WHERE source_id=?", (request_id,))
                self.db.commit()
                return {"ok": True, "id": request_id, "state": "cancelled",
                        "receivedBytes": 0, "totalBytes": 0, "text": "",
                        "textOffset": 0, "textLength": 0, "textComplete": True,
                        "error": ""}
            if method == "AUDIO_BEGIN":
                total = params.get("totalBytes")
                if type(total) is not int or not 1 <= total <= MAX_AUDIO:
                    raise Invalid("Запись слишком большая или пуста")
                old = self.db.execute("SELECT total,data,state FROM uploads WHERE id=?", (request_id,)).fetchone()
                if old and old["state"] == "cancelled":
                    raise Invalid("Запись отменена")
                if old and old[0] != total:
                    raise Invalid("ID уже используется для другой записи")
                if not old:
                    count = self.db.execute(
                        "SELECT count(*) FROM uploads WHERE state IN ('uploading','transcribing') OR length(data)>0"
                    ).fetchone()[0]
                    if count >= 4:
                        raise Invalid("Дождитесь обработки предыдущей записи")
                    self.db.execute("INSERT INTO uploads(id,total,data,created,state) VALUES (?,?,X'',?,'uploading')",
                                    (request_id, total, time.time()))
                self.db.commit()
                received = len(old["data"]) if old else 0
                if old and old["state"] in ("transcribing", "ready"):
                    received = old["total"]
                return {"ok": True, "id": request_id, "receivedBytes": received,
                        "totalBytes": total, "chunkBytes": 6144, "encoding": "base64"}
            row = self._get("uploads", request_id)
            if row["state"] == "cancelled":
                if method != "AUDIO_STATUS":
                    raise Invalid("Запись отменена")
            if method in ("AUDIO_CHUNK", "AUDIO_PART"):
                index, data = params.get("index"), params.get("data")
                if method == "AUDIO_PART":
                    offset = params.get("offset")
                    if type(offset) is not int or offset < 0 or offset % 1024 or not isinstance(data, str) or not 1 <= len(data) <= 8192:
                        raise Invalid("Некорректная часть записи")
                    try:
                        chunk = base64.b64decode(data, validate=True)
                    except (ValueError, binascii.Error) as exc:
                        raise Invalid("Повреждённая часть записи") from exc
                    chunk_size = 6144
                else:
                    if type(index) is not int or index < 0 or not isinstance(data, list) or not 1 <= len(data) <= 1024:
                        raise Invalid("Некорректная часть записи")
                    if any(type(x) is not int or not 0 <= x <= 255 for x in data):
                        raise Invalid("Повреждённая часть записи")
                    chunk, offset = bytes(data), index * 1024
                    chunk_size = 1024
                existing = bytes(row["data"])
                if offset + len(chunk) > row["total"]:
                    raise Invalid("Запись превышает заявленный размер")
                expected_size = min(chunk_size, row["total"] - offset)
                if not chunk or len(chunk) != expected_size:
                    raise Invalid("Неполная часть записи")
                if offset < len(existing):
                    if existing[offset:offset + len(chunk)] != chunk:
                        raise Invalid("Повтор отличается от принятой части")
                elif offset != len(existing):
                    raise Invalid("Нарушен порядок частей")
                else:
                    if row["state"] != "uploading":
                        raise Invalid("Запись уже закрыта")
                    self.db.execute("UPDATE uploads SET data=? WHERE id=?", (existing + chunk, request_id))
                self.db.commit()
                return {"ok": True, "id": request_id,
                        "receivedBytes": max(len(existing), offset + len(chunk)),
                        "totalBytes": row["total"]}
            if method == "AUDIO_FINISH":
                if row["state"] in ("uploading", "error"):
                    if len(row["data"]) != row["total"]:
                        raise Invalid("Запись передана не полностью")
                    self.db.execute("UPDATE uploads SET state='transcribing',error='' WHERE id=?", (request_id,))
                    self.db.commit()
                    self.event("upload_complete", id=request_id, bytes=row["total"], ms=round((time.time() - row["created"]) * 1000))
                    self.speech.submit(self._transcribe, request_id)
                    row["state"] = "transcribing"
                return {"ok": True, "id": request_id, "state": row["state"],
                        "receivedBytes": row["total"], "totalBytes": row["total"]}
            if method == "AUDIO_STATUS":
                offset = params.get("textOffset", 0)
                limit = params.get("textLimit", TEXT_PAGE_DEFAULT)
                if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= TEXT_PAGE_MAX:
                    raise Invalid("Некорректная страница расшифровки")
                if row["state"] == "cancelled":
                    return {"ok": True, "id": request_id, "state": "cancelled",
                            "receivedBytes": 0, "totalBytes": 0, "text": "",
                            "textOffset": 0, "textLength": 0, "textComplete": True,
                            "error": ""}
                text = row["text"] if row["state"] == "ready" else ""
                if offset > len(text):
                    raise Invalid("Страница за пределами расшифровки")
                page = text[offset:offset + limit]
                received = len(row["data"])
                if row["state"] in ("transcribing", "ready"):
                    received = row["total"]
                return {"ok": True, "id": row["id"], "state": row["state"],
                        "error": row["error"], "receivedBytes": received,
                        "totalBytes": row["total"], "text": page,
                        "textOffset": offset, "textLength": len(text),
                        "textComplete": offset + len(page) == len(text)}
        raise Invalid("Неизвестная команда")

    @staticmethod
    def _job_summary(row):
        text = row.get("full_result") or row.get("result") or row.get("error") or row.get("text") or ""
        return " ".join(str(text).split())[:JOB_SUMMARY]

    def _chat(self, chat_id):
        row = self.db.execute("SELECT * FROM chats WHERE id=?", (chat_id,)).fetchone()
        if row is None:
            raise Invalid("Чат не найден")
        return dict(row)

    def chat_list(self, params):
        if set(params) - {"offset", "limit", "archived"}:
            raise Invalid("Некорректный список чатов")
        offset, limit, archived = params.get("offset", 0), params.get("limit", 10), params.get("archived", False)
        if (type(offset) is not int or not 0 <= offset <= 2**53 - 1 or
                type(limit) is not int or not 1 <= limit <= 10 or type(archived) is not bool):
            raise Invalid("Некорректный список чатов")
        with self.lock:
            active_row = self.db.execute(
                "SELECT id FROM jobs WHERE state IN ('queued','submitting','running','approval','unknown','stopping') "
                "ORDER BY created DESC,id DESC LIMIT 1").fetchone()
        if active_row is not None:
            self.job_status(active_row["id"])
        clause = "archived_at IS NOT NULL" if archived else "archived_at IS NULL"
        with self.lock:
            rows = self.db.execute(
                f"SELECT * FROM chats WHERE {clause} ORDER BY updated DESC,id DESC LIMIT ? OFFSET ?",
                (limit + 1, offset)).fetchall()
            active = self.db.execute(
                "SELECT id,chat_id,state,mode FROM jobs WHERE state IN "
                "('queued','submitting','running','approval','unknown','stopping') "
                "ORDER BY created DESC,id DESC LIMIT 1").fetchone()
            chats = []
            for row in rows[:limit]:
                latest = self.db.execute(
                    "SELECT * FROM jobs WHERE chat_id=? AND deleted_at IS NULL "
                    "ORDER BY created DESC,id DESC LIMIT 1", (row["id"],)).fetchone()
                chats.append({
                    "id": row["id"], "title": row["title"], "updated": row["updated"],
                    "archived": row["archived_at"] is not None,
                    "latestJob": None if latest is None else {
                        "id": latest["id"], "state": latest["state"],
                        "summary": self._job_summary(dict(latest))[:120],
                        "mode": latest["mode"] or "task"},
                })
        active_job = None if active is None else {
            "id": active["id"], "chatId": active["chat_id"] or LEGACY_CHAT_ID,
            "state": active["state"], "mode": active["mode"] or "task"}
        return {"ok": True, "chats": chats,
                "nextOffset": offset + limit if len(rows) > limit else None,
                "activeJob": active_job}

    def chat_detail(self, params):
        if set(params) - {"chatId", "offset", "limit"}:
            raise Invalid("Некорректный чат")
        chat_id = chat_identifier(params.get("chatId"))
        offset, limit = params.get("offset", 0), params.get("limit", 5)
        if (type(offset) is not int or not 0 <= offset <= 2**53 - 1 or
                type(limit) is not int or not 1 <= limit <= 5):
            raise Invalid("Некорректный чат")
        with self.lock:
            chat = self._chat(chat_id)
            rows = self.db.execute(
                "SELECT * FROM jobs WHERE chat_id=? AND deleted_at IS NULL "
                "ORDER BY created DESC,id DESC LIMIT ? OFFSET ?", (chat_id, limit + 1, offset)).fetchall()
        return {
            "ok": True,
            "chat": {"id": chat["id"], "title": chat["title"], "archived": chat["archived_at"] is not None},
            "jobs": [self._chat_public(dict(row)) for row in rows[:limit]],
            "nextOffset": offset + limit if len(rows) > limit else None,
        }

    def chat_archive(self, params):
        if set(params) != {"chatId", "archived"} or type(params.get("archived")) is not bool:
            raise Invalid("Некорректный чат")
        chat_id, archived = chat_identifier(params.get("chatId")), params["archived"]
        with self.lock:
            self._chat(chat_id)
            if archived:
                active = self.db.execute(
                    "SELECT 1 FROM jobs WHERE chat_id=? AND state IN "
                    "('queued','submitting','running','approval','unknown','stopping') LIMIT 1",
                    (chat_id,)).fetchone()
                if active:
                    raise Invalid("Активный чат нельзя архивировать")
                self.db.execute("UPDATE chats SET archived_at=COALESCE(archived_at,?) WHERE id=?",
                                (time.time(), chat_id))
            else:
                self.db.execute("UPDATE chats SET archived_at=NULL WHERE id=?", (chat_id,))
            self.db.commit()
        return {"ok": True, "chatId": chat_id, "archived": archived}

    def history_list(self, params):
        if set(params) - {"trash", "offset", "limit"}:
            raise Invalid("Некорректная история")
        trash, offset, limit = params.get("trash", False), params.get("offset", 0), params.get("limit", 3)
        if type(trash) is not bool or type(offset) is not int or not 0 <= offset <= 2**53 - 1 or type(limit) is not int or not 1 <= limit <= 3:
            raise Invalid("Некорректная история")
        deleted_clause = "deleted_at IS NOT NULL" if trash else "deleted_at IS NULL"
        with self.lock:
            rows = self.db.execute(
                f"SELECT id,text,created,state,deleted_at FROM jobs WHERE {deleted_clause} "
                "ORDER BY created DESC,id DESC LIMIT ? OFFSET ?", (limit + 1, offset)).fetchall()
        items = [{"id": row["id"], "text": row["text"][:70], "created": row["created"],
                  "state": row["state"], "deleted": row["deleted_at"] is not None}
                 for row in rows[:limit]]
        return {"ok": True, "items": items, "hasMore": len(rows) > limit}

    def history_detail(self, params):
        if set(params) - {"id", "field", "offset", "limit"}:
            raise Invalid("Некорректная история")
        request_id = identifier(params.get("id"))
        field, offset, limit = params.get("field"), params.get("offset", 0), params.get("limit", 600)
        if field not in ("text", "result") or type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 600:
            raise Invalid("Некорректная история")
        with self.lock:
            row = self._get("jobs", request_id)
        content = (row["text"] if field == "text" else
                   row.get("full_result") or row["result"] or row["error"] or "")
        if offset > len(content):
            raise Invalid("Страница за пределами истории")
        page = content[offset:offset + limit]
        return {"ok": True, "id": request_id, "field": field, "content": page,
                "total": len(content), "offset": offset, "complete": offset + len(page) == len(content),
                "created": row["created"], "state": row["state"], "deleted": row["deleted_at"] is not None}

    def history_set_deleted(self, params):
        if set(params) != {"id", "deleted"} or type(params.get("deleted")) is not bool:
            raise Invalid("Некорректная история")
        request_id, deleted = identifier(params.get("id")), params["deleted"]
        with self.lock:
            row = self._get("jobs", request_id)
            if deleted and row["state"] not in ("completed", "error", "cancelled"):
                raise Invalid("Активную команду нельзя удалить")
            if deleted:
                self.db.execute("UPDATE jobs SET deleted_at=COALESCE(deleted_at,?) WHERE id=?",
                                (time.time(), request_id))
            else:
                self.db.execute("UPDATE jobs SET deleted_at=NULL WHERE id=?", (request_id,))
            self.db.commit()
        return {"ok": True, "id": request_id, "deleted": deleted}

    def history_empty_trash(self, params):
        """Permanently drop trashed finished jobs from the bridge. Hermes keeps its own memory."""
        if params:
            raise Invalid("Некорректная история")
        with self.lock:
            cursor = self.db.execute(
                "DELETE FROM jobs WHERE deleted_at IS NOT NULL AND state IN ('completed','error','cancelled')")
            self.db.commit()
        self.event("history_purged", removed=cursor.rowcount)
        return {"ok": True, "removed": cursor.rowcount}

    def history_current(self, params):
        if params:
            raise Invalid("Некорректная история")
        with self.lock:
            row = self.db.execute("""
                SELECT id FROM jobs WHERE deleted_at IS NULL
                  AND state IN ('queued','submitting','running','approval','unknown','stopping')
                ORDER BY created DESC,id DESC LIMIT 1
            """).fetchone()
        if not row:
            return {"ok": True, "job": None}
        job = self.job_status(row[0])
        return {"ok": True, "job": job if job["state"] in ACTIVE_JOB_STATES else None}

    def transcript(self, text_id):
        text_id = identifier(text_id)
        with self.lock:
            draft = self.db.execute("SELECT * FROM text_drafts WHERE id=?", (text_id,)).fetchone()
            if draft is not None:
                if draft["state"] != "ready" or not draft["text"]:
                    raise Invalid("Исправленный текст ещё не готов")
                return draft["text"]
            row = self._get("uploads", text_id)
        if row["state"] != "ready" or not row["text"]:
            raise Invalid("Расшифровка ещё не готова")
        return row["text"]

    def text_begin(self, params):
        if set(params) != {"id", "sourceId", "textLength"}:
            raise Invalid("Некорректный исправленный текст")
        draft_id = identifier(params.get("id"))
        source_value = params.get("sourceId")
        source_id = "" if source_value is None else identifier(source_value)
        text_length = params.get("textLength")
        if (source_id and draft_id == source_id) or type(text_length) is not int or not 1 <= text_length <= MAX_TEXT_CHARS:
            raise Invalid("Некорректный исправленный текст")
        now = time.time()
        with self.lock:
            old = self.db.execute("SELECT * FROM text_drafts WHERE id=?", (draft_id,)).fetchone()
            if old:
                if old["source_id"] != source_id or old["text_length"] != text_length:
                    raise Invalid("ID уже используется для другого исправленного текста")
                return {"ok": True, "id": draft_id, "state": old["state"],
                        "textLength": old["text_length"], "receivedLength": len(old["text"])}
            if source_id:
                source = self._get("uploads", source_id)
                if source["state"] != "ready" or not source["text"]:
                    raise Invalid("Расшифровка ещё не готова")
            self.db.execute("DELETE FROM text_drafts WHERE updated<?", (now - TEXT_DRAFT_RETENTION,))
            per_source = (self.db.execute(
                "SELECT count(*) FROM text_drafts WHERE source_id=?", (source_id,)).fetchone()[0]
                if source_id else 0)
            recent = self.db.execute("SELECT count(*) FROM text_drafts").fetchone()[0]
            if per_source >= MAX_DRAFTS_PER_SOURCE or recent >= MAX_RECENT_DRAFTS:
                self.db.commit()
                raise Invalid("Слишком много сохранённых исправлений. Повторите позже")
            self.db.execute(
                "INSERT INTO text_drafts(id,source_id,text_length,text,state,created,updated) "
                "VALUES (?,?,?,'','uploading',?,?)",
                (draft_id, source_id, text_length, now, now))
            self.db.commit()
        return {"ok": True, "id": draft_id, "state": "uploading",
                "textLength": text_length, "receivedLength": 0}

    def text_part(self, params):
        if set(params) != {"id", "offset", "text"}:
            raise Invalid("Некорректная часть исправленного текста")
        draft_id = identifier(params.get("id"))
        offset, part = params.get("offset"), params.get("text")
        if type(offset) is not int or offset < 0 or not isinstance(part, str) or not 1 <= len(part) <= MAX_TEXT_PART_CHARS:
            raise Invalid("Некорректная часть исправленного текста")
        try:
            part.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise Invalid("Исправленный текст содержит некорректный Unicode") from exc
        with self.lock:
            row = self._get("text_drafts", draft_id)
            current = row["text"]
            end = offset + len(part)
            if end > row["text_length"]:
                raise Invalid("Исправленный текст превышает заявленную длину")
            if offset < len(current):
                if end > len(current) or current[offset:end] != part:
                    raise Invalid("Повтор отличается от принятой части текста")
            elif offset != len(current):
                raise Invalid("Нарушен порядок частей текста")
            else:
                if row["state"] != "uploading":
                    raise Invalid("Исправленный текст уже закрыт")
                current += part
                self.db.execute("UPDATE text_drafts SET text=?,updated=? WHERE id=?",
                                (current, time.time(), draft_id))
                self.db.commit()
            return {"ok": True, "id": draft_id, "state": row["state"],
                    "textLength": row["text_length"], "receivedLength": len(current)}

    def text_finish(self, params):
        if set(params) != {"id"}:
            raise Invalid("Некорректный исправленный текст")
        draft_id = identifier(params.get("id"))
        with self.lock:
            row = self._get("text_drafts", draft_id)
            if row["state"] == "ready":
                return {"ok": True, "id": draft_id, "state": "ready",
                        "textLength": row["text_length"]}
            text = row["text"]
            if len(text) != row["text_length"]:
                raise Invalid("Исправленный текст передан не полностью")
            if not text.strip():
                raise Invalid("Исправленный текст пуст")
            if any(unicodedata.category(char) in ("Cc", "Cs") and char not in "\n\t" for char in text):
                raise Invalid("Исправленный текст содержит недопустимые символы")
            try:
                text.encode("utf-8")
            except UnicodeEncodeError as exc:
                raise Invalid("Исправленный текст содержит некорректный Unicode") from exc
            self.db.execute("UPDATE text_drafts SET state='ready',updated=? WHERE id=?",
                            (time.time(), draft_id))
            self.db.commit()
        return {"ok": True, "id": draft_id, "state": "ready",
                "textLength": row["text_length"]}

    def save_diagnostic(self, params):
        if set(params) != {"version", "stage", "detail"}:
            raise Invalid("Некорректная диагностика")
        version, stage, detail = params["version"], params["stage"], params["detail"]
        if not isinstance(version, str) or not re.fullmatch(r"[0-9]{1,2}(?:\.[0-9]{1,2}){2}", version):
            raise Invalid("Некорректная версия диагностики")
        if not isinstance(stage, str) or stage not in DIAGNOSTIC_STAGES:
            raise Invalid("Некорректный этап диагностики")
        if not isinstance(detail, str) or not 1 <= len(detail) <= 160:
            raise Invalid("Некорректное описание диагностики")
        try:
            detail.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise Invalid("Некорректное описание диагностики") from exc
        detail = re.sub(r"[\x00-\x1f\x7f]+", " ", detail).strip()
        if not detail:
            raise Invalid("Некорректное описание диагностики")
        record = {"version": version, "stage": stage, "detail": detail,
                  "receivedAt": int(time.time())}
        target = self.state / "last-diagnostic.json"
        temporary = self.state / "last-diagnostic.json.tmp"
        raw = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self.lock:
            with temporary.open("w", encoding="utf-8") as output:
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            temporary.chmod(0o600)
            os.replace(temporary, target)
        return {"ok": True}

    def _transcribe(self, request_id):
        import shutil
        folder = self.state / "audio" / request_id
        started = time.monotonic()
        self.event("asr_start", id=request_id)
        try:
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            with self.lock:
                row = self._get("uploads", request_id)
                if row["state"] == "cancelled":
                    return
                raw = row["data"]
            source = folder / "record.opus"
            source.write_bytes(raw)
            with self.lock:
                if self._get("uploads", request_id)["state"] == "cancelled":
                    return
            result = self.transcriber(source, folder, self.model).strip()
            if not result:
                raise ValueError("Распознавание не вернуло текст")
            result, fixed = normalize(result, self.lexicon)
            if fixed:
                self.event("asr_lexicon", id=request_id, replacements=fixed)
            if len(result) > MAX_TEXT_CHARS:
                raise ValueError("Расшифровка превышает допустимые 30000 символов")
            result.encode("utf-8")
            with self.lock:
                current = self._get("uploads", request_id)
                if current["state"] == "cancelled":
                    return
                self.db.execute("UPDATE uploads SET state='ready',text=?,data=X'' WHERE id=?", (result, request_id))
                self.db.commit()
            self.event("asr_complete", id=request_id, ms=round((time.monotonic() - started) * 1000), chars=len(result))
        except Exception as exc:
            self.event("asr_error", id=request_id, ms=round((time.monotonic() - started) * 1000), error=type(exc).__name__)
            print(f"speech failed: {type(exc).__name__}", flush=True)
            with self.lock:
                current = self.db.execute("SELECT state FROM uploads WHERE id=?", (request_id,)).fetchone()
                if current is None or current["state"] == "cancelled":
                    return
                self.db.execute("UPDATE uploads SET state='error',error=? WHERE id=?",
                                ("Не удалось распознать запись. Запись сохранена, можно повторить распознавание.", request_id))
                self.db.commit()
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    def send(self, request_id, text, text_id=None, *, chat_id=_MISSING, mode="task"):
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
            raise Invalid("Пустая или слишком длинная команда")
        if mode not in JOB_MODES:
            raise Invalid("Некорректный режим команды")
        try:
            text.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise Invalid("Команда содержит некорректный Unicode") from exc
        # Text selected by ID is already immutable and validated by its owner.
        # Keep it byte-for-byte; direct legacy input retains its old trimming.
        if text_id is None:
            text = text.strip()
        if chat_id is _MISSING:
            requested_chat, effective_chat = "__missing__", LEGACY_CHAT_ID
        elif chat_id is None:
            requested_chat, effective_chat = "__new__", request_id
        else:
            requested_chat = effective_chat = chat_identifier(chat_id)
        fingerprint = request_fingerprint(text, text_id, requested_chat, mode)
        with self.lock:
            old = self.db.execute("SELECT * FROM jobs WHERE id=?", (request_id,)).fetchone()
            if old:
                # Rows created before chat routing have no fingerprint. They may
                # only replay through the legacy call shape used by old packages.
                if old["request_fingerprint"]:
                    same = hmac.compare_digest(old["request_fingerprint"], fingerprint)
                else:
                    same = (old["text"] == text and chat_id is _MISSING and mode == "task")
                if not same:
                    raise Invalid("ID уже принят с другими параметрами")
                return self._public(dict(old))
            # A legacy direct command must still match its ASR row exactly. An
            # edited command is accepted only through an immutable ready draft
            # tied to this original audio/job id.
            draft = self.db.execute(
                "SELECT source_id,state,text FROM text_drafts WHERE id=?", (text_id,)).fetchone() if text_id else None
            if draft:
                bound = (draft["source_id"] == request_id if draft["source_id"] else text_id == request_id)
                if not bound or draft["state"] != "ready" or draft["text"] != text:
                    raise Invalid("Исправленный текст не соответствует этой записи")
            else:
                speech_id = text_id or request_id
                speech = self.db.execute("SELECT state,text FROM uploads WHERE id=?", (speech_id,)).fetchone()
                if text_id and speech is None:
                    raise Invalid("Текст команды не найден")
                if speech and (speech["state"] != "ready" or speech["text"] != text):
                    raise Invalid("Текст не соответствует распознанной записи")
            active = self.db.execute(
                "SELECT count(*) FROM jobs WHERE state IN "
                "('queued','submitting','running','approval','unknown','stopping')").fetchone()[0]
            if active:
                raise Invalid("Сначала дождитесь результата предыдущей команды")
            now = time.time()
            if chat_id is None:
                if self.db.execute("SELECT 1 FROM chats WHERE id=?", (effective_chat,)).fetchone():
                    raise Invalid("ID уже используется другим чатом")
                session_key = f"musafer-watch-chat-{effective_chat}"
                self.db.execute(
                    "INSERT INTO chats(id,title,session_key,created,updated) VALUES (?,?,?,?,?)",
                    (effective_chat, chat_title(text), session_key, now, now))
            elif chat_id is _MISSING:
                chat = self.db.execute("SELECT * FROM chats WHERE id=?", (LEGACY_CHAT_ID,)).fetchone()
                if chat is None:
                    self.db.execute(
                        "INSERT INTO chats(id,title,session_key,created,updated) VALUES (?,?,?,?,?)",
                        (LEGACY_CHAT_ID, chat_title(text), LEGACY_SESSION_KEY, now, now))
                    session_key = LEGACY_SESSION_KEY
                else:
                    if chat["archived_at"] is not None:
                        raise Invalid("Чат находится в архиве")
                    session_key = chat["session_key"]
            else:
                chat = self._chat(effective_chat)
                if chat["archived_at"] is not None:
                    raise Invalid("Чат находится в архиве")
                session_key = chat["session_key"]
            self.db.execute(
                "INSERT INTO jobs(id,text,created,state,chat_id,mode,source_text_id,request_fingerprint) "
                "VALUES (?,?,?,'queued',?,?,?,?)",
                (request_id, text, now, effective_chat, mode, text_id or "", fingerprint))
            self.db.execute("UPDATE chats SET updated=? WHERE id=?", (now, effective_chat))
            self.db.commit()
            self.worker.submit(self._submit, request_id, text, session_key, mode)
            return self._public(self._get("jobs", request_id))

    def _submit(self, request_id, text, session_key, mode):
        started = time.monotonic()
        with self.lock:
            row = self._get("jobs", request_id)
            if row["state"] != "queued" or row["stop_requested"]:
                return
            self.db.execute("UPDATE jobs SET state='submitting' WHERE id=?", (request_id,))
            self.db.commit()
        try:
            instructions = RESEARCH_INSTRUCTIONS if mode == "research" else INSTRUCTIONS
            response = self.hermes.call(
                "/v1/runs", {"input": text, "instructions": instructions}, request_id,
                session_key=session_key)
            self.event("hermes_submitted", id=request_id, ms=round((time.monotonic() - started) * 1000))
            run_id = response.get("run_id")
            if not isinstance(run_id, str) or not re.fullmatch(r"run_[0-9a-f]{32}", run_id):
                raise RuntimeError("Invalid run id")
            with self.lock:
                # A run id confirms receipt, not that an agent has started work.
                current = self._get("jobs", request_id)
                if current["state"] in TERMINAL_JOB_STATES:
                    return
                state = "stopping" if current["stop_requested"] else "queued"
                self.db.execute("UPDATE jobs SET state=?,run_id=? WHERE id=?", (state, run_id, request_id))
                self.db.commit()
                should_stop = bool(current["stop_requested"])
            if should_stop:
                self._request_stop(request_id, run_id)
        except Exception as exc:
            # A timeout can follow acceptance. Never turn a lost receipt into a duplicate run.
            certain_rejection = isinstance(exc, HTTPError) and 400 <= exc.code < 500
            with self.lock:
                current = self._get("jobs", request_id)
                if current["state"] not in TERMINAL_JOB_STATES:
                    self.db.execute("UPDATE jobs SET state=?,error=? WHERE id=?", (
                        "error" if certain_rejection else "unknown",
                        "Hermes отклонил команду" if certain_rejection else "Ответ о приёме потерян. Не отправляйте команду повторно.", request_id))
                    self.db.commit()
            self._announce(request_id, "error" if certain_rejection else "unknown", error="Hermes отклонил команду")

    @classmethod
    def _public(cls, row):
        text = row["text"]
        report = row.get("full_result") or row.get("result") or row.get("error") or ""
        return {"ok": True, "id": row["id"], "text": text[:JOB_TEXT_PREVIEW],
                "textLength": len(text), "textComplete": len(text) <= JOB_TEXT_PREVIEW,
                **{k: row[k] for k in ("state", "result", "error")},
                "chatId": row.get("chat_id") or LEGACY_CHAT_ID,
                "mode": row.get("mode") or "task",
                "summary": cls._job_summary(row),
                "reportLength": len(report),
                "reportTruncated": bool(row.get("report_truncated")),
                "stopRequested": bool(row.get("stop_requested"))}

    @classmethod
    def _chat_public(cls, row):
        answer = cls._public(row)
        answer["text"] = answer["text"][:160]
        answer["textComplete"] = answer["textLength"] <= 160
        answer["result"] = ""
        answer["summary"] = answer["summary"][:160]
        return answer

    @staticmethod
    def _brief_status(answer, brief):
        if not brief or "approval" in answer:
            return answer
        answer["text"] = answer["text"][:160]
        answer["textComplete"] = answer["textLength"] <= 160
        answer["result"] = answer["summary"][:JOB_SUMMARY]
        return answer

    def job_report(self, request_id, params):
        if set(params) - {"id", "offset", "limit"}:
            raise Invalid("Некорректный отчёт")
        offset, limit = params.get("offset", 0), params.get("limit", 1000)
        if (type(offset) is not int or offset < 0 or type(limit) is not int or
                not 1 <= limit <= 1000):
            raise Invalid("Некорректный отчёт")
        with self.lock:
            row = self._get("jobs", request_id)
        report = row.get("full_result") or row.get("result") or row.get("error") or ""
        if offset > len(report):
            raise Invalid("Страница за пределами отчёта")
        page = report[offset:offset + limit]
        next_offset = offset + len(page)
        return {"ok": True, "id": request_id, "text": page, "textLength": len(report),
                "offset": offset, "nextOffset": next_offset if next_offset < len(report) else None,
                "truncated": bool(row.get("report_truncated"))}

    @staticmethod
    def _remote_state(remote_status):
        return {
            "queued": "queued", "submitting": "submitting", "running": "running",
            "stopping": "stopping", "completed": "completed", "failed": "error",
            "cancelled": "cancelled", "interrupted": "error",
            "waiting_for_approval": "approval",
        }.get(remote_status)

    def _apply_remote(self, request_id, remote):
        if not isinstance(remote, dict):
            return None
        mapped = self._remote_state(remote.get("status"))
        if mapped is None:
            return None
        output = str(remote.get("output") or "")
        full_result = output[:JOB_REPORT_MAX]
        truncated = len(output) > JOB_REPORT_MAX
        result = output[:JOB_RESULT_PREVIEW]
        error = str(remote.get("error") or "")[:500]
        with self.lock:
            row = self._get("jobs", request_id)
            # Network responses can complete out of order. A terminal state is
            # monotonic, and a stop request fences every later active response.
            if row["state"] in TERMINAL_JOB_STATES:
                return row
            if row["stop_requested"] and mapped in ("queued", "submitting", "running", "approval"):
                mapped = "stopping"
            previous = row["state"]
            self.db.execute(
                "UPDATE jobs SET state=?,result=?,full_result=?,report_truncated=?,error=? WHERE id=?",
                (mapped, result, full_result, int(truncated), error, request_id))
            self.db.commit()
            row = self._get("jobs", request_id)
        if previous != mapped:
            self.event("job_state", id=request_id, state=mapped, previous=previous,
                       ms=round((time.time() - row["created"]) * 1000))
        return row

    def job_stop(self, request_id, params):
        if set(params) != {"id"}:
            raise Invalid("Некорректная остановка")
        with self.lock:
            row = self._get("jobs", request_id)
            if row["state"] in ("completed", "error", "cancelled") or row["stop_requested"]:
                return self._public(row)
            if row["state"] == "queued" and not row["run_id"]:
                self.db.execute(
                    "UPDATE jobs SET state='cancelled',stop_requested=1,result=?,error='' WHERE id=?",
                    ("Остановлено до отправки Hermes.", request_id))
                self.db.commit()
                return self._public(self._get("jobs", request_id))
            state = "stopping" if row["state"] != "unknown" or row["run_id"] else "unknown"
            error = "" if row["run_id"] or row["state"] == "submitting" else (
                "Нет идентификатора Hermes для подтверждения остановки.")
            self.db.execute(
                "UPDATE jobs SET state=?,stop_requested=1,error=? WHERE id=?",
                (state, error, request_id))
            self.db.commit()
            row = self._get("jobs", request_id)
        return self._request_stop(request_id, row["run_id"]) if row["run_id"] else self._public(row)

    def _request_stop(self, request_id, run_id):
        try:
            remote = self.hermes.call(f"/v1/runs/{run_id}/stop", {}, timeout=6)
            applied = self._apply_remote(request_id, remote)
            if applied is None:
                with self.lock:
                    current = self._get("jobs", request_id)
                    if current["state"] not in TERMINAL_JOB_STATES:
                        self.db.execute(
                            "UPDATE jobs SET state='stopping',error=? WHERE id=?",
                            ("Hermes вернул неизвестный статус остановки. Статус обновляется.", request_id))
                        self.db.commit()
            with self.lock:
                row = self._get("jobs", request_id)
            return self._public(row)
        except (OSError, ValueError, RuntimeError):
            with self.lock:
                row = self._get("jobs", request_id)
                if row["state"] not in ("completed", "error", "cancelled"):
                    self.db.execute(
                        "UPDATE jobs SET state='stopping',error=? WHERE id=?",
                        ("Не удалось подтвердить остановку. Статус обновляется.", request_id))
                    self.db.commit()
                row = self._get("jobs", request_id)
            return self._public(row)

    def job_status(self, request_id, timeout=8, brief=False):
        with self.lock:
            row = self._get("jobs", request_id)
        if row["run_id"] and row["state"] in ACTIVE_JOB_STATES:
            try:
                remote = self.hermes.call("/v1/runs/" + row["run_id"], timeout=timeout)
                row = self._apply_remote(request_id, remote)
                if row is None:
                    with self.lock:
                        current = self._get("jobs", request_id)
                        if current["state"] in TERMINAL_JOB_STATES:
                            return self._brief_status(self._public(current), brief)
                        unknown_state = "stopping" if current["stop_requested"] else "unknown"
                        message = "Hermes вернул неизвестный статус. Команда не повторялась."
                        self.db.execute("UPDATE jobs SET state=?,error=? WHERE id=?",
                                        (unknown_state, message, request_id))
                        self.db.commit()
                        current = self._get("jobs", request_id)
                    self._announce(request_id, unknown_state, error=message)
                    return self._brief_status(self._public(current), brief)
                answer = self._public(row)
                if row["state"] == "approval" and not row["stop_requested"]:
                    approval = remote.get("approval") or {}
                    proposal = str(approval.get("command") or approval.get("description") or "")
                    aid = approval.get("request_id")
                    if row["decision_id"] == aid and aid:
                        message = ("Срок разрешения истёк. Ожидаем итог Hermes."
                                   if self.expired_approvals.get(row["run_id"]) == aid else
                                   "Решение уже передавалось Hermes. Повтора не будет.")
                        with self.lock:
                            current = self._get("jobs", request_id)
                            if (current["state"] in TERMINAL_JOB_STATES or
                                    current["stop_requested"]):
                                return self._brief_status(self._public(current), brief)
                            if current["state"] == "approval" and current["decision_id"] == aid:
                                self.db.execute(
                                    "UPDATE jobs SET state='submitting',result=?,error='' WHERE id=?",
                                    (message, request_id))
                                self.db.commit()
                                current = self._get("jobs", request_id)
                        return self._brief_status(self._public(current), brief)
                    # Never approve an unidentified or truncated action from the watch.
                    if isinstance(aid, str) and aid and proposal and len(proposal) <= APPROVAL_TEXT_MAX:
                        answer["approval"] = {"id": aid, "text": proposal}
                    else:
                        self.event("approval_unavailable", id=request_id, chars=len(proposal), identified=bool(aid))
                        answer["result"] = "Не удалось показать полное действие для подтверждения. Оно не одобрено. Статус обновляется автоматически."
                self._announce(request_id, row["state"], answer.get("approval"), row["result"], row["error"])
                return self._brief_status(answer, brief)
            except (OSError, ValueError, RuntimeError):
                with self.lock:
                    current = self._get("jobs", request_id)
                if current["state"] in TERMINAL_JOB_STATES:
                    return self._brief_status(self._public(current), brief)
                answer = {**self._public(current),
                          "error": "Не удалось обновить статус. Команда не отправлялась повторно."}
                return self._brief_status(answer, brief)
        return self._brief_status(self._public(row), brief)


def make_handler(bridge, token):
    class Handler(BaseHTTPRequestHandler):
        server_version = "MusafirBridge/" + VERSION

        def log_message(self, *args):
            pass  # No bearer tokens, dictated text or audio in access logs.

        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def reply(self, status, data):
            raw = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path == "/health":
                self.reply(200, {"ok": True, "service": "musafer-bridge", "version": VERSION, "asr": bridge.speech_status()})
            else:
                self.reply(404, {"ok": False})

        def do_POST(self):
            if self.path != "/rpc":
                return self.reply(404, {"ok": False})
            auth = self.headers.get("Authorization", "")
            if not hmac.compare_digest(auth.encode(), ("Bearer " + token).encode()):
                return self.reply(401, {"ok": False, "error": "Доступ отключён"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_REQUEST_BYTES or self.headers.get("Transfer-Encoding"):
                    raise Invalid("Недопустимый размер запроса")
                if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                    raise Invalid("Требуется JSON")
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict):
                    raise Invalid("Некорректный запрос")
                answer = bridge.rpc(request.get("method"), request.get("params", {}))
                self.reply(200, answer)
            except Invalid as exc:
                self.reply(400, {"ok": False, "error": str(exc)})
            except CliFailure as exc:
                unavailable = exc.code == "runtime_unavailable"
                self.reply(503, {"ok": False, "code": "ORCA_" + exc.code.upper(),
                                 "retryable": not unavailable,
                                 "error": "Откройте Orca на Mac и повторите запрос" if unavailable else
                                 "Orca не успела ответить. Обновите статус на часах."})
            except (ValueError, TypeError):
                self.reply(400, {"ok": False, "error": "Некорректный запрос или операция сейчас недоступна"})
            except Exception as exc:
                print(f"rpc failed: {type(exc).__name__}", flush=True)
                self.reply(503, {"ok": False, "error": "Мусафир на Mac сейчас недоступен"})
    return Handler


if __name__ == "__main__":
    from audio import transcribe, warm_asr, asr_ready, close_asr
    from orca_service import OrcaService
    from orca_projects import OrcaProjects
    from orca_intent import ProjectIntentPlanner
    from orca_trust import FolderTrust
    from notify import Notifier
    from digest import Digest, DEFAULT_TIME as DIGEST_TIME
    from claude_sessions import ClaudeService, NIGHT_TIME
    from watchdog import Watchdog
    from limits import Limits
    from codex_sessions import CodexService
    os.umask(0o077)
    config = json.loads((ROOT / ".local/config.json").read_text())
    os.environ["MUSAFIR_ASR_BACKEND"] = config.get("asrBackend", "parakeet")
    for key, variable in (("parakeetRunner", "MUSAFIR_PARAKEET_RUNNER"),
                          ("parakeetModelDir", "MUSAFIR_PARAKEET_MODEL_DIR")):
        if config.get(key):
            os.environ[variable] = config[key]
    token = config["token"]
    if not isinstance(token, str) or len(token) < 32:
        raise SystemExit("Configure a strong device token first")
    notifier = Notifier(ROOT / ".local", config.get("telegramBotToken"), config.get("telegramChatId"))
    # Without a configured bot there is nothing to deliver and no reason to poll Hermes in the background.
    hook = notifier.notify if notifier.enabled else None
    files = notifier.send_file if notifier.enabled else None
    orca = OrcaService(ROOT / ".local", notify=hook, quick_commands=config.get("quickCommands"))
    # Optional overrides: orcaRoots {"internal": ["/path", "Label"], ...},
    # externalVolumeUUID, externalMount, claudeExecutable. Defaults: one root in ~/Documents/Orca Projects.
    roots = config.get("orcaRoots")
    roots = {key: (value[0], value[1]) for key, value in roots.items()
             if isinstance(value, list) and len(value) == 2 and all(isinstance(x, str) for x in value)
             } if isinstance(roots, dict) else None
    projects = OrcaProjects(ROOT / ".local", orca, model_catalog=config.get("orcaModelCatalog"),
                            roots=roots or None, external_volume_uuid=config.get("externalVolumeUUID"),
                            external_mount=config.get("externalMount"),
                            planner=ProjectIntentPlanner(ROOT / ".local", executable=config.get("claudeExecutable")),
                            trust=FolderTrust(orca), notify=hook, github_owner=config.get("githubOwner"),
                            default_mode=config.get("orcaDefaultMode", "auto"))
    claude = ClaudeService(ROOT / ".local", executable=config.get("claudeExecutable"), notify=hook,
                           timeout=config.get("claudeTimeout", 1200), extra_projects=config.get("claudeProjects"),
                           night_at=config.get("nightTime", NIGHT_TIME), send_file=files, research_dir=config.get("researchDir"),
                           presets=config.get("agentQuickCommands"))
    codex = CodexService(ROOT / ".local", executable=config.get("codexExecutable"), notify=hook,
                         timeout=config.get("codexTimeout", 1200), extra_projects=config.get("codexProjects"),
                         night_at=config.get("nightTime", NIGHT_TIME), send_file=files, research_dir=config.get("researchDir"),
                         presets=config.get("agentQuickCommands"))
    watchdog = Watchdog(ROOT / ".local", notify=hook)
    limits = Limits(ROOT / ".local", claude_executable=config.get("claudeExecutable"), codex_executable=config.get("codexExecutable"))
    service = Bridge(ROOT / ".local", Hermes(config["hermesEnv"]), transcribe,
                     config["model"], orca=orca, projects=projects, claude=claude, codex=codex, watchdog=watchdog, limits=limits,
                     speech_status=lambda: {"backend": os.environ["MUSAFIR_ASR_BACKEND"],
                                            "local": True, "ready": asr_ready()},
                     notify=hook, lexicon=config.get("asrLexicon"))
    notifier.event = service.event
    watchdog.event = service.event
    limits.event = service.event
    watchdog.start()
    service.event("notify_ready", enabled=notifier.enabled)
    digest = Digest(ROOT / ".local", hook, config.get("digestTime", DIGEST_TIME), event=service.event)
    digest.start()
    service.event("digest_ready", enabled=digest.enabled, at=config.get("digestTime", DIGEST_TIME))
    def warm_speech():
        started = time.monotonic()
        try:
            warm_asr()
            service.event("asr_warmed", ms=round((time.monotonic() - started) * 1000), backend=os.environ["MUSAFIR_ASR_BACKEND"])
        except Exception as exc:
            service.event("asr_warm_error", error=type(exc).__name__)
    service.speech.submit(warm_speech)
    server = ThreadingHTTPServer(("127.0.0.1", 8768), make_handler(service, token))
    print("Musafer bridge listening on 127.0.0.1:8768", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        service.close()
        digest.close()
        notifier.close()
        close_asr()
