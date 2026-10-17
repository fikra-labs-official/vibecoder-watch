# Musafir 0.10: navigation and explicit input

The watch is a remote for the owner's Hermes agent on their computer. Audio is
transcribed by the local bridge; only a separate, confirmed `SEND_TEXT` starts an
agent task. The phone and Tailscale are transport, not another agent identity.

## Screen contract

| Screen | Main actions | Back / exit |
| --- | --- | --- |
| Home | New task, Research, chats, pending draft or active task | System exit |
| Chat list / archive | Open chat, change list page | Exact preceding view |
| Chat detail | Open saved response, Continue, Archive / Restore | Exact list and offset |
| Compose | Dictate or Type | Originating chat or Home; no microphone/network write |
| Recording | Transcribe, Cancel | Discard recording before leaving |
| Preparing / uploading / transcribing | Cancel | Cancel unsent intent before leaving |
| Review | Edit, Send, Cancel | Preserve text as a local draft and leave |
| Saving text | Cancel before actual submission | Fence late save completion from starting a task |
| Submitting / status unknown | Inspect same job | Preserve receipt recovery; never resend automatically |
| Running / awaiting permission | Stop task, allow/deny where applicable | Leave task running; no implicit approval |
| Result | Full answer, Continue | Originating chat or Home |
| Full answer | Page arrows | Exact originating task; separate Home shortcut |
| Hero picker | Scroll all five portraits, select | Return to the preceding screen |

New task, Research and Continue open Compose. Persisted legacy `autoRecord` must
never start the microphone. Keyboard completion creates a review draft, not a
submission. Blank or invalid text cannot be submitted.

## Cancellation and recovery

- Cancel intent is persisted synchronously before `recorder.stop()`. A delayed
  native callback, page destruction or an immediate reopen cannot reverse it.
- Recording destroyed without an explicit Transcribe action is discarded.
  `pending-audio.uploadConsent` is granted only by that deliberate action.
- Old unaccepted audio without that consent must not upload on reopening.
- Once audio reached the bridge, `AUDIO_CANCEL` leaves a monotonic tombstone,
  clears retained audio/text and invalidates drafts derived from that audio.
  A late transcriber result is discarded. In-flight speech compute may finish.
- Canceling audio does not cancel an already accepted Hermes job. Job Stop is a
  separate explicit action with a confirmed terminal state.
- Review text survives ordinary Back. Explicit Cancel discards it. Pending-send
  ambiguity is recovered by the exact job ID before starting another task.

## Native UI constraints

Every secondary screen has a visible Back control and equivalent right-swipe / Back
key behavior. Document-page arrows are not named Back. Keyboard input owns its
events while it is open. Event registrations are removed during page destruction.

Native buttons have at least 44 px touch height, complete nonoverlapping hit areas
and a safe bottom inset at 432×514, 390×450 and 390×400. Every BUTTON text/layout
update passes `x`, `y`, `w`, `h` together through `prop.MORE`; visibility is separate.
The preview rejects incomplete button updates instead of silently merging them.

The hero picker is one native scrolling list of five 96×96 portraits with a current
selection marker. Images and labels select the same row. Hero selection changes
only the watch preference, never a chat, session key, prompt or backend request.

Primary API references: [BUTTON](https://docs.zepp.com/docs/reference/device-app-api/newAPI/ui/widget/BUTTON/),
[SCROLL_LIST](https://docs.zepp.com/docs/reference/device-app-api/newAPI/ui/widget/SCROLL_LIST/),
[onGesture](https://docs.zepp.com/docs/reference/device-app-api/newAPI/interaction/onGesture/),
[onKey](https://docs.zepp.com/docs/reference/device-app-api/newAPI/interaction/onKey/).

## Acceptance

Checks exercise the real page factories, phone forwarding and backend protocol,
including cancel/destroy/reopen races, typed input, late replies, exact return
destinations, five selectable heroes and all three screen geometries. Browser
inspection uses synthetic tasks and never sends a real command to the owner's
agent. Physical touch, keyboard and BLE acceptance still require the watch.
