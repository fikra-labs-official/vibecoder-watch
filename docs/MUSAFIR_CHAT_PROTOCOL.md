# Musafir home, chats and cosmetic heroes

The home screen is the default launch destination. An old result opens only after
the owner selects its chat and job. New task and Research create a new conversation
only when confirmed text is sent; Continue keeps the selected chat.

## Boundaries

- `musafir-hero` is a watch-only appearance preference. It never enters an RPC,
  chat identifier, Hermes session key, draft identity or agent instructions.
- `musafir-context` names the explicit voice destination and any exact job being
  inspected. A pending draft separately preserves its original destination.
- Each chat has a stable Hermes session key. All pre-existing jobs migrate to one
  `legacy` chat using the previous key. Migration is additive and repeatable.
- Only one Hermes job may be active globally. The UI may record a draft while busy;
  it must not claim the draft was queued before the server accepts it.
- Archive is reversible. It neither deletes Hermes memory nor changes other apps.

## RPC additions

`CHAT_LIST({offset,limit,archived})` returns chats, nextOffset and an activeJob.
`CHAT_DETAIL({chatId,offset,limit})` returns chat metadata and newest-first jobs.
`CHAT_ARCHIVE({chatId,archived})` changes visibility, refusing active chats.

`SEND_TEXT` adds `chatId` and `mode`. Explicit null starts a new chat whose ID is
the first job ID. An existing ID continues that chat. Omitting the field preserves
compatibility with old packages and the legacy session. Replayed IDs must have the
same text, destination and mode. Heroes never affect replay identity.

`JOB_REPORT({id,offset,limit})` provides bounded Unicode pages of the stored full
output. Result cards show a short opening; longer output is read on demand. Any
storage limit is explicit through a truncation flag.

`JOB_STOP({id})` requests cancellation of the actual Hermes run. A lost response
keeps polling the same job. Only a confirmed terminal state ends the work indicator;
completion may win a stop race. Stale approvals cannot execute after stop begins.

Research uses the existing Hermes agent with report/source instructions and full
output storage. It does not imply a different model, fake progress or automatic
delivery to another application. No hidden reasoning or raw tool arguments appear.

## Verification boundary

Unit tests cover migration, session isolation, continuation, replay protection,
stop races, reports, UI navigation and cosmetic hero selection. The browser preview
is a widget simulation. Real watch keyboard, BLE, brightness and motion still need
physical-device acceptance.
