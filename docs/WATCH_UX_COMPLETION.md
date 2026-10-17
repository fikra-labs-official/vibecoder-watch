# Watch UX completion: staged execution

## Scope and order

### Device feedback correction (17 October)

The owner reports overlapping Claude/Codex menu rows after More and no obvious direct New task action. Earlier desktop acceptance covered voice states but did not establish native menu acceptance. The correction puts New task first on the home screen, gives Claude/Codex a dedicated general workspace without requiring an existing project/session, and routes Orca New task through an explicit pair choice. Three fixed native BUTTON rows replace the Claude/Codex menu SCROLL_LIST. Text readers retain continuous scrolling. Tests must check pairwise intersections in home/More and every menu category, not only screen bounds. Real watch acceptance remains separate.

1. Musafir: continuous full-answer reader; retain completed draft scrolling.
2. Codex: review project/session/task flows and apply common voice/history improvements.
3. Orca: review pair/project/plan/clarification/approval flows and integrate the same reading/input rules.
4. Claude: verify shared agent-menu changes against Claude-specific modes/permissions and finish its flow.

Existing project/session/pair identities, permissions and explicit mutation confirmations remain authoritative. No real agent task is required for UI testing. Limits is outside this change. Unrelated private edits are preserved.

## Shared contracts

- Native vertical text list uses width-safe rows and exact original Unicode text. No manual page arrows for message/answer reading.
- Remote response chunks load automatically, sequentially and with a deadline. Loaded content remains readable if continuation fails; retry targets the same unread cursor. Back always cancels further reads and fences late completion.
- New/Continue opens an explicit choice of voice or keyboard. Recording requires a tap; cancellation persists before stopping the recorder. Sending remains a separate confirmed action after review.
- Visible Back, hardware Back and right swipe agree. Leaving a task does not stop it. Stop and permission decisions remain explicit and are never retried blindly after an ambiguous receipt.
- Native buttons receive complete geometry and usable nonoverlapping touch areas. Screen coordinates fit 432x514, 390x450 and 390x400. Loading and error states retain a working exit.
- UI status distinguishes connecting, accepted, agent start, running, permission, completed and uncertain receipt. Automatic retries are limited to safe reads and idempotent upload operations.

## Verification and release

Tests cover full text, chunk boundaries, Unicode, cancellations, stale callbacks, exact destinations and safe retry. Browser scenarios use production factories/phone allowlists with synthetic data. Compiled private phone packages receive read-only HTTPS smoke checks. Public source/packages are scanned before scoped commit/push and raw-file readback. Physical touch, BLE and native keyboard acceptance is reported separately.

## Progress

- Musafir: continuous full-answer reader, exact incremental Unicode rows and cancellation implemented.
- Codex: exact new/session/latest intent, common typed review and result readers, menu recovery implemented.
- Orca: reversible lists, persistent operations/handoff, wizard return steps, plan decline, confirmed stop and common input implemented.
- Claude: shared menu changes verified with permission questions, project-scoped bypass confirmation, full persisted results and exact session recovery.

## Recovery details

Result screens render their first transport chunk immediately. Full answer opens the common history reader (Musafir uses its chat-bound report reader). Readers append sequential chunks without resetting position, retain loaded text on failure and retry only the unread offset. Row wrapping reprocesses only the final row plus the new chunk. The watch caps a reader at 200000 codepoints with an explicit notice; Claude/Codex retain the entire result on the Mac.

A definite nonretryable send rejection restores the exact unsent draft. An uncertain receipt reconciles the saved job ID. Preset dispatch and Orca provisioning save their IDs before networking. Orca handoff saves both source and destination IDs and checks the destination on retry. Menu mutation errors lead to status inspection instead of blind repeat.

Stop is successful only after bounded confirmation. Claude/Codex terminate and wait, then kill and wait if required. Orca fences dispatch, interrupts the exact bound terminal and verifies idle. An unconfirmed stop remains unknown with a reason, including a worker-start receipt arriving after stop. No real task was started for these checks.

Root verification: 284 JavaScript tests and 220 Python tests passed. Browser QA exercised 72 settled screens across all four profiles at 432x514, 390x450 and 390x400; visible controls remained within the screen. Each full reader automatically loaded a 4675-codepoint synthetic result and was scrolled to its final line. The Codex project/input/review/Back/reopen path preserved its exact draft; Orca project/pair/input navigation was exercised. Browser data was synthetic.

Personal and public packages are built for Musafir 0.11.0 (code 29), Codex 0.3.0 (code 10), Orca 0.5.0 (code 19) and Claude 0.3.0 (code 11). Compiled phone services passed 33 synthetic method-forwarding checks, rejected another profile and completed 12 read-only HTTPS calls with status 200. Bridge 0.11.0 was installed after checking idle queues and taking consistent SQLite/source backups; all 18 existing jobs and settings were preserved. Public checkout verification/readback is recorded in the release log.

Physical watch touch, swipe-versus-tap discrimination, native keyboard and BLE remain outside desktop acceptance.

## Menu correction verification

Released correction: Codex/Claude 0.3.1, Orca 0.5.1, bridge 0.11.1. New task is the first home action. Claude/Codex use a fixed isolated general workspace with no prior project/session requirement; history preserves the general alias and exact job identity. Existing project routes remain. Orca New task selects a pair and clears previous job intent. Fixed native menu buttons have full geometry, width-bounded captions and reverse navigation. Extra Orca actions are paginated instead of silently discarded. Native text readers are unchanged.

Root verification passed 292 JavaScript and 223 Python tests. The initial full Python run hit the unchanged Parakeet test's 2-second startup timeout under load; isolated recheck and final full rerun passed without modifying that test or audio code. Browser verification covered 43 settled menu views, including home/More for all three apps and night/research/watch for Claude/Codex at three geometries, with no intersecting or out-of-bounds buttons. Both direct general-task flows reached synthetic completion, returned home, opened a fresh task and recovered the previous exact result. Orca pair selection reached compose.

Three personal/public packages and embedded manifests were verified. Compiled phone services passed 25 synthetic forwarding checks and 10 read-only HTTPS requests, including general LATEST/SESSIONS. Bridge deployment preserved all 18 pre-existing jobs and settings with consistent backups. No real agent task was started. The original firmware overlap mechanism is not established by desktop simulation; physical acceptance is still required.
