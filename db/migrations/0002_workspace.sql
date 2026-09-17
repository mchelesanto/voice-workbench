CREATE TABLE areas (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  name_key TEXT NOT NULL,
  vocabulary_json TEXT NOT NULL CHECK (json_valid(vocabulary_json)),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  creation_digest TEXT NOT NULL CHECK (length(creation_digest)=64)
);
CREATE UNIQUE INDEX idx_areas_active_name ON areas(name_key) WHERE archived_at IS NULL;
CREATE TABLE library_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  last_reset_at TEXT
);
INSERT INTO library_state VALUES (1,1,NULL);
CREATE TABLE library_resets (
  operation_id TEXT PRIMARY KEY NOT NULL,
  from_generation INTEGER NOT NULL CHECK (from_generation BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('completed','cancelled')),
  to_generation INTEGER,
  reset_at TEXT,
  deleted_note_count INTEGER,
  CHECK ((state='cancelled' AND to_generation IS NULL AND reset_at IS NULL AND deleted_note_count IS NULL)
    OR (state='completed' AND to_generation=from_generation+1 AND to_generation BETWEEN 2 AND 9007199254740991
      AND reset_at IS NOT NULL AND deleted_note_count BETWEEN 0 AND 9007199254740991))
);
CREATE TABLE library_notes (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(title) <= 160),
  original_text TEXT NOT NULL CHECK (length(original_text) BETWEEN 1 AND 100000),
  body TEXT NOT NULL CHECK (length(body) <= 100000),
  provider TEXT NOT NULL CHECK (provider IN ('google','mistral')),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  mode TEXT NOT NULL CHECK (mode IN ('verbatim','smart')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  area_id TEXT REFERENCES areas(id),
  CHECK (provider != 'mistral' OR mode = 'verbatim')
);
INSERT INTO library_notes SELECT notes.*,1,NULL FROM notes;
CREATE TABLE _workspace_copy_assert (ok INTEGER NOT NULL CHECK (ok=1));
INSERT INTO _workspace_copy_assert SELECT CASE WHEN
  (SELECT count(*) FROM notes)=(SELECT count(*) FROM library_notes)
  AND NOT EXISTS (SELECT notes.*,1,NULL FROM notes EXCEPT SELECT * FROM library_notes)
  THEN 1 ELSE 0 END;
DROP TABLE _workspace_copy_assert;
DROP TABLE notes;
CREATE VIEW notes AS SELECT id,title,original_text,body,provider,model,mode,duration_ms,created_at,updated_at,revision FROM library_notes;
CREATE INDEX idx_library_notes_updated_id ON library_notes(updated_at DESC,id DESC);
CREATE INDEX idx_library_notes_area_updated ON library_notes(area_id,updated_at DESC,id DESC);
CREATE TRIGGER library_notes_preserve_origin
BEFORE UPDATE OF id,original_text,provider,model,mode,duration_ms,created_at,generation ON library_notes
WHEN NEW.id != OLD.id OR NEW.original_text != OLD.original_text OR NEW.provider != OLD.provider
 OR NEW.model != OLD.model OR NEW.mode != OLD.mode OR NEW.duration_ms != OLD.duration_ms
 OR NEW.created_at != OLD.created_at OR NEW.generation != OLD.generation
BEGIN SELECT RAISE(ABORT,'immutable_note_origin'); END;
CREATE TRIGGER library_notes_no_recreation BEFORE INSERT ON library_notes
WHEN EXISTS (SELECT 1 FROM deleted_notes WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'deleted_note_id'); END;
CREATE TRIGGER library_notes_current_generation BEFORE INSERT ON library_notes
WHEN NOT EXISTS (SELECT 1 FROM library_state WHERE id=1 AND generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'stale_library_generation'); END;
CREATE TRIGGER library_resets_immutable_update BEFORE UPDATE ON library_resets
BEGIN SELECT RAISE(ABORT,'immutable_reset_receipt'); END;
CREATE TRIGGER library_resets_immutable_delete BEFORE DELETE ON library_resets
BEGIN SELECT RAISE(ABORT,'immutable_reset_receipt'); END;
