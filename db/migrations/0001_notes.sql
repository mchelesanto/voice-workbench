CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(title) <= 160),
  original_text TEXT NOT NULL CHECK (length(original_text) BETWEEN 1 AND 100000),
  body TEXT NOT NULL CHECK (length(body) <= 100000),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'mistral')),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  mode TEXT NOT NULL CHECK (mode IN ('verbatim', 'smart')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  CHECK (provider != 'mistral' OR mode = 'verbatim')
);
CREATE INDEX idx_notes_updated_id ON notes(updated_at DESC, id DESC);
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  vocabulary_json TEXT NOT NULL CHECK (json_valid(vocabulary_json)),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991)
);
INSERT INTO settings(id, vocabulary_json, revision) VALUES (1, '[]', 1);
CREATE TABLE deleted_notes (id TEXT PRIMARY KEY NOT NULL, deleted_at TEXT NOT NULL);
CREATE TRIGGER notes_preserve_origin
BEFORE UPDATE OF id, original_text, provider, model, mode, duration_ms, created_at ON notes
WHEN NEW.id != OLD.id OR NEW.original_text != OLD.original_text OR NEW.provider != OLD.provider
 OR NEW.model != OLD.model OR NEW.mode != OLD.mode OR NEW.duration_ms != OLD.duration_ms OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_note_origin');
END;
CREATE TRIGGER notes_no_recreation BEFORE INSERT ON notes
WHEN EXISTS (SELECT 1 FROM deleted_notes WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'deleted_note_id');
END;
