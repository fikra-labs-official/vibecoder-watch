import unittest

from orca_trust import FolderTrust


WORKSPACE = "repo-1::/tmp/Trusted Project"
PATH = "/tmp/Trusted Project"
HANDLE = "term_12345678-abcd"


class FakeService:
    def __init__(self, *, selected="cancel"):
        self.runtime = "runtime-1"
        self.path = PATH
        self.incarnation = "incarnation-1"
        self.selected = selected
        self.prompt = True
        self.calls = []
        self.fail_send_number = None
        self.send_count = 0

    def run_cli(self, argv, timeout=8, allow_timeout=False):
        self.calls.append(list(argv))
        if argv[0] == "status":
            return {"runtime": {"state": "ready", "reachable": True,
                                "runtimeId": self.runtime}}
        if argv[:2] == ["terminal", "show"]:
            return {"terminal": {
                "handle": HANDLE, "worktreeId": WORKSPACE, "worktreePath": self.path,
                "ptyId": "pty-1", "incarnationId": self.incarnation,
                "tabId": "tab-1", "leafId": "leaf-1", "orphaned": False,
                "connected": True, "writable": True,
                "agentIdentity": None if self.prompt else "claude",
            }}
        if argv[:2] == ["terminal", "read"]:
            return {"terminal": {"handle": HANDLE, "status": "running",
                                 "source": "screen", "truncated": False,
                                 "limited": False, "tail": self._screen()}}
        if argv[:2] == ["terminal", "wait"]:
            return {"wait": {"satisfied": True}}
        if argv[:2] == ["terminal", "send"]:
            self.send_count += 1
            if self.fail_send_number == self.send_count:
                raise RuntimeError("transport lost")
            if "--enter" in argv:
                self.prompt = False
                size = 1
            else:
                text = argv[argv.index("--text") + 1]
                size = len(text.encode())
                if text == "\x1b[B":
                    self.selected = "confirm"
                elif text == "\x1b":
                    self.prompt = False
            return {"send": {"accepted": True, "handle": HANDLE,
                             "bytesWritten": size}}
        raise AssertionError(argv)

    def _screen(self):
        if not self.prompt:
            return ["me@mac Trusted Project %"]
        yes = ("\u276f " if self.selected == "confirm" else "  ") + "Yes, I trust this folder"
        no = ("\u276f " if self.selected == "cancel" else "  ") + "No, exit"
        return [
            "me@mac Trusted Project % /Users/me/.local/share/claude/versions/2.1.283 --model claude-opus-5-5",
            "─" * 80,
            "Accessing workspace:", PATH,
            "Quick safety check: Is this a project you created or one you trust? (Like your own code,",
            "a well-known open source project, or work from your team).",
            "Claude Code'll be able to read, edit, and execute files here.",
            no, yes, "Enter to confirm · Esc to cancel",
        ]


class FolderTrustTests(unittest.TestCase):
    def test_allow_moves_from_default_cancel_then_confirms(self):
        service = FakeService()
        trust = FolderTrust(service)
        snapshot = trust.detect(HANDLE, WORKSPACE)
        self.assertEqual(snapshot["selected"], "cancel")
        receipt = trust.decide(snapshot, True)
        self.assertTrue(receipt["accepted"])
        self.assertTrue(receipt["promptGone"])
        sends = [call for call in service.calls if call[:2] == ["terminal", "send"]]
        self.assertEqual(sends[0][sends[0].index("--text") + 1], "\x1b[B")
        self.assertIn("--enter", sends[1])

    def test_allow_uses_only_enter_when_owner_already_selected_yes(self):
        service = FakeService(selected="confirm")
        trust = FolderTrust(service)
        receipt = trust.decide(trust.detect(HANDLE, WORKSPACE), True)
        self.assertEqual(len(receipt["receipts"]), 1)
        sends = [call for call in service.calls if call[:2] == ["terminal", "send"]]
        self.assertEqual(len(sends), 1)
        self.assertIn("--enter", sends[0])

    def test_deny_uses_escape_and_proves_prompt_gone(self):
        service = FakeService()
        trust = FolderTrust(service)
        receipt = trust.decide(trust.detect(HANDLE, WORKSPACE), False)
        self.assertEqual(receipt["decision"], "deny")
        sends = [call for call in service.calls if call[:2] == ["terminal", "send"]]
        self.assertEqual(sends[0][sends[0].index("--text") + 1], "\x1b")

    def test_ambiguous_send_is_never_retried(self):
        service = FakeService()
        trust = FolderTrust(service)
        snapshot = trust.detect(HANDLE, WORKSPACE)
        service.fail_send_number = 1
        with self.assertRaisesRegex(RuntimeError, "do not retry"):
            trust.decide(snapshot, True)
        sends = [call for call in service.calls if call[:2] == ["terminal", "send"]]
        self.assertEqual(len(sends), 1)

    def test_ambiguous_enter_is_never_retried(self):
        service = FakeService()
        trust = FolderTrust(service)
        snapshot = trust.detect(HANDLE, WORKSPACE)
        service.fail_send_number = 2
        with self.assertRaisesRegex(RuntimeError, "do not retry"):
            trust.decide(snapshot, True)
        sends = [call for call in service.calls if call[:2] == ["terminal", "send"]]
        self.assertEqual(len(sends), 2)
        self.assertEqual(sum("--enter" in call for call in sends), 1)

    def test_changed_runtime_incarnation_or_path_stops_before_input(self):
        for attribute, value in (("runtime", "runtime-2"),
                                 ("incarnation", "incarnation-2"),
                                 ("path", "/tmp/Other")):
            with self.subTest(attribute=attribute):
                service = FakeService()
                trust = FolderTrust(service)
                snapshot = trust.detect(HANDLE, WORKSPACE)
                setattr(service, attribute, value)
                with self.assertRaises(RuntimeError):
                    trust.decide(snapshot, True)
                self.assertEqual(service.send_count, 0)

    def test_stale_prompt_stops_before_input(self):
        service = FakeService()
        trust = FolderTrust(service)
        snapshot = trust.detect(HANDLE, WORKSPACE)
        service.prompt = False
        with self.assertRaisesRegex(RuntimeError, "no longer active"):
            trust.decide(snapshot, True)
        self.assertEqual(service.send_count, 0)

    def test_clipped_prompt_path_is_rejected(self):
        service = FakeService()
        service.path = "/tmp/A much longer workspace path"
        trust = FolderTrust(service)
        with self.assertRaisesRegex(RuntimeError, "path is clipped"):
            trust.detect(HANDLE, WORKSPACE)

    def test_path_prefix_and_unsupported_claude_version_are_rejected(self):
        service = FakeService()
        service.path = PATH.removesuffix(" Project")
        trust = FolderTrust(service)
        with self.assertRaisesRegex(RuntimeError, "path is clipped"):
            trust.detect(HANDLE, WORKSPACE)

        # Any Claude Code 2.x renders the same verified dialog; a new major or
        # a clipped version line is never approved.
        for replacement, accepted in (("versions/2.1.284", True), ("versions/2.9.0", True),
                                      ("versions/3.0.0", False), ("versions/", False)):
            with self.subTest(version=replacement):
                service = FakeService()
                original = service._screen
                service._screen = lambda: [line.replace("versions/2.1.283", replacement) for line in original()]
                if accepted:
                    self.assertEqual(FolderTrust(service).detect(HANDLE, WORKSPACE)["selected"], "cancel")
                else:
                    with self.assertRaisesRegex(RuntimeError, "Unsupported or clipped"):
                        FolderTrust(service).detect(HANDLE, WORKSPACE)

    def test_normal_claude_screen_is_not_mistaken_for_trust_prompt(self):
        service = FakeService()
        service.prompt = False
        service._screen = lambda: [
            " ▐▋███▋█   Claude Code v2.1.283",
            "❯ Try fixing a bug",
        ]
        self.assertIsNone(FolderTrust(service).detect(HANDLE, WORKSPACE))

    def test_detect_retries_a_partially_painted_prompt(self):
        service = FakeService()
        complete = service._screen()
        screens = iter(([complete[2]], complete))
        service._screen = lambda: next(screens)
        snapshot = FolderTrust(service).detect(HANDLE, WORKSPACE)
        self.assertEqual(snapshot["selected"], "cancel")

    def test_wrapped_path_and_choices_keep_exact_identity_and_focus(self):
        service = FakeService()
        service._screen = lambda: [
            "me@mac % /Users/me/.local/share/claude/versions/2.1.283 --model claude-opus-5-5",
            "Accessing workspace:", "/tmp/Trusted", "Project",
            "Quick safety check: Is this a project you created or one you trust?",
            "❯ No, ex", "it", "  Yes, I trust this fol", "der",
        ]
        snapshot = FolderTrust(service).detect(HANDLE, WORKSPACE)
        self.assertEqual(snapshot["worktreePath"], PATH)
        self.assertEqual(snapshot["selected"], "cancel")


class CodexService(FakeService):
    def _screen(self):
        if not self.prompt:
            return ["OpenAI Codex", "› Explain this codebase"]
        return [
            "> You are in " + PATH,
            "Do you trust the contents of this directory? Working with untrusted",
            "contents comes with higher risk of prompt injection. Trusting the directory",
            "allows project-local config, hooks, and exec policies to load.",
            ("› " if self.selected == "confirm" else "") + "1. Yes, continue",
            ("› " if self.selected == "cancel" else "") + "2. No, quit",
            "Press enter to continue",
        ]

    def run_cli(self, argv, **kwargs):
        result = super().run_cli(argv, **kwargs)
        if argv[:2] == ["terminal", "show"]:
            result["terminal"]["agentIdentity"] = None if self.prompt else "codex"
        if argv[:2] == ["terminal", "send"] and "--text" in argv:
            self.selected = "confirm" if argv[argv.index("--text") + 1] == "\x1b[A" else "cancel"
        return result


class CodexTrustTests(unittest.TestCase):
    def test_both_initial_selections_and_deny(self):
        for selected, allow, keys in (("confirm", True, ["enter"]),
                                      ("cancel", True, ["\x1b[A", "enter"]),
                                      ("confirm", False, ["\x1b[B", "enter"]),
                                      ("cancel", False, ["enter"])):
            with self.subTest(selected=selected, allow=allow):
                service = CodexService(selected=selected)
                trust = FolderTrust(service)
                snapshot = trust.detect(HANDLE, WORKSPACE, agent="codex")
                receipt = trust.decide(snapshot, allow)
                self.assertEqual(receipt["contract"], "codex-folder-trust/v1")
                self.assertEqual(receipt["decision"], "allow" if allow else "deny")
                self.assertEqual(["enter" if "--enter" in c else c[c.index("--text") + 1]
                                  for c in service.calls if c[:2] == ["terminal", "send"]], keys)

    def test_wrong_path_changed_incarnation_and_lost_receipt_never_replayed(self):
        for scenario in ("path", "incarnation", "lost"):
            service = CodexService(selected="confirm")
            trust = FolderTrust(service)
            snapshot = trust.detect(HANDLE, WORKSPACE, agent="codex")
            if scenario == "path":
                service.path = PATH + " other"
            elif scenario == "incarnation":
                service.incarnation = "new-incarnation"
            else:
                service.fail_send_number = 1
            with self.assertRaises(RuntimeError):
                trust.decide(snapshot, True)
            self.assertEqual(service.send_count, 1 if scenario == "lost" else 0)

    def test_clipped_trust_is_rejected_but_normal_codex_viewport_is_not_a_prompt(self):
        service = CodexService(selected="confirm")
        original = service.run_cli
        def clipped(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[:2] == ["terminal", "read"]:
                result["terminal"]["truncated"] = True
            return result
        service.run_cli = clipped
        trust = FolderTrust(service)
        with self.assertRaisesRegex(RuntimeError, "truncated"):
            trust.detect(HANDLE, WORKSPACE, agent="codex")
        self.assertEqual(service.send_count, 0)
        service.prompt = False
        service._screen = lambda: ["OpenAI Codex", "›⠁Ask Codex to do anything⠐"]
        self.assertIsNone(trust.detect(HANDLE, WORKSPACE, agent="codex"))

    def test_focus_change_before_enter_stops_without_input(self):
        from orca_trust import CodexFolderTrust
        service = CodexService(selected="confirm")
        trust = CodexFolderTrust(service)
        snapshot = trust.detect(HANDLE, WORKSPACE)
        service.selected = "cancel"
        with self.assertRaisesRegex(RuntimeError, "selection changed"):
            trust._send(snapshot, enter=True, expected_bytes=1, expected_selection="confirm")
        self.assertEqual(service.send_count, 0)

    def test_unrelated_or_edited_prompt_does_not_authorize_input(self):
        from orca_trust import CodexFolderTrust
        service = CodexService(selected="confirm")
        lines = service._screen()
        self.assertIsNone(CodexFolderTrust._prompt(["› Run a command?"], PATH))
        with self.assertRaises(RuntimeError):
            CodexFolderTrust._prompt([x.replace("exec policies", "other policies") for x in lines], PATH)
        with self.assertRaises(RuntimeError):
            CodexFolderTrust._prompt(lines, "/tmp/Trusted")


if __name__ == "__main__":
    unittest.main()
