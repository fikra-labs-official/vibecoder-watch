# Orca voice project creation

## Boundary

A confirmed speech transcript is input data. A tool-free semantic planner proposes a single project plan. Only a separately confirmed plan may create a folder and open agents. Creation never submits a task or starts research, implementation, or a reviewer dispatch. The owner sends a separate task after opening the created pair. Descriptions and original dictation remain stored as context. The selected storage root is authoritative; ambiguity is returned as a question. Arbitrary project names and task subjects are supported without an allowlist of business domains. Installed agents and model IDs remain an explicit allowlist.

## Durable operation

Keep one SQLite operation from planning through creation. Persist the original dictation, plan, approval nonce, exact folder/workspace, terminal handles and process incarnations, pair receipt. The plan and any clarification are immutable revisions. A clarification before creation supersedes its parent. Repeating an operation ID reads the existing receipt; it never reinterprets the input.

States: queued/running (planning or bootstrap), clarification, approval (plan or folder trust), completed, cancelled, error, unknown. Approvals have unpredictable IDs bound to one operation and kind. A plan approval starts creation; folder trust approval applies only to the recorded newly created folder and exact live Claude or Codex process. Decline stops bootstrap without deleting the folder. An uncertain mutation is not repeated automatically.

Before every create/save/send boundary, preserve a receipt or write-ahead marker. Resume only stages with an exact saved identity. A lost terminal-create acknowledgement stays unknown, because creating a second terminal is unsafe.

## RPC and watch

ORCA_PROJECT_PLAN {id,textId,rootId,parentId?} queues planning without filesystem/agent side effects. ORCA_OPERATION {id,cursor?} reads state and bounded approval pages. ORCA_PROJECT_DECIDE {id,approvalId,allow} records the owner's choice and queues continuation. ORCA_PROJECT_RESUME {id} explicitly rechecks an unknown bootstrap only when saved workspace and terminal handles exist and no uncertain trust input or denial exists; it never recreates a terminal with a lost receipt. Legacy ORCA_PROJECT_CREATE reads old receipts; new legacy requests require a client upgrade.

The watch uses its existing recorder, transcript review and paginated reader. A new plan appears as a separate review. Clarifications preserve the original dictation. Folder trust shows the exact path and access implications, with allow/decline. Progress and pending approval recover after sleep using the saved operation ID. A created pair waits idle. Only a separate explicit task from its voice screen enters the existing reviewer/worker coordinator.

## Verification and limitations

Test unrelated Russian project briefs, mixed pairs, unsupported models, malformed planner output, clarification, refusal, duplicate requests, stale trust prompts, restart, and lost receipts. Exercise the actual planner and a new isolated Orca project on external Storage. Device audio/Bluetooth and physical watch input require device evidence and cannot be claimed from server or simulated tests.

Folder trust transport must use supported terminal input scoped to a verified terminal. Never globally disable trust checks or command permissions. If the installed Orca cannot safely expose the active trust prompt, retain the pending state and report that limitation rather than inventing an approval.

The installed trust adapter is fenced to the Claude Code 2.x folder-trust screen (dialog text verified verbatim, the rendered version is part of the prompt hash, a new major stops it) and the exact two-choice Codex trust screen. It binds raw key input to the runtime, workspace, handle, process incarnation and prompt hash. Changed or unsupported screens stop without input. This is folder trust only, not general permission automation. Clarification questions commit before yielding; unconsumed approval nonces recover after restart; a saved trust denial remains terminal even across a crash.

Codex launches override `check_for_update_on_startup=false` for that process only. An interactive startup prompt (`agentWait`) is not agent readiness. Identity reads briefly tolerate delayed agent attachment after `tui-idle`; they never recreate a terminal. Codex viewport truncation is accepted only for a positively identified normal welcome prompt with no trust dialog or interactive wait; clipped trust screens cannot authorize input.

Existing-pair preflight reads retry once only on transport/timeout errors. Mutation calls remain single-attempt and receipt-backed. Failure before any mutation returns an unsent error; an uncertain mutation remains unknown. Voice inside a selected pair is a task for that pair; creating another project starts from New project.
