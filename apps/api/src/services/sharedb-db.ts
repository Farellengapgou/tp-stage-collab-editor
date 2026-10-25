import { randomUUID } from "node:crypto";
import ShareDB from "sharedb";
import { pool } from "../db.js";

const collectionName = "documents";
const textType = "text-unicode";

export class DocumentShareDb extends ShareDB.DB {
  commit(
    collection: string,
    documentId: string,
    operation: { v: number; op?: unknown[]; m?: { editorId?: string } },
    snapshot: { v: number; data: string },
    _options: unknown,
    callback: (error: Error | null, succeeded?: boolean) => void
  ): void {
    void this.commitDocument(collection, documentId, operation, snapshot, callback);
  }

  private async commitDocument(
    collection: string,
    documentId: string,
    operation: { v: number; op?: unknown[]; m?: { editorId?: string } },
    snapshot: { v: number; data: string },
    callback: (error: Error | null, succeeded?: boolean) => void
  ): Promise<void> {
    if (collection !== collectionName || !operation.op || !operation.m?.editorId) {
      callback(new Error("Invalid document operation."));
      return;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const current = await client.query<{ revision: number }>(
        "SELECT revision FROM document_states WHERE document_id = $1 FOR UPDATE",
        [documentId]
      );

      if (current.rowCount !== 1 || snapshot.v !== current.rows[0].revision + 1) {
        await client.query("ROLLBACK");
        callback(null, false);
        return;
      }

      await client.query(
        `UPDATE document_states
         SET content = $2, revision = $3, updated_at = NOW()
         WHERE document_id = $1`,
        [documentId, snapshot.data, snapshot.v]
      );
      await client.query(
        "UPDATE documents SET current_revision = $2 WHERE id = $1",
        [documentId, snapshot.v]
      );
      await client.query(
        `INSERT INTO edit_operations (
           id, document_id, editor_id, base_revision, accepted_revision,
           operation, inserted_code_points
         ) VALUES ($1, $2, $3, $4, $5, $6, 0)`,
        [
          randomUUID(),
          documentId,
          operation.m.editorId,
          operation.v,
          snapshot.v,
          JSON.stringify(operation.op)
        ]
      );
      await client.query("COMMIT");
      callback(null, true);
    } catch (error) {
      await client.query("ROLLBACK");
      callback(error instanceof Error ? error : new Error("Database operation failed."));
    } finally {
      client.release();
    }
  }

  getSnapshot(
    collection: string,
    documentId: string,
    _fields: unknown,
    _options: unknown,
    callback: (
      error: Error | null,
      snapshot?: { id: string; v: number; type: string | null; data?: string; m: null }
    ) => void
  ): void {
    void (async () => {
      if (collection !== collectionName) {
        callback(null, { id: documentId, v: 0, type: null, m: null });
        return;
      }

      try {
        const result = await pool.query<{ content: string; revision: number }>(
          "SELECT content, revision FROM document_states WHERE document_id = $1",
          [documentId]
        );
        const state = result.rows[0];
        callback(null, state
          ? { id: documentId, v: state.revision, type: textType, data: state.content, m: null }
          : { id: documentId, v: 0, type: null, m: null });
      } catch (error) {
        callback(error instanceof Error ? error : new Error("Database operation failed."));
      }
    })();
  }

  getOps(
    collection: string,
    documentId: string,
    from: number | null,
    to: number | null,
    _options: unknown,
    callback: (error: Error | null, operations?: unknown[]) => void
  ): void {
    void (async () => {
      if (collection !== collectionName) {
        callback(null, []);
        return;
      }

      try {
        const result = await pool.query<{ accepted_revision: number; operation: unknown }>(
          `SELECT accepted_revision, operation
           FROM edit_operations
           WHERE document_id = $1
             AND accepted_revision > $2
             AND ($3::integer IS NULL OR accepted_revision <= $3)
           ORDER BY accepted_revision`,
          [documentId, from ?? 0, to]
        );
        callback(null, result.rows.map((row) => ({
          v: row.accepted_revision - 1,
          op: row.operation
        })));
      } catch (error) {
        callback(error instanceof Error ? error : new Error("Database operation failed."));
      }
    })();
  }
}
