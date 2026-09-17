# ADR 0003: Areas, temporary audio, and an explicit library reset

Status: accepted. The persistence and temporary-audio foundation is implemented; area management and the reset-entry UI follow separately. Authoritative lifecycle and wire details: `../design/workspace-management.md`.

## Decision

Areas organize notes and add vocabulary to the global dictionary. A shared alphabetical chip editor replaces line-based word entry. Captures freeze their effective words/provider/area context; moving a note later changes organization, not transcription.

New audio remains only in tab memory. Reload/close loses it, while successful transcripts and editable text drafts remain durable. Legacy persistent audio remains available in Local audio & drafts for explicit export/removal, never silent upgrade deletion. Retained content does not block new capture/import or add availability banners to the recording screen. No filesystem audio service, cloud audio store, or unload-triggered deletion promise.

Delete-all clears every cloud note and the initiating browser profile's local content, preserving words and areas. Other profiles retain their local material read-only after detecting a reset. A monotonic library generation fences stale writes; an idempotent receipt and IndexedDB-CAS journal prevent replayed deletion from clearing new content. Move note writes to a new physical table and leave a read-only old-name view, so another machine's old local server cannot silently bypass the new write contract.

## Reasons and prior art

- [MDN beforeunload](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event): close callbacks are not reliable. Never persisting audio meets temporary-tab retention without relying on cleanup at exit. The cost is losing audio on reload/crash; text remains independently recoverable.
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html): reuse atomic write transactions for reset/CAS. Contention may fail rather than wait. A local probe proved that an unguarded default generation accepts stale legacy inserts, so API-only validation was rejected.
- [IndexedDB clear](https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/clear) removes current records, not in-flight JavaScript work. Same-profile journal locking plus terminal context invalidation covers late writes and repeated cleanup.
- [Broadcast Channel](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API) accelerates same-origin notification. Durable metadata and server state remain authoritative; there is no all-device deletion claim.
- [Google vocabulary](https://ai.google.dev/gemini-api/docs/transcribe) and [Mistral context bias](https://docs.mistral.ai/studio/audio/speech_to_text/offline_transcription) take flat lists. Compose global and area words once, validate the chosen provider's cap, and freeze it for manual retry. Alphabetical display must not silently rewrite the request snapshot.

## Alternatives and costs

Persistent browser audio plus deletion on browser close cannot offer the requested lifecycle reliably. A filesystem temp directory moves the cleanup problem to another process and leaves browser tabs and local files with different lifetimes. RAM audio is the smallest MVP policy and uses no new dependency.

Deleting local audio on other machines after a remote reset was rejected: offline new material cannot reliably be distinguished by generation alone. The chosen narrow scope retains those copies but prevents automatic resurrection into the cloud. Per-note tombstones alone do not cover a never-uploaded recording's ID. A sync engine or worker service is unnecessary.

Costs are a SQL migration with a compatibility view, revisioned areas, a text-only local-store upgrade, and a library lifecycle coordinator. Existing data is preserved during migration. Old installations need updating for writes and new retention behavior. No promise is made about provider-side retention, database backups, or separately downloaded files.

## Revision triggers

Explicit requests for durable audio, offline audio recovery, shared users/permissions, nested projects, or cross-device audio synchronization require a new decision. They are not hidden extensions of this MVP.
