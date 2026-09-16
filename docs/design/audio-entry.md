# Audio entry: record, discard, and import

## Shared outcome

Each completed capture or imported file becomes one recording with a new UUID. Both enter the existing local-save, transcription, local-result-save, and cloud-note pipeline. No automatic provider retry, alternate storage path, or note-schema change. Existing local recovery rules apply.

## Focused capture

A modal shows microphone permission, active recording, and recording completion. Desktop keeps the inactive workspace behind it; mobile uses a dedicated full-height view. The prior note stays selected behind the capture modal; finishing capture then opens the existing processing/recovery view. Cancel returns to that prior note. The view shows a timer, the provider/mode snapshot, and a real input-level history. If the level meter cannot run, say so without pretending to show live levels or blocking capture. Respect reduced motion.

During capture, Stop & transcribe finishes and follows the existing automatic pipeline. Cancel recording opens an in-dialog confirmation while recording continues. Keep recording dismisses the confirmation. Discard recording releases microphone and meter, discards chunks, and invokes no recording-ready callback, persistence, model call, or note creation. Escape requests the same confirmation; a backdrop click never silently discards audio. Permission cancellation needs no discard confirmation.

Time and byte limits still stop capture. If a discard confirmation is open when a limit is reached, hold the completed audio in this tab until the explicit Keep & transcribe or Discard recording decision. Do not upload automatically while the user is deciding. Finishing is idempotent. Every recording session owns its own stream, timer, meter, and callbacks; late permission, data, stop, or error events must not affect a replacement session or revive a discarded recording. Unmount releases resources without creating a note.

After capture ends, the existing device-saving and transcription UI remains available, including local backup/download on failures. Cancel during an already submitted model request remains distinct from discarding a microphone capture; it cannot undo incurred costs.

## Import audio

Import audio opens a file chooser/dropzone for one file. Selection is local, with name, size, decoded duration, playback, and provider/mode shown before Transcribe. Closing/replacing the selection aborts inspection and revokes preview URLs; stale completions cannot replace a newer selection. No model or storage write happens merely from selecting a file.

Support the existing MP3, M4A/MP4, WAV, WebM, and Ogg/Opus container classes. Determine the supported container from bytes, normalize known browser MIME aliases, and reject incompatible declared audio types. Empty or generic binary MIME values may be filled from the detected content. File extension alone is not validation. Raw Opus without a recognized supported container is not promised.

Reject empty files, files above 25 MiB, unplayable files, and media longer than the ten-minute note limit before a provider request. Use the existing bounded local-duration preparation for inspection. The original file remains unchanged. Only an explicit Transcribe freezes the displayed provider/mode, creates the recording UUID, and enters the existing pipeline, which secures audio on this device before upload. Duration metadata for an import comes from the local media element; it is not a billing attestation.

All supported containers keep appropriate download/upload extensions, including MP3 and WAV. The original filename is only local preview information; the existing note title continues to come from the transcript. No batch import or background queue in this version.

## Import preflight and MIME handoff

Selecting and previewing files remains possible while settings load, but Transcribe requires both the chosen provider and loaded vocabulary settings. A failed settings request keeps the dialog and selection intact with an explicit connection instruction.

ID3-tagged MP3s are inspected by their bounded tag extent and the MPEG frame after it, including v2.4 footers; malformed sizes/flags or absent frames are rejected. The 25-MiB file limit still applies before reading. The transcription model receives the validated MIME even when the AI SDK's own short-prefix sniff cannot see past large cover art. File bytes, including metadata, remain unchanged.
