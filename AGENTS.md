# Voice Workbench

## Structure

- `src/client`: browser workspace, recording, local recovery, editor state, and export.
- `src/server`: local API, storage, and model adapters.
- `src/shared`: shared types, validation, and response contracts.
- `app`: Next.js pages, application styles, and API route entry.
- `proxy.ts`: page security headers and per-request content-security-policy nonce.
- `db/migrations`: versioned SQL migrations.
- `scripts`: configuration, startup, and migration tooling.
- `tests`: deterministic tests with synthetic data.
- `docs`: architecture and functional contracts.

## Development

Use Node.js 24 or newer and npm. Install dependencies with `npm ci`.

- `npm run dev`: development server on `127.0.0.1:3210`.
- `npm run build`: production build without credentials.
- `npm start`: production server.
- `npm run db:migrate`: apply database migrations.
- `npm test`: behavior tests without external services.
- `npm run typecheck`, `npm run lint`, `npm run format:check`: source validation.
- `npm run format`: format source, tests, and configuration.

Keep TypeScript strict. UI copy, runtime messages, identifiers, comments, and test descriptions are English. Multilingual transcription and vocabulary fixtures remain intentional. Use existing shared schemas and errors. Do not import server modules into the client.

## Browser behavior

Persist completed recordings before upload and finished transcripts before cloud creation. Separate drafts by editor instance. Preserve local edits during pending requests and revision conflicts. Do not automatically retry model calls. Use existing retry and replay classifiers for data requests.

Keep desktop and mobile workflows complete. Use the application tokens, visible keyboard focus, accessible action names, and reduced-motion support. Do not render transcript or model text as HTML. Clipboard success requires a fulfilled write; downloads use safe filenames.

## Data and configuration

Application configuration belongs only in `.env.local`. Never put credentials in Git, logs, or browser artifacts. Bind only to loopback.

Applied migrations are immutable. Schema changes require a new numbered SQL file. Preserve LF line endings. Keep audio, temporary data, and local verification files out of version control.

See `README.md` for setup and current functionality. API and data contracts live in `docs/design/voice-workbench.md`.
