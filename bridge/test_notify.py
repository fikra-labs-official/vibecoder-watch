import tempfile
import unittest

import notify
from notify import Notifier


class NotifierTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.sent, self.events = [], []
        self.send = lambda token, chat, text: self.sent.append((token, chat, text))
        self.event = lambda name, **fields: self.events.append((name, fields))

    def tearDown(self):
        self.temp.cleanup()

    def make(self, token="t", chat="1", send=None):
        return Notifier(self.temp.name, token, chat, send=send or self.send, event=self.event)

    def test_disabled_without_token_and_chat(self):
        for token, chat in (("", "1"), ("t", None), (None, None), ("t", True), ("  ", 5)):
            n = self.make(token, chat)
            self.assertFalse(n.enabled)
            self.assertFalse(n.notify("k", "text"))
            n.close()
        self.assertEqual(self.sent, [])

    def test_one_message_per_key_survives_restart_and_trims_text(self):
        n = self.make()
        self.assertTrue(n.notify("orca:1:completed", "  Готово " + "x" * 5000))
        self.assertFalse(n.notify("orca:1:completed", "again"))
        n.close()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0][:2], ("t", "1"))
        self.assertTrue(self.sent[0][2].startswith("Готово"))
        self.assertLessEqual(len(self.sent[0][2]), notify.MAX_TEXT)
        again = self.make()
        self.assertFalse(again.notify("orca:1:completed", "again"))
        self.assertTrue(again.notify("orca:1:error", "x"))
        again.close()
        self.assertEqual(len(self.sent), 2)
        self.assertIn(("notify_sent", {"key": "orca:1:completed"}), self.events)

    def test_documents_are_sent_once_per_key_and_validated(self):
        docs = []
        n = self.make()
        n.send_document = lambda token, chat, name, data, caption: docs.append((token, chat, name, data, caption))
        self.assertTrue(n.send_file("claude:1:report", "отчёт.md", b"# x", "подпись"))
        self.assertFalse(n.send_file("claude:1:report", "отчёт.md", b"# x"))
        self.assertFalse(n.send_file("claude:2:report", "a.md", b""))
        self.assertFalse(n.send_file("claude:3:report", "a.md", "text"))
        self.assertFalse(n.send_file("claude:4:report", "", b"x"))
        n.close()
        self.assertEqual(docs, [("t", "1", "отчёт.md", b"# x", "подпись")])
        self.assertIn(("notify_sent", {"key": "claude:1:report"}), self.events)
        self.assertFalse(self.make().notify("claude:1:report", "same key, text form"))

    def test_delivery_failure_is_logged_not_raised_and_not_retried(self):
        def broken(*args):
            raise RuntimeError("network")
        n = self.make(send=broken)
        self.assertTrue(n.notify("k", "text"))
        self.assertFalse(n.notify("k", "text"))
        n.close()
        self.assertEqual(self.events[-1], ("notify_error", {"key": "k", "error": "RuntimeError"}))

    def test_invalid_key_or_empty_text_are_ignored(self):
        n = self.make()
        self.assertFalse(n.notify("", "text"))
        self.assertFalse(n.notify("k", "   "))
        self.assertFalse(n.notify(None, "text"))
        n.close()
        self.assertEqual(self.sent, [])

    def test_sent_keys_store_is_bounded(self):
        original = notify.KEEP
        notify.KEEP = 3
        try:
            n = self.make()
            for index in range(5):
                n.notify(f"k{index}", "text")
            self.assertEqual(n.db.execute("SELECT count(*) FROM sent").fetchone()[0], 3)
            n.close()
        finally:
            notify.KEEP = original


if __name__ == "__main__":
    unittest.main()
