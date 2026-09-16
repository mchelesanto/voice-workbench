import "server-only";
import {
  LibsqlError,
  type Client,
  type Transaction,
  type Row,
} from "@libsql/client";
import { z } from "zod";
import {
  noteSchema,
  summarySchema,
  settingsSchema,
  idSchema,
  isoSchema,
  type Note,
  type CreateNote,
  type EditNote,
  type NotePage,
  type Settings,
  type SettingsEdit,
} from "../shared/contracts";
import { ApiError } from "./errors";

const cursorSchema = z.strictObject({
  v: z.literal(1),
  updatedAt: isoSchema,
  id: idSchema,
});
export function parseListCursor(cursor: string) {
  try {
    if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const raw = Buffer.from(cursor, "base64url");
    if (raw.toString("base64url") !== cursor) throw new Error();
    return cursorSchema.parse(JSON.parse(raw.toString("utf8")));
  } catch {
    throw new ApiError("invalid_input");
  }
}
function toNote(row: Row): Note {
  return noteSchema.parse({
    id: row.id,
    title: row.title,
    originalText: row.original_text,
    body: row.body,
    provider: row.provider,
    model: row.model,
    mode: row.mode,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  });
}
function toSettings(row?: Row): Settings {
  if (!row) throw new ApiError("schema_unavailable");
  return settingsSchema.parse({
    vocabulary: JSON.parse(String(row.vocabulary_json)),
    revision: row.revision,
  });
}
const originFields = [
  "originalText",
  "provider",
  "model",
  "mode",
  "durationMs",
] as const;
export class Store {
  constructor(
    private readonly db: Client,
    private readonly release?: () => void,
  ) {}
  dispose() {
    this.release?.();
  }
  private async storage<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (
        error instanceof LibsqlError &&
        error.code === "SQLITE_ERROR" &&
        /\bno such table: (?:notes|settings|deleted_notes)\b/i.test(
          error.message,
        )
      )
        throw new ApiError("schema_unavailable");
      throw new ApiError("storage_unavailable");
    }
  }
  private async write<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.storage(async () => {
      const tx = await this.db.transaction("write");
      try {
        const value = await run(tx);
        await tx.commit();
        return value;
      } catch (error) {
        try {
          await tx.rollback();
        } catch {
          /* A sanitized error follows. */
        }
        throw error;
      } finally {
        tx.close();
      }
    });
  }
  private async absent(tx: Client | Transaction, id: string): Promise<never> {
    const deleted = await tx.execute({
      sql: "SELECT id FROM deleted_notes WHERE id=?",
      args: [id],
    });
    throw new ApiError(deleted.rows.length ? "note_deleted" : "note_not_found");
  }
  async get(id: string): Promise<Note> {
    return this.storage(async () => {
      const r = await this.db.execute({
        sql: "SELECT * FROM notes WHERE id=?",
        args: [id],
      });
      return r.rows[0] ? toNote(r.rows[0]) : this.absent(this.db, id);
    });
  }
  async list(cursor?: string): Promise<NotePage> {
    const after = cursor === undefined ? undefined : parseListCursor(cursor);
    return this.storage(async () => {
      const r = await this.db.execute(
        after
          ? {
              sql: "SELECT id,title,substr(body,1,140) AS preview,provider,mode,updated_at,revision FROM notes WHERE (updated_at,id) < (?,?) ORDER BY updated_at DESC, id DESC LIMIT 51",
              args: [after.updatedAt, after.id],
            }
          : "SELECT id,title,substr(body,1,140) AS preview,provider,mode,updated_at,revision FROM notes ORDER BY updated_at DESC, id DESC LIMIT 51",
      );
      const notes = r.rows.slice(0, 50).map((row) =>
        summarySchema.parse({
          id: row.id,
          title: row.title,
          preview: String(row.preview),
          provider: row.provider,
          mode: row.mode,
          updatedAt: row.updated_at,
          revision: row.revision,
        }),
      );
      const last = notes.at(-1);
      return {
        items: notes,
        nextCursor:
          r.rows.length > 50 && last
            ? Buffer.from(
                JSON.stringify({
                  v: 1,
                  updatedAt: last.updatedAt,
                  id: last.id,
                }),
              ).toString("base64url")
            : null,
      };
    });
  }
  async create(id: string, input: CreateNote): Promise<Note> {
    return this.write(async (tx) => {
      const existing = await tx.execute({
        sql: "SELECT notes.*, EXISTS(SELECT 1 FROM deleted_notes WHERE id=request.id) AS was_deleted FROM (SELECT ? AS id) AS request LEFT JOIN notes ON notes.id=request.id",
        args: [id],
      });
      const existingNote = existing.rows[0];
      if (existingNote.was_deleted === 1) throw new ApiError("note_deleted");
      if (existingNote.id !== null) {
        const note = toNote(existingNote);
        if (originFields.some((field) => note[field] !== input[field]))
          throw new ApiError("id_conflict");
        return note;
      }
      const stamp = new Date().toISOString();
      const r = await tx.execute({
        sql: "INSERT INTO notes (id,title,original_text,body,provider,model,mode,duration_ms,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,1) RETURNING *",
        args: [
          id,
          input.title,
          input.originalText,
          input.body,
          input.provider,
          input.model,
          input.mode,
          input.durationMs,
          stamp,
          stamp,
        ],
      });
      return toNote(r.rows[0]);
    });
  }
  async update(id: string, input: EditNote): Promise<Note> {
    return this.write(async (tx) => {
      const r = await tx.execute({
        sql: "UPDATE notes SET title=?, body=?, revision=revision+1, updated_at=? WHERE id=? AND revision=? AND revision < 9007199254740991 RETURNING *",
        args: [
          input.title,
          input.body,
          new Date().toISOString(),
          id,
          input.expectedRevision,
        ],
      });
      if (r.rows.length === 1) return toNote(r.rows[0]);
      const current = await tx.execute({
        sql: "SELECT * FROM notes WHERE id=?",
        args: [id],
      });
      if (!current.rows.length) return this.absent(tx, id);
      throw new ApiError("revision_conflict", toNote(current.rows[0]));
    });
  }
  async delete(id: string, revision: number): Promise<void> {
    return this.write(async (tx) => {
      const r = await tx.execute({
        sql: "DELETE FROM notes WHERE id=? AND revision=? RETURNING id",
        args: [id, revision],
      });
      if (r.rows.length === 1) {
        await tx.execute({
          sql: "INSERT INTO deleted_notes(id,deleted_at) VALUES (?,?)",
          args: [id, new Date().toISOString()],
        });
        return;
      }
      const current = await tx.execute({
        sql: "SELECT * FROM notes WHERE id=?",
        args: [id],
      });
      if (current.rows.length)
        throw new ApiError("revision_conflict", toNote(current.rows[0]));
      const deleted = await tx.execute({
        sql: "SELECT id FROM deleted_notes WHERE id=?",
        args: [id],
      });
      if (!deleted.rows.length) throw new ApiError("note_not_found");
    });
  }
  async settings(): Promise<Settings> {
    return this.storage(async () =>
      toSettings(
        (await this.db.execute("SELECT * FROM settings WHERE id=1")).rows[0],
      ),
    );
  }
  async saveSettings(input: SettingsEdit): Promise<Settings> {
    return this.write(async (tx) => {
      const r = await tx.execute({
        sql: "UPDATE settings SET vocabulary_json=?, revision=revision+1 WHERE id=1 AND revision=? AND revision < 9007199254740991 RETURNING *",
        args: [JSON.stringify(input.vocabulary), input.expectedRevision],
      });
      if (r.rows.length === 1) return toSettings(r.rows[0]);
      const current = toSettings(
        (await tx.execute("SELECT * FROM settings WHERE id=1")).rows[0],
      );
      throw new ApiError("revision_conflict", current);
    });
  }
}
