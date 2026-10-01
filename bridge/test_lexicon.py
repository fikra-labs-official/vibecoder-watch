import unittest

from lexicon import compile_rules, normalize


class LexiconTests(unittest.TestCase):
    def setUp(self):
        self.rules = compile_rules()

    def fix(self, text):
        return normalize(text, self.rules)[0]

    def test_agent_names_in_every_heard_form(self):
        cases = {
            "открой клод код боевой и клод-код проверяющий": "открой Claude Code боевой и Claude Code проверяющий",
            "Клауд кода должна быть в обоих": "Claude Code должна быть в обоих",
            "клод кот и клот": "Claude Code и Claude",
            "кодекс боевой, кодексом проверяем": "Codex боевой, Codex проверяем",
            "в орке есть орка, оркой и горка тоже": "в Orca есть Orca, Orca и Orca тоже",
            "гермес, гермец, гельмеса, гермейси, хермесу": "Hermes, Hermes, Hermes, Hermes, Hermes",
            "мусафер, муссайфер, мусафиру и мусахир": "Мусафир, Мусафир, Мусафир и Мусафир",
            "залей на гитхаб на пайтоне, некст джиэс, супабейс, постгрес, тайпскрипт, джаваскрипт, докер":
                "залей на GitHub на Python, Next.js, Supabase, Postgres, TypeScript, JavaScript, Docker",
        }
        for heard, expected in cases.items():
            with self.subTest(heard=heard):
                self.assertEqual(self.fix(heard), expected)

    def test_ordinary_words_and_existing_spelling_stay(self):
        for text in ("код проекта и кодовая база", "Claude Code уже правильно", "Orca и Hermes", "закодируй",
                     "оркестр", "мусор", "хер знает", "код-ревью"):
            with self.subTest(text=text):
                self.assertEqual(self.fix(text), text)
        text, count = normalize("", self.rules)
        self.assertEqual((text, count), ("", 0))
        self.assertEqual(normalize(None, self.rules), (None, 0))

    def test_config_rules_extend_defaults_and_bad_ones_are_skipped(self):
        rules = compile_rules([
            {"pattern": r"такси[\s-]*дубай[а-яё]*", "replacement": "Такси Дубай"},
            {"pattern": "(", "replacement": "x"},
            {"pattern": "", "replacement": "x"},
            "junk",
            {"pattern": "клод", "replacement": 5},
        ])
        self.assertEqual(len(rules), len(compile_rules()) + 1)
        self.assertEqual(normalize("проект такси дубай в клод коде", rules), ("проект Такси Дубай в Claude Code", 2))


if __name__ == "__main__":
    unittest.main()
