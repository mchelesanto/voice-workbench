# Changelog

## Unreleased

### Added

- Area persistence, generation-fenced note APIs, immutable reset/cancellation receipts, and browser-profile reset recovery.
- Read-only preservation of older-generation text and audio, plus explicit legacy-audio cleanup.

- Alphabetical vocabulary tags with phrase input, bulk paste, accessible removal, and preservation of invalid or over-limit input.

- Focused transcription status with the bound provider, elapsed time, real pipeline stages, cancellation, and backup downloads.

- Focused microphone capture with live levels, explicit discard confirmation, and local audio-file import with preview.

- Local Next.js API for notes, vocabulary, transcription, and text refinement.
- Transactional storage with revision conflicts, replay semantics, and deletion markers.
- Versioned SQL migrations with checksums and atomic application.
- Project-scoped startup that does not inherit unrelated credentials.
- Provider adapters, resource limits, and sanitized error messages.
- Deterministic behavior tests and reproducible validation commands.
- Shared response, field-error, and replay contracts for browser clients.
- Historical model identifiers and complete Unicode previews across library pages.
- Bounded audio streams and enforced response deadlines with correct resource lifetime.
- Consistent configuration checks for startup and builds, plus controlled process termination.
- Responsive English workspace with recording, local recovery, library, and editor.
- Separate local editor drafts, revision conflict resolution, and visible save states.
- Side-by-side refinement comparison, guarded undo of the previous working version, plain-text copying, and Markdown export.
- Local audio playback, grouped recovery drafts, and independent local save retries.
- Recoverable transcripts after browser-storage errors and temporary oversized audio for explicit download/removal.
- Controlled dialog dismissal and local draft deletion across pending writes.
- Compact mobile editing controls, visible copy actions, and readable status colors.
- Vocabulary settings, provider availability, and separate audio download and deletion.
- Per-request page CSP, keyboard-accessible dialogs, and reduced-motion support.

### Changed

- Keep new audio only in tab memory, with reserved capacity and truthful reload/close warnings. Save transcripts as strict text-only drafts before cloud creation.
- Freeze capture vocabulary/context and expand stored word lists to 1,000 terms while enforcing provider-specific request caps.

- Replace the ten-minute application cap with provider-specific recording and import limits, larger uploads, compact speech capture, and a separate long-transcription deadline.

- Runtime messages, code comments, and test descriptions use English. Multilingual input remains supported.

### Fixed

- Redirect pages opened on another loopback address, such as the `127.0.0.1:3210` link printed at startup, to the configured `APP_ORIGIN` instead of loading a workspace whose API requests all fail.

- Pause capture, its timer and input immediately before the compact discard question. Resume continues the same clip; pause time is excluded. A separate Pause/Resume action replaces the footer Cancel button.

- Apply a selected remote vocabulary to subsequent recordings and unlock settings opened before their initial load completes.
- Preserve rejected input across retries, confirm equal word sets regardless of stored order, and keep mobile conflict actions clear of their content.

- Keep interrupted or over-duration captures local instead of automatically transcribing them.
- Retry unavailable settings inside the import dialog without losing the selected file, with reachable actions on short screens.
- Recognize the platform MP3 MIME alias while retaining byte-level format validation.

- Include live audio and completed in-memory transcripts in recovery, with truthful storage and cancellation states.
- Prevent older transcription completions from overwriting newer per-tab attempts or crossing a library reset.
- Share one client deadline across both attempts of a data request.

- Bound storage operations and their HTTP transport with isolated request cancellation and explicit timeout outcomes.
- Retry retryable or unreadable non-timeout data 5xx responses once, keeping configuration and schema failures manual, and diagnose missing tables without exposing database errors.

- Confirm local recordings after later successful saves and matching cloud reads without overwriting newer processing attempts.
- Keep recovery provider choices and persisted error actions explicit, including setup failures and oversized audio.

- Open recovered drafts even when their new local copy cannot be saved, and keep existing cloud notes accessible after an identifier conflict.
- Validate launcher exit codes on Windows without assuming POSIX signal delivery.
- Keep recovery actions beside their own warnings, show both conflict previews with explicit replacement choices, and announce local failures accessibly.

- Keep live unsaved drafts accessible when browser storage and cloud reads fail.
- Preserve deletion, conflict, and cloud-confirmed states through local persistence failures.
- Retry local recovery work without repeating confirmed cloud writes, and resume autosave for newly entered text.
- Track the newest completed local snapshot and reset the view when opening another note.

### Pending

- Area management, capture destination selection, note moves, and delete-all entry UI.

- Complete-application validation before the first release.
- License and public repository visibility decisions.
