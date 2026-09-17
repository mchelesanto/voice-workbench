import "server-only";
import { createHash } from "node:crypto";
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
  revisionSchema,
  areaFilterSchema,
  areaSchema,
  createAreaSchema,
  editAreaSchema,
  libraryStateSchema,
  resetResolutionSchema,
  type Note,
  type CreateNote,
  type EditNote,
  type NotePage,
  type Settings,
  type SettingsEdit,
  type Area,
  type CreateArea,
  type EditArea,
  type AreaFilter,
  type LibraryState,
  type ResetInput,
  type ResetReceipt,
  type ResetResolution,
} from "../shared/contracts";
import { ApiError } from "./errors";
import { sameNoteOrigin } from "../shared/responses";

const cursorSchema = z.strictObject({
  v: z.literal(2),
  generation: revisionSchema,
  area: areaFilterSchema,
  updatedAt: isoSchema,
  id: idSchema,
});
export function parseListCursor(cursor: string) {
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))
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
    generation: row.generation,
    areaId: row.area_id,
  });
}
function toSettings(row?: Row): Settings {
  if (!row) throw new ApiError("schema_unavailable");
  return settingsSchema.parse({
    vocabulary: JSON.parse(String(row.vocabulary_json)),
    revision: row.revision,
  });
}
function toArea(row: Row): Area {
  return areaSchema.parse({
    id: row.id,
    name: row.name,
    vocabulary: JSON.parse(String(row.vocabulary_json)),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  });
}
function toResolution(row: Row): ResetResolution {
  return resetResolutionSchema.parse(
    row.state === "cancelled"
      ? {
          state: "cancelled",
          operationId: row.operation_id,
          expectedGeneration: row.from_generation,
        }
      : {
          state: "completed",
          receipt: {
            operationId: row.operation_id,
            fromGeneration: row.from_generation,
            generation: row.to_generation,
            resetAt: row.reset_at,
            deletedNoteCount: row.deleted_note_count,
          },
        },
  );
}
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
      if (error instanceof LibsqlError) {
        if (
          error.code === "SQLITE_ERROR" &&
          /\bno such table: (?:notes|library_notes|library_state|library_resets|areas|settings|deleted_notes)\b/i.test(
            error.message,
          )
        )
          throw new ApiError("schema_unavailable");
        if (
          error.code.startsWith("SQLITE_CONSTRAINT") &&
          /areas\.name_key/.test(error.message)
        )
          throw new ApiError("area_name_conflict");
      }
      throw new ApiError("storage_unavailable");
    }
  }
  private async transaction<T>(
    mode: "read" | "write",
    run: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.storage(async () => {
      const tx = await this.db.transaction(mode);
      try {
        const value = await run(tx);
        await tx.commit();
        return value;
      } catch (error) {
        try {
          await tx.rollback();
        } catch {
          /* Preserve the sanitized cause. */
        }
        throw error;
      } finally {
        tx.close();
      }
    });
  }
  private async state(tx: Client | Transaction): Promise<LibraryState> {
    const row = (await tx.execute("SELECT * FROM library_state WHERE id=1"))
      .rows[0];
    if (!row) throw new ApiError("schema_unavailable");
    return libraryStateSchema.parse({
      generation: row.generation,
      lastResetAt: row.last_reset_at,
    });
  }
  private async requireGeneration(
    tx: Client | Transaction,
    generation: number,
  ) {
    if (!revisionSchema.safeParse(generation).success)
      throw new ApiError("invalid_input");
    const current = await this.state(tx);
    if (current.generation !== generation)
      throw new ApiError("library_reset", { kind: "library", current });
    return current;
  }
  libraryState() {
    return this.storage(() => this.state(this.db));
  }
  checkGeneration(generation: number) {
    return this.storage(() => this.requireGeneration(this.db, generation));
  }
  private async requireArea(tx: Transaction, id: string | null) {
    if (
      id !== null &&
      !(
        await tx.execute({ sql: "SELECT id FROM areas WHERE id=?", args: [id] })
      ).rows.length
    )
      throw new ApiError("area_not_found");
  }
  private async absent(tx: Transaction, id: string): Promise<never> {
    const r = await tx.execute({
      sql: "SELECT id FROM deleted_notes WHERE id=?",
      args: [id],
    });
    throw new ApiError(r.rows.length ? "note_deleted" : "note_not_found");
  }
  get(id: string, generation: number): Promise<Note> {
    return this.transaction("read", async (tx) => {
      await this.requireGeneration(tx, generation);
      const r = await tx.execute({
        sql: "SELECT * FROM library_notes WHERE id=?",
        args: [id],
      });
      return r.rows[0] ? toNote(r.rows[0]) : this.absent(tx, id);
    });
  }
  async list(
    generation: number,
    area: AreaFilter = "all",
    cursor?: string,
  ): Promise<NotePage> {
    const after = cursor === undefined ? undefined : parseListCursor(cursor);
    if (
      !areaFilterSchema.safeParse(area).success ||
      (after && after.area !== area)
    )
      throw new ApiError("invalid_input");
    return this.transaction("read", async (tx) => {
      await this.requireGeneration(tx, generation);
      if (after && after.generation !== generation)
        throw new ApiError("library_reset", {
          kind: "library",
          current: await this.state(tx),
        });
      const where: string[] = [];
      const args: (string | number | null)[] = [];
      if (area !== "all") {
        where.push("area_id IS ?");
        args.push(area === "general" ? null : area);
      }
      if (after) {
        where.push("(updated_at,id) < (?,?)");
        args.push(after.updatedAt, after.id);
      }
      const rows = (
        await tx.execute({
          sql: `SELECT id,title,substr(body,1,140) AS preview,provider,mode,updated_at,revision,generation,area_id FROM library_notes ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC,id DESC LIMIT 51`,
          args,
        })
      ).rows;
      const items = rows.slice(0, 50).map((row) =>
        summarySchema.parse({
          id: row.id,
          title: row.title,
          preview: String(row.preview),
          provider: row.provider,
          mode: row.mode,
          updatedAt: row.updated_at,
          revision: row.revision,
          generation: row.generation,
          areaId: row.area_id,
        }),
      );
      const last = items.at(-1);
      return {
        generation,
        items,
        nextCursor:
          rows.length > 50 && last
            ? Buffer.from(
                JSON.stringify({
                  v: 2,
                  generation,
                  area,
                  updatedAt: last.updatedAt,
                  id: last.id,
                }),
              ).toString("base64url")
            : null,
      };
    });
  }
  create(id: string, input: CreateNote): Promise<Note> {
    return this.transaction("write", async (tx) => {
      await this.requireGeneration(tx, input.generation);
      await this.requireArea(tx, input.areaId);
      if (
        (
          await tx.execute({
            sql: "SELECT id FROM deleted_notes WHERE id=?",
            args: [id],
          })
        ).rows.length
      )
        throw new ApiError("note_deleted");
      const existing = (
        await tx.execute({
          sql: "SELECT * FROM library_notes WHERE id=?",
          args: [id],
        })
      ).rows[0];
      if (existing) {
        const current = toNote(existing);
        if (!sameNoteOrigin(input, current))
          throw new ApiError("id_conflict", { kind: "note", current });
        return current;
      }
      const stamp = new Date().toISOString();
      const r = await tx.execute({
        sql: "INSERT INTO library_notes(id,title,original_text,body,provider,model,mode,duration_ms,created_at,updated_at,revision,generation,area_id) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?) RETURNING *",
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
          input.generation,
          input.areaId,
        ],
      });
      return toNote(r.rows[0]);
    });
  }
  update(id: string, input: EditNote): Promise<Note> {
    return this.transaction("write", async (tx) => {
      await this.requireGeneration(tx, input.generation);
      await this.requireArea(tx, input.areaId);
      const r = await tx.execute({
        sql: "UPDATE library_notes SET title=?,body=?,area_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND revision<9007199254740991 RETURNING *",
        args: [
          input.title,
          input.body,
          input.areaId,
          new Date().toISOString(),
          id,
          input.expectedRevision,
        ],
      });
      if (r.rows.length) return toNote(r.rows[0]);
      const row = (
        await tx.execute({
          sql: "SELECT * FROM library_notes WHERE id=?",
          args: [id],
        })
      ).rows[0];
      if (!row) return this.absent(tx, id);
      throw new ApiError("revision_conflict", {
        kind: "note",
        current: toNote(row),
      });
    });
  }
  delete(id: string, revision: number, generation: number): Promise<void> {
    return this.transaction("write", async (tx) => {
      await this.requireGeneration(tx, generation);
      const r = await tx.execute({
        sql: "DELETE FROM library_notes WHERE id=? AND revision=? RETURNING id",
        args: [id, revision],
      });
      if (r.rows.length) {
        await tx.execute({
          sql: "INSERT INTO deleted_notes(id,deleted_at) VALUES (?,?)",
          args: [id, new Date().toISOString()],
        });
        return;
      }
      const row = (
        await tx.execute({
          sql: "SELECT * FROM library_notes WHERE id=?",
          args: [id],
        })
      ).rows[0];
      if (row)
        throw new ApiError("revision_conflict", {
          kind: "note",
          current: toNote(row),
        });
      if (
        !(
          await tx.execute({
            sql: "SELECT id FROM deleted_notes WHERE id=?",
            args: [id],
          })
        ).rows.length
      )
        throw new ApiError("note_not_found");
    });
  }
  settings(): Promise<Settings> {
    return this.storage(async () =>
      toSettings(
        (await this.db.execute("SELECT * FROM settings WHERE id=1")).rows[0],
      ),
    );
  }
  saveSettings(input: SettingsEdit): Promise<Settings> {
    return this.transaction("write", async (tx) => {
      const r = await tx.execute({
        sql: "UPDATE settings SET vocabulary_json=?,revision=revision+1 WHERE id=1 AND revision=? AND revision<9007199254740991 RETURNING *",
        args: [JSON.stringify(input.vocabulary), input.expectedRevision],
      });
      if (r.rows.length) return toSettings(r.rows[0]);
      throw new ApiError("revision_conflict", {
        kind: "settings",
        current: toSettings(
          (await tx.execute("SELECT * FROM settings WHERE id=1")).rows[0],
        ),
      });
    });
  }
  areas(): Promise<Area[]> {
    return this.storage(async () =>
      (
        await this.db.execute("SELECT * FROM areas ORDER BY name_key,id")
      ).rows.map(toArea),
    );
  }
  async createArea(id: string, input: CreateArea): Promise<Area> {
    const parsed = createAreaSchema.safeParse(input);
    if (!parsed.success) throw new ApiError("invalid_input");
    const value = parsed.data;
    const digest = createHash("sha256")
      .update(JSON.stringify([value.name, value.vocabulary]))
      .digest("hex");
    return this.transaction("write", async (tx) => {
      const row = (
        await tx.execute({ sql: "SELECT * FROM areas WHERE id=?", args: [id] })
      ).rows[0];
      if (row) {
        const current = toArea(row);
        if (row.creation_digest !== digest)
          throw new ApiError("id_conflict", { kind: "area", current });
        return current;
      }
      const stamp = new Date().toISOString();
      return toArea(
        (
          await tx.execute({
            sql: "INSERT INTO areas(id,name,name_key,vocabulary_json,revision,created_at,updated_at,archived_at,creation_digest) VALUES (?,?,?,?,1,?,?,NULL,?) RETURNING *",
            args: [
              id,
              value.name,
              value.name.toLowerCase(),
              JSON.stringify(value.vocabulary),
              stamp,
              stamp,
              digest,
            ],
          })
        ).rows[0],
      );
    });
  }
  async updateArea(id: string, input: EditArea): Promise<Area> {
    const parsed = editAreaSchema.safeParse(input);
    if (!parsed.success) throw new ApiError("invalid_input");
    const value = parsed.data;
    return this.transaction("write", async (tx) => {
      const row = (
        await tx.execute({ sql: "SELECT * FROM areas WHERE id=?", args: [id] })
      ).rows[0];
      if (!row) throw new ApiError("area_not_found");
      const current = toArea(row);
      if (
        current.revision !== value.expectedRevision ||
        current.revision === Number.MAX_SAFE_INTEGER
      )
        throw new ApiError("revision_conflict", { kind: "area", current });
      const stamp = new Date().toISOString();
      return toArea(
        (
          await tx.execute({
            sql: "UPDATE areas SET name=?,name_key=?,vocabulary_json=?,revision=revision+1,updated_at=?,archived_at=? WHERE id=? RETURNING *",
            args: [
              value.name,
              value.name.toLowerCase(),
              JSON.stringify(value.vocabulary),
              stamp,
              value.archived ? (current.archivedAt ?? stamp) : null,
              id,
            ],
          })
        ).rows[0],
      );
    });
  }
  private async receipt(tx: Transaction, input: ResetInput) {
    const row = (
      await tx.execute({
        sql: "SELECT * FROM library_resets WHERE operation_id=?",
        args: [input.operationId],
      })
    ).rows[0];
    if (!row) return;
    const current = toResolution(row);
    if (row.from_generation !== input.expectedGeneration)
      throw new ApiError("reset_conflict", { kind: "reset", current });
    return current;
  }
  resetLibrary(input: ResetInput): Promise<ResetReceipt> {
    return this.transaction("write", async (tx) => {
      const existing = await this.receipt(tx, input);
      if (existing?.state === "completed") return existing.receipt;
      if (existing)
        throw new ApiError("reset_cancelled", {
          kind: "reset",
          current: existing,
        });
      const state = await this.requireGeneration(tx, input.expectedGeneration);
      if (state.generation === Number.MAX_SAFE_INTEGER)
        throw new ApiError("generation_exhausted");
      const stamp = new Date().toISOString();
      const count = Number(
        (await tx.execute("SELECT count(*) AS n FROM library_notes")).rows[0].n,
      );
      await tx.execute({
        sql: "INSERT OR IGNORE INTO deleted_notes(id,deleted_at) SELECT id,? FROM library_notes",
        args: [stamp],
      });
      await tx.execute("DELETE FROM library_notes");
      await tx.execute({
        sql: "UPDATE library_state SET generation=generation+1,last_reset_at=? WHERE id=1",
        args: [stamp],
      });
      await tx.execute({
        sql: "INSERT INTO library_resets VALUES (?,?,'completed',?,?,?)",
        args: [
          input.operationId,
          state.generation,
          state.generation + 1,
          stamp,
          count,
        ],
      });
      return {
        operationId: input.operationId,
        fromGeneration: state.generation,
        generation: state.generation + 1,
        resetAt: stamp,
        deletedNoteCount: count,
      };
    });
  }
  cancelReset(input: ResetInput): Promise<ResetResolution> {
    return this.transaction("write", async (tx) => {
      const existing = await this.receipt(tx, input);
      if (existing) return existing;
      await tx.execute({
        sql: "INSERT INTO library_resets VALUES (?,?,'cancelled',NULL,NULL,NULL)",
        args: [input.operationId, input.expectedGeneration],
      });
      return { state: "cancelled", ...input };
    });
  }
}
