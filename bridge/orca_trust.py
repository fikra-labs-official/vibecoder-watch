"""Fenced handling of Claude Code and Codex first-folder trust dialogs.

The public Orca CLI does not expose a structured trust-approval RPC.  Claude
Code 2.x starts this dialog with ``No`` focused, so approval is one Down
key followed by Enter.  Every write is surrounded by current rendered-screen
and terminal-incarnation checks; an ambiguous write is never retried here.
"""

from __future__ import annotations

import hashlib
import json
import re
import time


# Fenced to Claude Code 2.x. Every read verifies the dialog text verbatim, so a
# patch release cannot change what the owner approves; a new major stops here.
CONTRACT = "claude-folder-trust/2"
VERSION_LABEL_RE = re.compile(r"Claude Code v(2\.\d{1,3}\.\d{1,4})(?![.\d])")
VERSION_PATH_RE = re.compile(r"(?<!\S)/\S*/claude/versions/(2\.\d{1,3}\.\d{1,4})(?=\s|$)")
PAINT_SECONDS = 3.0   # a TUI frame that is still being drawn
SETTLE_SECONDS = 5.0  # the dialog closing and the agent's main screen appearing
POINTER = "\u276f"
TRUST_LABEL = "Yes, I trust this folder"
CANCEL_LABELS = ("No, exit", "No, continue without these permissions")
DOWN = "\x1b[B"
ESCAPE = "\x1b"
TERMINAL_RE = re.compile(r"^term_[A-Za-z0-9-]{8,80}$")


class _PromptIncomplete(RuntimeError):
    pass


class FolderTrust:
    """Detect and resolve one live, provider-specific folder-trust prompt."""

    contract = CONTRACT
    agents = (None, "claude")
    confirm_key = DOWN

    def __init__(self, service):
        self.service = service

    def detect(self, handle, workspace, *, agent="claude"):
        """Return a private, identity-bound snapshot, or ``None`` if no prompt exists."""
        if agent == "codex" and type(self) is FolderTrust:
            return CodexFolderTrust(self.service).detect(handle, workspace)
        self._validate_address(handle, workspace)
        deadline = time.monotonic() + PAINT_SECONDS
        while True:
            capture = self._capture(handle, workspace)
            try:
                prompt = self._prompt(
                    capture["screen"], capture["terminal"]["worktreePath"]
                )
                break
            except _PromptIncomplete as exc:
                if time.monotonic() >= deadline:
                    raise RuntimeError(str(exc)) from exc
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        if prompt is None:
            return None
        return {
            "contract": self.contract,
            "runtimeId": capture["runtimeId"],
            "workspaceId": workspace,
            "worktreePath": capture["terminal"]["worktreePath"],
            "handle": handle,
            "incarnationId": capture["terminal"]["incarnationId"],
            "ptyId": capture["terminal"]["ptyId"],
            "selected": prompt["selected"],
            "promptHash": prompt["hash"],
        }

    def decide(self, snapshot, allow):
        """Apply one decision and prove that the exact current prompt disappeared.

        Raw terminal writes have no idempotent retry receipt.  Any exception or
        uncertain postcondition raises ``RuntimeError`` and the caller must mark
        the operation unknown rather than calling this method again.
        """
        if type(self) is FolderTrust and isinstance(snapshot, dict) and snapshot.get("contract") == CodexFolderTrust.contract:
            return CodexFolderTrust(self.service).decide(snapshot, allow)
        if type(allow) is not bool:
            raise ValueError("allow must be boolean")
        saved = self._validate_snapshot(snapshot)
        _, prompt = self._current_prompt(saved)
        receipts = []

        if allow and prompt["selected"] == "cancel":
            receipts.append(self._send(saved, text=self.confirm_key, expected_bytes=3, expected_selection="cancel"))
            self._wait_selection(saved, "confirm")
        elif allow and prompt["selected"] != "confirm":
            raise RuntimeError("Current trust selection is unverifiable")

        if allow:
            receipts.append(self._send(saved, enter=True, expected_bytes=1, expected_selection="confirm"))
        elif self.contract == CodexFolderTrust.contract:
            if prompt["selected"] == "confirm":
                receipts.append(self._send(saved, text=DOWN, expected_bytes=3, expected_selection="confirm"))
                self._wait_selection(saved, "cancel")
            receipts.append(self._send(saved, enter=True, expected_bytes=1, expected_selection="cancel"))
        else:
            receipts.append(self._send(saved, text=ESCAPE, expected_bytes=1))

        self._wait_idle(saved["handle"])
        self._wait_prompt_gone(saved)
        return {
            "accepted": True,
            "promptGone": True,
            "decision": "allow" if allow else "deny",
            "contract": self.contract,
            "runtimeId": saved["runtimeId"],
            "workspaceId": saved["workspaceId"],
            "handle": saved["handle"],
            "incarnationId": saved["incarnationId"],
            "receipts": receipts,
        }

    def _current_prompt(self, saved):
        capture = self._capture(saved["handle"], saved["workspaceId"])
        self._same_identity(saved, capture)
        prompt = self._prompt(capture["screen"], saved["worktreePath"])
        if prompt is None:
            raise RuntimeError("The approved trust prompt is no longer active")
        if prompt["hash"] != saved["promptHash"]:
            # A human may only move focus between the same two choices while the
            # owner decides.  The hash intentionally excludes the focus state.
            raise RuntimeError("The trust prompt changed after approval was requested")
        return capture, prompt

    def _wait_selection(self, saved, selected):
        deadline = time.monotonic() + PAINT_SECONDS
        while True:
            try:
                _, prompt = self._current_prompt(saved)
            except _PromptIncomplete:
                prompt = None
            if prompt is not None and prompt["selected"] == selected:
                return
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    "Trust selection did not move to confirmation; outcome unknown"
                )
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))

    def _wait_prompt_gone(self, saved):
        deadline = time.monotonic() + SETTLE_SECONDS
        while True:
            capture = self._capture(saved["handle"], saved["workspaceId"])
            self._same_identity(saved, capture)
            try:
                prompt = self._prompt(capture["screen"], saved["worktreePath"])
            except _PromptIncomplete:
                prompt = True
            if prompt is None:
                return
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    "Trust input was accepted but the prompt is still active; outcome unknown"
                )
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))

    def _capture(self, handle, workspace):
        before = self._status()
        first = self._show(handle, workspace)
        read = self.service.run_cli(
            ["terminal", "read", "--terminal", handle, "--screen", "--json"], timeout=8
        )
        screen = read.get("terminal", read) if isinstance(read, dict) else {}
        if (not isinstance(screen, dict) or screen.get("handle") != handle or
                screen.get("source") != "screen" or screen.get("status") != "running" or
                not isinstance(screen.get("truncated"), bool) or screen.get("limited") is not False or
                not isinstance(screen.get("tail"), list) or
                not all(isinstance(line, str) for line in screen["tail"])):
            raise RuntimeError("Current rendered terminal screen is unavailable")
        if screen["truncated"]:
            # Orca marks the normal Codex welcome screen truncated when its
            # scrollback exceeds the viewport. Never approve a clipped prompt.
            normal_codex = (self.contract == CodexFolderTrust.contract and
                            first.get("agentIdentity") == "codex" and not first.get("agentWait") and
                            any(re.match(r"^›\s*Ask Codex to do anything", re.sub(r"[\u2800-\u28ff]", "", line).strip()) for line in screen["tail"]) and
                            self._prompt(screen["tail"], first["worktreePath"]) is None)
            if not normal_codex:
                raise RuntimeError("Current trust screen is truncated")
        second = self._show(handle, workspace)
        after = self._status()
        if before != after:
            raise RuntimeError("Orca runtime changed while reading the trust prompt")
        self._match_terminals(first, second)
        return {"runtimeId": before, "terminal": second, "screen": screen["tail"]}

    def _status(self):
        result = self.service.run_cli(["status", "--json"], timeout=8)
        runtime = result.get("runtime", {}) if isinstance(result, dict) else {}
        runtime_id = runtime.get("runtimeId")
        if (runtime.get("state") != "ready" or runtime.get("reachable") is not True or
                not isinstance(runtime_id, str) or not runtime_id):
            raise RuntimeError("Orca runtime identity is unavailable")
        return runtime_id

    def _show(self, handle, workspace):
        result = self.service.run_cli(
            ["terminal", "show", "--terminal", handle, "--json"], timeout=8
        )
        term = result.get("terminal", result) if isinstance(result, dict) else {}
        if (not isinstance(term, dict) or term.get("handle") != handle or
                term.get("worktreeId") != workspace or
                not isinstance(term.get("worktreePath"), str) or
                not term.get("worktreePath") or not isinstance(term.get("ptyId"), str) or
                not term.get("ptyId") or not isinstance(term.get("incarnationId"), str) or
                not term.get("incarnationId") or
                not isinstance(term.get("tabId"), str) or not term.get("tabId") or
                not isinstance(term.get("leafId"), str) or not term.get("leafId") or
                term.get("orphaned") is not False or
                term.get("connected") is not True or term.get("writable") is not True or
                term.get("agentIdentity") not in self.agents):
            raise RuntimeError("Agent terminal identity is unavailable or changed")
        return term

    @staticmethod
    def _match_terminals(first, second):
        keys = ("handle", "worktreeId", "worktreePath", "ptyId", "incarnationId",
                "tabId", "leafId")
        if any(first.get(key) != second.get(key) for key in keys):
            raise RuntimeError("Terminal identity changed while reading the trust prompt")

    @staticmethod
    def _prompt(lines, worktree_path):
        markers = (
            "Accessing workspace:",
            "Quick safety check:",
            "Is this a project you created or one you trust?",
            TRUST_LABEL,
        )
        # A rendered row can wrap inside a word (raw concatenation) or at a
        # trimmed space (space-joined rows).  Accept those two exact forms only.
        present = [FolderTrust._contains_wrapped(lines, marker) for marker in markers]
        if not any(present):
            return None
        if not all(present):
            raise _PromptIncomplete("A partial Claude trust prompt cannot be approved")
        version = FolderTrust._version(lines)
        if version is None:
            raise RuntimeError("Unsupported or clipped Claude Code version on trust prompt")
        if worktree_path not in FolderTrust._displayed_paths(lines):
            raise RuntimeError("The trust prompt path is clipped or does not match the workspace")
        cancel_label = next((label for label in CANCEL_LABELS
                             if FolderTrust._contains_wrapped(lines, label)), None)
        if cancel_label is None:
            raise _PromptIncomplete("The trust prompt cancel choice is unavailable")

        confirm_focused = FolderTrust._focused(lines, TRUST_LABEL)
        cancel_focused = FolderTrust._focused(lines, cancel_label)
        if confirm_focused == cancel_focused:
            raise _PromptIncomplete("The current trust selection cannot be determined")
        canonical = {
            "contract": CONTRACT,
            "version": version,
            "path": worktree_path,
            "confirm": TRUST_LABEL,
            "cancel": cancel_label,
            # Focus is deliberately excluded: the owner may move it locally.
        }
        digest = hashlib.sha256(
            json.dumps(canonical, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return {"selected": "confirm" if confirm_focused else "cancel", "hash": digest}

    @staticmethod
    def _focused(lines, label):
        for index, line in enumerate(lines):
            if POINTER not in line:
                continue
            # The label can wrap, but its pointer remains on the first row.
            # Stop before another pointer so focus cannot bleed into a later
            # option when a very narrow terminal wraps both choices.
            first = line.split(POINTER, 1)[1].strip()
            following = [row.strip() for row in lines[index + 1:index + 6]]
            raw = first + "".join(following)
            spaced = " ".join([first, *following])
            if raw.startswith(label) or spaced.lstrip().startswith(label):
                return True
        return False

    @staticmethod
    def _displayed_paths(lines):
        """Extract the complete path between the two trust-dialog headings."""
        rows = [row.strip() for row in lines]
        # Depending on xterm wrapping, a token is split either inside a word
        # or at a trimmed space.  Parse both representations between exact
        # headings, rather than accepting a path as a substring.
        candidates = set()
        for rendered in ("".join(rows), " ".join(rows)):
            start = rendered.find("Accessing workspace:")
            if start < 0:
                continue
            start += len("Accessing workspace:")
            end = rendered.find("Quick safety check:", start)
            if end >= start:
                candidates.add(rendered[start:end].strip())
        return candidates

    @staticmethod
    def _version(lines):
        """Return the rendered Claude Code 2.x version, or None when absent or clipped."""
        for rendered in ("".join(lines), "".join(line.strip() for line in lines),
                         " ".join(" ".join(lines).split())):
            found = VERSION_LABEL_RE.search(rendered)
            if found:
                return found.group(1)
        access = next((index for index, line in enumerate(lines)
                       if "Accessing workspace:" in line), len(lines))
        for line in lines[:access]:
            found = VERSION_PATH_RE.search(line)
            if found:
                return found.group(1)
        return None

    @staticmethod
    def _contains_wrapped(lines, text):
        raw = "".join(lines)
        compact = "".join(line.strip() for line in lines)
        spaced = " ".join(" ".join(lines).split())
        return text in raw or text in compact or text in spaced

    def _send(self, saved, *, text=None, enter=False, expected_bytes, expected_selection=None):
        _, current = self._current_prompt(saved)
        if expected_selection and current["selected"] != expected_selection:
            raise RuntimeError("Trust selection changed before input; no input sent")
        argv = ["terminal", "send", "--terminal", saved["handle"]]
        if text is not None:
            argv += ["--text", text]
        if enter:
            argv.append("--enter")
        argv.append("--json")
        try:
            result = self.service.run_cli(argv, timeout=8)
        except Exception as exc:
            raise RuntimeError("Trust input outcome is unknown; do not retry") from exc
        send = result.get("send", result) if isinstance(result, dict) else {}
        if (not isinstance(send, dict) or send.get("accepted") is not True or
                send.get("handle") != saved["handle"] or
                send.get("bytesWritten") != expected_bytes or send.get("prompt") is not None):
            raise RuntimeError("Orca did not prove exact raw trust input acceptance")
        return {"handle": send["handle"], "bytesWritten": send["bytesWritten"]}

    def _wait_idle(self, handle):
        try:
            self.service.run_cli([
                "terminal", "wait", "--terminal", handle, "--for", "tui-idle",
                "--timeout-ms", "10000", "--json",
            ], timeout=12, allow_timeout=True)
        except Exception:
            # The following fenced screen read is authoritative.  A failed wait
            # does not authorize another write and is not itself success.
            pass

    @classmethod
    def _same_identity(cls, saved, capture):
        term = capture["terminal"]
        checks = {
            "runtimeId": capture["runtimeId"],
            "workspaceId": term.get("worktreeId"),
            "worktreePath": term.get("worktreePath"),
            "handle": term.get("handle"),
            "incarnationId": term.get("incarnationId"),
            "ptyId": term.get("ptyId"),
        }
        for key, actual in checks.items():
            if saved.get(key) != actual:
                raise RuntimeError(f"Trust target changed: {key}")
        agent = term.get("agentIdentity")
        if agent not in cls.agents:
            raise RuntimeError("Trust target is no longer the expected agent terminal")

    @staticmethod
    def _validate_address(handle, workspace):
        if not isinstance(handle, str) or not TERMINAL_RE.fullmatch(handle):
            raise ValueError("Invalid terminal handle")
        if not isinstance(workspace, str) or not workspace or len(workspace) > 4096:
            raise ValueError("Invalid workspace ID")

    @classmethod
    def _validate_snapshot(cls, snapshot):
        required = {
            "contract", "runtimeId", "workspaceId", "worktreePath", "handle",
            "incarnationId", "ptyId", "selected", "promptHash",
        }
        if not isinstance(snapshot, dict) or set(snapshot) != required:
            raise ValueError("Invalid trust snapshot")
        if snapshot.get("contract") != cls.contract:
            raise RuntimeError("Unsupported trust-dialog contract")
        FolderTrust._validate_address(snapshot.get("handle"), snapshot.get("workspaceId"))
        for key in ("runtimeId", "worktreePath", "incarnationId", "ptyId", "promptHash"):
            if not isinstance(snapshot.get(key), str) or not snapshot[key]:
                raise ValueError("Invalid trust snapshot")
        if snapshot.get("selected") not in ("cancel", "confirm"):
            raise ValueError("Invalid trust snapshot")
        return dict(snapshot)


class CodexFolderTrust(FolderTrust):
    """Exact two-choice Codex trust screen; no general permission automation."""

    contract = "codex-folder-trust/v1"
    agents = (None, "codex")
    confirm_key = "\x1b[A"

    @staticmethod
    def _prompt(lines, worktree_path):
        rows = [line.strip() for line in lines if line.strip()]
        heading = "> You are in "
        question = "Do you trust the contents of this directory?"
        if not any(heading in row for row in rows) and not FolderTrust._contains_wrapped(rows, question):
            return None
        joined = " ".join(rows)
        match = re.search(r"> You are in (.+?) Do you trust the contents of this directory\?", joined)
        if not match:
            raise _PromptIncomplete("A partial Codex trust prompt cannot be approved")
        if match.group(1) != worktree_path:
            raise RuntimeError("The trust prompt path is clipped or does not match the workspace")
        # Match the full warning and both choices, not keywords in arbitrary output.
        warning = ("Do you trust the contents of this directory? Working with untrusted "
                   "contents comes with higher risk of prompt injection. Trusting the directory "
                   "allows project-local config, hooks, and exec policies to load.")
        tail = joined[match.start():]
        tail = tail.replace("› ", "")
        expected = heading + worktree_path + " " + warning + " 1. Yes, continue 2. No, quit Press enter to continue"
        if tail != expected:
            raise _PromptIncomplete("Unsupported or incomplete Codex trust screen")
        yes = any(row == "› 1. Yes, continue" for row in rows)
        no = any(row == "› 2. No, quit" for row in rows)
        if yes == no:
            raise _PromptIncomplete("The current Codex trust selection cannot be determined")
        digest = hashlib.sha256((CodexFolderTrust.contract + "\n" + expected).encode()).hexdigest()
        return {"selected": "confirm" if yes else "cancel", "hash": digest}
