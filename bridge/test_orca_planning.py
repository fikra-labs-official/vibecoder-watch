import json
import time
import unittest

import test_orca_projects as fixtures
from orca_projects import OrcaProjectError, OrcaProjects, WaitingForOwner


class PlannerFlowTest(unittest.TestCase):
    tearDown = fixtures.OrcaProjectsTest.tearDown
    settle = fixtures.OrcaProjectsTest.settle

    def setUp(self):
        fixtures.OrcaProjectsTest.setUp(self)
        self.intent_calls = []
        self.plan = dict(name='CRM для продюсеров', workerAgent='claude', reviewerAgent='codex',
                         workerModel='claude-safe', reviewerModel='codex-safe',
                         brief='Сначала изучить конкурентов, затем согласовать план Next.js.', question='')
        def planner(text, catalog, defaults):
            self.intent_calls.append(text)
            return dict(self.plan)
        self.projects.planner = planner
        self.rpc_original = self.service.rpc
        self.jobs = {}
        def rpc(method, params, lookup=None):
            if method == 'ORCA_SEND':
                if params['id'] not in self.jobs:
                    self.jobs[params['id']] = {'id': params['id'], 'state': 'queued', 'source': lookup(params['textId'])}
                return {'ok': True, 'job': self.jobs[params['id']]}
            return self.rpc_original(method, params, lookup)
        self.service.rpc = rpc

    def create_plan(self, op='200-1', text='Создай CRM для продюсеров. Next.js, Supabase, Postgres.', parent=None):
        params = dict(id=op, textId=op, rootId='external')
        if parent:
            params['parentId'] = parent
        self.projects.rpc('ORCA_PROJECT_PLAN', params, lambda _: text)
        return self.settle(op)

    def decide(self, operation, allow=True):
        self.projects.rpc('ORCA_PROJECT_DECIDE', dict(id=operation['id'], approvalId=operation['approval']['id'], allow=allow))
        return self.settle(operation['id'])

    def test_old_watch_gets_upgrade_instead_of_keyword_parser_or_hidden_approval(self):
        params = dict(id='200-1', textId='200-1', rootId='external')
        def no_lookup(_):
            raise AssertionError('Legacy request must not reinterpret the transcript')
        rejected = self.projects.rpc('ORCA_PROJECT_CREATE', params, no_lookup)
        self.assertEqual(rejected['code'], 'PROJECT_REJECTED')
        self.assertIn('0.3.0', rejected['error'])
        with self.assertRaises(OrcaProjectError):
            self.projects.operation('200-1')
        planned = self.create_plan()
        replay = self.projects.rpc('ORCA_PROJECT_CREATE', params, no_lookup)
        self.assertEqual(replay['code'], 'PROJECT_REJECTED')
        self.assertIn('Текст сохранён', replay['error'])
        self.assertEqual(self.projects.operation('200-1')['approval'], planned['approval'])
        self.assertEqual(self.service.next_terminal, 0)
        self.assertFalse(self.jobs)

    def test_creation_preserves_description_but_never_dispatches_work(self):
        op = self.create_plan()
        self.assertEqual(op['state'], 'approval')
        self.assertEqual(op['approval']['kind'], 'plan')
        self.assertEqual(self.service.workspaces, [])
        self.assertEqual(list(self.external.iterdir()), [])
        self.assertFalse(self.jobs)
        done = self.decide(op)
        self.assertEqual(done['state'], 'completed')
        self.assertNotIn('jobId', done)
        self.assertIn('Жду отдельную команду', done['message'])
        self.assertEqual(self.service.next_terminal, 2)
        row = self.projects.db.execute('SELECT params,result FROM operations WHERE id=?', ('200-1',)).fetchone()
        self.assertIn('Next.js, Supabase, Postgres', json.loads(row['params'])['rawText'])
        self.assertEqual(json.loads(row['result'])['plan']['brief'], self.plan['brief'])
        self.assertFalse(self.jobs)
        again = self.decide(op)
        self.assertEqual(again['state'], 'completed')
        self.assertEqual(self.service.next_terminal, 2)
        self.assertFalse(self.jobs)
        # Replay survives missing provider/catalog/disk after acceptance.
        self.projects.planner = None
        self.disk['VolumeUUID'] = 'gone'
        replay = self.projects.rpc('ORCA_PROJECT_PLAN', {'id':'200-1','textId':'200-1','rootId':'external'})
        self.assertEqual(replay['operation']['state'], 'completed')
        self.assertEqual(len(self.intent_calls), 1)

    def test_folder_description_without_agents_does_not_trigger_task_or_pair_question(self):
        self.plan.update(workerAgent='', reviewerAgent='', workerModel='', reviewerModel='')
        op = self.create_plan(text='Создай папку CRM, Next.js и исследование обсудим потом.')
        self.assertEqual(op['state'], 'approval')
        done = self.decide(op)
        self.assertEqual(done['state'], 'completed')
        self.assertEqual(self.service.next_terminal, 0)
        self.assertFalse(self.jobs)
        self.assertTrue((self.external / self.plan['name']).exists())

    def test_decline_plan_never_creates_folder_or_terminal(self):
        op = self.create_plan()
        done = self.decide(op, False)
        self.assertEqual(done['state'], 'cancelled')
        self.assertEqual(list(self.external.iterdir()), [])
        self.assertEqual(self.service.next_terminal, 0)
        with self.assertRaises(OrcaProjectError):
            self.decide(op, True)

    def test_clarification_and_edit_supersede_unapproved_plan_only(self):
        self.plan = dict(name='',workerAgent='',reviewerAgent='',workerModel='',reviewerModel='',brief='',question='Как назвать папку?')
        original = self.create_plan(text='Новый проект для специалиста по шариатской рукъя.')
        self.assertEqual(original['state'], 'clarification')
        self.plan = dict(name='CRM рукъя',workerAgent='',reviewerAgent='',workerModel='',reviewerModel='',brief='',question='')
        revised = self.create_plan('200-2','Назови CRM рукъя, пока только папку.',parent='200-1')
        self.assertIn('шариатской рукъя',self.intent_calls[-1])
        self.assertIn('Назови CRM рукъя',self.intent_calls[-1])
        self.assertEqual(self.projects.operation('200-1')['state'],'cancelled')
        edited = self.create_plan('200-3','Исправь название.',parent='200-2')
        with self.assertRaises(OrcaProjectError):
            self.decide(revised)
        self.assertEqual(self.decide(edited)['state'],'completed')
        bad = self.projects.rpc(
            'ORCA_PROJECT_PLAN', {'id':'200-4','textId':'200-4','rootId':'external','parentId':'200-3'},lambda _: 'Еще правка')
        self.assertEqual(bad['code'],'PROJECT_REJECTED')

    def test_approval_pages_keep_nonce_and_all_requirements(self):
        self.plan['brief'] = 'Все требования. ' * 300
        op = self.create_plan()
        text = op['approval']['text']
        cursor = op.get('nextCursor')
        while cursor:
            page = self.projects.rpc('ORCA_OPERATION',dict(id=op['id'],cursor=cursor))['operation']
            self.assertEqual(page['approval']['id'],op['approval']['id'])
            text += page['approval']['text']
            cursor = page.get('nextCursor')
        self.assertIn(self.plan['brief'],text)
        self.assertIn('после отдельной команды',text)
        self.assertNotIn('передана проверяющему',text)

    def test_update_prompt_is_not_ready_and_codex_launch_disables_only_update_check(self):
        original = self.service.run_cli
        def update_prompt(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[:2] == ['terminal', 'show']:
                result = {'terminal': {**result['terminal'], 'agentWait': {'reason': 'agent-update-prompt'}}}
            return result
        self.service.run_cli = update_prompt
        done = self.decide(self.create_plan())
        self.assertEqual(done['state'], 'unknown')
        self.assertEqual(self.service.next_terminal, 1)
        self.assertFalse(self.jobs)
        self.assertFalse(any(c[0] == 'ORCA_BIND' for c in self.service.calls))
        import shlex
        command = shlex.split(self.projects._agent_command('codex', 'codex-safe'))
        self.assertEqual(command[1:], ['--approve-for-me', '-c', 'check_for_update_on_startup=false', '--model', 'codex-safe'])

    def test_idle_before_agent_identity_rechecks_without_recreating_terminal(self):
        original = self.service.run_cli
        reads = {}
        def delayed(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[:2] == ['terminal', 'show']:
                handle = argv[argv.index('--terminal') + 1]
                reads[handle] = reads.get(handle, 0) + 1
                if reads[handle] < 4:
                    result = {'terminal': {**result['terminal'], 'agentIdentity': None}}
            return result
        self.service.run_cli = delayed
        done = self.decide(self.create_plan())
        self.assertEqual(done['state'], 'completed')
        self.assertEqual(self.service.next_terminal, 2)
        self.assertFalse(self.jobs)
        self.assertTrue(all(count >= 4 for count in reads.values()))

    def test_folder_trust_resumes_same_worker_after_restart_without_duplicate(self):
        service = self.service
        class Trust:
            pending = True
            calls = 0
            def detect(self, handle, workspace, **kwargs):
                return {'handle':handle,'workspace':workspace} if self.pending else None
            def decide(self, snapshot, allow):
                self.calls += 1
                self.pending = False
                return {'accepted':True}
        trust = Trust()
        self.projects.trust = trust
        op = self.create_plan()
        approval = self.decide(op)
        self.assertEqual(approval['approval']['kind'],'folder_trust')
        self.assertEqual(service.next_terminal,1)
        self.assertFalse(self.jobs)
        # Restart while waiting for owner keeps pending approval and exact receipts.
        self.projects.close()
        self.projects = OrcaProjects(self.projects.state, service,
            roots={'internal':(self.internal,'Internal'),'external':(self.external,'External')},
            disk_info=lambda:dict(self.disk),disk_usage=lambda path:type('Usage',(),{'free':10**10})(),
            model_catalog={'claude':['','claude-safe'],'codex':['','codex-safe']},
            agent_commands={'claude':'/bin/echo','codex':'/bin/echo'},
            planner=lambda *a:self.plan,trust=trust,sleep=lambda _:None)
        restored = self.projects.operation('200-1')
        self.assertEqual(restored['approval']['id'],approval['approval']['id'])
        done = self.decide(restored)
        self.assertEqual(done['state'],'completed')
        self.assertEqual(service.next_terminal,2)
        self.assertEqual(trust.calls,1)
        self.decide(restored)
        self.assertEqual(trust.calls,1)

    def test_owner_notified_for_plan_trust_and_completion(self):
        notes = []
        self.projects.notify = lambda key, text: notes.append((key, text)) or True
        class Trust:
            pending = True
            def detect(self, handle, workspace, **kwargs):
                return {'handle': handle, 'workspace': workspace} if self.pending else None
            def decide(self, snapshot, allow):
                self.pending = False
                return {'accepted': True}
        self.projects.trust = Trust()
        op = self.create_plan()
        self.assertEqual(notes[-1][0], f"project:200-1:plan:{op['approval']['id']}")
        self.assertIn('подтверди на часах', notes[-1][1])
        trust = self.decide(op)
        self.assertEqual(trust['approval']['kind'], 'folder_trust')
        self.assertEqual(notes[-1][0], f"project:200-1:trust:{trust['approval']['id']}")
        done = self.decide(trust)
        self.assertEqual(done['state'], 'completed')
        self.assertEqual(notes[-1][0], 'project:200-1:completed')
        self.assertEqual(len([key for key, _ in notes if key.startswith('project:200-1:plan')]), 1)

    def test_dictated_repository_is_created_private_after_plan_approval(self):
        self.plan = dict(name='Такси Дубай', workerAgent='', reviewerAgent='', workerModel='', reviewerModel='',
                         brief='', question='', github=True)
        op = self.create_plan(text='Создай репозиторий такси дубай')
        self.assertEqual(op['state'], 'approval')
        self.assertIn('GitHub: приватный репозиторий fikra-labs-official/taksi-dubay', op['approval']['text'])
        self.assertFalse(any(c[1:3] == ['repo', 'create'] for c in self.github_calls))
        done = self.decide(op)
        self.assertEqual(done['state'], 'completed')
        self.assertIn('https://github.com/fikra-labs-official/taksi-dubay', done['message'])
        self.assertEqual(done['github']['private'], True)
        create = next(c for c in self.github_calls if c[1:3] == ['repo', 'create'])
        self.assertIn('--private', create)
        self.assertEqual(create[create.index('--source') + 1], str(self.external / 'Такси Дубай'))
        self.assertFalse(self.jobs)

    def test_unknown_trust_input_not_replayed_and_no_reviewer_created(self):
        class Trust:
            calls=0
            def detect(self, handle, workspace, **kwargs):return {'handle':handle}
            def decide(self,snapshot,allow):
                self.calls+=1
                raise RuntimeError('input receipt lost')
        trust=Trust(); self.projects.trust=trust
        approval=self.decide(self.create_plan())
        unknown=self.decide(approval)
        self.assertEqual(unknown['state'],'unknown')
        self.assertFalse(unknown['canResume'])
        with self.assertRaises(OrcaProjectError):
            self.projects.rpc('ORCA_PROJECT_RESUME',{'id':unknown['id']})
        self.assertEqual(self.service.next_terminal,1)
        self.decide(approval)
        self.assertEqual(trust.calls,1)
        self.assertFalse(self.jobs)

    def test_resume_rechecks_saved_startup_but_cannot_repeat_lost_terminal_create(self):
        class Trust:
            unavailable=True
            def detect(self,handle,workspace, **kwargs):
                if self.unavailable:raise RuntimeError('screen not painted')
                return {'handle':handle}
            def decide(self,*a):raise AssertionError('not approved')
        trust=Trust();self.projects.trust=trust
        unknown=self.decide(self.create_plan())
        self.assertEqual(unknown['state'],'unknown')
        self.assertTrue(unknown['canResume'])
        self.assertEqual(self.service.next_terminal,1)
        trust.unavailable=False
        self.projects.rpc('ORCA_PROJECT_RESUME',{'id':unknown['id']})
        waiting=self.settle(unknown['id'])
        self.assertEqual(waiting['approval']['kind'],'folder_trust')
        self.assertEqual(self.service.next_terminal,1)
        self.assertFalse(self.jobs)
        # In contrast, a terminal creation with no handle cannot be retried.
        self.projects._save_result(unknown['id'],terminals={'Боевой':{'agent':'claude'}})
        self.projects._finish(unknown['id'],'unknown','lost create receipt',None)
        self.assertFalse(self.projects.operation(unknown['id'])['canResume'])
        with self.assertRaises(OrcaProjectError):
            self.projects.rpc('ORCA_PROJECT_RESUME',{'id':unknown['id']})

    def test_crash_windows_restore_unconsumed_plan_and_keep_denial_terminal(self):
        op=self.create_plan()
        # Simulate stop after plan+nonce save, before state=approval commit.
        self.projects._finish(op['id'],'running','interrupted',None)
        def reopen():
            old=self.projects;old.close()
            self.projects=OrcaProjects(old.state,self.service,
                roots=old.roots,disk_info=old.disk_info,disk_usage=old.disk_usage,
                model_catalog=old.injected_models,agent_commands=old.injected_commands,
                planner=old.planner,trust=old.trust,sleep=lambda _:None)
        reopen()
        restored=self.projects.operation(op['id'])
        self.assertEqual(restored['state'],'approval')
        self.assertEqual(restored['approval']['id'],op['approval']['id'])
        # Simulate owner deny persisted and a process failure before cancellation.
        r=self.projects._save_result(op['id'])
        r.update(approvedPlan=op['approval']['id'],workspace={'id':'w'},terminals={'Боевой':{'handle':'h'}},
                 decisions={'trust-nonce':{'kind':'folder_trust','allow':False}},
                 trustDecision=None,trustReceipt={'decision':'deny'})
        self.projects._finish(op['id'],'running','interrupted after deny',r)
        reopen()
        stopped=self.projects.operation(op['id'])
        self.assertEqual(stopped['state'],'cancelled')
        self.assertFalse(stopped['canResume'])
        self.projects.rpc('ORCA_PROJECT_RESUME',{'id':op['id']})
        self.assertEqual(self.service.next_terminal,0)
        self.assertFalse(self.jobs)

    def test_clarification_is_durable_before_worker_catches_wait(self):
        self.plan['question'] = 'Как назвать папку?'
        op = self.create_plan()
        self.projects._finish(op['id'], 'running', 'planning', None)
        row = self.projects.db.execute('SELECT params FROM operations WHERE id=?', (op['id'],)).fetchone()
        with self.assertRaises(WaitingForOwner):
            self.projects._plan_project(op['id'], json.loads(row['params']))
        # No _execute catch has run: the question must already be committed.
        saved = self.projects.operation(op['id'])
        self.assertEqual(saved['state'], 'clarification')
        self.assertEqual(saved['message'], self.plan['question'])
        self.assertEqual(self.service.next_terminal, 0)

    def test_folder_trust_decline_never_starts_task(self):
        class Trust:
            def detect(self,handle,workspace, **kwargs):return {'handle':handle}
            def decide(self,snapshot,allow):
                assert allow is False
                return {'accepted':True}
        self.projects.trust=Trust()
        trust=self.decide(self.create_plan())
        done=self.decide(trust,False)
        self.assertEqual(done['state'],'cancelled')
        self.assertTrue((self.external/self.plan['name']).exists())
        self.assertEqual(self.service.next_terminal,1)
        self.assertFalse(self.jobs)


if __name__ == '__main__':
    unittest.main()
