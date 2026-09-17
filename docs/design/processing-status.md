# Focused processing status

This view presents the existing recording pipeline. It does not create a new model, storage, retry, or cancellation path.

The view is mounted only while an actual recording operation is running. It shows the provider and mode bound to that recording, its duration, a monotonic elapsed processing timer, and the current application stage. The transcription stage includes request transfer and provider processing; the API exposes no reliable percentage, separate upload-completion event, or ETA. The animation is indeterminate and respects reduced motion.

Three visual steps group the existing `RecordingPhase` values: Audio, Transcribe, and Save note. The last step changes its title/detail between securing the returned transcript locally and preparing/saving the library note. The existing saving_note phase includes local editor-draft preparation before the cloud write; its copy must not claim the network write has already started. Confirmed audio awaiting attempt setup is shown as preparing the request, without model cancellation. Device-save confirmation requires the existing durability flag. Receiving a transcript is not a cloud-save confirmation. A retry that is still securing a local copy cannot claim that copy is durable.

During the provider call, Cancel transcription delegates to the existing AbortController. Audio is retained, and the UI explains that provider charges may already apply. Local and cloud saving stages offer no model cancellation. Download audio remains available throughout; a returned transcript remains downloadable during its local/cloud save. Errors leave the processing view and reveal the existing recovery/editor state.

The status occupies the workspace instead of competing with the compact recording dock and receipt. Existing editor/receipt components remain mounted but are hidden while processing; their business lifetimes are unchanged. Starting a processing operation resets the workspace scroll to the status heading. The display timer is released on unmount. Stage announcements are polite; the timer is not announced every second. Desktop, 390x844, and 390x667 views must keep the active stage and cancellation/recovery actions reachable.

Verification uses delayed synthetic provider/storage responses in an isolated browser profile. Provider identity, elapsed time, cancellation, successful completion, failed provider request, and pending note-save with transcript download are checked. No real library content is used or deleted.
