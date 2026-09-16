# Voice Workbench

A personal workspace for thinking out loud, shaping your words, and keeping notes across computers.

Record a thought, keep the original transcript, and refine a separate working version. Your notes and vocabulary live in your own Turso database. Audio and recovery drafts stay in your browser.

## Project status

The local server and browser workspace are implemented and locally validated. This is a preview; complete-application validation is still pending before the first release.

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

Set `GOOGLE_GENERATIVE_AI_API_KEY` for Google transcription, `MISTRAL_API_KEY` for Mistral transcription and optional text refinement, or both. Unconfigured providers are shown as unavailable. Provider selection does not change the language you speak; the interface is English.

On another computer, use the same Turso connection in that computer's own `.env.local`. Do not create a second database if you want a shared library. Audio and unsynchronized drafts remain on their original device.

Credentials belong exclusively in the ignored `.env.local`. The launcher rejects extra environment files and unknown keys, and inherited credentials do not override the project file. Builds work without credentials. Credentials are never returned to the browser.

## Working with your voice

- **Record:** Choose a provider and transcription mode, then start. Each recording becomes a new note. Recording stops at ten minutes or the byte limit.
- **Write:** Edit the title and working text. The original transcript remains unchanged. Edits are saved locally before cloud writes.
- **Refine:** Ask Mistral to clean up, structure, or translate your text into English. Compare the exact input with the suggestion, then explicitly apply it. Undo restores the previous working version within the current editor session. If you edit again, that previous version remains available to copy without overwriting the newer work. A changed source makes an older suggestion ineligible for application.
- **Recover:** Open **Local audio & drafts** to recover completed recordings and pending drafts. Drafts from separate tabs are preserved independently and grouped by note. Unsaved text still held in the current tab appears here even if browser storage is unavailable; **Open draft** reopens that live version without waiting for the cloud. Copy or download in-memory-only text before closing or reloading. A confirmed restoration retires its exact source snapshot, preserving newer edits. A local-only save retry never starts a model request. If local storage rejects a finished transcript, it remains visible for copying or Markdown download.
- **Resolve:** Concurrent edits show both versions. Choose explicitly; the application never silently overwrites another version.
- **Use elsewhere:** Copy plain text or download a Markdown note. Listen to locally available audio, or download and delete it separately.

**Saved on this device** and **Saved to cloud** mean different things. A local storage or cleanup warning never reverses a confirmed cloud save or a known deletion. Local-copy retries do not send another cloud write; genuinely new edits continue to autosave. Cloud failure leaves a recoverable local copy. Model requests are never automatically retried; repeating an interrupted request may incur another charge.

The library filter searches titles and the first 140 characters of each loaded note, not full text. Use **Load more notes** to include older notes. The refresh button updates both the library and the open note, as does returning to the tab.

Recovery identifies the provider and mode stored with each recording. Changing the recording bar affects the next recording only. Unsupported or oversized audio is retained for download, with no unchanged upload offered. Configuration failures explain the setup step and require your acknowledgement before retrying. Later successful saves and reopening a cloud note also confirm the matching local recording, even if its working text has since changed.

The recovery space includes recordings and completed transcripts held only in the current tab. Saving on this device is confirmed only after the local transaction completes. Cancel is available during transcription; saving the resulting transcript is a separate, non-cancelable step. Concurrent tabs claim recording attempts atomically, so an older result cannot overwrite a newer attempt or its cloud confirmation.

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

## Data and limits

Transcription sends audio and vocabulary to your selected provider. Refinement sends text to Mistral. Notes and settings are stored in Turso. Audio and pending drafts remain in IndexedDB in the current browser profile. Clearing browser data removes this local recovery space. Download important audio for a separate backup.

Refinement can change meaning despite preservation instructions. Review names, order, conditions, and negations. Incomplete model responses are not offered for application. Refinement accepts up to 12,000 UTF-16 units; larger notes can still be saved and exported.

This is a local single-user application, without authentication against other processes on the same computer. It is not configured for public network access. There is no general offline synchronization or guaranteed recovery of a recording still in progress during a browser crash. Server limits bound upload bytes and processing time, not decoded audio duration. Two model requests can run at once per local server process.

## Technical reference

- `docs/design/voice-workbench.md`: API, storage, recovery, and interaction contracts.
- `docs/adr/0001-local-next-and-shared-turso.md`: runtime and persistence decision.
- `src/shared/contracts.ts` and `src/shared/responses.ts`: shared validation, response, and retry contracts.

## License

No usage license has been granted for the application code yet.
