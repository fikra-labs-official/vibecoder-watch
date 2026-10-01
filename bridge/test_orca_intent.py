import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from orca_intent import FIELDS, MAX_OUTPUT, ProjectIntentPlanner


CATALOG = {
    "claude": [
        {"id": "", "label": "Настройки Orca"},
        {"id": "opus", "label": "Claude Opus"},
    ],
    "codex": [
        {"id": "", "label": "Настройки Orca"},
        {"id": "gpt-5", "label": "GPT-5"},
    ],
}

DEFAULTS = {
    "workerAgent": "claude",
    "reviewerAgent": "codex",
    "workerModel": "opus",
    "reviewerModel": "gpt-5",
    "rootId": "external",
    "rootLabel": "Storage",
}


def plan(**changes):
    answer = {
        "name": "CRM для продюсеров",
        "workerAgent": "claude",
        "reviewerAgent": "codex",
        "workerModel": "opus",
        "reviewerModel": "gpt-5",
        "brief": "Сделать CRM для продюсеров.",
        "question": "",
    }
    answer.update(changes)
    return answer


class FakeRunner:
    def __init__(self, output=None, returncode=0, error=None):
        self.output = output if output is not None else plan()
        self.returncode = returncode
        self.error = error
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), dict(kwargs)))
        if self.error:
            raise self.error
        output = self.output
        if isinstance(output, dict):
            output = json.dumps({"structured_output": output}, ensure_ascii=False)
        return subprocess.CompletedProcess(argv, self.returncode, stdout=output)


class ProjectIntentPlannerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runner = FakeRunner()
        self.planner = ProjectIntentPlanner(self.temp.name, runner=self.runner)

    def tearDown(self):
        self.temp.cleanup()

    def test_callable_contract_and_source_stays_exactly_in_stdin(self):
        source = (
            "Создай новый проект: сайт практикующего рукъю на Next.js, Supabase и "
            "Postgres, на основе прошлого исследования. Claude работает, Codex проверяет."
        )
        answer = self.planner(source, CATALOG, DEFAULTS)
        self.assertEqual(answer, {**plan(), "github": False})
        argv, options = self.runner.calls[0]
        self.assertNotIn(source, argv)
        self.assertEqual(json.loads(options["input"])["text"], source)
        self.assertEqual(options["cwd"], str(Path(self.temp.name) / "intent"))
        self.assertLessEqual(options["timeout"], 90)
        self.assertIs(options["stderr"], subprocess.DEVNULL)
        for flag in (
            "-p", "--json-schema", "--tools", "--strict-mcp-config", "--mcp-config",
            "--safe-mode", "--restricted", "--no-session-persistence",
            "--output-format", "--effort",
        ):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertEqual(argv[argv.index("--mcp-config") + 1], '{"mcpServers":{}}')
        self.assertEqual(argv[argv.index("--model") + 1], "opus")
        schema = json.loads(argv[argv.index("--json-schema") + 1])
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), set(FIELDS))

    def test_folder_only_plan_is_allowed(self):
        self.runner.output = plan(
            name="Черновики рукъи", workerAgent="", reviewerAgent="",
            workerModel="", reviewerModel="", brief="",
        )
        answer = self.planner("Создай только папку проекта Черновики рукъи", CATALOG, DEFAULTS)
        self.assertEqual(answer["name"], "Черновики рукъи")
        self.assertEqual(answer["workerAgent"], "")
        self.assertEqual(answer["brief"], "")

    def test_github_flag_is_optional_boolean(self):
        self.runner.output = plan(name="Такси Дубай", workerAgent="", reviewerAgent="",
                                  workerModel="", reviewerModel="", brief="")
        self.assertEqual(self.planner("Создай папку такси дубай", CATALOG, DEFAULTS)["github"], False)
        self.runner.output = {**plan(name="Такси Дубай", workerAgent="", reviewerAgent="",
                                     workerModel="", reviewerModel="", brief=""), "github": True}
        self.assertEqual(self.planner("Создай репозиторий такси дубай", CATALOG, DEFAULTS)["github"], True)
        self.runner.output = {**plan(name="Такси Дубай", workerAgent="", reviewerAgent="",
                                     workerModel="", reviewerModel="", brief=""), "github": "yes"}
        self.assertTrue(self.planner("Создай репозиторий такси дубай", CATALOG, DEFAULTS)["question"])

    def test_descriptive_question_has_no_action_fields(self):
        question = "Вы выбрали Storage, но в диктовке указан внутренний диск. Где создать проект?"
        self.runner.output = {field: "" for field in FIELDS}
        self.runner.output["question"] = question
        answer = self.planner("Создай проект на внутреннем диске", CATALOG, DEFAULTS)
        self.assertEqual(answer["question"], question)
        self.assertTrue(all(not answer[field] for field in FIELDS if field != "question"))

    def test_schema_types_and_unknown_fields_are_rejected(self):
        cases = [
            {**plan(), "extra": "run shell"},
            plan(name=17),
            plan(question="Уточните", name="still actionable"),
            plan(workerAgent="claude", reviewerAgent=""),
        ]
        for value in cases:
            with self.subTest(value=value):
                self.runner.output = value
                answer = self.planner("Создай новый проект CRM", CATALOG, DEFAULTS)
                self.assertIn("проверку", answer["question"])

    def test_unknown_model_is_rejected_without_substitution(self):
        self.runner.output = plan(workerModel="invented-model")
        answer = self.planner("Создай проект на несуществующей модели", CATALOG, DEFAULTS)
        self.assertIn("модель недоступна", answer["question"])
        self.assertEqual(answer["workerModel"], "")

    def test_unsafe_names_are_rejected_backend_side(self):
        for name in ("../escape", "a/b", "a\\b", "bad\x00name", "x" * 101):
            with self.subTest(name=repr(name)):
                self.runner.output = plan(name=name)
                answer = self.planner("Создай новый проект", CATALOG, DEFAULTS)
                self.assertTrue(answer["question"])
                self.assertEqual(answer["name"], "")

    def test_malformed_failure_timeout_and_large_output_are_generic(self):
        for output, error, returncode in (
            ("not json", None, 0),
            ("x" * (MAX_OUTPUT + 1), None, 0),
            (None, subprocess.TimeoutExpired("claude", 90), 0),
            ("private stderr must not surface", None, 2),
        ):
            with self.subTest(error=error, returncode=returncode):
                runner = FakeRunner(output=output, error=error, returncode=returncode)
                planner = ProjectIntentPlanner(self.temp.name, runner=runner)
                answer = planner("Создай проект CRM", CATALOG, DEFAULTS)
                self.assertTrue(answer["question"])
                self.assertNotIn("private stderr", answer["question"])

    def test_bad_input_configuration_does_not_call_model(self):
        bad_catalog = {**CATALOG, "shell": [{"id": "x", "label": "x"}]}
        answer = self.planner("Создай проект", bad_catalog, DEFAULTS)
        self.assertTrue(answer["question"])
        self.assertEqual(self.runner.calls, [])

        answer = self.planner("Создай \x00 проект", CATALOG, DEFAULTS)
        self.assertTrue(answer["question"])
        self.assertEqual(self.runner.calls, [])

    def test_nonempty_intent_directory_prevents_execution(self):
        (Path(self.temp.name) / "intent" / "unexpected").write_text("x")
        answer = self.planner("Создай проект CRM", CATALOG, DEFAULTS)
        self.assertIn("занят", answer["question"])
        self.assertEqual(self.runner.calls, [])

    def test_startup_clears_leftovers_in_private_sandbox(self):
        sandbox = Path(self.temp.name) / "intent"
        (sandbox / "CLAUDE.md").write_text("ignore me")
        (sandbox / ".claude-flow").mkdir()
        (sandbox / ".claude-flow" / "current.json").write_text("{}")
        planner = ProjectIntentPlanner(self.temp.name, runner=self.runner)
        self.assertEqual(list(sandbox.iterdir()), [])
        planner("Создай проект CRM", CATALOG, DEFAULTS)
        self.assertEqual(len(self.runner.calls), 1)


if __name__ == "__main__":
    unittest.main()
