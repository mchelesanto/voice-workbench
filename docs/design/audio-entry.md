# Audio entry: record, discard, and import

## Shared outcome

Each completed capture or imported file becomes one recording with a new UUID. Both enter the temporary-audio, transcription, text-only draft, and cloud-note pipeline. The frozen generation/area/vocabulary context and RAM reservations follow `workspace-management.md`. No automatic provider retry.

## Focused capture

A modal shows microphone permission, active recording, and recording completion. Desktop keeps the inactive workspace behind it; mobile uses a dedicated full-height view. The prior note stays selected behind the capture modal; finishing capture then opens the existing processing/recovery view. Cancel returns to that prior note. The view shows a timer, the provider/mode snapshot, and a real input-level history. If the level meter cannot run, say so without pretending to show live levels or blocking capture. Respect reduced motion.

During capture, the footer contains Pause recording and Stop & transcribe. Pause immediately pauses MediaRecorder, mutes its existing input tracks, and freezes the timer and level display. Resume recording continues the same recorder, frozen context and clip without requesting another microphone stream. Completed pause intervals are excluded from capture duration and the provider-duration guard. Input permission can remain held for resumption; the UI promises paused recording, not a closed microphone device.

The header X is the cancel entry. It pauses first, then opens a compact native confirmation dialog over the unchanged capture screen. Continue recording resumes the same clip; Discard recording releases microphone/meter, drops chunks and sends nothing. Stay paused and Escape dismiss this small question but leave capture paused, avoiding an unexpected resume. Resume is the primary action while paused. Permission cancellation needs no question because no clip exists yet. Stop & transcribe also works while paused and explicitly finishes/sends the captured clip. If a final native chunk reaches the byte limit while paused, hold the completed clip for an explicit Keep & transcribe or Discard decision. A stale Continue action cannot become an upload when the clip finished meanwhile. Pause/resume failures salvage audio for manual recovery without automatic transcription.


The selected provider’s time and byte limits stop capture, not a fixed ten-minute application timer. If a discard confirmation is open when a limit is reached, hold the completed audio in this tab until the explicit Keep & transcribe or Discard recording decision. Do not upload automatically while the user is deciding. Finishing is idempotent. Every recording session owns its own stream, timer, meter, and callbacks; late permission, data, stop, or error events must not affect a replacement session or revive a discarded recording. Unmount releases resources without creating a note. An unsolicited native stop is treated as interrupted audio and secured locally for review, never automatically transcribed.

After capture ends, transcription and temporary-audio download remain available, including on failures. Cancel during an already submitted model request remains distinct from discarding a microphone capture; it cannot undo incurred costs.

## Import audio

Import audio opens a file chooser/dropzone for one file. Selection is local, with name, size, decoded duration, playback, and provider/mode shown before Transcribe. Closing/replacing the selection aborts inspection and revokes preview URLs; stale completions cannot replace a newer selection. No model or storage write happens merely from selecting a file.

Support the existing MP3, M4A/MP4, WAV, WebM, and Ogg/Opus container classes. Determine the supported container from bytes, normalize known browser MIME aliases, and reject incompatible declared audio types. Empty or generic binary MIME values may be filled from the detected content. File extension alone is not validation. Raw Opus without a recognized supported container is not promised.

Reject empty files, files above the largest supported upload, unplayable files, and media exceeding the selected provider’s duration or upload limit before a provider request. Use the existing bounded local-duration preparation for inspection. The original file remains unchanged. Only an explicit Transcribe freezes the displayed provider/mode, creates the recording UUID, and enters the existing pipeline, which retains audio only in tab memory before upload. Duration metadata for an import comes from the local media element; it is not a billing attestation.

All supported containers keep appropriate download/upload extensions, including MP3 and WAV. The original filename is only local preview information; the existing note title continues to come from the transcript. No batch import or background queue in this version.

## Import preflight and MIME handoff

Selecting and previewing files remains possible while settings load, but Transcribe requires both the chosen provider and loaded vocabulary settings. A failed settings request keeps the dialog and selection intact. Check connection retries within the dialog without rereading the file or sending audio.

ID3-tagged MP3s are inspected by their bounded tag extent and the MPEG frame after it, including v2.4 footers; malformed sizes/flags or absent frames are rejected. The largest supported upload limit still applies before reading; the selected provider’s smaller limit is checked before sending and after every provider change. The transcription model receives the validated MIME even when the AI SDK's own short-prefix sniff cannot see past large cover art. File bytes, including metadata, remain unchanged.

## Provider limits and evidence

Recording and import follow `PROVIDERS` in `src/shared/contracts.ts`. Google unary transcription supports 60 minutes; Mistral Voxtral Mini Transcribe 2 supports 180 minutes. These are file-transcription limits, not streaming-session limits. Neither diarization nor word timestamps are requested. The app has no separate ten-minute note limit.

Google uses the installed SDK’s inline base64 Interactions request. Its 70-MiB raw-audio ceiling leaves room under the documented 100-MB total request size after base64 expansion and vocabulary metadata. Supporting larger Google files requires the Files API; this version does not upload persistent provider files. Mistral’s direct multipart ceiling is 500,000,000 bytes. The local multipart transport ceiling is that largest audio limit plus 1 MiB. Capture reserves one second for the final duration tick and 1 MiB for final chunks and requests 64 kbit/s encoding. The final blob and measured duration are checked again and kept locally without an unchanged upload if oversized or over duration. A delayed background timer may still overshoot; preserving audio takes priority over pretending its duration was within the limit. Recording duration is measured by the browser, not a server-side decoding guarantee.

The local body deadline is 60 seconds for audio. Transcription processing has a separate 30-minute deadline, with a client budget covering both, the 12-second generation preflight, and 10 seconds of transport margin. Refinement keeps 120 seconds. Cancellation and manual-only model retries remain unchanged. These operational deadlines are not audio-duration limits. Audio stays in tab memory; text-only IndexedDB storage remains quota-dependent. There is no infinite memory or crash recovery promise for audio.

Primary references checked 2026-09-17:
- [Google Transcribe](https://ai.google.dev/gemini-api/docs/transcribe): unary audio duration and mode constraints.
- [Google Files guide](https://ai.google.dev/gemini-api/docs/files): 100-MB total inline request boundary. The general audio guide still says 20 MB; an actual 57,456,916-byte WAV succeeded through the installed inline transcription adapter. Keep this discrepancy visible when changing the transport.
- [Mistral speech transcription](https://docs.mistral.ai/capabilities/audio_transcription): model-specific three-hour support.
- [Mistral known limitations](https://docs.mistral.ai/resources/known-limitations): 500-MB upload limit; its generic 60-minute duration conflicts with the newer model-specific three-hour page. Use the model-specific duration, but do not claim a tested three-hour live run. The news page’s 1-GB figure describes the Studio playground, not this direct API path.

Revisit these values when the model or upload transport changes. A 30-minute recording is a normal supported use case. Transcript storage (100,000 UTF-16 units) and optional refinement (12,000) remain separate text limits; provider maximum duration is not a guarantee that every possible transcript fits those text contracts.
