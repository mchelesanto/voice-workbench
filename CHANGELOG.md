# Changelog

## Unreleased

### Added

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
- Recoverable transcripts after browser-storage errors and durable oversized recordings.
- Controlled dialog dismissal and local draft deletion across pending writes.
- Compact mobile editing controls, visible copy actions, and readable status colors.
- Vocabulary settings, provider availability, and separate audio download and deletion.
- Per-request page CSP, keyboard-accessible dialogs, and reduced-motion support.

### Changed

- Runtime messages, code comments, and test descriptions use English. Multilingual input remains supported.

### Fixed

- Open recovered drafts even when their new local copy cannot be saved, and keep existing cloud notes accessible after an identifier conflict.
- Validate launcher exit codes on Windows without assuming POSIX signal delivery.
- Keep recovery actions beside their own warnings, show both conflict previews with explicit replacement choices, and announce local failures accessibly.

- Keep live unsaved drafts accessible when browser storage and cloud reads fail.
- Preserve deletion, conflict, and cloud-confirmed states through local persistence failures.
- Retry local recovery work without repeating confirmed cloud writes, and resume autosave for newly entered text.
- Track the newest completed local snapshot and reset the view when opening another note.

### Pending

- Complete-application validation before the first release.
- License and public repository visibility decisions.
