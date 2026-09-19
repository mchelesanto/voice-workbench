# Voice Workbench

A personal workspace for thinking out loud, shaping your words, and keeping notes across computers.

Record a thought, keep the initial transcription, and refine a separate working version. Your notes and vocabulary live in your own Turso database. Audio stays only in the open tab and is lost on reload or close. Text recovery drafts are saved separately in the browser.

**Initial transcription · Kept unchanged** preserves the first text returned by the transcription provider. With Polished mode, that text is already polished; a separate verbatim transcript is not generated. The audio recording is the source, and even Verbatim mode may contain transcription errors.

## Project status

This is a locally validated preview with temporary audio, pause/resume, and the area/reset storage foundation. New captures use General; area management, destination selection, note moves, and the delete-all entry screen are the next UI increment. Complete-application validation remains pending before the first release.

## Quick start

Requires Node.js 24 or newer, npm, your own Turso database, and at least one transcription provider.

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env.local` and configure the project.
3. Apply migrations with `npm run db:migrate`.
4. Run `npm run build`, then `npm start`.
5. Open [localhost:3210](http://localhost:3210).

For development, run `npm run dev`. The launcher binds only to `127.0.0.1:3210`. The default browser origin is `http://localhost:3210`; it must match `APP_ORIGIN`. Restart after changing configuration.

## Configuration

Create a dedicated Turso database and a token scoped to that database. The token needs data and schema permissions for migrations. Do not use a platform or group token in the application.

Set `GOOGLE_GENERATIVE_AI_API_KEY` for Google transcription, `MISTRAL_API_KEY` for Mistral transcription, or both. Set `FIREWORKS_API_KEY` for optional refinement with GLM 5.3 Flash. Unconfigured providers are shown as unavailable. Provider selection does not change the language you speak; the interface is English.

On another computer, use the same Turso connection in that computer's own `.env.local`. Do not create a second database if you want a shared library. Temporary audio remains in its original tab; unsynchronized text drafts remain in their original browser profile.

Credentials belong exclusively in the ignored `.env.local`. The launcher rejects extra environment files and unknown keys, and inherited credentials do not override the project file. Builds work without credentials. Credentials are never returned to the browser.

## Working with your voice

- **Record:** Choose a provider and transcription mode, then start. A focused capture view shows elapsed time and a real microphone level. **Stop & transcribe** finishes the recording; **Pause recording** lets you think, and **Resume recording** continues the same clip without including the pause in its duration. The header **X** pauses first and asks whether to discard or continue. Each completed recording becomes a new note. Recording stops at the selected provider’s duration or upload limit: Google allows 60 minutes, Mistral 180 minutes. If you are deciding whether to discard at that point, nothing is sent until you explicitly keep or discard the finished audio.
- **Import:** Use **Import audio** to select or drop one MP3, M4A/MP4, WAV, WebM, or Ogg/Opus file. Preview it and choose the provider/mode before **Transcribe**. Selecting or canceling a file sends nothing. Files must be readable by the browser and fit the selected provider: Google allows 60 minutes and 70 MiB through the inline upload; Mistral allows 180 minutes and 500 MB. Switching provider rechecks the current selection. The original file is unchanged; audio stays in this tab until it is closed or reloaded.
- **Processing:** A focused status view names Google or Mistral, shows elapsed time and the current save/transcription stage, and keeps audio downloads available. Cancel transcription retains your audio; provider charges may still apply. No estimated percentage is shown.
- **Vocabulary:** Add words or phrases as alphabetical tags in **Vocabulary & models**. Enter or comma adds a term; paste a comma-, tab-, or newline-separated list to add several. Save also includes the last typed phrase. Invalid or over-limit terms stay editable, and conflicting versions require an explicit choice. The shared dictionary supports 1,000 terms. Google accepts up to 1,000 terms per request and Mistral up to 100. An oversized dictionary blocks recording for that provider without silently dropping words.
- **Write:** Edit the title and working text. The initial transcription remains unchanged. Local recovery saves are coalesced during typing. Cloud sync waits for three seconds without changes, and always secures the latest text locally first.
- **Refine:** Ask GLM 5.3 Flash through Fireworks to clean up, structure, or translate your text into English. Compare the exact input with the suggestion, then explicitly apply it. Undo restores the previous working version within the current editor session. If you edit again, that previous version remains available to copy without overwriting the newer work. A changed source makes an older suggestion ineligible for application.
- **Recover:** Open **Local audio & drafts** to open temporary recordings and recover persistent text drafts. Drafts from separate tabs are preserved independently and grouped by note. Unsaved text still held in the current tab appears here even if browser storage is unavailable; **Open draft** reopens that live version without waiting for the cloud. Copy or download in-memory-only text before closing or reloading. A confirmed restoration retires its exact source snapshot, preserving newer edits. A local-only save retry never starts a model request. If local storage rejects a finished transcript, it remains visible for copying or Markdown download.
- **Resolve:** Concurrent edits show both versions. Choose explicitly; the application never silently overwrites another version.
- **Use elsewhere:** Copy plain text or download a Markdown note. Listen to locally available audio, or download and delete it separately.

**Saved on this device** and **Saved to cloud** mean different things. A local storage or cleanup warning never reverses a confirmed cloud save or a known deletion. Local-copy retries do not send another cloud write; genuinely new edits continue to autosave. Cloud failure leaves a recoverable local copy. Model requests are never automatically retried; repeating an interrupted request may incur another charge.

The library filter searches titles and the first 140 characters of each loaded note, not full text. Use **Load more notes** to include older notes. The refresh button updates both the library and the open note, as does returning to the tab.

Recovery identifies the provider and mode stored with each recording. Changing the recording bar affects the next recording only. Unsupported or oversized audio is retained for download, with no unchanged upload offered. Configuration failures explain the setup step and require your acknowledgement before retrying. Later successful saves and reopening a cloud note also confirm the matching local recording, even if its working text has since changed.

The recovery space includes recordings and completed transcripts held only in the current tab. Saving on this device is confirmed only after the local transaction completes. Cancel is available during transcription; saving the resulting transcript is a separate, non-cancelable step. Recording attempts use per-tab tokens, so an older result cannot overwrite a newer attempt or its cloud confirmation. Audio is not shared between tabs.

Playback first resolves the complete audio duration. Browser recordings without duration metadata are scanned locally while paused, then returned to the beginning before controls appear. The recording card uses that media duration once available; the stored capture timer remains unchanged. Refreshing the library keeps the same recording at its current position. If preparation or playback fails, download the audio to use another player. Existing recordings are supported without rewriting their files.

## Checks

- `npm test`: deterministic tests without live provider or cloud calls.
- `npm run typecheck`: strict TypeScript checks, including tests and launch scripts.
- `npm run lint`: source checks.
- `npm run format:check`: formatting checks.
- `npm run build`: production build without credentials.

On Windows, process-exit checks run normally; the two POSIX signal-forwarding tests run only on Unix systems because Windows forcibly terminates processes sent a signal through `child.kill()`.

`npm run format` formats source, scripts, tests, and configuration. SQL migrations are immutable once applied. Add a new migration for schema changes. LF line endings keep migration checksums stable across operating systems.

Database operations share a 12-second deadline per operation and follow client cancellation. A timed-out write may already have completed remotely, so retry it manually; note IDs and revision checks preserve the existing replay rules. Non-timeout data failures may retry once with the same payload. Missing database tables produce the migration instruction instead of a generic connection error.

Both attempts of a data request share one 20-second client deadline. A retry does not restart that deadline.

## Library upgrades and reset scope

Migration 0002 preserves existing notes and settings, moves notes into a generation-fenced table, and makes the old table name a read-only view. Back up the database and update every local installation before using the new generation-aware client. Old server writes deliberately fail after this migration. Never migrate a live database before the compatible client is ready.

The reset protocol removes notes across all areas and, after a confirmed receipt, local content in the initiating browser profile. It preserves words and areas. Other profiles retain their old local material read-only. Unknown outcomes stay locked until an explicit same-operation retry or authoritative cancellation resolves them. Reset requests never retry automatically; old receipts cannot clear newer notes. The reset-entry UI is still pending.

## Data and limits

Transcription sends audio and vocabulary to your selected provider. Refinement sends text to Fireworks. Notes and settings are stored in Turso. New audio never enters IndexedDB or another application-managed durable store. Text drafts and reset metadata use IndexedDB. Earlier saved audio remains available read-only in Local audio & drafts, with download/remove controls. It does not block new recordings or imports. Removal first secures any unextracted transcript atomically. Download important audio before closing or reloading.

Refinement can change meaning despite preservation instructions. Review names, order, conditions, and negations. Incomplete model responses are not offered for application. Refinement accepts up to 12,000 UTF-16 units; larger notes can still be saved and exported.

This is a local single-user application, without authentication against other processes on the same computer. It is not configured for public network access. There is no general offline synchronization or guaranteed recovery of a recording still in progress during a browser crash. Server limits bound upload bytes and processing time, not decoded audio duration. Transcription has a 30-minute processing deadline, distinct from the length of your recording; refinement retains its two-minute deadline. Browser recordings request 64 kbit/s audio to keep spoken notes compact, though the browser controls the actual encoding. Large files require available memory. Retained audio and active reservations share a 1,000,000,000-byte budget per tab; audio is never silently evicted. This budget bounds retained Blob bytes, not the full browser heap. Two model requests can run at once per local server process.

## Technical reference

- `docs/design/voice-workbench.md`: API, storage, recovery, and interaction contracts.
- `docs/design/audio-entry.md`: capture focus, discard confirmation, and audio import behavior.
- `docs/design/processing-status.md`: processing stages, cancellation, and backup availability.
- `docs/design/vocabulary-editor.md`: alphabetical tags, input handling, and settings conflicts.
- `docs/design/workspace-management.md`: area, generation, reset, and temporary-audio contracts.
- `docs/adr/0003-areas-and-library-generation.md`: lifecycle and reset decisions.
- `docs/adr/0001-local-next-and-shared-turso.md`: runtime and persistence decision.
- `src/shared/contracts.ts` and `src/shared/responses.ts`: shared validation, response, and retry contracts.

## License

Released under the [MIT License](LICENSE). You are free to use, modify, and
distribute this software, including for commercial purposes.
