"""Durable, bounded creation of Orca folders and agent terminals."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import plistlib
import re
import secrets
import shlex
import shutil
import sqlite3
import subprocess
import threading
import time
import tomllib
import unicodedata
from concurrent.futures import ThreadPoolExecutor


OPERATION_ID = re.compile(r"^[0-9]{1,16}-[0-9]{1,8}$")
MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$")
# An external disk root is opt-in: orcaRoots.external + externalVolumeUUID + externalMount in config.
EXTERNAL_UUID = ""
EXTERNAL_MOUNT = ""
MIN_FREE_BYTES = 512 * 1024 * 1024
GITHUB_SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]{0,99}$")
GITHUB_OWNER = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
TRANSLIT = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
                    ["a", "b", "v", "g", "d", "e", "yo", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p",
                     "r", "s", "t", "u", "f", "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "yu", "ya"]))


def github_slug(name):
    """'Такси Дубай' → 'taksi-dubay'; None when nothing usable remains."""
    if not isinstance(name, str):
        return None
    letters = "".join(TRANSLIT.get(char, char) for char in unicodedata.normalize("NFC", name).lower())
    slug = re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9._-]+", "-", letters)).strip("-._")[:100]
    return slug if slug and GITHUB_SLUG.fullmatch(slug) else None
READY_TIMEOUT_MS = 60_000

DEFAULT_ROOTS = {
    "internal": (Path.home() / "Documents/Orca Projects", "На Mac"),
}
PRESETS = (
    ("claude-claude", "Claude + Claude", "claude", "claude"),
    ("codex-codex", "Codex + Codex", "codex", "codex"),
    ("claude-codex", "Claude + Codex", "claude", "codex"),
    ("codex-claude", "Codex + Claude", "codex", "claude"),
)
# Launch-time permission modes per agent. Verified against Claude Code 2.1.283 and
# Codex 0.155.1 flags. An empty mode means "the default", DEFAULT_MODE unless the
# agent has no such mode; the watch offers the default first and the rest on request.
AGENT_MODES = {
    "claude": (
        ("auto", "Авто", ("--permission-mode", "auto")),
        ("plan", "План", ("--permission-mode", "plan")),
        ("acceptEdits", "Автоправки", ("--permission-mode", "acceptEdits")),
        ("bypass", "Без ограничений", ("--dangerously-skip-permissions",)),
    ),
    "codex": (
        ("auto", "Авто", ("--approve-for-me",)),
        ("read-only", "Только чтение", ("-s", "read-only")),
        ("bypass", "Без ограничений", ("--dangerously-bypass-approvals-and-sandbox",)),
    ),
}
DEFAULT_MODES = (("", "Обычный", ()),)
DEFAULT_MODE = "auto"
AGENT_LABELS = {
    "claude": "Claude",
    "codex": "Codex",
    "muse": "Muse",
    "opencode": "OpenCode",
    "omp": "OMP",
    "pi": "Pi",
    "grok": "Grok",
}


class OrcaProjectError(ValueError):
    pass


class UncertainOperation(RuntimeError):
    pass


class WaitingForOwner(Exception):
    def __init__(self, state, message):
        self.state, self.message = state, message


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _page(items, cursor, limit):
    if type(limit) is not int or not 1 <= limit <= 10:
        raise OrcaProjectError("Некорректный размер страницы")
    if cursor in (None, ""):
        offset = 0
    elif isinstance(cursor, str) and cursor.isdigit():
        offset = int(cursor)
    else:
        raise OrcaProjectError("Некорректный курсор")
    if offset > len(items):
        raise OrcaProjectError("Курсор за пределами списка")
    end = min(len(items), offset + limit)
    return items[offset:end], str(end) if end < len(items) else None


def _find_value(value, keys):
    """Find one documented receipt field without depending on wrapper depth."""
    if isinstance(value, dict):
        for key in keys:
            found = value.get(key)
            if isinstance(found, str) and found:
                return found
        for nested in value.values():
            found = _find_value(nested, keys)
            if found:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = _find_value(nested, keys)
            if found:
                return found
    return None


class OrcaProjects:
    def __init__(
        self,
        state_dir,
        service,
        *,
        roots=None,
        disk_info=None,
        disk_usage=None,
        command_runner=None,
        model_catalog=None,
        external_volume_uuid=None,
        external_mount=None,
        agent_commands=None,
        planner=None,
        trust=None,
        notify=None,
        github_owner=None,
        github_runner=None,
        sleep=time.sleep,
        default_mode=DEFAULT_MODE,
    ):
        self.state = Path(state_dir)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.service = service
        self.roots = {
            key: (Path(path), label) for key, (path, label) in (roots or DEFAULT_ROOTS).items()
        }
        self.external_uuid = external_volume_uuid or EXTERNAL_UUID
        self.external_mount = external_mount or EXTERNAL_MOUNT
        self.disk_info = disk_info or self._read_external_disk_info
        self.disk_usage = disk_usage or shutil.disk_usage
        self.command_runner = command_runner or self._run_command
        self.injected_models = model_catalog
        self.commands_injected = agent_commands is not None
        self.injected_commands = agent_commands or {}
        self.sleep = sleep
        self.planner = planner
        self.trust = trust
        self.notify = notify
        self.github_owner = github_owner if isinstance(github_owner, str) and GITHUB_OWNER.fullmatch(github_owner) else None
        self.default_mode = default_mode if isinstance(default_mode, str) else DEFAULT_MODE
        # Network-touching commands (gh, git push) are separable so tests never reach GitHub.
        self.github_runner = github_runner or self.command_runner
        self.lock = threading.RLock()
        self.db = sqlite3.connect(
            self.state / "orca-projects.sqlite3", check_same_thread=False
        )
        self.db.row_factory = sqlite3.Row
        self.db.execute("""
            CREATE TABLE IF NOT EXISTS operations (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                params TEXT NOT NULL,
                state TEXT NOT NULL,
                message TEXT NOT NULL DEFAULT '',
                result TEXT NOT NULL DEFAULT '{}',
                created REAL NOT NULL,
                updated REAL NOT NULL
            )
        """)
        self.db.execute(
            "UPDATE operations SET state='unknown',message=? WHERE state='running'",
            ("Связь потеряна после начала операции. Проверьте результат на Mac.",),
        )
        # A persisted owner prompt is not an uncertain side effect. Recover the
        # same nonce if the process stopped between saving it and marking approval.
        for row in self.db.execute("SELECT id,result FROM operations WHERE state='unknown'").fetchall():
            saved = json.loads(row['result'])
            approval = saved.get('approval', {})
            decisions = saved.get('decisions', {})
            denied = any(d.get('kind') == 'folder_trust' and d.get('allow') is False
                         for d in decisions.values())
            if denied:
                self.db.execute("UPDATE operations SET state='cancelled',message=? WHERE id=?",
                                ('Доверие отклонено. Папка сохранена, задача не запущена.', row['id']))
            elif (approval.get('kind') in ('plan', 'folder_trust') and approval.get('id') and
                  approval['id'] not in decisions and not saved.get('trustDecision')):
                self.db.execute("UPDATE operations SET state='approval',message=? WHERE id=?",
                                ('Ожидается ваше решение.', row['id']))
        self.db.commit()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="orca-projects")
        queued = self.db.execute(
            "SELECT id FROM operations WHERE state='queued' ORDER BY created"
        ).fetchall()
        for row in queued:
            self.worker.submit(self._execute, row["id"])

    def close(self):
        self.worker.shutdown(wait=True)
        self.db.close()

    def rpc(self, method, params, transcript_lookup=None):
        if not isinstance(params, dict):
            raise OrcaProjectError("Некорректный запрос Orca")
        if method == "ORCA_ROOTS":
            self._only(params)
            return {"ok": True, "roots": self.available_roots()}
        if method == "ORCA_PRESETS":
            self._only(params, "cursor", "limit")
            items = [{
                "id": row[0], "label": row[1],
                "workerAgent": row[2], "reviewerAgent": row[3],
            } for row in PRESETS]
            page, next_cursor = _page(items, params.get("cursor"), params.get("limit", 3))
            return {"ok": True, "presets": page, "nextCursor": next_cursor}
        if method == "ORCA_AGENTS":
            self._only(params, "cursor", "limit")
            items = [{"id": agent, "label": AGENT_LABELS[agent]}
                     for agent in self._installed_agents()]
            page, next_cursor = _page(items, params.get("cursor"), params.get("limit", 6))
            return {"ok": True, "agents": page, "nextCursor": next_cursor}
        if method == "ORCA_MODELS":
            self._only(params, "agent", "cursor", "limit")
            agent = self._agent(params.get("agent"))
            page, next_cursor = _page(
                self.models(agent), params.get("cursor"), params.get("limit", 6)
            )
            return {"ok": True, "agent": agent, "models": page,
                    "nextCursor": next_cursor}
        if method == "ORCA_GITHUB_CREATE":
            self._only(params, "id", "workspaceId")
            operation_id = self._operation_id(params.get("id"))
            workspace = self._workspace(params.get("workspaceId"))
            payload = {"workspaceId": workspace["id"], "path": workspace["path"],
                       "name": workspace.get("name") or Path(workspace["path"]).name}
            return {"ok": True, "operation": self._enqueue(operation_id, "github", payload)}
        if method == "ORCA_MODES":
            self._only(params, "agent", "cursor", "limit")
            agent = self._agent(params.get("agent"))
            items = [{"id": mode_id, "label": label} for mode_id, label, _ in AGENT_MODES.get(agent, DEFAULT_MODES)]
            page, next_cursor = _page(items, params.get("cursor"), params.get("limit", 3))
            return {"ok": True, "agent": agent, "modes": page, "nextCursor": next_cursor}
        if method == "ORCA_OPERATION":
            self._only(params, "id", "cursor")
            try:
                operation_id = self._operation_id(params.get("id"))
                operation = self.operation(operation_id, params.get("cursor"))
            except OrcaProjectError:
                return {
                    "ok": False,
                    "code": "OPERATION_NOT_FOUND",
                    "error": "Операция не найдена",
                }
            return {"ok": True, "operation": operation}
        if method == "ORCA_PROJECT_PLAN":
            return self._request_plan(params, transcript_lookup)
        if method == "ORCA_PROJECT_DECIDE":
            return self._decide(params)
        if method == "ORCA_PROJECT_RESUME":
            self._only(params, 'id')
            operation_id = self._operation_id(params.get('id'))
            with self.lock:
                row = self.db.execute('SELECT * FROM operations WHERE id=?', (operation_id,)).fetchone()
                if not row:
                    raise OrcaProjectError('Операция не найдена')
                if row['state'] in ('queued', 'running', 'approval', 'completed', 'cancelled'):
                    return {'ok': True, 'operation': self.operation(operation_id)}
                result = json.loads(row['result'])
                if not self._can_resume(row, result):
                    raise OrcaProjectError('Нет точных квитанций для безопасного продолжения')
                self._finish(operation_id, 'queued', 'Проверяю уже открытые терминалы.', result)
            self.worker.submit(self._execute, operation_id)
            return {'ok': True, 'operation': self.operation(operation_id)}
        if method == "ORCA_PROJECT_CREATE":
            try:
                self._only(params, "id", "textId", "rootId")
                operation_id = self._operation_id(params.get("id"))
            except OrcaProjectError as exc:
                return {"ok": False, "code": "PROJECT_REJECTED", "error": str(exc)}
            with self.lock:
                old = self.db.execute(
                    "SELECT kind,params FROM operations WHERE id=?", (operation_id,)
                ).fetchone()
            if callable(self.planner) and (not old or old["kind"] == "planned_project"):
                # Older watches cannot display plan/trust approvals. Keep their
                # transcript and require the client that implements those steps.
                return {"ok": False, "code": "PROJECT_REJECTED", "error":
                        "На часах прежняя версия Orca. Установите Orca 0.3.0 через новый QR в Zepp. "
                        "Текст сохранён на Mac. В новой версии нажмите «Разобрать»."}
            if old:
                saved = json.loads(old["params"])
                if (
                    old["kind"] not in ("project", "project_pair")
                    or saved.get("rootId") != params.get("rootId")
                    or saved.get("textId") != params.get("textId")
                ):
                    raise OrcaProjectError("ID уже используется другой операцией")
                return {"ok": True, "operation": self.operation(operation_id)}
            try:
                if not callable(transcript_lookup):
                    raise OrcaProjectError("Расшифровка недоступна")
                text_id = params.get("textId")
                if not isinstance(text_id, str) or not text_id:
                    raise OrcaProjectError("Некорректный ID расшифровки")
                self._check_root(params.get("rootId"), create_base=False)
                request = self._project_request(transcript_lookup(text_id))
                payload = {
                    "rootId": params.get("rootId"),
                    "name": request["name"],
                    "textId": text_id,
                }
                kind = "project"
                if request.get("pair"):
                    model = self._spoken_model("claude", request["model"])
                    self._agent("claude")
                    payload.update({
                        "presetId": "claude-claude",
                        "workerAgent": "claude",
                        "reviewerAgent": "claude",
                        "workerModel": model,
                        "reviewerModel": model,
                    })
                    kind = "project_pair"
            except OrcaProjectError as exc:
                return {"ok": False, "code": "PROJECT_REJECTED", "error": str(exc)}
            return {"ok": True, "operation": self._enqueue(operation_id, kind, payload)}
        if method == "ORCA_PAIR_CREATE":
            self._only(params, "id", "workspaceId", "presetId", "models", "modes")
            operation_id = self._operation_id(params.get("id"))
            preset = self._preset(params.get("presetId"))
            workspace = self._workspace(params.get("workspaceId"))
            selected = params.get("models", {})
            if not isinstance(selected, dict) or not set(selected) <= {"worker", "reviewer"}:
                raise OrcaProjectError("Некорректный выбор моделей")
            modes = params.get("modes", {})
            if not isinstance(modes, dict) or not set(modes) <= {"worker", "reviewer"}:
                raise OrcaProjectError("Некорректный выбор режимов")
            payload = {
                "workspaceId": workspace["id"],
                "presetId": preset[0],
                "workerAgent": preset[2],
                "reviewerAgent": preset[3],
                "workerModel": self._model(preset[2], selected.get("worker")),
                "reviewerModel": self._model(preset[3], selected.get("reviewer")),
                "workerMode": self._mode(preset[2], modes.get("worker")),
                "reviewerMode": self._mode(preset[3], modes.get("reviewer")),
            }
            return {"ok": True, "operation": self._enqueue(operation_id, "pair", payload)}
        if method == "ORCA_AGENT_CREATE":
            self._only(params, "id", "workspaceId", "agent", "model", "mode")
            operation_id = self._operation_id(params.get("id"))
            workspace = self._workspace(params.get("workspaceId"))
            agent = self._agent(params.get("agent"))
            payload = {
                "workspaceId": workspace["id"],
                "agent": agent,
                "model": self._model(agent, params.get("model")),
                "mode": self._mode(agent, params.get("mode")),
            }
            return {"ok": True, "operation": self._enqueue(operation_id, "agent", payload)}
        raise OrcaProjectError("Неизвестная команда Orca")

    def _request_plan(self, params, transcript_lookup):
        self._only(params, 'id', 'textId', 'rootId', 'parentId')
        operation_id = self._operation_id(params.get('id'))
        identity = {key: params.get(key) for key in ('textId', 'rootId', 'parentId')}
        with self.lock:
            old = self.db.execute('SELECT kind,params FROM operations WHERE id=?', (operation_id,)).fetchone()
        if old:
            saved = json.loads(old['params'])
            if old['kind'] != 'planned_project' or any(saved.get(key) != value for key, value in identity.items()):
                raise OrcaProjectError('ID уже используется другой операцией')
            return {'ok': True, 'operation': self.operation(operation_id)}
        try:
            root = self._check_root(identity['rootId'], create_base=False)
            if not callable(self.planner) or not callable(transcript_lookup):
                raise OrcaProjectError('Разбор команды сейчас недоступен на Mac')
            text_id = self._operation_id(identity['textId'])
            text = transcript_lookup(text_id)
            if not isinstance(text, str) or not text.strip() or len(text) > 30000:
                raise OrcaProjectError('Не удалось прочитать полный текст команды')
            if any(unicodedata.category(c).startswith('C') and c not in '\n\r\t' for c in text):
                raise OrcaProjectError('В команде недопустимые символы')
            if identity['parentId']:
                self._operation_id(identity['parentId'])
                with self.lock:
                    parent = self.db.execute('SELECT * FROM operations WHERE id=?', (identity['parentId'],)).fetchone()
                if not parent or parent['kind'] != 'planned_project':
                    raise OrcaProjectError('Предыдущий план не найден')
                previous = json.loads(parent['params'])
                receipt = json.loads(parent['result'])
                if (parent['state'] not in ('clarification', 'approval') or receipt.get('approvedPlan') or
                        receipt.get('folder') or previous['rootId'] != identity['rootId']):
                    raise OrcaProjectError('Этот проект уже запускается. Создайте отдельную задачу.')
                text = previous['rawText'] + '\n\nУточнение владельца:\n' + text
                if len(text) > 29000:
                    raise OrcaProjectError('Команда с уточнениями слишком длинная. Запишите новый запрос.')
            if len(text) > 29000:
                raise OrcaProjectError('Команда слишком длинная. Сократите описание.')
        except (OrcaProjectError, ValueError) as exc:
            return {'ok': False, 'code': 'PROJECT_REJECTED', 'error': str(exc)}
        payload = {**identity, 'rawText': text, 'rootPath': str(root)}
        # Supersede only a plan that has never been approved. Hold the lock
        # through enqueue so a concurrent owner confirmation cannot race this.
        with self.lock:
            if identity['parentId']:
                current = self.db.execute('SELECT state,result FROM operations WHERE id=?', (identity['parentId'],)).fetchone()
                receipt = json.loads(current['result'])
                if current['state'] not in ('clarification', 'approval') or receipt.get('approvedPlan'):
                    raise OrcaProjectError('Предыдущий план уже принят')
                duplicate = self.db.execute('SELECT kind,params FROM operations WHERE id=?', (operation_id,)).fetchone()
                if duplicate:
                    if duplicate['kind'] != 'planned_project' or duplicate['params'] != _json(payload):
                        raise OrcaProjectError('ID уже используется другой операцией')
                    return {'ok': True, 'operation': self.operation(operation_id)}
                now = time.time()
                self.db.execute("INSERT INTO operations(id,kind,params,state,created,updated) VALUES (?,'planned_project',?,'queued',?,?)",
                                (operation_id, _json(payload), now, now))
                self.db.execute("UPDATE operations SET state='cancelled',message=?,updated=? WHERE id=?",
                                ('План заменён уточнением.', now, identity['parentId']))
                self.db.commit()
                self.worker.submit(self._execute, operation_id)
                return {'ok': True, 'operation': self.operation(operation_id)}
            return {'ok': True, 'operation': self._enqueue(operation_id, 'planned_project', payload)}

    def _decide(self, params):
        self._only(params, 'id', 'approvalId', 'allow')
        operation_id = self._operation_id(params.get('id'))
        if not isinstance(params.get('approvalId'), str) or type(params.get('allow')) is not bool:
            raise OrcaProjectError('Некорректное решение')
        with self.lock:
            row = self.db.execute('SELECT * FROM operations WHERE id=?', (operation_id,)).fetchone()
            if not row:
                raise OrcaProjectError('Операция не найдена')
            result = json.loads(row['result'])
            decisions = result.get('decisions', {})
            old = decisions.get(params['approvalId'])
            if old is not None:
                if old['allow'] != params['allow']:
                    raise OrcaProjectError('Для этого разрешения уже принято другое решение')
                return {'ok': True, 'operation': self.operation(operation_id)}
            approval = result.get('approval', {})
            if row['state'] != 'approval' or approval.get('id') != params['approvalId']:
                raise OrcaProjectError('Этот запрос разрешения больше не действует')
            decisions[approval['id']] = {'allow': params['allow'], 'kind': approval['kind']}
            result['decisions'] = decisions
            if approval['kind'] == 'plan':
                if not params['allow']:
                    self._finish(operation_id, 'cancelled', 'Создание отменено. Папка не создавалась.', result)
                    return {'ok': True, 'operation': self.operation(operation_id)}
                result['approvedPlan'] = approval['id']
            elif approval['kind'] == 'folder_trust':
                result['trustDecision'] = {'approvalId': approval['id'], 'allow': params['allow']}
            else:
                raise OrcaProjectError('Неизвестный вид разрешения')
            result['phase'] = 'creating'
            self._finish(operation_id, 'queued', 'Продолжаю создание на Mac.', result)
        self.worker.submit(self._execute, operation_id)
        return {'ok': True, 'operation': self.operation(operation_id)}

    def _clarify(self, operation_id, question):
        self._finish(operation_id, 'clarification', question, self._save_result(operation_id))
        raise WaitingForOwner('clarification', question)

    def _plan_project(self, operation_id, params):
        result = self._save_result(operation_id)
        if not result.get('approvedPlan'):
            self._save_result(operation_id, phase='planning')
            catalog = {agent: self.models(agent) for agent in ('claude', 'codex')
                       if agent in self._installed_agents()}
            default_model = 'claude-opus-5-5' if any(m['id'] == 'claude-opus-5-5' for m in catalog.get('claude', [])) else ''
            defaults = {'workerAgent': 'claude', 'reviewerAgent': 'claude',
                        'workerModel': default_model, 'reviewerModel': default_model,
                        'rootId': params['rootId'], 'rootLabel': self.roots[params['rootId']][1]}
            plan = self.planner(params['rawText'], catalog, defaults)
            if not isinstance(plan, dict):
                raise OrcaProjectError('Разбор не вернул план проекта')
            question = plan.get('question')
            if question:
                if not isinstance(question, str) or len(question) > 1500:
                    raise OrcaProjectError('Некорректный вопрос разбора')
                self._clarify(operation_id, question)
            name = self._folder_name(plan.get('name'))
            brief = plan.get('brief')
            if not isinstance(brief, str) or len(brief) > 12000:
                raise OrcaProjectError('Не удалось прочитать задачу проекта')
            clean = {'name': name, 'rootId': params['rootId'], 'brief': brief, 'github': bool(plan.get('github'))}
            worker, reviewer = plan.get('workerAgent'), plan.get('reviewerAgent')
            if worker or reviewer:
                if worker not in ('claude', 'codex') or reviewer not in ('claude', 'codex'):
                    raise OrcaProjectError('Для проекта нужна связка из Claude Code и/или Codex')
                for role, agent in (('worker', worker), ('reviewer', reviewer)):
                    clean[role + 'Agent'] = self._agent(agent)
                    clean[role + 'Model'] = self._model(agent, plan.get(role + 'Model'))
                clean['presetId'] = worker + '-' + reviewer
            root = self._check_root(params['rootId'], create_base=False)
            if os.path.lexists(root / name):
                self._clarify(operation_id, 'Папка «' + name + '» уже существует. Укажите другое имя или выберите текущий проект в меню Orca.')
            text = 'Проект: ' + name + '\nПапка: ' + str(root / name)
            if worker:
                text += '\nБоевой: ' + worker + ' · ' + (clean['workerModel'] or 'настройки Orca')
                text += '\nПроверяющий: ' + reviewer + ' · ' + (clean['reviewerModel'] or 'настройки Orca')
            else:
                text += '\nТолько папка, без запуска агентов.'
            if clean['github']:
                slug = github_slug(name)
                if not slug:
                    self._clarify(operation_id, 'Не получается составить латинское имя репозитория из «' + name + '». Назовите проект иначе.')
                text += '\nGitHub: приватный репозиторий ' + (self._github_owner(strict=False) or 'владелец gh') + '/' + slug
            if brief:
                text += '\nОписание: ' + brief
            text += '\nТолько создать проект и открыть выбранных агентов. Разработка и исследование начнутся после отдельной команды.'
            approval = {'id': secrets.token_hex(16), 'kind': 'plan', 'text': text}
            self._save_result(operation_id, plan=clean, approval=approval)
            raise WaitingForOwner('approval', 'Проверьте план проекта.')

        plan = result['plan']
        self._save_result(operation_id, phase='creating')
        workspace = result.get('workspace')
        if workspace is None:
            if result.get('folder') or result.get('folderCreateStarted'):
                raise UncertainOperation('Папка уже создавалась, но квитанция Orca неполная. Повторного создания не будет.')
            self._save_result(operation_id, folderCreateStarted=True)
            result, _ = self._create_project(operation_id, plan)
            workspace = result['workspace']
        github_note = ''
        if plan.get('github'):
            if not self._save_result(operation_id).get('github'):
                self._ensure_github(operation_id, Path(workspace['path']), plan['name'])
            github_note = ' ' + self._save_result(operation_id)['github']['url'] + '.'
        if plan.get('workerAgent'):
            pair_params = {**plan, 'workspaceId': workspace['id']}
            result, _ = self._create_pair(operation_id, pair_params)
        return self._save_result(operation_id), 'Проект создан' + (', связка открыта.' if plan.get('workerAgent') else '.') + github_note + ' Жду отдельную команду на работу.'

    def available_roots(self):
        available = []
        for root_id, (path, label) in self.roots.items():
            try:
                self._check_root(root_id, create_base=False)
            except OrcaProjectError:
                continue
            available.append({"id": root_id, "label": label})
        return available

    def operation(self, operation_id, cursor=None):
        with self.lock:
            row = self.db.execute(
                "SELECT * FROM operations WHERE id=?", (operation_id,)
            ).fetchone()
        if row is None:
            raise OrcaProjectError("Операция не найдена")
        result = json.loads(row["result"])
        answer = {
            "id": row["id"],
            "state": row["state"],
            "message": row["message"],
            "canResume": self._can_resume(row, result),
        }
        for key in ("pair", "workspace", "agent", "jobId", "phase", "github"):
            if key in result:
                answer[key] = result[key]
        if row["state"] == "approval" and result.get("approval"):
            approval = result["approval"]
            offset = 0 if cursor is None else int(cursor)
            if offset < 0 or (cursor is not None and str(offset) != cursor):
                raise OrcaProjectError("Некорректная страница")
            text = approval["text"]
            answer["approval"] = {key: approval[key] for key in ("id", "kind")}
            answer["approval"]["text"] = text[offset:offset + 500]
            answer["nextCursor"] = str(offset + 500) if offset + 500 < len(text) else None
        return answer

    @staticmethod
    def _can_resume(row, result):
        terminals = result.get('terminals', {})
        return bool(row['kind'] == 'planned_project' and row['state'] == 'unknown' and
                    result.get('approvedPlan') and result.get('workspace') and terminals and
                    all(isinstance(t, dict) and t.get('handle') for t in terminals.values()) and
                    not result.get('trustDecision') and
                    not any(d.get('kind') == 'folder_trust' and d.get('allow') is False
                            for d in result.get('decisions', {}).values()))

    def models(self, agent):
        if self.injected_models is not None and agent in self.injected_models:
            values = self.injected_models[agent]
            return self._normalize_models(values)
        command = self._agent_executable(agent)
        models = [{"id": "", "label": "Настройки Orca"}]
        configured = self._configured_models(agent)
        if agent == "claude":
            try:
                help_text = self.command_runner([command, "--help"], 8)
            except (OSError, RuntimeError, subprocess.SubprocessError):
                help_text = ""
            if isinstance(help_text, str) and "--model" in help_text:
                for alias in ("sonnet", "opus", "haiku", "fable"):
                    if re.search(rf"(?<![A-Za-z0-9_-]){re.escape(alias)}(?![A-Za-z0-9_-])", help_text):
                        configured.append(alias)
        for model in configured:
            if model and MODEL_ID.fullmatch(model):
                models.append({"id": model, "label": model})
        return self._normalize_models(models)

    def _normalize_models(self, values):
        answer = []
        seen = set()
        for value in values:
            if isinstance(value, str):
                model_id, label = value, value
            elif isinstance(value, dict):
                model_id, label = value.get("id"), value.get("label")
            else:
                continue
            if not isinstance(model_id, str) or (model_id and not MODEL_ID.fullmatch(model_id)):
                continue
            if not isinstance(label, str) or not label or len(label) > 100 or model_id in seen:
                continue
            seen.add(model_id)
            answer.append({"id": model_id, "label": label})
            if len(answer) == 20:
                break
        if "" not in seen:
            answer.insert(0, {"id": "", "label": "Настройки Orca"})
        return answer[:20]

    def _configured_models(self, agent):
        values = []
        paths = []
        if agent == "codex":
            paths.append(Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "config.toml")
        elif agent == "claude":
            paths.extend((Path.home() / ".claude/settings.json", Path.home() / ".claude/settings.local.json"))
        for path in paths:
            try:
                with path.open("rb") as source:
                    data = tomllib.load(source) if path.suffix == ".toml" else json.load(source)
            except (OSError, ValueError, TypeError):
                continue
            self._collect_models(data, values)
        return values

    @classmethod
    def _collect_models(cls, value, output):
        if isinstance(value, dict):
            for key, nested in value.items():
                if key == "model" and isinstance(nested, str):
                    output.append(nested)
                elif key == "models" and isinstance(nested, list):
                    output.extend(item for item in nested if isinstance(item, str))
                elif isinstance(nested, (dict, list)):
                    cls._collect_models(nested, output)
        elif isinstance(value, list):
            for nested in value:
                cls._collect_models(nested, output)

    def _enqueue(self, operation_id, kind, params):
        raw = _json(params)
        now = time.time()
        with self.lock:
            old = self.db.execute(
                "SELECT kind,params FROM operations WHERE id=?", (operation_id,)
            ).fetchone()
            if old:
                if old["kind"] != kind or old["params"] != raw:
                    raise OrcaProjectError("ID уже используется другой операцией")
                return self.operation(operation_id)
            self.db.execute(
                "INSERT INTO operations(id,kind,params,state,created,updated) VALUES (?,?,?,'queued',?,?)",
                (operation_id, kind, raw, now, now),
            )
            self.db.commit()
        self.worker.submit(self._execute, operation_id)
        return self.operation(operation_id)

    def _execute(self, operation_id):
        with self.lock:
            row = self.db.execute(
                "SELECT kind,params,state FROM operations WHERE id=?", (operation_id,)
            ).fetchone()
            if row is None or row["state"] != "queued":
                return
            self.db.execute(
                "UPDATE operations SET state='running',message=?,updated=? WHERE id=?",
                ("Операция выполняется на Mac.", time.time(), operation_id),
            )
            self.db.commit()
        try:
            params = json.loads(row["params"])
            if row["kind"] == "planned_project":
                result, message = self._plan_project(operation_id, params)
            elif row["kind"] == "project":
                result, message = self._create_project(operation_id, params)
            elif row["kind"] == "project_pair":
                result, message = self._create_project_pair(operation_id, params)
            elif row["kind"] == "pair":
                result, message = self._create_pair(operation_id, params)
            elif row["kind"] == "github":
                result, message = self._create_github(operation_id, params)
            else:
                result, message = self._create_agent(operation_id, params)
            self._finish(operation_id, "completed", message, result)
        except WaitingForOwner as exc:
            self._finish(operation_id, exc.state, exc.message, None)
        except UncertainOperation as exc:
            self._finish(operation_id, "unknown", str(exc), None)
        except (OrcaProjectError, ValueError, OSError) as exc:
            self._finish(operation_id, "error", str(exc), None)
        except Exception as exc:
            logging.getLogger(__name__).error("Orca bootstrap failed id=%s type=%s", operation_id, type(exc).__name__)
            self._finish(
                operation_id,
                "unknown",
                "Не удалось подтвердить результат. Не запускайте операцию повторно.",
                None,
            )

    def _finish(self, operation_id, state, message, result):
        message = str(message or "")[:1500]
        with self.lock:
            if result is None:
                current = self.db.execute(
                    "SELECT result FROM operations WHERE id=?", (operation_id,)
                ).fetchone()
                raw = current["result"] if current else "{}"
            else:
                raw = _json(result)
            self.db.execute(
                "UPDATE operations SET state=?,message=?,result=?,updated=? WHERE id=?",
                (state, message, raw, time.time(), operation_id),
            )
            self.db.commit()
        if self.notify:
            self._announce(operation_id, state, message, raw)

    def _announce(self, operation_id, state, message, raw):
        try:
            approval = json.loads(raw).get("approval") or {}
            if state == "approval" and approval.get("kind") == "folder_trust":
                key = f"project:{operation_id}:trust:{approval.get('id')}"
                text = "Orca · новый проект\nАгент ждёт доверие папке. Реши на часах."
            elif state == "approval":
                key = f"project:{operation_id}:plan:{approval.get('id')}"
                text = f"Orca · новый проект\nПлан готов, подтверди на часах.\n{str(approval.get('text', ''))[:300]}"
            elif state == "clarification":
                key = f"project:{operation_id}:clarification"
                text = f"Orca · новый проект\nВопрос: {message[:300]}"
            elif state in ("completed", "error", "unknown"):
                key = f"project:{operation_id}:{state}"
                text = f"Orca · проект\n{message[:300]}"
            else:
                return
            self.notify(key, text)
        except Exception:
            pass

    def _save_result(self, operation_id, **fields):
        with self.lock:
            row = self.db.execute(
                "SELECT result FROM operations WHERE id=?", (operation_id,)
            ).fetchone()
            result = json.loads(row["result"]) if row else {}
            result.update(fields)
            self.db.execute(
                "UPDATE operations SET result=?,updated=? WHERE id=?",
                (_json(result), time.time(), operation_id),
            )
            self.db.commit()
        return result

    def _create_project(self, operation_id, params):
        root_id = params.get("rootId")
        root = self._check_root(root_id, create_base=True)
        target = root / params["name"]
        if os.path.lexists(target):
            raise OrcaProjectError("Папка с таким именем уже существует")
        os.mkdir(target, 0o700)
        self._save_result(operation_id, folder=str(target))
        # Orca's repo-add accepts Git checkouts, not an empty directory. A real
        # initial commit also gives future worktrees a valid base. This runs
        # only in the directory just created above, never an existing project.
        try:
            self.command_runner([
                "git", "-c", "init.templateDir=", "init", "--initial-branch=main", str(target)
            ], 15)
            git = ["git", "-C", str(target)]
            self.command_runner(git + [
                "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
                "-c", "user.name=Orca Watch", "-c", "user.email=orca-watch@localhost",
                "commit", "--allow-empty", "-m", "Initialize project"
            ], 15)
            self.command_runner(git + ["rev-parse", "--verify", "HEAD"], 5)
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            raise OrcaProjectError("Не удалось подготовить Git в новой папке проекта.") from exc
        try:
            receipt = self.service.run_cli(
                ["repo", "add", "--path", str(target), "--json"], timeout=30
            )
        except RuntimeError as exc:
            if getattr(exc, "uncertain", True) is False:
                raise OrcaProjectError(str(exc)) from exc
            raise UncertainOperation(
                "Папка создана, но ответ Orca потерян. Проверьте проект на Mac."
            ) from exc
        receipt_id = _find_value(receipt, ("id", "repoId", "projectId"))
        self._save_result(operation_id, repoReceipt={"id": receipt_id} if receipt_id else {})
        workspace = self._discover_workspace(str(target))
        if workspace is None:
            raise UncertainOperation(
                "Папка создана и передана Orca, но рабочий каталог ещё не найден."
            )
        result = self._save_result(operation_id, workspace=workspace)
        message = "Проект создан в Orca."
        if root_id == "external":
            limitation = self._set_external_worktree_base(operation_id, workspace, root)
            if limitation:
                message = "Проект создан. " + limitation
        return self._save_result(operation_id), message

    def _create_project_pair(self, operation_id, params):
        # Revalidate the durable model identity before the first side effect.
        for role in ("worker", "reviewer"):
            agent = params[role + "Agent"]
            self._agent(agent)
            self._model(agent, params[role + "Model"])
        project = self._save_result(operation_id)
        if not project.get("workspace"):
            project, _ = self._create_project(operation_id, params)
        pair_params = dict(params)
        pair_params["workspaceId"] = project["workspace"]["id"]
        result, _ = self._create_pair(operation_id, pair_params)
        return result, "Проект создан, связка открыта."

    def _set_external_worktree_base(self, operation_id, workspace, root):
        project_id = workspace.get("projectId")
        if not isinstance(project_id, str) or not project_id:
            return "Базу будущих worktree нужно настроить на Mac."
        try:
            answer = self.service.run_cli(
                ["project", "setups", "--json"], timeout=8
            )
        except (ValueError, RuntimeError):
            return "Базу будущих worktree нужно настроить на Mac."
        setups = answer.get("setups", []) if isinstance(answer, dict) else []
        exact = [
            item for item in setups
            if isinstance(item, dict)
            and os.path.realpath(str(item.get("path", ""))) == os.path.realpath(workspace["path"])
            and item.get("repoId") == project_id
            and isinstance(item.get("id"), str)
        ]
        if len(exact) != 1:
            return "Базу будущих worktree нужно настроить на Mac."
        setup_id = exact[0]["id"]
        self._save_result(operation_id, setupId=setup_id)
        try:
            receipt = self.service.run_cli(
                ["project", "setup-update", "--setup", setup_id,
                 "--worktree-base-path", str(root), "--json"],
                timeout=15,
            )
        except ValueError:
            return "Эта версия Orca не применила базу будущих worktree."
        except RuntimeError as exc:
            if getattr(exc, "uncertain", True) is False:
                return "Эта версия Orca не применила базу будущих worktree."
            raise UncertainOperation(
                "Проект создан, но результат настройки будущих worktree неизвестен."
            ) from exc
        update_id = _find_value(receipt, ("id", "setupId"))
        self._save_result(operation_id, setupReceipt={"id": update_id} if update_id else {})
        return ""

    def _gh(self):
        return shutil.which("gh") or "/opt/homebrew/bin/gh"

    def _github_owner(self, strict=True):
        if self.github_owner:
            return self.github_owner
        try:
            login = self.github_runner([self._gh(), "api", "user", "-q", ".login"], 15).strip()
        except (OSError, RuntimeError, subprocess.SubprocessError):
            login = ""
        if GITHUB_OWNER.fullmatch(login):
            self.github_owner = login
            return login
        if strict:
            raise OrcaProjectError("GitHub недоступен: выполните gh auth login или задайте githubOwner в config.json")
        return None

    def _ensure_github(self, operation_id, folder, name):
        """Connect the folder to a private GitHub repository exactly once.

        Order: an existing origin wins; a repository that already exists under the
        owner is only connected; otherwise it is created private and pushed.
        """
        folder = Path(folder)
        if not folder.is_dir():
            raise OrcaProjectError("Папка проекта не найдена")
        git = ["git", "-C", str(folder)]
        try:
            existing = self.command_runner(git + ["remote", "get-url", "origin"], 10).strip()
        except (OSError, RuntimeError, subprocess.SubprocessError):
            existing = ""
        if existing:
            self._save_result(operation_id, github={"url": existing, "existing": True})
            return existing
        slug = github_slug(name)
        if not slug:
            raise OrcaProjectError("Не удалось составить латинское имя репозитория из названия")
        full = self._github_owner() + "/" + slug
        self._save_result(operation_id, githubStarted=full)
        try:
            url = self.github_runner([self._gh(), "repo", "view", full, "--json", "url", "-q", ".url"], 20).strip()
        except (OSError, RuntimeError):
            url = ""
        except subprocess.SubprocessError as exc:
            raise UncertainOperation("GitHub не ответил; проверьте репозиторий на Mac.") from exc
        connected_only = bool(url)
        try:
            branch = self.command_runner(git + ["rev-parse", "--abbrev-ref", "HEAD"], 5).strip() or "main"
            if url:
                self.command_runner(git + ["remote", "add", "origin", url], 10)
            else:
                self.github_runner([self._gh(), "repo", "create", full, "--private", "--source", str(folder),
                                    "--remote", "origin", "--push"], 120)
                url = "https://github.com/" + full
            self.github_runner(git + ["push", "-u", "origin", branch], 120)
        except subprocess.TimeoutExpired as exc:
            raise UncertainOperation("GitHub не ответил вовремя; проверьте репозиторий на Mac.") from exc
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            raise OrcaProjectError("Не удалось создать репозиторий на GitHub. Проверьте gh auth status.") from exc
        self._save_result(operation_id, github={"url": url, "existing": connected_only, "private": not connected_only})
        return url

    def _create_github(self, operation_id, params):
        url = self._ensure_github(operation_id, Path(params["path"]), params["name"])
        result = self._save_result(operation_id, workspace={"id": params["workspaceId"], "path": params["path"]})
        existing = result.get("github", {}).get("existing")
        return result, ("Репозиторий подключён: " if existing else "Приватный репозиторий создан: ") + url

    def _create_pair(self, operation_id, params):
        saved = self._save_result(operation_id)
        if saved.get("pair"):
            return saved, "Связка открыта."
        workspace = self._workspace(params["workspaceId"])
        worker = self._create_terminal(
            operation_id, workspace, params["workerAgent"], params["workerModel"], "Боевой",
            params.get("workerMode", ""),
        )
        reviewer = self._create_terminal(
            operation_id, workspace, params["reviewerAgent"], params["reviewerModel"], "Проверка",
            params.get("reviewerMode", ""),
        )
        try:
            answer = self.service.rpc("ORCA_BIND", {
                "workspaceId": workspace["id"],
                "workerId": worker,
                "reviewerId": reviewer,
            })
        except RuntimeError as exc:
            raise UncertainOperation(
                "Агенты открыты, но ответ о сохранении связки потерян."
            ) from exc
        pair = answer.get("pair") if isinstance(answer, dict) else None
        if not isinstance(pair, dict):
            raise UncertainOperation("Агенты открыты, но связка не подтверждена Orca.")
        return self._save_result(operation_id, pair=pair, workspace=workspace), "Связка открыта."

    def _create_agent(self, operation_id, params):
        workspace = self._workspace(params["workspaceId"])
        handle = self._create_terminal(
            operation_id, workspace, params["agent"], params["model"], "Агент", params.get("mode", "")
        )
        agent = {
            "id": handle,
            "agent": params["agent"],
            "model": params["model"],
            "mode": params.get("mode", ""),
        }
        return self._save_result(operation_id, agent=agent, workspace=workspace), "Агент открыт."

    def _create_terminal(self, operation_id, workspace, agent, model, role, mode=""):
        command = self._agent_command(agent, model, mode)
        result = self._save_result(operation_id)
        terminals = result.get('terminals', {})
        saved = terminals.get(role)
        if saved:
            if (saved.get('workspaceId') != workspace['id'] or saved.get('agent') != agent or
                    saved.get('model') != model or saved.get('mode', '') != mode or not saved.get('handle')):
                raise UncertainOperation('Запуск терминала уже начат, но точная квитанция неизвестна.')
            handle = saved['handle']
        else:
            saved = {'workspaceId': workspace['id'], 'agent': agent, 'model': model, 'mode': mode}
            terminals[role] = saved
            self._save_result(operation_id, terminals=terminals)
            try:
                receipt = self.service.run_cli([
                    'terminal', 'create', '--worktree', 'id:' + workspace['id'],
                    '--title', f'{role}: {agent.title()}', '--command', command, '--json',
                ], timeout=20)
            except RuntimeError as exc:
                if getattr(exc, 'uncertain', True) is False:
                    raise OrcaProjectError(str(exc)) from exc
                raise UncertainOperation('Ответ о запуске агента потерян. Терминал не создавался повторно.') from exc
            handle = _find_value(receipt, ('handle', 'terminalHandle'))
            if not handle:
                raise UncertainOperation('Orca не вернула точный handle нового терминала.')
            saved['handle'] = handle
            handles = list(result.get('terminalHandles', []))
            handles.append(handle)
            self._save_result(operation_id, terminals=terminals, terminalHandles=handles)
        shown = self.service.run_cli(['terminal', 'show', '--terminal', handle, '--json'], timeout=8)
        term = shown.get('terminal', shown) if isinstance(shown, dict) else {}
        if term.get('handle') != handle:
            raise UncertainOperation('Orca вернула другой terminal handle.')
        if saved.get('incarnationId') and term.get('incarnationId') != saved['incarnationId']:
            raise UncertainOperation('Процесс агента сменился. Старое разрешение не применяется.')
        if term.get('incarnationId'):
            saved['incarnationId'] = term['incarnationId']
            self._save_result(operation_id, terminals=terminals)
        decision = result.get('trustDecision')
        approval = result.get('approval', {})
        if decision and approval.get('terminalRole') == role:
            if not self.trust or decision['approvalId'] != approval.get('id'):
                raise UncertainOperation('Не удалось проверить запрос доверия.')
            # A write-ahead claim ensures an uncertain raw key is never repeated.
            if result.get('trustAttempt') == decision['approvalId']:
                raise UncertainOperation('Решение о доверии уже передавалось. Повторная отправка запрещена.')
            self._save_result(operation_id, trustAttempt=decision['approvalId'])
            try:
                receipt = self.trust.decide(approval['snapshot'], decision['allow'])
            except (ValueError, RuntimeError) as exc:
                raise UncertainOperation('Не удалось подтвердить применение доверия: ' + str(exc)) from exc
            if not decision['allow']:
                final = self._save_result(operation_id)
                final.update(trustDecision=None, trustReceipt=receipt)
                message = 'Доверие отклонено. Папка сохранена, задача не запущена.'
                self._finish(operation_id, 'cancelled', message, final)
                raise WaitingForOwner('cancelled', message)
            self._save_result(operation_id, trustDecision=None, trustReceipt=receipt)
        try:
            waited = self.service.run_cli([
                'terminal', 'wait', '--terminal', handle, '--for', 'tui-idle',
                '--timeout-ms', str(READY_TIMEOUT_MS), '--json',
            ], timeout=70, allow_timeout=True)
        except (ValueError, RuntimeError) as exc:
            raise UncertainOperation('Терминал создан, но готовность агента неизвестна.') from exc
        wait = waited.get('wait', {}) if isinstance(waited, dict) else {}
        # Orca can report a quiet TUI before attaching the agent identity.
        # Recheck this read-only startup boundary without restarting the process.
        if agent in ('claude', 'codex'):
            for attempt in range(6):
                shown = self.service.run_cli(['terminal', 'show', '--terminal', handle, '--json'], timeout=8)
                term = shown.get('terminal', shown) if isinstance(shown, dict) else {}
                if term.get('agentIdentity') == agent or term.get('agentWait') or wait.get('satisfied') is not True:
                    break
                if attempt < 5:
                    self.sleep(0.4)
        if agent in ('claude', 'codex') and self.trust:
            agent_label = 'Claude Code' if agent == 'claude' else 'Codex'
            try:
                snapshot = self.trust.detect(handle, workspace["id"], **({"agent": "codex"} if agent == "codex" else {}))
            except RuntimeError as exc:
                logging.getLogger(__name__).warning("Trust screen unavailable id=%s: %s", operation_id, str(exc)[:200])
                raise UncertainOperation(f'Не удалось проверить экран первого запуска {agent_label}. Терминал сохранён; «Обновить» проверит его снова без повторного создания.') from exc
            if snapshot:
                approval = {'id': secrets.token_hex(16), 'kind': 'folder_trust',
                            'terminalRole': role, 'snapshot': snapshot,
                            'text': 'Доверять папке?\n' + workspace['path'] +
                                    f'\n{agent_label} сможет читать, менять и запускать файлы в этом проекте. '
                                    'Разрешение относится к этой папке. Разрешения отдельных команд остаются включены.'}
                self._save_result(operation_id, approval=approval)
                raise WaitingForOwner('approval', f'{agent_label} ожидает доверие папке.')
        wait = waited.get('wait', {}) if isinstance(waited, dict) else {}
        if wait.get('satisfied') is not True:
            raise UncertainOperation('Терминал создан, но агент не подтвердил готовность.')
        if agent in ('claude', 'codex'):
            shown = self.service.run_cli(['terminal', 'show', '--terminal', handle, '--json'], timeout=8)
            term = shown.get('terminal', shown) if isinstance(shown, dict) else {}
            if (term.get('handle') != handle or term.get('agentIdentity') != agent or
                    term.get('worktreeId') != workspace['id'] or not term.get('connected') or term.get('agentWait') or
                    (saved.get('incarnationId') and term.get('incarnationId') != saved['incarnationId'])):
                raise UncertainOperation('Агент открыт, но ещё не готов. Неизвестный экран первого запуска на Mac.')
        return handle

    def _agent_command(self, agent, model, mode=""):
        command = [self._agent_executable(agent)]
        command.extend(self._mode_flags(agent, mode))
        if agent == 'codex':
            # Per-process only: a remote project must not block on an updater.
            command.extend(('-c', 'check_for_update_on_startup=false'))
        if model:
            allowed = {item["id"] for item in self.models(agent)}
            if model not in allowed:
                raise OrcaProjectError("Модель больше не доступна")
            command.extend(("--model", model))
        return shlex.join(command)

    def _agent_executable(self, agent):
        candidate = self.injected_commands.get(agent)
        if not self.commands_injected:
            candidate = candidate or shutil.which(agent)
        if not candidate:
            raise OrcaProjectError(f"{agent.title()} CLI не найден")
        path = Path(candidate).expanduser().resolve()
        if not path.is_file() or not os.access(path, os.X_OK):
            raise OrcaProjectError(f"{agent.title()} CLI недоступен")
        return str(path)

    def _installed_agents(self):
        installed = []
        for agent in AGENT_LABELS:
            candidate = self.injected_commands.get(agent)
            if not self.commands_injected:
                candidate = candidate or shutil.which(agent)
            if not candidate:
                continue
            path = Path(candidate).expanduser().resolve()
            if path.is_file() and os.access(path, os.X_OK):
                installed.append(agent)
        return installed

    def _workspace(self, workspace_id):
        if not isinstance(workspace_id, str) or not workspace_id or len(workspace_id) > 1000:
            raise OrcaProjectError("Некорректный рабочий каталог")
        cursor = None
        for _ in range(100):
            answer = self.service.rpc("ORCA_LIST", {"cursor": cursor, "limit": 10})
            for workspace in answer.get("workspaces", []):
                if workspace.get("id") == workspace_id:
                    return workspace
            cursor = answer.get("nextCursor")
            if not cursor:
                break
        raise OrcaProjectError("Рабочий каталог Orca не найден")

    def _discover_workspace(self, path):
        wanted = os.path.realpath(path)
        for attempt in range(5):
            cursor = None
            for _ in range(100):
                answer = self.service.rpc("ORCA_LIST", {"cursor": cursor, "limit": 10})
                for workspace in answer.get("workspaces", []):
                    candidate = workspace.get("path")
                    if isinstance(candidate, str) and os.path.realpath(candidate) == wanted:
                        return workspace
                cursor = answer.get("nextCursor")
                if not cursor:
                    break
            if attempt < 4:
                self.sleep(0.2)
        return None

    def _check_root(self, root_id, create_base):
        if not isinstance(root_id, str) or root_id not in self.roots:
            raise OrcaProjectError("Неизвестное место для проекта")
        root = self.roots[root_id][0]
        if root_id == "external":
            info = self.disk_info()
            uuid = info.get("VolumeUUID") or info.get("DiskUUID")
            if uuid != self.external_uuid or info.get("MountPoint") != self.external_mount:
                raise OrcaProjectError("Нужный диск Storage не подключён")
            if info.get("Writable") is False or info.get("WritableVolume") is False:
                raise OrcaProjectError("Диск Storage доступен только для чтения")
        if root.exists():
            if root.is_symlink() or not root.is_dir():
                raise OrcaProjectError("Корневая папка проекта небезопасна")
            probe = root
        else:
            parent = root.parent
            if root_id != "internal" or not parent.is_dir() or parent.is_symlink():
                raise OrcaProjectError("Корневая папка проекта недоступна")
            if create_base:
                os.mkdir(root, 0o700)
                probe = root
            else:
                probe = parent
        if not os.access(probe, os.W_OK | os.X_OK):
            raise OrcaProjectError("Нет доступа для создания проекта")
        try:
            free = self.disk_usage(probe).free
        except OSError as exc:
            raise OrcaProjectError("Не удалось проверить свободное место") from exc
        if free < MIN_FREE_BYTES:
            raise OrcaProjectError("Недостаточно свободного места")
        return root

    @staticmethod
    def _folder_name(text):
        if not isinstance(text, str):
            raise OrcaProjectError("Расшифровка имени недоступна")
        name = unicodedata.normalize("NFC", text.strip())
        if (
            not name
            or len(name) > 100
            or name in (".", "..")
            or ".." in name
            or "/" in name
            or "\\" in name
            or "\0" in name
            or any(unicodedata.category(char).startswith("C") for char in name)
        ):
            raise OrcaProjectError("Некорректное имя папки")
        return name

    def _project_request(self, text):
        if not isinstance(text, str):
            raise OrcaProjectError("Расшифровка имени недоступна")
        spoken = unicodedata.normalize("NFC", text.strip())
        explicit = re.search(
            r"(?:проект\s+называется|назови\s+проект|открой\s+"
            r"(?:клод(?:-|\s)?код|claude(?:-|\s)+code)|"
            r"(?:сдела(?:й|ем)|создай|создадим|открой)\b.*\bпроект|"
            r"(?:клод(?:-|\s)?код|claude(?:-|\s)+code|кодекс|codex)\s+(?:боевой|проверяющий))",
            spoken,
            re.IGNORECASE,
        )
        if not explicit:
            return {"name": self._folder_name(spoken)}

        name = None
        pair = False
        model = None
        sentence_break = r"[!?]+|(?<!\d)\.+|\.+(?=\s|$)"
        for sentence in (part.strip() for part in re.split(sentence_break, spoken)):
            if not sentence:
                continue
            match = re.fullmatch(
                r"(?:и\s+)?проект\s+называется(?:\s+у\s+нас\s+будет)?\s+(.+)",
                sentence,
                re.IGNORECASE,
            ) or re.fullmatch(
                r"(?:и\s+)?назови\s+проект\s+(.+)", sentence, re.IGNORECASE
            )
            if match:
                if name is not None:
                    raise OrcaProjectError("Имя проекта указано неоднозначно")
                name = self._folder_name(match.group(1))
                continue
            if re.fullmatch(
                r"(?:там\s+)?открой\s+(?:клод(?:-|\s)?код|claude(?:-|\s)+code)"
                r"\s+боевой\s+и\s+(?:клод(?:-|\s)?код|claude(?:-|\s)+code)"
                r"\s+проверяющий",
                sentence,
                re.IGNORECASE,
            ):
                if pair:
                    raise OrcaProjectError("Связка агентов указана неоднозначно")
                pair = True
                continue
            match = re.fullmatch(
                r"(?:по\s+умолчанию\s+)?(.+?)\s+должн(?:а|ы)\s+быть\s+в\s+обоих",
                sentence,
                re.IGNORECASE,
            )
            if match:
                if model is not None:
                    raise OrcaProjectError("Модель указана неоднозначно")
                model = match.group(1).strip()
                continue
            if re.fullmatch(
                r"(?:так,?\s*)?сдела(?:й|ем)\s+(?:мне\s+)?новый\s+проект|"
                r"понял|вс[её],?\s*давай",
                sentence,
                re.IGNORECASE,
            ):
                continue
            raise OrcaProjectError('Не понял команду создания. Скажите только имя папки или «Проект называется такси дубай».')
        if name is None:
            raise OrcaProjectError("Не удалось однозначно определить имя проекта")
        if pair != (model is not None):
            raise OrcaProjectError("Для связки укажите точную модель для обоих агентов")
        return {"name": name, "pair": pair, "model": model}

    def _spoken_model(self, agent, spoken):
        def key(value):
            value = unicodedata.normalize("NFKC", value).casefold()
            value = re.sub(
                r"\b(?:claude(?:-|\s)+code|claude|клод(?:-|\s)?код)\b", " ", value
            )
            value = re.sub(r"\bопус\b", "opus", value)
            return " ".join(re.sub(r"[._:/,\\-]+", " ", value).split())

        wanted = key(spoken)
        matches = {
            item["id"]
            for item in self.models(agent)
            if item["id"] and wanted in {key(item["id"]), key(item["label"])}
        }
        if len(matches) != 1:
            raise OrcaProjectError(
                "Модель не найдена" if not matches else "Модель указана неоднозначно"
            )
        return matches.pop()

    @staticmethod
    def _operation_id(value):
        if not isinstance(value, str) or not OPERATION_ID.fullmatch(value):
            raise OrcaProjectError("Некорректный ID операции")
        return value

    @staticmethod
    def _only(params, *allowed):
        if not set(params) <= set(allowed):
            raise OrcaProjectError("Некорректные поля запроса Orca")

    def _agent(self, value):
        if value not in self._installed_agents():
            raise OrcaProjectError("Неизвестный агент")
        return value

    @staticmethod
    def _preset(value):
        for preset in PRESETS:
            if preset[0] == value:
                return preset
        raise OrcaProjectError("Неизвестная связка")

    def _mode(self, agent, value):
        """Resolve a requested mode; empty means the configured default when the agent supports it."""
        known = {item[0] for item in AGENT_MODES.get(agent, DEFAULT_MODES)}
        if value in (None, ""):
            return self.default_mode if self.default_mode in known else ""
        if not isinstance(value, str) or value not in known:
            raise OrcaProjectError("Режим недоступен для этого агента")
        return value

    def _mode_flags(self, agent, mode):
        resolved = self._mode(agent, mode)
        for mode_id, _, flags in AGENT_MODES.get(agent, DEFAULT_MODES):
            if mode_id == resolved:
                return list(flags)
        return []  # "" on an agent without a default mode: launch as Orca configures it

    def _model(self, agent, value):
        model = "" if value in (None, "") else value
        if not isinstance(model, str) or model not in {item["id"] for item in self.models(agent)}:
            raise OrcaProjectError("Модель недоступна")
        return model

    @staticmethod
    def _run_command(argv, timeout):
        result = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
        if result.returncode:
            raise RuntimeError("command failed")
        return result.stdout[:128_000]

    def _read_external_disk_info(self):
        try:
            result = subprocess.run(
                ["/usr/sbin/diskutil", "info", "-plist", self.external_mount],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=8,
                check=False,
            )
            if result.returncode:
                return {}
            data = plistlib.loads(result.stdout)
            return data if isinstance(data, dict) else {}
        except (OSError, subprocess.SubprocessError, plistlib.InvalidFileException):
            return {}
