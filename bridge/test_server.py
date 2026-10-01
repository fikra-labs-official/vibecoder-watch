import base64
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from server import Bridge, Invalid, MAX_AUDIO, MAX_TEXT_CHARS, make_handler


class FakeHermes:
    def __init__(self):
        self.calls = []
        self.status = {'status': 'completed', 'output': 'Готово'}
        self.failure = None

    def call(self, path, body=None, request_id=None):
        self.calls.append((path, body, request_id))
        if self.failure:
            raise self.failure
        if path == '/v1/runs':
            return {'run_id': 'run_' + 'a' * 32}
        return self.status


class BridgeTests(unittest.TestCase):
    def test_compact_upload_resume_duplicate_and_invalid_parts(self):
        rpc = self.bridge.rpc
        data = bytes(range(256)) * 33
        begin = rpc('AUDIO_BEGIN', {'id': '123-1', 'totalBytes': len(data)})
        self.assertEqual((begin['encoding'], begin['chunkBytes']), ('base64', 6144))
        rpc('AUDIO_CHUNK', {'id': '123-1', 'index': 0, 'data': list(data[:1024])})
        part = {'id': '123-1', 'offset': 1024, 'data': base64.b64encode(data[1024:7168]).decode()}
        self.assertEqual(rpc('AUDIO_PART', part)['receivedBytes'], 7168)
        self.assertEqual(rpc('AUDIO_PART', part)['receivedBytes'], 7168)
        for bad in [dict(part, data='!'), dict(part, offset=True), dict(part, offset=1025),
                    dict(part, offset=9216), dict(part, data='AAAA'),
                    dict(part, data=base64.b64encode(b'X' * 6144).decode())]:
            with self.assertRaises(Invalid):
                rpc('AUDIO_PART', bad)
        rpc('AUDIO_PART', {'id': '123-1', 'offset': 7168, 'data': base64.b64encode(data[7168:]).decode()})
        self.assertEqual(self.bridge._get('uploads', '123-1')['data'], data)

    def test_full_long_approval_and_late_decision(self):
        self.bridge.send('123-1', 'test')
        self.settle()
        command = 'x' * 3066
        self.hermes.status = {'status': 'waiting_for_approval', 'approval': {'request_id': 'approval-1', 'command': command}}
        self.assertEqual(self.bridge.job_status('123-1')['approval']['text'], command)
        original = self.hermes.call
        def expired(path, body=None, request_id=None):
            if path.endswith('/approval'):
                raise HTTPError(path, 409, 'expired', {}, None)
            return original(path, body, request_id)
        self.hermes.call = expired
        result = self.bridge.rpc('JOB_APPROVE', {'id': '123-1', 'approvalId': 'approval-1', 'allow': True})
        self.assertEqual(result['state'], 'running')
        self.assertNotIn('approval', result)
        with self.assertRaises(Invalid):
            self.bridge.rpc('JOB_APPROVE', {'id': '123-1', 'approvalId': 'approval-1', 'allow': True})
        self.hermes.status['approval']['request_id'] = 'approval-2'
        self.assertEqual(self.bridge.job_status('123-1')['approval']['id'], 'approval-2')
        self.hermes.status['approval']['command'] = 'x' * 12001
        self.assertNotIn('approval', self.bridge.job_status('123-1'))

    def test_events_do_not_contain_dictation_or_commands(self):
        self.bridge.rpc('SEND_TEXT', {'id': '123-1', 'text': 'PRIVATE_DICTATION_SECRET'})
        self.settle()
        self.bridge.job_status('123-1')
        events = (Path(self.tmp.name) / 'events.jsonl').read_text()
        self.assertIn('hermes_submitted', events)
        self.assertNotIn('PRIVATE_DICTATION_SECRET', events)
        self.assertEqual((Path(self.tmp.name) / 'events.jsonl').stat().st_mode & 0o777, 0o600)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hermes = FakeHermes()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *a: 'Привет', '/tmp/model')

    def tearDown(self):
        self.bridge.close()
        self.tmp.cleanup()

    def settle(self, request_id='123-1'):
        for _ in range(100):
            with self.bridge.lock:
                row = self.bridge._get('jobs', request_id)
            if row['state'] not in ('queued', 'submitting'):
                return row
            time.sleep(.01)
        self.fail('worker did not finish')

    def notifying_bridge(self, notes):
        seen = set()
        def note(key, text):
            if key in seen:
                return False
            seen.add(key)
            notes.append((key, text))
            return True
        self.bridge.close()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *a: 'Привет', '/tmp/model', notify=note)

    def test_owner_notifications_for_approval_result_and_lost_receipt(self):
        notes = []
        self.notifying_bridge(notes)
        self.bridge.send('123-1', 'Привет')
        self.settle()
        self.hermes.status = {'status': 'waiting_for_approval',
                              'approval': {'request_id': 'approval-1', 'command': 'rm -rf build'}}
        self.bridge.job_status('123-1')
        self.bridge.job_status('123-1')
        self.assertEqual([key for key, _ in notes], ['hermes:123-1:approval:approval-1'])
        self.assertIn('rm -rf build', notes[0][1])
        self.hermes.status = {'status': 'completed', 'output': 'Готово 42'}
        self.bridge.job_status('123-1')
        self.assertEqual(notes[-1][0], 'hermes:123-1:completed')
        self.assertIn('Готово 42', notes[-1][1])
        self.hermes.failure = OSError('lost')
        self.bridge.send('123-2', 'Второй')
        self.settle('123-2')
        self.assertEqual(notes[-1][0], 'hermes:123-2:unknown')
        with self.bridge.lock:  # the owner resolved the unknown task on the Mac
            self.bridge.db.execute("UPDATE jobs SET state='error' WHERE id='123-2'")
            self.bridge.db.commit()
        self.hermes.failure = HTTPError('/v1/runs', 400, 'bad', {}, None)
        self.bridge.send('123-3', 'Третий')
        self.settle('123-3')
        self.assertEqual(notes[-1][0], 'hermes:123-3:error')

    def test_background_poll_observes_hermes_without_the_watch(self):
        original = Bridge.POLL_SECONDS
        Bridge.POLL_SECONDS = 0.05
        try:
            notes = []
            self.notifying_bridge(notes)
            self.hermes.status = {'status': 'running'}
            self.bridge.send('123-1', 'Привет')
            self.settle()
            self.hermes.status = {'status': 'completed', 'output': 'Готово'}
            for _ in range(200):
                if any(key == 'hermes:123-1:completed' for key, _ in notes):
                    break
                time.sleep(0.02)
            self.assertEqual([key for key, _ in notes], ['hermes:123-1:completed'])
            with self.bridge.lock:
                self.assertEqual(self.bridge._get('jobs', '123-1')['state'], 'completed')
        finally:
            Bridge.POLL_SECONDS = original

    def test_orca_methods_route_to_the_owning_service(self):
        class Recorder:
            def __init__(self):
                self.methods = []
            def rpc(self, method, params, lookup=None):
                self.methods.append(method)
                return {'ok': True}
            def close(self):
                pass
        orca, projects = Recorder(), Recorder()
        self.bridge.close()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *a: 'Привет', '/tmp/model', orca=orca, projects=projects)
        for method in ('ORCA_MODES', 'ORCA_MODELS', 'ORCA_ROOTS', 'ORCA_PRESETS', 'ORCA_AGENTS', 'ORCA_OPERATION',
                       'ORCA_PROJECT_PLAN', 'ORCA_PROJECT_DECIDE', 'ORCA_PROJECT_RESUME', 'ORCA_PAIR_CREATE', 'ORCA_AGENT_CREATE'):
            self.bridge.rpc(method, {})
        for method in ('ORCA_QUICK_LIST', 'ORCA_LIST', 'ORCA_PAIRS', 'ORCA_SEND', 'ORCA_JOB', 'ORCA_LATEST',
                       'ORCA_HISTORY_LIST', 'ORCA_HISTORY_DETAIL', 'ORCA_HISTORY_SET_DELETED', 'ORCA_PAUSE'):
            self.bridge.rpc(method, {})
        self.assertIn('ORCA_MODES', projects.methods)
        self.assertNotIn('ORCA_MODES', orca.methods)
        self.assertIn('ORCA_QUICK_LIST', orca.methods)
        self.assertEqual(len(projects.methods) + len(orca.methods), 21)

    def test_research_topic_is_mirrored_to_the_other_agent_only_when_asked(self):
        class Recorder:
            def __init__(self, prefix):
                self.PREFIX, self.calls = prefix, []
            def rpc(self, method, params, lookup=None):
                self.calls.append((method, dict(params)))
                return {'ok': True, 'job': {'id': params.get('id')}}
            def close(self):
                pass
        claude, codex = Recorder('CLAUDE'), Recorder('CODEX')
        self.bridge.close()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *a: 'Привет', '/tmp/model', claude=claude, codex=codex)
        base = {'id': '1-1', 'textId': '1-1', 'project': 'research', 'kind': 'research'}
        self.assertEqual(self.bridge.rpc('CLAUDE_SEND', dict(base, both=True))['job']['id'], '1-1')
        self.assertEqual(claude.calls, [('CLAUDE_SEND', base)])
        self.assertEqual(codex.calls, [('CODEX_SEND', base)])
        self.bridge.rpc('CODEX_SEND', dict(base, id='1-2'))
        self.assertEqual(len(claude.calls), 1)
        self.bridge.rpc('CODEX_SEND', dict(base, id='1-3', both=True))
        self.assertEqual(claude.calls[-1][0], 'CLAUDE_SEND')
        with self.assertRaises(Invalid):
            self.bridge.rpc('CLAUDE_SEND', {'id': '1-4', 'textId': '1-4', 'project': '/p', 'both': True})
        with self.assertRaises(Invalid):
            self.bridge.rpc('CLAUDE_SEND', dict(base, id='1-5', both='yes'))

    def test_watch_methods_route_to_the_watchdog_with_the_transcript_lookup(self):
        class Dog:
            def __init__(self): self.calls = []
            def rpc(self, method, params, lookup=None):
                self.calls.append((method, dict(params), callable(lookup)))
                if method == 'WATCH_ADD': raise ValueError('Не разобрал адрес')
                return {'ok': True}
            def close(self): pass
        dog = Dog()
        self.bridge.close()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *a: 'Привет', '/tmp/model', watchdog=dog)
        self.assertEqual(self.bridge.rpc('WATCH_LIST', {'limit': 2}), {'ok': True})
        with self.assertRaises(Invalid):
            self.bridge.rpc('WATCH_ADD', {'kind': 'url', 'textId': '1-1'})
        self.assertEqual(dog.calls, [('WATCH_LIST', {'limit': 2}, True), ('WATCH_ADD', {'kind': 'url', 'textId': '1-1'}, True)])
        self.bridge.close()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *a: 'Привет', '/tmp/model')
        with self.assertRaises(Invalid):
            self.bridge.rpc('WATCH_LIST', {})

    def test_limits_route_to_the_reader_or_ask_for_a_bridge_update(self):
        class Reader:
            def rpc(self, method, params): return {'ok': True, 'text': 'Claude 5 часов 43%', 'method': method, 'params': dict(params)}
        self.bridge.close()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *a: 'Привет', '/tmp/model', limits=Reader())
        self.assertEqual(self.bridge.rpc('LIMITS', {'force': True})['params'], {'force': True})
        self.bridge.close()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *a: 'Привет', '/tmp/model')
        with self.assertRaises(Invalid):
            self.bridge.rpc('LIMITS', {})

    def test_summary_is_one_line_for_the_home_screen(self):
        reply = self.bridge.rpc('SUMMARY', {})
        self.assertEqual((reply['ok'], reply['text']), (True, 'Тишина: агенты свободны'))
        self.bridge.send('123-1', 'Привет')
        self.assertTrue(self.bridge.rpc('SUMMARY', {})['text'].startswith('Работают '))

    def test_empty_trash_removes_only_trashed_finished_jobs(self):
        with self.bridge.lock:
            self.bridge.db.executemany(
                "INSERT INTO jobs(id,text,created,state,result,deleted_at) VALUES (?,?,?,?,?,?)",
                [('1-1', 'a', 1, 'completed', 'x', 5.0), ('1-2', 'b', 2, 'error', '', 5.0),
                 ('1-3', 'c', 3, 'completed', 'y', None), ('1-4', 'd', 4, 'unknown', '', None)])
            self.bridge.db.commit()
        with self.assertRaises(Invalid):
            self.bridge.rpc('HISTORY_EMPTY_TRASH', {'all': True})
        self.assertEqual(self.bridge.rpc('HISTORY_EMPTY_TRASH', {}), {'ok': True, 'removed': 2})
        self.assertEqual(self.bridge.rpc('HISTORY_EMPTY_TRASH', {}), {'ok': True, 'removed': 0})
        with self.bridge.lock:
            left = sorted(r[0] for r in self.bridge.db.execute("SELECT id FROM jobs"))
        self.assertEqual(left, ['1-3', '1-4'])
        self.assertEqual(self.bridge.rpc('HISTORY_LIST', {'trash': True})['items'], [])
        self.assertEqual(len(self.hermes.calls), 0)

    def test_transcripts_get_standard_names_before_review(self):
        self.bridge.close()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *a: 'скажи гермесу открыть клод код и кодекс в орке', '/tmp/model')
        data = bytes(range(256)) * 4
        self.bridge.rpc('AUDIO_BEGIN', {'id': '123-1', 'totalBytes': len(data)})
        self.bridge.rpc('AUDIO_CHUNK', {'id': '123-1', 'index': 0, 'data': list(data)})
        self.bridge.rpc('AUDIO_FINISH', {'id': '123-1'})
        for _ in range(100):
            with self.bridge.lock:
                row = self.bridge._get('uploads', '123-1')
            if row['state'] != 'transcribing':
                break
            time.sleep(.01)
        self.assertEqual(row['text'], 'скажи Hermes открыть Claude Code и Codex в Orca')
        events = (Path(self.tmp.name) / 'events.jsonl').read_text()
        self.assertIn('"asr_lexicon"', events)
        self.assertNotIn('Claude Code', events)

    def test_duplicate_send_and_conflict(self):
        self.bridge.send('123-1', 'Привет')
        self.settle()
        self.bridge.send('123-1', 'Привет')
        with self.assertRaises(Invalid):
            self.bridge.send('123-1', 'Другое')
        self.assertEqual(len([c for c in self.hermes.calls if c[0] == '/v1/runs']), 1)
        self.assertEqual(self.bridge.job_status('123-1')['result'], 'Готово')
        self.assertEqual(self.bridge.rpc('LATEST_JOB', {})['job']['id'], '123-1')

    def test_history_migrates_existing_jobs_table(self):
        self.bridge.close()
        database = Path(self.tmp.name) / 'state.sqlite3'
        database.unlink()
        with sqlite3.connect(database) as db:
            db.execute("""CREATE TABLE jobs (
                id TEXT PRIMARY KEY, text TEXT, created REAL, state TEXT,
                run_id TEXT DEFAULT '', result TEXT DEFAULT '', error TEXT DEFAULT '')""")
            db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?)",
                       ('123-1', 'Старый вопрос', 1, 'completed', '', 'Старый ответ', ''))
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *a: '', '/tmp/model')
        columns = {row[1] for row in self.bridge.db.execute('PRAGMA table_info(jobs)')}
        self.assertIn('deleted_at', columns)
        detail = self.bridge.rpc('HISTORY_DETAIL', {'id': '123-1', 'field': 'result'})
        self.assertEqual(detail['content'], 'Старый ответ')
        self.assertFalse(detail['deleted'])

    def test_history_unicode_pagination_and_validation(self):
        text = 'вопрос😀' * 20
        result = 'ответ🌙' * 150
        with self.bridge.lock:
            for job_id, created in [('123-1', 1), ('123-2', 2), ('123-3', 3), ('123-4', 4)]:
                self.bridge.db.execute(
                    "INSERT INTO jobs(id,text,created,state,result) VALUES (?,?,?,'completed',?)",
                    (job_id, text + job_id, created, result + job_id))
            self.bridge.db.commit()
        first = self.bridge.rpc('HISTORY_LIST', {'limit': 3})
        self.assertEqual([item['id'] for item in first['items']], ['123-4', '123-3', '123-2'])
        self.assertTrue(first['hasMore'])
        self.assertTrue(all(len(item['text']) <= 70 and not item['deleted'] for item in first['items']))
        second = self.bridge.rpc('HISTORY_LIST', {'offset': 3, 'limit': 3, 'trash': False})
        self.assertEqual([item['id'] for item in second['items']], ['123-1'])
        self.assertFalse(second['hasMore'])
        question_pages, offset = [], 0
        while True:
            page = self.bridge.rpc('HISTORY_DETAIL', {
                'id': '123-4', 'field': 'text', 'offset': offset, 'limit': 83})
            question_pages.append(page['content'])
            offset += len(page['content'])
            if page['complete']:
                break
        self.assertEqual(''.join(question_pages), text + '123-4')
        pages, offset = [], 0
        while True:
            page = self.bridge.rpc('HISTORY_DETAIL', {
                'id': '123-4', 'field': 'result', 'offset': offset, 'limit': 97})
            pages.append(page['content'])
            offset += len(page['content'])
            if page['complete']:
                break
        self.assertEqual(''.join(pages), result + '123-4')
        with self.bridge.lock:
            self.bridge.db.execute(
                "UPDATE jobs SET state='error',result='',error='Ошибка🌙' WHERE id='123-1'")
            self.bridge.db.commit()
        self.assertEqual(self.bridge.rpc(
            'HISTORY_DETAIL', {'id': '123-1', 'field': 'result'})['content'], 'Ошибка🌙')
        self.assertEqual(self.hermes.calls, [])
        bad = [
            ('HISTORY_LIST', {'trash': 1}),
            ('HISTORY_LIST', {'offset': True}),
            ('HISTORY_LIST', {'offset': 2**100}),
            ('HISTORY_LIST', {'limit': 4}),
            ('HISTORY_LIST', {'extra': 1}),
            ('HISTORY_DETAIL', {'id': 'bad', 'field': 'text'}),
            ('HISTORY_DETAIL', {'id': '123-1', 'field': 'run_id'}),
            ('HISTORY_DETAIL', {'id': '123-1', 'field': 'text', 'limit': True}),
            ('HISTORY_SET_DELETED', {'id': '123-1', 'deleted': 1}),
            ('HISTORY_CURRENT', {'id': '123-1'}),
        ]
        for method, params in bad:
            with self.subTest(method=method, params=params), self.assertRaises(Invalid):
                self.bridge.rpc(method, params)

    def test_history_trash_restore_current_latest_and_send_dedup(self):
        with self.bridge.lock:
            self.bridge.db.execute(
                "INSERT INTO jobs(id,text,created,state,result) VALUES (?,?,?,'completed',?)",
                ('123-1', 'Принято', 10, 'Готово'))
            self.bridge.db.execute(
                "INSERT INTO jobs(id,text,created,state,run_id) VALUES (?,?,?,'running',?)",
                ('123-2', 'Текущая', 1, 'run_' + 'b' * 32))
            self.bridge.db.commit()
        self.hermes.status = {'status': 'running'}
        self.assertEqual(self.bridge.rpc('LATEST_JOB', {})['job']['id'], '123-2')
        self.assertEqual(self.bridge.rpc('HISTORY_CURRENT', {})['job']['id'], '123-2')
        with self.assertRaises(Invalid):
            self.bridge.rpc('HISTORY_SET_DELETED', {'id': '123-2', 'deleted': True})
        deleted = self.bridge.rpc('HISTORY_SET_DELETED', {'id': '123-1', 'deleted': True})
        self.assertTrue(deleted['deleted'])
        timestamp = self.bridge._get('jobs', '123-1')['deleted_at']
        self.bridge.rpc('HISTORY_SET_DELETED', {'id': '123-1', 'deleted': True})
        self.assertEqual(self.bridge._get('jobs', '123-1')['deleted_at'], timestamp)
        self.assertEqual([item['id'] for item in self.bridge.rpc('HISTORY_LIST', {'trash': True})['items']], ['123-1'])
        with self.bridge.lock:
            self.bridge.db.execute("UPDATE jobs SET state='completed',result='Готово' WHERE id='123-2'")
            self.bridge.db.commit()
        self.assertEqual(self.bridge.rpc('LATEST_JOB', {})['job']['id'], '123-2')
        self.assertIsNone(self.bridge.rpc('HISTORY_CURRENT', {})['job'])
        before = len([call for call in self.hermes.calls if call[0] == '/v1/runs'])
        duplicate = self.bridge.send('123-1', 'Принято')
        self.assertEqual(duplicate['state'], 'completed')
        self.assertEqual(len([call for call in self.hermes.calls if call[0] == '/v1/runs']), before)
        self.bridge.rpc('HISTORY_SET_DELETED', {'id': '123-1', 'deleted': False})
        self.bridge.rpc('HISTORY_SET_DELETED', {'id': '123-1', 'deleted': False})
        self.assertFalse(self.bridge._get('jobs', '123-1')['deleted_at'])
        self.assertEqual([item['id'] for item in self.bridge.rpc('HISTORY_LIST', {})['items']], ['123-1', '123-2'])

    def test_orca_routes_use_ready_full_transcript_without_calling_hermes(self):
        class Adapter:
            def __init__(self):
                self.calls = []

            def rpc(self, method, params, transcript_lookup):
                self.calls.append((method, dict(params)))
                return {'ok': True, 'text': transcript_lookup(params['textId'])} if 'textId' in params else {'ok': True}

            def close(self):
                pass

        core, projects = Adapter(), Adapter()
        self.bridge.orca, self.bridge.projects = core, projects
        text = 'Полная длинная команда. ' * 200
        self.bridge.rpc('AUDIO_BEGIN', {'id': '123-1', 'totalBytes': 1})
        with self.assertRaises(Invalid):
            self.bridge.rpc('ORCA_SEND', {'textId': '123-1'})
        with self.bridge.lock:
            self.bridge.db.execute("UPDATE uploads SET state='ready',text=? WHERE id='123-1'", (text,))
            self.bridge.db.commit()
        answer = self.bridge.rpc('ORCA_SEND', {'textId': '123-1'})
        self.assertEqual(answer['text'], text)
        self.bridge.rpc('ORCA_ROOTS', {})
        self.assertEqual(projects.calls, [('ORCA_ROOTS', {})])
        self.assertEqual(self.hermes.calls, [])

    def test_unknown_acceptance_never_retries(self):
        self.hermes.failure = TimeoutError()
        self.bridge.send('123-1', 'Привет')
        self.assertEqual(self.settle()['state'], 'unknown')
        self.bridge.send('123-1', 'Привет')
        with self.assertRaises(Invalid):
            self.bridge.send('123-2', 'Привет')
        self.assertEqual(len(self.hermes.calls), 1)

    def test_audio_order_duplicates_integrity_and_confirmation(self):
        rpc = self.bridge.rpc
        self.assertEqual(
            rpc('AUDIO_BEGIN', {'id': '123-1', 'totalBytes': 1025})['receivedBytes'], 0)
        with self.assertRaises(Invalid):
            rpc('AUDIO_CHUNK', {'id': '123-1', 'index': 1, 'data': [1]})
        first = {'id': '123-1', 'index': 0, 'data': [0] * 1024}
        self.assertEqual(rpc('AUDIO_CHUNK', first)['receivedBytes'], 1024)
        self.assertEqual(rpc('AUDIO_BEGIN', {
            'id': '123-1', 'totalBytes': 1025})['receivedBytes'], 1024)
        self.assertEqual(rpc('AUDIO_CHUNK', first)['receivedBytes'], 1024)
        with self.assertRaises(Invalid):
            rpc('AUDIO_CHUNK', {**first, 'data': [1] * 1024})
        with self.assertRaises(Invalid):
            rpc('AUDIO_FINISH', {'id': '123-1'})
        rpc('AUDIO_CHUNK', {'id': '123-1', 'index': 1, 'data': [1]})
        rpc('AUDIO_FINISH', {'id': '123-1'})
        for _ in range(100):
            row = rpc('AUDIO_STATUS', {'id': '123-1'})
            if row['state'] == 'ready':
                break
            time.sleep(.01)
        self.assertEqual(row['text'], 'Привет')
        self.assertEqual(row['receivedBytes'], 1025)
        self.assertEqual(self.hermes.calls, [])
        with self.assertRaises(Invalid):
            self.bridge.send('123-1', 'Изменённый текст')
        self.bridge.send('123-1', 'Привет')
        self.settle()

    def test_audio_bounds_and_path_validation(self):
        for bad in ['../passwd', '', 'abc', None]:
            with self.assertRaises(Invalid):
                self.bridge.rpc('AUDIO_BEGIN', {'id': bad, 'totalBytes': 1})
        for size in [0, MAX_AUDIO + 1, True, 1.2]:
            with self.assertRaises(Invalid):
                self.bridge.rpc('AUDIO_BEGIN', {'id': '123-1', 'totalBytes': size})
        self.assertEqual(self.bridge.rpc('AUDIO_BEGIN', {
            'id': '123-1', 'totalBytes': MAX_AUDIO})['totalBytes'], MAX_AUDIO)
        for data in [[-1], [256], [True], ['1']]:
            with self.assertRaises(Invalid):
                self.bridge.rpc('AUDIO_CHUNK', {'id': '123-1', 'index': 0, 'data': data})

    def test_long_transcript_is_paged_and_sent_to_hermes_without_loss(self):
        text = ('аб😀в' * 7000)[:MAX_TEXT_CHARS]
        self.bridge.transcriber = lambda *args: text
        rpc = self.bridge.rpc
        rpc('AUDIO_BEGIN', {'id': '123-1', 'totalBytes': 1})
        rpc('AUDIO_CHUNK', {'id': '123-1', 'index': 0, 'data': [7]})
        rpc('AUDIO_FINISH', {'id': '123-1'})
        for _ in range(100):
            first = rpc('AUDIO_STATUS', {
                'id': '123-1', 'textOffset': 0, 'textLimit': 777})
            if first['state'] == 'ready':
                break
            time.sleep(.01)
        self.assertEqual(first['text'], text[:777])
        self.assertEqual(first['textLength'], len(text))
        self.assertFalse(first['textComplete'])
        second = rpc('AUDIO_STATUS', {
            'id': '123-1', 'textOffset': 777, 'textLimit': 777})
        self.assertEqual(second['text'], text[777:1554])
        with self.assertRaises(Invalid):
            rpc('AUDIO_STATUS', {'id': '123-1', 'textOffset': len(text) + 1})

        queued = rpc('SEND_TEXT', {'id': '123-1', 'textId': '123-1'})
        self.assertEqual(queued['text'], text[:1000])
        self.assertEqual(queued['textLength'], len(text))
        self.assertFalse(queued['textComplete'])
        self.settle()
        submitted = next(call for call in self.hermes.calls if call[0] == '/v1/runs')
        self.assertEqual(submitted[1]['input'], text)

    def test_failed_asr_keeps_audio_and_finish_retries(self):
        attempts = 0

        def transcriber(*args):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise ValueError('decode failed')
            return 'Восстановлено'

        self.bridge.transcriber = transcriber
        rpc = self.bridge.rpc
        rpc('AUDIO_BEGIN', {'id': '123-1', 'totalBytes': 1})
        rpc('AUDIO_CHUNK', {'id': '123-1', 'index': 0, 'data': [9]})
        rpc('AUDIO_FINISH', {'id': '123-1'})
        for _ in range(100):
            failed = rpc('AUDIO_STATUS', {'id': '123-1'})
            if failed['state'] == 'error':
                break
            time.sleep(.01)
        self.assertEqual(failed['receivedBytes'], 1)
        self.assertIn('сохранена', failed['error'])
        rpc('AUDIO_FINISH', {'id': '123-1'})
        for _ in range(100):
            recovered = rpc('AUDIO_STATUS', {'id': '123-1'})
            if recovered['state'] == 'ready':
                break
            time.sleep(.01)
        self.assertEqual(recovered['text'], 'Восстановлено')
        self.assertEqual(attempts, 2)

    def test_reviewed_text_limit_is_30000_unicode_codepoints(self):
        accepted = '😀' * MAX_TEXT_CHARS
        reply = self.bridge.rpc('SEND_TEXT', {'id': '123-1', 'text': accepted})
        self.assertEqual(reply['textLength'], MAX_TEXT_CHARS)
        self.settle()
        submitted = next(call for call in self.hermes.calls if call[0] == '/v1/runs')
        self.assertEqual(submitted[1]['input'], accepted)
        with self.assertRaises(Invalid):
            self.bridge.rpc('SEND_TEXT', {'id': '123-2', 'text': accepted + 'x'})
        with self.assertRaises(Invalid):
            self.bridge.rpc('SEND_TEXT', {'id': '123-3', 'text': '\ud800'})

    def test_diagnostic_replaces_one_private_bounded_record(self):
        first = {'version': '0.3.2', 'stage': 'recorder_create', 'detail': ' first\nerror '}
        self.assertEqual(self.bridge.rpc('DIAGNOSTIC', first), {'ok': True})
        path = Path(self.tmp.name) / 'last-diagnostic.json'
        record = json.loads(path.read_text())
        self.assertEqual(record['version'], '0.3.2')
        self.assertEqual(record['stage'], 'recorder_create')
        self.assertEqual(record['detail'], 'first error')
        self.assertIsInstance(record['receivedAt'], int)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

        second = {'version': '0.3.2', 'stage': 'recorder_open', 'detail': 'NotAllowedError'}
        self.bridge.rpc('DIAGNOSTIC', second)
        self.assertEqual(json.loads(path.read_text())['detail'], 'NotAllowedError')
        self.assertEqual(list(Path(self.tmp.name).glob('*diagnostic*')), [path])
        self.assertEqual(self.hermes.calls, [])

    def test_diagnostic_rejects_unknown_or_oversized_fields(self):
        valid = {'version': '0.3.2', 'stage': 'recorder_start', 'detail': 'failed'}
        bad = [
            {**valid, 'audio': [1, 2, 3]},
            {**valid, 'version': 'latest'},
            {**valid, 'stage': 'arbitrary_stage'},
            {**valid, 'stage': []},
            {**valid, 'detail': ''},
            {**valid, 'detail': 'x' * 161},
            {**valid, 'detail': '\n\t'},
            {**valid, 'detail': 7},
        ]
        for params in bad:
            with self.subTest(params=params), self.assertRaises(Invalid):
                self.bridge.rpc('DIAGNOSTIC', params)
        self.assertFalse((Path(self.tmp.name) / 'last-diagnostic.json').exists())

    def test_stale_approval_and_once_only(self):
        self.bridge.send('123-1', 'Привет')
        self.settle()
        self.hermes.status = {'status': 'waiting_for_approval', 'approval': {'request_id': 'approve-1', 'command': 'concrete command'}}
        with self.assertRaises(Invalid):
            self.bridge.rpc('JOB_APPROVE', {'id': '123-1', 'approvalId': 'old', 'allow': True})
        self.bridge.rpc('JOB_APPROVE', {'id': '123-1', 'approvalId': 'approve-1', 'allow': True})
        approvals = [c for c in self.hermes.calls if c[0].endswith('/approval')]
        self.assertEqual(approvals[0][1], {'choice': 'once', 'request_id': 'approve-1'})

    def test_persisted_result_and_restart_uncertainty(self):
        self.bridge.send('123-1', 'Привет')
        self.settle()
        self.bridge.job_status('123-1')
        self.bridge.close()
        self.bridge = Bridge(self.tmp.name, self.hermes, lambda *a: '', '/tmp/model')
        self.assertEqual(self.bridge.rpc('LATEST_JOB', {})['job']['result'], 'Готово')

    def test_http_auth_payload_and_unknown_route(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.bridge, 's' * 43))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'http://127.0.0.1:{server.server_port}'
        try:
            for token, body, route, expected in [
                ('bad', {'method': 'STATUS'}, '/rpc', 401),
                ('s' * 43, [], '/rpc', 400),
                ('s' * 43, {'method': 'STATUS'}, '/shell', 404),
            ]:
                request = Request(url + route, data=json.dumps(body).encode(), headers={
                    'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with self.assertRaises(HTTPError) as result:
                    urlopen(request, timeout=3)
                self.assertEqual(result.exception.code, expected)
            diagnostic = {'method': 'DIAGNOSTIC', 'params': {
                'version': '0.3.2', 'stage': 'recorder_file', 'detail': 'empty file'}}
            request = Request(url + '/rpc', data=json.dumps(diagnostic).encode(), headers={
                'Authorization': 'Bearer ' + 's' * 43, 'Content-Type': 'application/json'})
            with urlopen(request, timeout=3) as response:
                self.assertTrue(json.load(response)['ok'])
            self.assertTrue((Path(self.tmp.name) / 'last-diagnostic.json').is_file())
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
