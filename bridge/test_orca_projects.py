import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import unittest

from orca_projects import OrcaProjectError, OrcaProjects

DISK_UUID = "00000000-0000-4000-8000-000000000001"


class Usage:
    free = 10 * 1024 * 1024 * 1024


class FakeService:
    def __init__(self):
        self.calls = []
        self.workspaces = []
        self.repo_failure = None
        self.terminal_failure = None
        self.wait_satisfied = True
        self.next_terminal = 0
        self.terminals = {}
        self.startup_ready = True

    def rpc(self, method, params, transcript_lookup=None):
        self.calls.append((method, dict(params)))
        if method == "ORCA_LIST":
            return {"ok": True, "workspaces": list(self.workspaces), "nextCursor": None}
        if method == "ORCA_BIND":
            return {"ok": True, "pair": {
                "id": "pair-1",
                "projectLabel": "Test",
                "workerAgent": "claude",
                "reviewerAgent": "codex",
            }}
        raise AssertionError(method)

    def run_cli(self, argv, timeout=8, allow_timeout=False):
        self.calls.append(("CLI", list(argv)))
        command = tuple(argv[:2])
        if command == ("repo", "add"):
            if self.repo_failure:
                raise self.repo_failure
            path = argv[argv.index("--path") + 1]
            # Match the real CLI contract, which rejects a plain directory.
            subprocess.run(["git", "-C", path, "rev-parse", "--verify", "HEAD"],
                           check=True, capture_output=True)
            self.workspaces.append({
                "id": "repo-1::" + path,
                "projectId": "project-1",
                "projectLabel": Path(path).name,
                "name": Path(path).name,
                "path": path,
                "kind": "folder",
            })
            return {"repo": {"id": "repo-1"}}
        if command == ("project", "setups"):
            path = self.workspaces[-1]["path"]
            # Durable projectId is not the compatibility repo UUID.
            if "--project" in argv:
                return {"setups": []}
            return {"setups": [{"id": "setup-1", "repoId": "project-1", "path": path}]}
        if command == ("project", "setup-update"):
            return {"setup": {"id": "setup-1"}}
        if command == ("terminal", "create"):
            if self.terminal_failure:
                raise self.terminal_failure
            self.next_terminal += 1
            handle = f"term-{self.next_terminal}"
            command = argv[argv.index("--command") + 1]
            agent = "codex" if "codex-safe" in command else "claude"
            self.terminals[handle] = {"handle": handle, "agentIdentity": agent,
                                     "worktreeId": argv[argv.index("--worktree") + 1][3:],
                                     "connected": True}
            return {"terminal": {"handle": handle}}
        if command == ("terminal", "show"):
            handle = argv[argv.index("--terminal") + 1]
            return {"terminal": self.terminals[handle] if self.startup_ready else {"handle": handle}}
        if command == ("terminal", "wait"):
            return {"wait": {"satisfied": self.wait_satisfied}}
        raise AssertionError(argv)


def fake_github(test, argv):
    """Fake gh/push shared by project and planning tests: never reaches GitHub, mirrors gh's remote setup."""
    test.github_calls.append(list(argv))
    tool = Path(argv[0]).name
    if tool == "gh" and argv[1:3] == ["api", "user"]:
        return "fikra-labs-official\n"
    if tool == "gh" and argv[1:3] == ["repo", "view"]:
        if argv[3] in test.github_repos:
            return f"https://github.com/{argv[3]}\n"
        raise RuntimeError("command failed")
    if tool == "gh" and argv[1:3] == ["repo", "create"]:
        assert "--private" in argv and "--public" not in argv
        test.github_repos.add(argv[3])
        path = argv[argv.index("--source") + 1]
        subprocess.run(["git", "-C", path, "remote", "add", "origin", f"https://github.com/{argv[3]}.git"],
                       check=True, capture_output=True)
        return "created\n"
    if tool == "git" and "push" in argv:
        return ""
    raise AssertionError(argv)


class OrcaProjectsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.internal = base / "internal"
        self.external = base / "external"
        self.internal.mkdir()
        self.external.mkdir()
        self.service = FakeService()
        self.github_calls, self.github_repos = [], set()
        self.disk = {
            "VolumeUUID": DISK_UUID,
            "MountPoint": "/Volumes/Data",
            "Writable": True,
        }
        self.projects = OrcaProjects(
            base / "state",
            self.service,
            roots={
                "internal": (self.internal, "Internal"),
                "external": (self.external, "External"),
            },
            disk_info=lambda: dict(self.disk),
            external_volume_uuid=DISK_UUID,
            external_mount="/Volumes/Data",
            disk_usage=lambda path: Usage(),
            model_catalog={
                "claude": ["", "claude-safe"],
                "codex": ["", "codex-safe"],
                "muse": [""],
            },
            agent_commands={
                "claude": "/bin/echo", "codex": "/bin/echo", "muse": "/bin/echo"
            },
            github_runner=lambda argv, timeout: fake_github(self, argv),
            sleep=lambda seconds: None,
        )

    def git_folder(self, name):
        folder = self.internal / name
        folder.mkdir()
        subprocess.run(["git", "-c", "init.templateDir=", "init", "-q", "--initial-branch=main", str(folder)], check=True)
        subprocess.run(["git", "-C", str(folder), "-c", "user.name=t", "-c", "user.email=t@localhost",
                        "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"], check=True)
        workspace = {"id": "repo-git::" + str(folder), "projectId": "project-git", "projectLabel": name,
                     "name": name, "path": str(folder), "kind": "git"}
        self.service.workspaces.append(workspace)
        return folder, workspace

    def tearDown(self):
        self.projects.close()
        self.temp.cleanup()

    def settle(self, operation_id):
        for _ in range(200):
            operation = self.projects.rpc("ORCA_OPERATION", {"id": operation_id})["operation"]
            if operation["state"] not in ("queued", "running"):
                return operation
            time.sleep(.005)
        self.fail("operation did not settle")

    def add_workspace(self):
        workspace = {
            "id": "repo-existing::/workspace",
            "projectId": "project-existing",
            "projectLabel": "Existing",
            "name": "workspace",
            "path": "/workspace",
            "kind": "folder",
        }
        self.service.workspaces.append(workspace)
        return workspace

    def test_roots_require_exact_external_disk_and_never_fallback(self):
        self.assertEqual(
            [root["id"] for root in self.projects.rpc("ORCA_ROOTS", {})["roots"]],
            ["internal", "external"],
        )
        self.disk["VolumeUUID"] = "wrong-disk"
        self.assertEqual(
            [root["id"] for root in self.projects.rpc("ORCA_ROOTS", {})["roots"]],
            ["internal"],
        )
        reply = self.projects.rpc(
            "ORCA_PROJECT_CREATE",
            {"id": "100-1", "textId": "speech-1", "rootId": "external"},
            lambda text_id: "External project",
        )
        self.assertEqual(reply["ok"], False)
        self.assertEqual(reply["code"], "PROJECT_REJECTED")
        self.assertIn("не подключён", reply["error"])
        self.assertFalse((self.external / "External project").exists())
        self.assertFalse((self.internal / "External project").exists())
        self.assertFalse(any(call[0] == "CLI" for call in self.service.calls))

    def test_folder_name_rejects_traversal_controls_and_symlink_overwrite(self):
        for index, name in enumerate(("../escape", "a/b", "a\\b", "a\0b", "x" * 101)):
            with self.subTest(name=repr(name)):
                reply = self.projects.rpc(
                    "ORCA_PROJECT_CREATE",
                    {"id": f"101-{index + 1}", "textId": "speech", "rootId": "internal"},
                    lambda text_id, value=name: value,
                )
                self.assertEqual(reply["ok"], False)
                self.assertEqual(reply["code"], "PROJECT_REJECTED")
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        os.symlink(outside, self.internal / "linked")
        self.projects.rpc(
            "ORCA_PROJECT_CREATE",
            {"id": "102-1", "textId": "speech", "rootId": "internal"},
            lambda text_id: "linked",
        )
        operation = self.settle("102-1")
        self.assertEqual(operation["state"], "error")
        self.assertIn("существует", operation["message"])
        self.assertEqual(list(outside.iterdir()), [])

    def test_project_creation_is_live_discovered_and_duplicate_id_is_idempotent(self):
        params = {"id": "103-1", "textId": "speech", "rootId": "external"}
        first = self.projects.rpc(
            "ORCA_PROJECT_CREATE", params, lambda text_id: "  Café project  "
        )["operation"]
        self.assertIn(first["state"], ("queued", "running"))
        completed = self.settle("103-1")
        self.assertEqual(completed["state"], "completed")
        self.assertEqual(completed["workspace"]["path"], str(self.external / "Café project"))
        self.assertTrue((self.external / "Café project").is_dir())
        checkout = self.external / "Café project"
        self.assertEqual(subprocess.check_output(
            ["git", "-C", str(checkout), "branch", "--show-current"], text=True).strip(), "main")
        self.assertEqual(subprocess.check_output(
            ["git", "-C", str(checkout), "ls-tree", "--name-only", "HEAD"], text=True), "")
        self.assertEqual(subprocess.check_output(
            ["git", "-C", str(checkout), "status", "--porcelain"], text=True), "")
        second = self.projects.rpc(
            "ORCA_PROJECT_CREATE", params, lambda text_id: "Café project"
        )["operation"]
        self.assertEqual(second["state"], "completed")
        repo_adds = [call for call in self.service.calls if call[:2] == ("CLI", [
            "repo", "add", "--path", str(self.external / "Café project"), "--json"
        ])]
        self.assertEqual(len(repo_adds), 1)
        updates = [call for call in self.service.calls if call[0] == "CLI" and call[1][:2] == [
            "project", "setup-update"
        ]]
        self.assertEqual(len(updates), 1)
        self.assertIn("--worktree-base-path", updates[0][1])
        self.assertEqual(updates[0][1][updates[0][1].index("--worktree-base-path") + 1], str(self.external))
        second = self.projects.rpc(
            "ORCA_PROJECT_CREATE", params,
            lambda text_id: self.fail("existing operation reparsed its transcript"),
        )
        self.assertEqual(second["operation"]["state"], "completed")
        with self.assertRaisesRegex(OrcaProjectError, "ID уже используется"):
            self.projects.rpc(
                "ORCA_PROJECT_CREATE",
                {"id": "103-1", "textId": "different", "rootId": "external"},
                lambda text_id: "Different",
            )
        with self.assertRaisesRegex(OrcaProjectError, "ID уже используется"):
            self.projects.rpc(
                "ORCA_PROJECT_CREATE",
                {"id": "103-1", "textId": "speech", "rootId": "internal"},
                lambda text_id: "Different",
            )

    def test_spoken_project_creates_claude_pair_with_exact_installed_model(self):
        self.projects.injected_models["claude"].append({
            "id": "claude-opus-5-5-20260901", "label": "Opus 5.5"
        })
        transcript = (
            "Так, сделаем мне новый проект. Там открой клод-код боевой и клод-код "
            "проверяющий. По умолчанию опус 5,5 должны быть в обоих. И проект "
            "называется у нас будет такси дубай. Понял? Все, давай."
        )
        params = {"id": "103-2", "textId": "speech", "rootId": "internal"}
        first = self.projects.rpc("ORCA_PROJECT_CREATE", params, lambda text_id: transcript)
        self.assertTrue(first["ok"])
        operation = self.settle("103-2")
        self.assertEqual(operation["state"], "completed")
        self.assertEqual(operation["workspace"]["path"], str(self.internal / "такси дубай"))
        self.assertEqual(operation["pair"]["id"], "pair-1")
        creates = [call[1] for call in self.service.calls
                   if call[0] == "CLI" and call[1][:2] == ["terminal", "create"]]
        self.assertEqual(len(creates), 2)
        for argv in creates:
            self.assertEqual(
                shlex_split(argv[argv.index("--command") + 1]),
                ["/bin/echo", "--permission-mode", "auto", "--model", "claude-opus-5-5-20260901"],
            )

        repeated = self.projects.rpc("ORCA_PROJECT_CREATE", params, lambda text_id: transcript)
        self.assertEqual(repeated["operation"]["state"], "completed")
        repo_adds = [call for call in self.service.calls
                     if call[0] == "CLI" and call[1][:2] == ["repo", "add"]]
        self.assertEqual(len(repo_adds), 1)
        self.assertEqual(len([
            call for call in self.service.calls
            if call[0] == "CLI" and call[1][:2] == ["terminal", "create"]
        ]), 2)

        self.projects.injected_models["claude"] = [""]
        self.projects.roots["internal"] = (Path(self.temp.name) / "missing" / "root", "Missing")
        durable = self.projects.rpc(
            "ORCA_PROJECT_CREATE", params,
            lambda text_id: self.fail("completed operation reparsed its transcript"),
        )
        self.assertEqual(durable["operation"]["state"], "completed")

    def test_spoken_decimal_dot_and_english_claude_code_are_preserved(self):
        self.projects.injected_models["claude"].append("claude-opus-5-5")
        transcript = (
            "Сделай новый проект. Открой Claude Code боевой и Claude Code проверяющий. "
            "Opus 5.5 должны быть в обоих. Назови проект Decimal model."
        )
        reply = self.projects.rpc(
            "ORCA_PROJECT_CREATE",
            {"id": "103-7", "textId": "speech", "rootId": "internal"},
            lambda text_id: transcript,
        )
        self.assertTrue(reply["ok"])
        self.assertEqual(self.settle("103-7")["state"], "completed")

    def test_plain_and_explicit_names_reject_control_characters(self):
        for index, transcript in enumerate((
            "bad\nname",
            "Сделай новый проект. Назови проект bad\nname.",
        )):
            with self.subTest(transcript=transcript):
                reply = self.projects.rpc(
                    "ORCA_PROJECT_CREATE",
                    {"id": f"103-{index + 8}", "textId": "speech", "rootId": "internal"},
                    lambda text_id, value=transcript: value,
                )
                self.assertEqual(reply["code"], "PROJECT_REJECTED")

    def test_unparsed_instructions_never_become_folder_names(self):
        for index, text in enumerate((
            "Создай новый проект такси дубай и запусти агентов",
            "Открой проект с агентами",
            "Claude Code боевой и проверяющий",
        )):
            reply = self.projects.rpc("ORCA_PROJECT_CREATE", {
                "id": f"103-{index + 30}", "textId": "speech", "rootId": "internal"
            }, lambda text_id, value=text: value)
            self.assertEqual(reply["code"], "PROJECT_REJECTED")
        self.assertFalse(list(self.internal.iterdir()))

    def test_spoken_project_rejects_bad_name_and_unknown_or_ambiguous_model(self):
        bad_name = self.projects.rpc(
            "ORCA_PROJECT_CREATE",
            {"id": "103-3", "textId": "speech", "rootId": "internal"},
            lambda text_id: "Назови проект a/b.",
        )
        self.assertEqual(bad_name["code"], "PROJECT_REJECTED")

        template = (
            "Сделай мне новый проект. Открой клод-код боевой и клод-код проверяющий. "
            "{model} должны быть в обоих. Проект называется Test."
        )
        unknown = self.projects.rpc(
            "ORCA_PROJECT_CREATE",
            {"id": "103-4", "textId": "speech", "rootId": "internal"},
            lambda text_id: template.format(model="Опус 9,9"),
        )
        self.assertEqual(unknown["code"], "PROJECT_REJECTED")
        self.assertIn("Модель не найдена", unknown["error"])

        self.projects.injected_models["claude"].extend((
            {"id": "opus-a", "label": "Opus 5.5"},
            {"id": "opus-b", "label": "Opus 5.5"},
        ))
        ambiguous = self.projects.rpc(
            "ORCA_PROJECT_CREATE",
            {"id": "103-5", "textId": "speech", "rootId": "internal"},
            lambda text_id: template.format(model="Опус 5,5"),
        )
        self.assertEqual(ambiguous["code"], "PROJECT_REJECTED")
        self.assertIn("неоднозначно", ambiguous["error"])
        count = self.projects.db.execute(
            "SELECT count(*) FROM operations WHERE id IN ('103-3','103-4','103-5')"
        ).fetchone()[0]
        self.assertEqual(count, 0)
        self.assertFalse(any(call[0] == "CLI" for call in self.service.calls))

    def test_spoken_project_preserves_partial_pair_without_retry(self):
        self.projects.injected_models["claude"].append({
            "id": "claude-opus-5-5", "label": "Opus 5.5"
        })
        original = self.service.run_cli

        def fail_second_terminal(argv, timeout=8, allow_timeout=False):
            if argv[:2] == ["terminal", "create"] and self.service.next_terminal == 1:
                raise RuntimeError("second receipt lost")
            return original(argv, timeout=timeout, allow_timeout=allow_timeout)

        self.service.run_cli = fail_second_terminal
        transcript = (
            "Сделай новый проект. Открой клод-код боевой и клод-код проверяющий. "
            "Опус 5,5 должны быть в обоих. Назови проект Partial pair."
        )
        params = {"id": "103-6", "textId": "speech", "rootId": "internal"}
        self.projects.rpc("ORCA_PROJECT_CREATE", params, lambda text_id: transcript)
        operation = self.settle("103-6")
        self.assertEqual(operation["state"], "unknown")
        self.assertEqual(operation["workspace"]["path"], str(self.internal / "Partial pair"))
        self.assertTrue((self.internal / "Partial pair").is_dir())
        self.projects.injected_models["claude"] = [""]
        self.projects.roots["internal"] = (Path(self.temp.name) / "missing" / "root", "Missing")
        repeated = self.projects.rpc(
            "ORCA_PROJECT_CREATE", params,
            lambda text_id: self.fail("partial operation reparsed its transcript"),
        )
        self.assertEqual(repeated["operation"]["state"], "unknown")
        self.assertEqual(self.service.next_terminal, 1)
        self.assertEqual(len([
            call for call in self.service.calls
            if call[0] == "CLI" and call[1][:2] == ["repo", "add"]
        ]), 1)

    def test_missing_operation_is_a_definite_not_found_response(self):
        for params in ({"id": "999-1"}, {}):
            with self.subTest(params=params):
                reply = self.projects.rpc("ORCA_OPERATION", params)
                self.assertEqual(reply, {
                    "ok": False,
                    "code": "OPERATION_NOT_FOUND",
                    "error": "Операция не найдена",
                })

    def test_partial_injected_model_catalog_falls_back_for_other_agents(self):
        projects = OrcaProjects(
            Path(self.temp.name) / "partial-catalog-state",
            self.service,
            roots={"internal": (self.internal, "Internal")},
            disk_usage=lambda path: Usage(),
            command_runner=lambda argv, timeout: "--model sonnet opus haiku fable",
            model_catalog={"codex": ["", "codex-safe"]},
            agent_commands={"claude": "/bin/echo", "codex": "/bin/echo"},
            sleep=lambda seconds: None,
        )
        try:
            ids = [item["id"] for item in projects.models("claude")]
            self.assertIn("opus", ids)
        finally:
            projects.close()

    def test_partial_project_failure_keeps_folder_and_does_not_retry(self):
        self.service.repo_failure = ValueError("repo rejected")
        params = {"id": "104-1", "textId": "speech", "rootId": "internal"}
        self.projects.rpc("ORCA_PROJECT_CREATE", params, lambda text_id: "Partial")
        operation = self.settle("104-1")
        self.assertEqual(operation["state"], "error")
        self.assertTrue((self.internal / "Partial").is_dir())
        self.projects.rpc("ORCA_PROJECT_CREATE", params, lambda text_id: "Partial")
        repo_adds = [call for call in self.service.calls if call[0] == "CLI" and call[1][:2] == [
            "repo", "add"
        ]]
        self.assertEqual(len(repo_adds), 1)

    def test_git_initialization_failure_does_not_register_project(self):
        def fail(argv, timeout):
            raise RuntimeError("git unavailable")
        self.projects.command_runner = fail
        self.projects.rpc("ORCA_PROJECT_CREATE", {
            "id": "104-2", "textId": "speech", "rootId": "external"
        }, lambda text_id: "Failed initialization")
        operation = self.settle("104-2")
        self.assertEqual(operation["state"], "error")
        self.assertIn("Git", operation["message"])
        self.assertTrue((self.external / "Failed initialization").is_dir())
        self.assertFalse(any(call[0] == "CLI" for call in self.service.calls))

    def test_unknown_terminal_receipt_never_launches_again(self):
        workspace = self.add_workspace()
        self.service.terminal_failure = RuntimeError("receipt lost")
        params = {
            "id": "105-1",
            "workspaceId": workspace["id"],
            "presetId": "claude-codex",
        }
        self.projects.rpc("ORCA_PAIR_CREATE", params)
        operation = self.settle("105-1")
        self.assertEqual(operation["state"], "unknown")
        self.assertIn("не создавался повторно", operation["message"])
        self.projects.rpc("ORCA_PAIR_CREATE", params)
        creates = [call for call in self.service.calls if call[0] == "CLI" and call[1][:2] == [
            "terminal", "create"
        ]]
        self.assertEqual(len(creates), 1)

    def test_pair_uses_exact_workspace_and_allowlisted_models_then_binds(self):
        workspace = self.add_workspace()
        with self.assertRaises(OrcaProjectError):
            self.projects.rpc("ORCA_PAIR_CREATE", {
                "id": "106-1",
                "workspaceId": workspace["id"],
                "presetId": "claude-codex",
                "models": {"worker": "$(touch /tmp/not-allowed)"},
            })
        self.assertFalse(any(
            call[0] == "CLI" and call[1][:2] == ["terminal", "create"]
            for call in self.service.calls
        ))

        self.projects.rpc("ORCA_PAIR_CREATE", {
            "id": "106-2",
            "workspaceId": workspace["id"],
            "presetId": "claude-codex",
            "models": {"worker": "claude-safe", "reviewer": "codex-safe"},
        })
        operation = self.settle("106-2")
        self.assertEqual(operation["state"], "completed")
        self.assertEqual(operation["pair"]["id"], "pair-1")
        creates = [call[1] for call in self.service.calls if call[0] == "CLI" and call[1][:2] == [
            "terminal", "create"
        ]]
        self.assertEqual(len(creates), 2)
        for argv, model in zip(creates, ("claude-safe", "codex-safe")):
            self.assertEqual(argv[argv.index("--worktree") + 1], "id:" + workspace["id"])
            command = argv[argv.index("--command") + 1]
            self.assertEqual(shlex_split(command), ["/bin/echo", *(["--approve-for-me", "-c", "check_for_update_on_startup=false"]
                                                     if model == "codex-safe" else ["--permission-mode", "auto"]), "--model", model])
        binds = [call for call in self.service.calls if call[0] == "ORCA_BIND"]
        self.assertEqual(binds[-1][1], {
            "workspaceId": workspace["id"], "workerId": "term-1", "reviewerId": "term-2"
        })

    def test_launch_modes_are_catalogued_validated_and_applied(self):
        modes = self.projects.rpc("ORCA_MODES", {"agent": "claude", "limit": 10})["modes"]
        self.assertEqual([m["id"] for m in modes], ["auto", "plan", "acceptEdits", "bypass"])
        codex = self.projects.rpc("ORCA_MODES", {"agent": "codex", "limit": 10})["modes"]
        self.assertEqual([m["id"] for m in codex], ["auto", "read-only", "bypass"])
        # An empty mode is the configured default (auto), or nothing for agents without one.
        self.assertEqual(self.projects._mode_flags("claude", ""), ["--permission-mode", "auto"])
        self.assertEqual(self.projects._mode_flags("codex", None), ["--approve-for-me"])
        self.assertEqual(self.projects._mode("claude", ""), "auto")
        self.projects.default_mode = ""
        self.assertEqual(self.projects._mode_flags("claude", ""), [])
        self.assertEqual(self.projects._mode("claude", ""), "")
        self.projects.default_mode = "auto"
        with self.assertRaises(OrcaProjectError):
            self.projects.rpc("ORCA_MODES", {"agent": "shell"})
        workspace = self.add_workspace()
        for bad in ({"mode": "--dangerously-skip-permissions"}, {"mode": "auto; rm -rf /"}, {"mode": 5}):
            with self.assertRaises(OrcaProjectError):
                self.projects.rpc("ORCA_AGENT_CREATE", {"id": "107-0", "workspaceId": workspace["id"],
                                                        "agent": "claude", **bad})
        with self.assertRaises(OrcaProjectError):
            self.projects.rpc("ORCA_PAIR_CREATE", {"id": "107-0", "workspaceId": workspace["id"],
                                                   "presetId": "claude-codex", "modes": {"worker": "read-only"}})
        self.assertFalse(any(call[0] == "CLI" and call[1][:2] == ["terminal", "create"] for call in self.service.calls))
        self.projects.rpc("ORCA_AGENT_CREATE", {"id": "107-1", "workspaceId": workspace["id"],
                                                "agent": "claude", "model": "claude-safe", "mode": "plan"})
        operation = self.settle("107-1")
        self.assertEqual(operation["state"], "completed")
        self.assertEqual(operation["agent"]["mode"], "plan")
        pair = {"id": "107-2", "workspaceId": workspace["id"], "presetId": "claude-codex",
                "models": {"worker": "claude-safe", "reviewer": "codex-safe"}, "modes": {"worker": "bypass", "reviewer": "auto"}}
        self.projects.rpc("ORCA_PAIR_CREATE", pair)
        self.assertEqual(self.settle("107-2")["state"], "completed")
        commands = [shlex_split(call[1][call[1].index("--command") + 1]) for call in self.service.calls
                    if call[0] == "CLI" and call[1][:2] == ["terminal", "create"]]
        self.assertEqual(commands[0], ["/bin/echo", "--permission-mode", "plan", "--model", "claude-safe"])
        self.assertEqual(commands[1], ["/bin/echo", "--dangerously-skip-permissions", "--model", "claude-safe"])
        self.assertEqual(commands[2], ["/bin/echo", "--approve-for-me", "-c", "check_for_update_on_startup=false", "--model", "codex-safe"])
        # A repeated operation id must not silently relaunch with a different mode.
        self.projects.rpc("ORCA_PAIR_CREATE", pair)
        with self.assertRaises(OrcaProjectError):
            self.projects.rpc("ORCA_PAIR_CREATE", {**pair, "modes": {"worker": "plan", "reviewer": "auto"}})
        self.assertEqual(len(commands), 3)

    def test_github_repository_is_private_once_and_reuses_existing(self):
        from orca_projects import github_slug
        self.assertEqual(github_slug("Такси Дубай"), "taksi-dubay")
        self.assertEqual(github_slug("CRM для маркетолога"), "crm-dlya-marketologa")
        self.assertEqual(github_slug("Проект Щи и Ёж 2"), "proekt-shchi-i-yozh-2")
        self.assertIsNone(github_slug("???"))
        folder, workspace = self.git_folder("Такси Дубай")
        with self.assertRaises(OrcaProjectError):
            self.projects.rpc("ORCA_GITHUB_CREATE", {"id": "108-0", "workspaceId": "repo-none::/nowhere"})
        self.projects.rpc("ORCA_GITHUB_CREATE", {"id": "108-1", "workspaceId": workspace["id"]})
        done = self.settle("108-1")
        self.assertEqual(done["state"], "completed")
        self.assertEqual(done["github"], {"url": "https://github.com/fikra-labs-official/taksi-dubay", "existing": False, "private": True})
        self.assertIn("Приватный репозиторий создан: https://github.com/fikra-labs-official/taksi-dubay", done["message"])
        create = next(c for c in self.github_calls if c[1:3] == ["repo", "create"])
        self.assertEqual(create[3], "fikra-labs-official/taksi-dubay")
        self.assertEqual(create[create.index("--source") + 1], str(folder))
        self.assertTrue(any(c[0] == "git" and "push" in c for c in self.github_calls))
        remote = subprocess.run(["git", "-C", str(folder), "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
        self.assertEqual(remote, "https://github.com/fikra-labs-official/taksi-dubay.git")
        # Second request for the same folder only reports the existing origin.
        before = len(self.github_calls)
        self.projects.rpc("ORCA_GITHUB_CREATE", {"id": "108-2", "workspaceId": workspace["id"]})
        again = self.settle("108-2")
        self.assertIn("Репозиторий подключён", again["message"])
        self.assertTrue(again["github"]["existing"])
        self.assertEqual(len(self.github_calls), before)
        # A repository that already exists on GitHub is connected, not created again.
        folder2, workspace2 = self.git_folder("CRM для маркетолога")
        self.github_repos.add("fikra-labs-official/crm-dlya-marketologa")
        self.projects.rpc("ORCA_GITHUB_CREATE", {"id": "108-3", "workspaceId": workspace2["id"]})
        linked = self.settle("108-3")
        self.assertEqual(linked["state"], "completed")
        self.assertFalse(any(c[1:3] == ["repo", "create"] and c[3].endswith("marketologa") for c in self.github_calls))
        remote2 = subprocess.run(["git", "-C", str(folder2), "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
        self.assertEqual(remote2, "https://github.com/fikra-labs-official/crm-dlya-marketologa")

    def test_idle_trust_dialog_is_not_a_ready_agent(self):
        workspace = self.add_workspace()
        self.service.startup_ready = False
        self.projects.rpc("ORCA_PAIR_CREATE", {
            "id": "106-5", "workspaceId": workspace["id"], "presetId": "claude-claude"
        })
        operation = self.settle("106-5")
        self.assertEqual(operation["state"], "unknown")
        self.assertIn("первого запуска", operation["message"])
        self.assertEqual(self.service.next_terminal, 1)
        self.assertFalse(any(call[0] == "ORCA_BIND" for call in self.service.calls))

    def test_presets_models_and_single_agent_creation_are_bounded(self):
        first = self.projects.rpc("ORCA_PRESETS", {"limit": 3})
        self.assertEqual([item["id"] for item in first["presets"]], [
            "claude-claude", "codex-codex", "claude-codex"
        ])
        second = self.projects.rpc("ORCA_PRESETS", {
            "cursor": first["nextCursor"], "limit": 3
        })
        self.assertEqual([item["id"] for item in second["presets"]], ["codex-claude"])
        models = self.projects.rpc("ORCA_MODELS", {"agent": "claude"})["models"]
        self.assertEqual([item["id"] for item in models], ["", "claude-safe"])
        agents = self.projects.rpc("ORCA_AGENTS", {})["agents"]
        self.assertEqual([item["id"] for item in agents], ["claude", "codex", "muse"])

        workspace = self.add_workspace()
        self.projects.rpc("ORCA_AGENT_CREATE", {
            "id": "106-3", "workspaceId": workspace["id"],
            "agent": "claude", "model": "claude-safe",
        })
        operation = self.settle("106-3")
        self.assertEqual(operation["state"], "completed")
        self.assertEqual(operation["agent"], {
            "id": "term-1", "agent": "claude", "model": "claude-safe", "mode": "auto"
        })
        self.assertEqual(
            [item["id"] for item in self.projects.rpc(
                "ORCA_MODELS", {"agent": "muse"})["models"]],
            [""],
        )
        self.projects.rpc("ORCA_AGENT_CREATE", {
            "id": "106-4", "workspaceId": workspace["id"], "agent": "muse",
        })
        muse = self.settle("106-4")
        self.assertEqual(muse["agent"], {"id": "term-2", "agent": "muse", "model": "", "mode": ""})
        create = [call[1] for call in self.service.calls
                  if call[0] == "CLI" and call[1][:2] == ["terminal", "create"]][-1]
        self.assertEqual(shlex_split(create[create.index("--command") + 1]), ["/bin/echo"])

    def test_restart_marks_inflight_operation_unknown(self):
        database = Path(self.temp.name) / "state" / "orca-projects.sqlite3"
        self.projects.close()
        with sqlite3.connect(database) as db:
            db.execute(
                "INSERT INTO operations(id,kind,params,state,created,updated) VALUES (?,?,?,?,?,?)",
                ("107-1", "agent", "{}", "running", time.time(), time.time()),
            )
            db.commit()
        self.projects = OrcaProjects(
            Path(self.temp.name) / "state", self.service,
            roots={"internal": (self.internal, "Internal")},
            disk_usage=lambda path: Usage(), model_catalog={"claude": [""]},
            agent_commands={"claude": "/bin/echo"}, sleep=lambda seconds: None,
        )
        operation = self.projects.rpc("ORCA_OPERATION", {"id": "107-1"})["operation"]
        self.assertEqual(operation["state"], "unknown")


def shlex_split(command):
    import shlex
    return shlex.split(command)


if __name__ == "__main__":
    unittest.main()
