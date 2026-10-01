"""Post-ASR spelling of names the owner dictates all day.

Parakeet writes proper names by ear and differently each time; the owner
reviews the text on the watch before anything is sent, so this only fixes the
words that are always the same thing in this workflow. Rules are regexes over
whole words, case-insensitive, Russian endings are swallowed. Extend with
"asrLexicon": [{"pattern": "...", "replacement": "..."}] in config.json.
"""
from __future__ import annotations

import re

DEFAULT_RULES = (
    (r"(?:клод|клауд|клот|cloud|claud)[\s-]*ко[дт][а-яё]*", "Claude Code"),
    (r"(?:клод|клауд|клот)[а-яё]*", "Claude"),
    (r"код[эе]кс[а-яё]*", "Codex"),
    (r"г?орк(?:[аеиоуы]|ой)?", "Orca"),
    (r"[гх]е(?:р|ль|л)ь?м[еиэ]й?[сц][а-яё]*", "Hermes"),
    (r"мус{1,2}а(?:й|и)?ф[еиэ]р[а-яё]*", "Мусафир"),
    (r"мусах[еи]р[а-яё]*", "Мусафир"),
    (r"гит[\s-]*хаб[а-яё]*", "GitHub"),
    (r"пайтон[а-яё]*", "Python"),
    (r"некст[\s-]*(?:джи?[\s-]*эс|js)", "Next.js"),
    (r"супаб[еэ][йи]?[сз][а-яё]*", "Supabase"),
    (r"постгрес[а-яё]*", "Postgres"),
    (r"тайпскрипт[а-яё]*", "TypeScript"),
    (r"джаваскрипт[а-яё]*", "JavaScript"),
    (r"докер[а-яё]*", "Docker"),
)
MAX_RULES = 64


def compile_rules(extra=None):
    """Default rules first, then well-formed config rules; broken regexes are skipped."""
    rules = []
    for pattern, replacement in DEFAULT_RULES:
        rules.append((re.compile(rf"(?<![\w-]){pattern}(?![\w-])", re.IGNORECASE), replacement))
    for item in extra if isinstance(extra, list) else []:
        if not isinstance(item, dict):
            continue
        pattern, replacement = item.get("pattern"), item.get("replacement")
        if (not isinstance(pattern, str) or not 1 <= len(pattern) <= 200 or
                not isinstance(replacement, str) or not 1 <= len(replacement) <= 100):
            continue
        try:
            rules.append((re.compile(rf"(?<![\w-]){pattern}(?![\w-])", re.IGNORECASE), replacement))
        except re.error:
            continue
        if len(rules) >= MAX_RULES:
            break
    return rules


def normalize(text, rules):
    """Apply the rules; returns (text, replacements made)."""
    if not isinstance(text, str) or not text:
        return text, 0
    total = 0
    for pattern, replacement in rules:
        text, count = pattern.subn(replacement, text)
        total += count
    return text, total
