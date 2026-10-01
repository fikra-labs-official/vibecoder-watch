"""At-most-once owner notifications through a Telegram bot.

Zepp mirrors iPhone notifications to the watch, so a Telegram message reaches
the wrist even when the watch app is closed. Keys deduplicate one event per
job/state; a failed delivery is logged, never retried, and never raises into
the coordinator or RPC paths.
"""
from __future__ import annotations

import json
from pathlib import Path
import uuid
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen

MAX_TEXT = 3500
MAX_FILE = 5_000_000
KEEP = 2000


def telegram_send(token, chat_id, text):
    request = Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps({"chat_id": chat_id, "text": text,
                         "disable_web_page_preview": True}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=10) as response:
        body = json.load(response)
    if not isinstance(body, dict) or body.get("ok") is not True:
        raise RuntimeError("telegram rejected the message")


def telegram_send_document(token, chat_id, filename, data, caption=""):
    boundary = "musafir" + uuid.uuid4().hex
    def field(name, value):
        return f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8")
    body = (field("chat_id", chat_id) + field("caption", caption[:1000]) +
            (f'--{boundary}\r\nContent-Disposition: form-data; name="document"; filename="{filename}"\r\n'
             f'Content-Type: text/markdown; charset=utf-8\r\n\r\n').encode("utf-8") +
            data + f"\r\n--{boundary}--\r\n".encode("utf-8"))
    request = Request(f"https://api.telegram.org/bot{token}/sendDocument", data=body,
                      headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urlopen(request, timeout=60) as response:
        reply = json.load(response)
    if not isinstance(reply, dict) or reply.get("ok") is not True:
        raise RuntimeError("telegram rejected the document")


class Notifier:
    def __init__(self, state_dir, token=None, chat_id=None, send=None, event=None, send_document=None):
        self.token = token if isinstance(token, str) and token.strip() else None
        self.chat_id = chat_id if isinstance(chat_id, (str, int)) and not isinstance(chat_id, bool) and chat_id else None
        self.enabled = bool(self.token and self.chat_id)
        self.send = send or telegram_send
        self.send_document = send_document or telegram_send_document
        self.event = event or (lambda *args, **fields: None)
        self.lock = threading.Lock()
        state = Path(state_dir)
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(state / "notify.sqlite3", check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS sent(key TEXT PRIMARY KEY, created REAL NOT NULL)")
        self.db.commit()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="notify")

    def notify(self, key, text):
        """Queue one message per key. Returns True only when newly queued."""
        if (not self.enabled or not isinstance(key, str) or not key or
                not isinstance(text, str) or not text.strip()):
            return False
        if not self._claim(key):
            return False
        self.worker.submit(self._deliver, key, text.strip()[:MAX_TEXT])
        return True

    def send_file(self, key, filename, data, caption=""):
        """Queue one document per key (a research report). Returns True only when newly queued."""
        if (not self.enabled or not isinstance(key, str) or not key or not isinstance(filename, str) or
                not filename.strip() or not isinstance(data, bytes) or not data or len(data) > MAX_FILE):
            return False
        if not self._claim(key):
            return False
        self.worker.submit(self._deliver_file, key, filename.strip()[:120], data, str(caption or ""))
        return True

    def _claim(self, key):
        with self.lock:
            if self.db.execute("SELECT 1 FROM sent WHERE key=?", (key,)).fetchone():
                return False
            self.db.execute("INSERT INTO sent(key,created) VALUES(?,?)", (key, time.time()))
            self.db.execute("DELETE FROM sent WHERE key NOT IN "
                            "(SELECT key FROM sent ORDER BY created DESC, key DESC LIMIT ?)", (KEEP,))
            self.db.commit()
            return True

    def _deliver_file(self, key, filename, data, caption):
        try:
            self.send_document(self.token, self.chat_id, filename, data, caption)
            self.event("notify_sent", key=key)
        except Exception as exc:
            self.event("notify_error", key=key, error=type(exc).__name__)

    def _deliver(self, key, text):
        try:
            self.send(self.token, self.chat_id, text)
            self.event("notify_sent", key=key)
        except Exception as exc:
            self.event("notify_error", key=key, error=type(exc).__name__)

    def close(self):
        self.worker.shutdown(wait=True)
        with self.lock:
            self.db.close()
