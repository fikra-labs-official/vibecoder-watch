import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

TOOL = Path(__file__).with_name("permission_tool.py")


class PermissionToolTests(unittest.TestCase):
    def test_stdio_server_forwards_prompt_and_returns_the_owner_decision(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / "job"
            env = {**os.environ, "MUSAFIR_PERMISSION_DIR": str(folder), "MUSAFIR_PERMISSION_TIMEOUT": "5"}
            proc = subprocess.Popen([sys.executable, str(TOOL)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, text=True, env=env, bufsize=1)
            def send(message):
                proc.stdin.write(json.dumps(message) + "\n"); proc.stdin.flush()
                return json.loads(proc.stdout.readline())
            init = send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}}})
            self.assertEqual(init["result"]["protocolVersion"], "2025-06-18")
            self.assertEqual(init["result"]["serverInfo"]["name"], "musafir-permissions")
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); proc.stdin.flush()
            tools = send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
            self.assertEqual(tools["result"]["tools"][0]["name"], "approve")
            self.assertEqual(send({"jsonrpc": "2.0", "id": 3, "method": "ping"})["result"], {})
            def owner():
                for _ in range(100):
                    requests = list(folder.glob("*.request.json")) if folder.exists() else []
                    if requests:
                        request = json.loads(requests[0].read_text())
                        self.assertEqual(request["toolName"], "Bash")
                        self.assertEqual(request["input"]["command"], "npm test")
                        (folder / requests[0].name.replace(".request.json", ".decision.json")).write_text(json.dumps({"allow": True}))
                        return
                    time.sleep(0.05)
            threading.Thread(target=owner, daemon=True).start()
            call = send({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "approve",
                         "arguments": {"tool_name": "Bash", "input": {"command": "npm test"}, "tool_use_id": "t1"}}})
            outcome = json.loads(call["result"]["content"][0]["text"])
            self.assertEqual(outcome, {"behavior": "allow", "updatedInput": {"command": "npm test"}})
            unknown = send({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "other", "arguments": {}}})
            self.assertIn("error", unknown)
            proc.stdin.close(); proc.wait(timeout=5)

    def test_answers_travel_back_inside_updated_input(self):
        import permission_tool
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            def owner():
                for _ in range(100):
                    requests = list(folder.glob("*.request.json"))
                    if requests:
                        (folder / requests[0].name.replace(".request.json", ".decision.json")).write_text(
                            json.dumps({"allow": True, "answers": {"Какой цвет?": "Синий"}}, ensure_ascii=False))
                        return
                    time.sleep(0.02)
            threading.Thread(target=owner, daemon=True).start()
            outcome = permission_tool.decide({"tool_name": "AskUserQuestion", "input": {"questions": [{"question": "Какой цвет?", "options": [{"label": "Синий"}]}]}},
                                             directory=folder, timeout=5, poll=0.05)
        self.assertEqual(outcome["behavior"], "allow")
        self.assertEqual(outcome["updatedInput"]["answers"], {"Какой цвет?": "Синий"})
        self.assertEqual(outcome["updatedInput"]["questions"][0]["question"], "Какой цвет?")

    def test_timeout_denies(self):
        import permission_tool
        with tempfile.TemporaryDirectory() as temp:
            outcome = permission_tool.decide({"tool_name": "Bash", "input": {"command": "x"}}, directory=Path(temp), timeout=0.3, poll=0.05)
        self.assertEqual(outcome["behavior"], "deny")
        self.assertIn("не ответил", outcome["message"])


if __name__ == "__main__":
    unittest.main()
