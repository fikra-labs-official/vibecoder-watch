"""Codex from the watch: ``codex exec`` in the owner's project folders.

Same durable job model as ClaudeService. Projects and sessions come from
``~/.codex/sessions/**/rollout-*.jsonl`` (``session_meta`` carries cwd and id).
A new task runs ``codex exec --json`` in the project; a continuation runs
``codex exec resume <id> --json``. Modes map to Codex config overrides, so the
same flags work for both forms; approvals are never left waiting on a human.
"""
from __future__ import annotations

import html
import json
from pathlib import Path
import re
import time

from claude_sessions import ClaudeService, SESSION_ID, _first_records

CODEX_MODES = (
    ("auto", "Авто", ("-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"')),
    ("read-only", "Только чтение", ("-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"')),
    ("bypass", "Без ограничений", ("--dangerously-bypass-approvals-and-sandbox",)),
)
ROLLOUT = re.compile(r"^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")
HINT = ("Ответ прочитают с экрана часов: коротко и по делу, до 1500 символов, "
        "без таблиц и длинных списков.")
SCAN_FILES = 400
# Codex prepends injected context as user-role messages; they are not the owner's request.
INJECTED = ("# AGENTS.md", "<environment_context>", "<send_user_message", "<user_instructions>",
            "<turn_context>", "<permissions", "<memory", "<skill", "<INSTRUCTIONS>")


def user_label(text):
    """First meaningful line of an owner message; '' for injected wrappers."""
    stripped = html.unescape(text).lstrip()
    if stripped.startswith(INJECTED):
        return ""
    for line in stripped.splitlines():
        line = line.strip()
        if line and not line.startswith(("#", "<", "```")):
            return line
    return ""


class CodexService(ClaudeService):
    KINDS = ("task", "research")  # no deep-research workflow in codex exec
    PREFIX = "CODEX"
    LABEL = "Codex"
    KEY = "codex"
    DB_NAME = "codex.sqlite3"
    MODES = CODEX_MODES
    DEFAULT_MODE = "auto"
    EXECUTABLE = "codex"
    EXECUTABLE_FALLBACK = str(Path.home() / ".local/bin/codex")
    PROJECTS_ROOT = Path.home() / ".codex/sessions"

    def _rollouts(self):
        try:
            files = sorted(self.projects_root.rglob("rollout-*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)
        except OSError:
            return []
        return files[:SCAN_FILES]

    @staticmethod
    def _meta(path):
        for record in _first_records(path, limit=3):
            if record.get("type") == "session_meta" and isinstance(record.get("payload"), dict):
                payload = record["payload"]
                session = payload.get("id") or payload.get("session_id")
                cwd = payload.get("cwd")
                if isinstance(session, str) and SESSION_ID.fullmatch(session) and isinstance(cwd, str) and cwd:
                    return session, cwd
                return None
        return None

    def projects(self):
        now = time.monotonic()
        if now - self._catalog[0] < 20.0:
            return self._catalog[1]
        found = {}
        for path in self._rollouts():
            meta = self._meta(path)
            if not meta:
                continue
            _, cwd = meta
            if cwd in found or not Path(cwd).is_dir():
                continue
            found[cwd] = {"id": cwd, "label": Path(cwd).name or cwd, "updated": path.stat().st_mtime, "dir": str(self.projects_root)}
        for extra in self.extra:
            found.setdefault(extra, {"id": extra, "label": Path(extra).name or extra, "updated": 0, "dir": ""})
        items = sorted(found.values(), key=lambda item: item["updated"], reverse=True)
        self._catalog = (now, items)
        return items

    def sessions(self, project):
        items = []
        for path in self._rollouts():
            meta = self._meta(path)
            if not meta or meta[1] != project["id"]:
                continue
            label = ""
            for record in _first_records(path, limit=400):
                payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
                if record.get("type") == "response_item" and payload.get("role") == "user":
                    for part in payload.get("content") or []:
                        if isinstance(part, dict) and isinstance(part.get("text"), str):
                            label = user_label(part["text"])
                            if label:
                                break
                if label:
                    break
            items.append({"id": meta[0], "label": " ".join(label.split())[:60] or meta[0][:8],
                          "updated": path.stat().st_mtime})
            if len(items) == 30:
                break
        return items

    def _launch_argv(self, job):
        if job["kind"] == "deep":
            raise ValueError("Большое исследование умеет только Claude")
        if job["kind"] == "research":
            # Live web search, read-only sandbox, nothing to approve.
            return [self.executable, "exec", "-C", job["project"], self._prompt(job), "--json",
                    "-c", 'web_search="live"', "-c", "check_for_update_on_startup=false", "--skip-git-repo-check",
                    "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"']
        flags = next(flags for mode_id, _, flags in self.MODES if mode_id == job["mode"])
        common = ["--json", "-c", "check_for_update_on_startup=false", "--skip-git-repo-check", *flags]
        prompt = job["source_text"]
        if not prompt.endswith(HINT):
            prompt += "\n\n" + HINT
        if job["session_id"]:
            return [self.executable, "exec", "resume", job["session_id"], prompt, *common]
        return [self.executable, "exec", "-C", job["project"], prompt, *common]

    def _parse_output(self, out, err, returncode, denials_note=True):
        session, answer, failures = "", "", []
        for line in out.split("\n"):
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            if event.get("type") == "thread.started" and isinstance(event.get("thread_id"), str):
                if SESSION_ID.fullmatch(event["thread_id"]):
                    session = event["thread_id"]
            item = event.get("item") if isinstance(event.get("item"), dict) else None
            if event.get("type") == "item.completed" and item:
                if item.get("type") == "agent_message" and isinstance(item.get("text"), str):
                    answer = item["text"]
                elif item.get("type") == "error":
                    failures.append(str(item.get("message") or item.get("text") or "ошибка"))
        if returncode != 0 or not answer.strip():
            reason = failures[-1] if failures else " ".join(err.split())[-300:] or f"код {returncode}"
            raise ValueError(reason)
        result = answer.strip()
        return result, session
