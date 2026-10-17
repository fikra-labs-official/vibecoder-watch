# Voice review and delivery

All four apps use `shared/voice-page.js` and `shared/watch-client.js`. The editor opens Zepp's native `createKeyboard` with the complete transcript. `JSKB` selects the enabled custom keyboard; `CHAR` is the fallback. Editing never submits a task. Confirmed edits return to the review screen and require an explicit Send.

## Draft transport

The original ASR remains in `uploads.text`. Edited text is stored separately in `text_drafts` and becomes immutable when ready. A changed edit receives a new draft ID. IDs use the existing local ID format. Sizes and offsets count Unicode code points, not JavaScript UTF-16 units.

| RPC | Parameters | Purpose |
| --- | --- | --- |
| `TEXT_BEGIN` | `id`, `sourceId`, `textLength` | Start or verify an existing draft for a ready original recording |
| `TEXT_PART` | `id`, `offset`, `text` | Append up to 1,000 code points or verify an identical replay |
| `TEXT_FINISH` | `id` | Validate exact length, Unicode and nonblank text; freeze the draft |
| Agent submit | original job `id`, draft `textId`, existing destination/options | Submit only the confirmed text |

Maximum draft length is 30,000 code points. The client replays every chunk from offset zero when retrying a draft upload, so it cannot silently accept a different prefix under the same ID. Audio, draft and task IDs have distinct responsibilities. Saving text is retryable; task submission and approval are never automatically repeated after an ambiguous response. Recovery checks the exact submitted job ID.

The watch persists the draft and submission checkpoint before sending. Reopening must preserve an unsent edit and reconcile an uncertain submission without starting a second job. A failed draft save must leave the editable text available.

## User-visible states

- Review: original or edited text, page controls, Edit, Send, Record again.
- Saving edits: text upload only; no agent task yet.
- Sending: waiting for the Mac's receipt.
- Queued: the Mac has saved the task; the agent has not confirmed a start.
- Submitting: the bridge is contacting the agent.
- Running: the backend reports that the worker has started.
- Approval, result, error or unknown: preserve the existing explicit decision and recovery controls.

A network timeout does not imply that a command failed. Safe status reads may retry; mutations require idempotency or reconciliation. A late callback cannot overwrite a newer page/connection generation.

## Verification

Run `npm test` and `npm run test:bridge`. Regression checks cover Unicode, chunk replay, invalid/changed drafts, original ASR preservation, corrected text reaching all four adapters, lost receipts with an older job in context, hung handshakes, keyboard confirm/cancel/destroy and review layout.

The browser preview uses a clearly labelled textarea to exercise keyboard callbacks. It does not emulate the installed Russian keyboard or prove behavior on physical Bip Max firmware. The final device check is: dictate, edit a middle word, save, review, Send, observe receipt/start/result, then repeat after closing and reopening the app.

API references: [SYSTEM_KEYBOARD](https://docs.zepp.com/docs/reference/device-app-api/newAPI/ui/widget/SYSTEM_KEYBOARD/), [custom keyboards](https://docs.zepp.com/docs/guides/keyboard/quick-start/).
