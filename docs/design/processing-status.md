# Focused processing status

The view follows the temporary-audio lifecycle in `workspace-management.md`. It does not introduce a separate model, retry, or cancellation path.

It mounts only during an actual recording operation and shows the bound provider/mode, recording duration, monotonic elapsed processing time, and current stage. Transcription includes request transfer and provider work; there is no reliable percentage or ETA. Indeterminate animation respects reduced motion.

Three steps group the pipeline: Audio, Transcribe, Save note. `preparing_audio` checks the frozen context for audio already in tab memory. `transcribing` is the cancellable model request. `saving_transcript` secures the text-only draft in IndexedDB; `saving_note` includes editor preparation and the cloud write. That last stage must not claim the network write has already started. Only `textDurable`, after transaction completion, permits “Transcript saved on this device”. Audio always remains temporary, including after a cloud save.

Cancel processing aborts the model request and keeps temporary audio. Provider charges may already apply. Text/cloud save stages have no model-cancel button. Audio download stays available; a returned transcript is downloadable while its save is pending. Errors reveal recovery/editor state. Generation changes invalidate old work; a late result cannot become a current-generation note.

The status occupies the workspace instead of competing with the recording dock and receipt. Editor/receipt components remain mounted but hidden while processing. Starting an operation scrolls to the status heading. The timer is released on unmount. Stage announcements are polite; elapsed seconds are not repeatedly announced. Desktop and 390-pixel mobile layouts keep cancellation and recovery actions reachable.

Verification uses isolated real browser storage, a local test database, and synthetic provider responses. Check bound vocabulary/provider, completion, cancellation, pending saves, reload loss of audio with preserved text, and resets during a model call. Never use real library content for destructive probes.
