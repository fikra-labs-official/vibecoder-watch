"""Private, single-device bridge. Hermes and its credentials stay on loopback."""
from __future__ import annotations

import base64
import binascii
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
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from lexicon import compile_rules, normalize

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.7.12"
ID = re.compile(r"^[0-9]{1,16}-[0-9]{1,8}$")
MAX_AUDIO = 8 * 1024 * 1024
MAX_TEXT_CHARS = 30_000
TEXT_PAGE_DEFAULT = 1_000
TEXT_PAGE_MAX = 2_000
JOB_TEXT_PREVIEW = 1_000
APPROVAL_TEXT_MAX = 12_000
MAX_REQUEST_BYTES = 512 * 1024
ACTIVE_JOB_STATES = ("queued", "submitting", "running", "approval", "unknown")
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


class Invalid(ValueError):
    pass


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise Invalid("Некорректный ID")
    return value


class Hermes:
    def __init__(self, env_path):
        self.env_path = Path(env_path)

    def call(self, path, body=None, request_id=None):
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
            headers["X-Hermes-Session-Key"] = "musafer-watch"
        req = Request("http://127.0.0.1:8642" + path,
                      data=None if body is None else json.dumps(body).encode(), headers=headers)
        with urlopen(req, timeout=12) as response:
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
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, text TEXT, created REAL, state TEXT,
                run_id TEXT DEFAULT '', result TEXT DEFAULT '', error TEXT DEFAULT '');
        """)
        if "deleted_at" not in {row[1] for row in self.db.execute("PRAGMA table_info(jobs)")}:
            self.db.execute("ALTER TABLE jobs ADD COLUMN deleted_at REAL")
        self.db.execute("UPDATE jobs SET state='unknown', error='Мост был перезапущен во время отправки. Не повторяйте команду.' WHERE state='submitting'")
        self.db.execute("UPDATE jobs SET state='error', error='Перезапуск до отправки. Команда не отправлена.' WHERE state='queued'")
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
                        "SELECT id FROM jobs WHERE state IN ('running','approval') AND run_id!=''").fetchall()
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
            if method in ("AUDIO_BEGIN", "AUDIO_FINISH", "JOB_APPROVE", "SEND_TEXT", "CLAUDE_SEND", "CLAUDE_STOP", "CODEX_SEND", "CODEX_STOP") or (
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
            self.hermes.call("/health")
            return {"ok": True, "agent": "Мусафир", "voice": self.model.exists(), "version": VERSION, "asr": self.speech_status()}
        if method == "LATEST_JOB":
            with self.lock:
                row = self.db.execute("""
                    SELECT id FROM jobs WHERE deleted_at IS NULL
                    ORDER BY CASE WHEN state IN ('queued','submitting','running','approval','unknown')
                                  THEN 0 ELSE 1 END,
                             created DESC, id DESC LIMIT 1
                """).fetchone()
            return {"ok": True, "job": self.job_status(row[0]) if row else None}
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
        request_id = identifier(params.get("id"))
        if method == "JOB_STATUS":
            return self.job_status(request_id)
        if method == "JOB_APPROVE":
            approval_id, allow = params.get("approvalId"), params.get("allow")
            if not isinstance(approval_id, str) or not isinstance(allow, bool):
                raise Invalid("Некорректное подтверждение")
            current = self.job_status(request_id)
            if current["state"] != "approval" or current.get("approval", {}).get("id") != approval_id:
                raise Invalid("Это подтверждение больше не действует")
            with self.lock:
                run_id = self._get("jobs", request_id)["run_id"]
            try:
                self.hermes.call(f"/v1/runs/{run_id}/approval", {
                    "choice": "once" if allow else "deny", "request_id": approval_id})
            except HTTPError as exc:
                if exc.code != 409:
                    raise
                with self.lock:
                    self.expired_approvals[run_id] = approval_id
                    if len(self.expired_approvals) > 128:
                        self.expired_approvals.pop(next(iter(self.expired_approvals)))
                self.event("approval_expired", id=request_id)
            return self.job_status(request_id)
        if method == "SEND_TEXT":
            text, text_id = params.get("text"), params.get("textId")
            if text is not None and text_id is not None:
                raise Invalid("Укажите текст или ID расшифровки")
            if text_id is not None:
                text_id = identifier(text_id)
                with self.lock:
                    speech = self._get("uploads", text_id)
                if speech["state"] != "ready" or not speech["text"]:
                    raise Invalid("Расшифровка ещё не готова")
                text = speech["text"]
            return self.send(request_id, text, text_id)
        with self.lock:
            # Unsubmitted speech is ephemeral. Accepted jobs are retained independently.
            self.db.execute("DELETE FROM uploads WHERE created<? AND state!='transcribing'", (time.time() - 86400,))
            if method == "AUDIO_BEGIN":
                total = params.get("totalBytes")
                if type(total) is not int or not 1 <= total <= MAX_AUDIO:
                    raise Invalid("Запись слишком большая или пуста")
                old = self.db.execute("SELECT total,data,state FROM uploads WHERE id=?", (request_id,)).fetchone()
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
        content = row["text"] if field == "text" else row["result"] or row["error"] or ""
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
            if deleted and row["state"] not in ("completed", "error"):
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
                "DELETE FROM jobs WHERE deleted_at IS NOT NULL AND state IN ('completed','error')")
            self.db.commit()
        self.event("history_purged", removed=cursor.rowcount)
        return {"ok": True, "removed": cursor.rowcount}

    def history_current(self, params):
        if params:
            raise Invalid("Некорректная история")
        with self.lock:
            row = self.db.execute("""
                SELECT id FROM jobs WHERE deleted_at IS NULL
                  AND state IN ('queued','submitting','running','approval','unknown')
                ORDER BY created DESC,id DESC LIMIT 1
            """).fetchone()
        if not row:
            return {"ok": True, "job": None}
        job = self.job_status(row[0])
        return {"ok": True, "job": job if job["state"] in ACTIVE_JOB_STATES else None}

    def transcript(self, text_id):
        with self.lock:
            row = self._get("uploads", identifier(text_id))
        if row["state"] != "ready" or not row["text"]:
            raise Invalid("Расшифровка ещё не готова")
        return row["text"]

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
                raw = self._get("uploads", request_id)["data"]
            source = folder / "record.opus"
            source.write_bytes(raw)
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
                self.db.execute("UPDATE uploads SET state='ready',text=?,data=X'' WHERE id=?", (result, request_id))
                self.db.commit()
            self.event("asr_complete", id=request_id, ms=round((time.monotonic() - started) * 1000), chars=len(result))
        except Exception as exc:
            self.event("asr_error", id=request_id, ms=round((time.monotonic() - started) * 1000), error=type(exc).__name__)
            print(f"speech failed: {type(exc).__name__}", flush=True)
            with self.lock:
                self.db.execute("UPDATE uploads SET state='error',error=? WHERE id=?",
                                ("Не удалось распознать запись. Запись сохранена, можно повторить распознавание.", request_id))
                self.db.commit()
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    def send(self, request_id, text, text_id=None):
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
            raise Invalid("Пустая или слишком длинная команда")
        try:
            text.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise Invalid("Команда содержит некорректный Unicode") from exc
        text = text.strip()
        with self.lock:
            old = self.db.execute("SELECT * FROM jobs WHERE id=?", (request_id,)).fetchone()
            if old:
                if old["text"] != text:
                    raise Invalid("ID уже принят с другим текстом")
                return self._public(dict(old))
            # A captured command must match the transcription shown for confirmation.
            speech_id = text_id or request_id
            speech = self.db.execute("SELECT state,text FROM uploads WHERE id=?", (speech_id,)).fetchone()
            if speech and (speech["state"] != "ready" or speech["text"] != text):
                raise Invalid("Текст не соответствует распознанной записи")
            active = self.db.execute("SELECT count(*) FROM jobs WHERE state IN ('queued','submitting','running','approval','unknown')").fetchone()[0]
            if active:
                raise Invalid("Сначала дождитесь результата предыдущей команды")
            self.db.execute("INSERT INTO jobs(id,text,created,state) VALUES (?,?,?,'queued')", (request_id, text, time.time()))
            self.db.commit()
            self.worker.submit(self._submit, request_id, text)
            return self._public(self._get("jobs", request_id))

    def _submit(self, request_id, text):
        started = time.monotonic()
        with self.lock:
            self.db.execute("UPDATE jobs SET state='submitting' WHERE id=?", (request_id,))
            self.db.commit()
        try:
            response = self.hermes.call("/v1/runs", {"input": text, "instructions": INSTRUCTIONS}, request_id)
            self.event("hermes_submitted", id=request_id, ms=round((time.monotonic() - started) * 1000))
            run_id = response.get("run_id")
            if not isinstance(run_id, str) or not re.fullmatch(r"run_[0-9a-f]{32}", run_id):
                raise RuntimeError("Invalid run id")
            with self.lock:
                self.db.execute("UPDATE jobs SET state='running',run_id=? WHERE id=?", (run_id, request_id))
                self.db.commit()
        except Exception as exc:
            # A timeout can follow acceptance. Never turn a lost receipt into a duplicate run.
            certain_rejection = isinstance(exc, HTTPError) and 400 <= exc.code < 500
            with self.lock:
                self.db.execute("UPDATE jobs SET state=?,error=? WHERE id=?", (
                    "error" if certain_rejection else "unknown",
                    "Hermes отклонил команду" if certain_rejection else "Ответ о приёме потерян. Не отправляйте команду повторно.", request_id))
                self.db.commit()
            self._announce(request_id, "error" if certain_rejection else "unknown", error="Hermes отклонил команду")

    @staticmethod
    def _public(row):
        text = row["text"]
        return {"ok": True, "id": row["id"], "text": text[:JOB_TEXT_PREVIEW],
                "textLength": len(text), "textComplete": len(text) <= JOB_TEXT_PREVIEW,
                **{k: row[k] for k in ("state", "result", "error")}}

    def job_status(self, request_id):
        with self.lock:
            row = self._get("jobs", request_id)
        if row["run_id"] and row["state"] in ("running", "approval"):
            try:
                remote = self.hermes.call("/v1/runs/" + row["run_id"])
                states = {"completed": "completed", "failed": "error", "cancelled": "error", "interrupted": "error", "waiting_for_approval": "approval"}
                previous = row["state"]
                row["state"] = states.get(remote.get("status"), "running")
                if previous != row["state"]:
                    self.event("job_state", id=request_id, state=row["state"], previous=previous, ms=round((time.time() - row["created"]) * 1000))
                row["result"] = str(remote.get("output") or "")[:6000]
                row["error"] = str(remote.get("error") or "")[:500]
                with self.lock:
                    self.db.execute("UPDATE jobs SET state=?,result=?,error=? WHERE id=?",
                                    (row["state"], row["result"], row["error"], request_id))
                    self.db.commit()
                answer = self._public(row)
                if row["state"] == "approval":
                    approval = remote.get("approval") or {}
                    proposal = str(approval.get("command") or approval.get("description") or "")
                    aid = approval.get("request_id")
                    if self.expired_approvals.get(row["run_id"]) == aid and aid:
                        return {**answer, "state": "running", "result": "Срок разрешения истёк. Ожидаем итог Hermes."}
                    # Never approve an unidentified or truncated action from the watch.
                    if isinstance(aid, str) and aid and proposal and len(proposal) <= APPROVAL_TEXT_MAX:
                        answer["approval"] = {"id": aid, "text": proposal}
                    else:
                        self.event("approval_unavailable", id=request_id, chars=len(proposal), identified=bool(aid))
                        answer["result"] = "Не удалось показать полное действие для подтверждения. Оно не одобрено. Статус обновляется автоматически."
                self._announce(request_id, row["state"], answer.get("approval"), row["result"], row["error"])
                return answer
            except (OSError, ValueError, RuntimeError):
                return {**self._public(row), "error": "Не удалось обновить статус. Команда не отправлялась повторно."}
        return self._public(row)


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
