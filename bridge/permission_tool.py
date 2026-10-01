#!/usr/bin/env python3
"""MCP stdio server that forwards Claude Code permission prompts to the watch.

Claude runs it as ``--permission-prompt-tool mcp__musafir__approve``. Every
prompt becomes ``<dir>/<id>.request.json``; the bridge writes
``<dir>/<id>.decision.json`` after the owner taps Allow or Deny on the watch.
No decision within the timeout means deny. Standard library only.
"""
import json
import os
from pathlib import Path
import secrets
import sys
import time

DIR = Path(os.environ.get("MUSAFIR_PERMISSION_DIR", "") or ".")
TIMEOUT = float(os.environ.get("MUSAFIR_PERMISSION_TIMEOUT", "900"))
POLL = 0.5
TOOL = {
    "name": "approve",
    "description": "Ask the owner on the watch to allow or deny a tool call.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "tool_name": {"type": "string"},
            "input": {"type": "object"},
            "tool_use_id": {"type": "string"},
        },
        "required": ["tool_name", "input"],
    },
}


def reply(message_id, result=None, error=None):
    message = {"jsonrpc": "2.0", "id": message_id}
    if error is not None:
        message["error"] = {"code": -32000, "message": error}
    else:
        message["result"] = result
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def decide(arguments, directory=DIR, timeout=TIMEOUT, poll=POLL):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    request_id = secrets.token_hex(8)
    request = {"id": request_id, "toolName": str(arguments.get("tool_name") or ""),
               "input": arguments.get("input") if isinstance(arguments.get("input"), dict) else {},
               "toolUseId": arguments.get("tool_use_id"), "created": time.time()}
    tmp = directory / f"{request_id}.request.tmp"
    tmp.write_text(json.dumps(request, ensure_ascii=False))
    os.replace(tmp, directory / f"{request_id}.request.json")
    decision_path = directory / f"{request_id}.decision.json"
    deadline = time.time() + timeout
    while time.time() < deadline:
        if decision_path.exists():
            try:
                decision = json.loads(decision_path.read_text())
            except ValueError:
                decision = {}
            if decision.get("allow") is True:
                updated = dict(request["input"]) if isinstance(request.get("input"), dict) else {}
                answers = decision.get("answers")
                if isinstance(answers, dict) and answers:
                    updated["answers"] = answers  # AskUserQuestion: the owner's choices, keyed by question text
                return {"behavior": "allow", "updatedInput": updated}
            return {"behavior": "deny", "message": str(decision.get("message") or "Отклонено владельцем с часов")}
        time.sleep(poll)
    return {"behavior": "deny", "message": "Владелец не ответил на запрос разрешения вовремя"}


def serve(stdin=sys.stdin):
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if not isinstance(message, dict):
            continue
        method, message_id = message.get("method"), message.get("id")
        if method == "initialize":
            params = message.get("params") or {}
            reply(message_id, {"protocolVersion": params.get("protocolVersion") or "2024-11-05",
                               "capabilities": {"tools": {}},
                               "serverInfo": {"name": "musafir-permissions", "version": "1"}})
        elif method == "ping":
            reply(message_id, {})
        elif method == "tools/list":
            reply(message_id, {"tools": [TOOL]})
        elif method == "tools/call":
            params = message.get("params") or {}
            if params.get("name") != TOOL["name"]:
                reply(message_id, error="unknown tool")
                continue
            arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
            outcome = decide(arguments)
            reply(message_id, {"content": [{"type": "text", "text": json.dumps(outcome, ensure_ascii=False)}]})
        elif message_id is not None and method:
            reply(message_id, error=f"unsupported method {method}")


if __name__ == "__main__":
    serve()
