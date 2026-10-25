//ce fichier permet à sharedb d'utiliser postgreSQL pour conserver les modifications collaboratives , tout en appliquat la limitations sur les credits d'écritures comptés ici en caractère unicode 

import { randomUUID } from "node:crypto";
import ShareDB from "sharedb";
import { pool } from "../db.js";

const collectionName = "documents";
const textType = "text-unicode";

interface DocumentOperation { // comment est representé une modification 
  v: number;
  src?: string;
  seq?: number;
  op?: unknown[];
  m?: { editorId?: string; restoreExpectedRevision?: number };
}

// calcul des credits consommés 
function insertedCodePoints(operation: unknown[]): number {
  return operation.reduce<number>(
    (total, component) => total + (typeof component === "string" ? Array.from(component).length : 0),
    0
  );
}
// signaler un quota epuisé 
function creditExceededError(): Error {
  return Object.assign(new Error("Daily Unicode code point credit exhausted."), {
    code: "CREDIT_EXHAUSTED"
  });
}

function restoreConflictError(): Error {
  return Object.assign(new Error("Document changed before restoration could be applied."), {
    code: "RESTORE_CONFLICT"
  });
}

// Nous créons notre adaptateur postgreSQL (implemetation du stockage attendu par sharedb )
export class DocumentShareDb extends ShareDB.DB {
  commit(
    collection: string,
    documentId: string,
    operation: DocumentOperation,
    snapshot: { v: number; data: string },
    _options: unknown,
    callback: (error: Error | null, succeeded?: boolean) => void
  ): void {
    void this.commitDocument(collection, documentId, operation, snapshot, callback);
  }

  private async commitDocument(
    collection: string,
    documentId: string,
    operation: DocumentOperation,
    snapshot: { v: number; data: string },
    callback: (error: Error | null, succeeded?: boolean) => void
  ): Promise<void> {
    if (
      collection !== collectionName ||
      !operation.op ||
      !operation.m?.editorId ||
      !operation.src ||
      typeof operation.seq !== "number" ||
      !Number.isInteger(operation.seq) ||
      operation.seq < 0
    ) {
      callback(new Error("Invalid document operation."));
      return;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const sequence = operation.seq;
      const current = await client.query<{ revision: number }>(
        "SELECT revision FROM document_states WHERE document_id = $1 FOR UPDATE",
        [documentId]
      ); // verrouille la ligne du document pendant la transaction : c'est la base de notre protection contre les écirtures concurrentes 

      if (
        operation.m.restoreExpectedRevision !== undefined &&
        operation.m.restoreExpectedRevision !== current.rows[0]?.revision
      ) {
        throw restoreConflictError();
      }

      if (current.rowCount !== 1 || snapshot.v !== current.rows[0].revision + 1) {
        await client.query("ROLLBACK");
        callback(null, false);
        return;
      }

      const inserted = insertedCodePoints(operation.op);
      if (inserted > 0) {
        await client.query(
          `INSERT INTO daily_credits (editor_id, credit_date)
           VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date)
           ON CONFLICT (editor_id, credit_date) DO NOTHING`,
          [operation.m.editorId]
        );
        const debit = await client.query(
          `UPDATE daily_credits
           SET used_characters = used_characters + $2
           WHERE editor_id = $1
             AND credit_date = (NOW() AT TIME ZONE 'UTC')::date
             AND used_characters + $2 <= limit_characters
           RETURNING used_characters`,
          [operation.m.editorId, inserted]
        );
        if (debit.rowCount !== 1) {
          throw creditExceededError();
        }
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
           operation, inserted_code_points, source, sequence
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          documentId,
          operation.m.editorId,
          operation.v,
          snapshot.v,
          JSON.stringify(operation.op),
          inserted,
          operation.src,
          sequence
        ]
      );
      await client.query("COMMIT");
      callback(null, true);
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        callback(null, false);
        return;
      }
      callback(error instanceof Error ? error : new Error("Database operation failed."));
    } finally {
      client.release();
    }
  }

  getSnapshot( // permet de recuperer le document actuel 
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

  getOps( // permet de recuperer l'historique des opérations 
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
        const result = await pool.query<{
          accepted_revision: number;
          operation: unknown;
          source: string | null;
          sequence: number | null;
        }>(
          `SELECT accepted_revision, operation, source, sequence
           FROM edit_operations
           WHERE document_id = $1
             AND accepted_revision > $2
             AND ($3::integer IS NULL OR accepted_revision <= $3)
           ORDER BY accepted_revision`,
          [documentId, from ?? 0, to]
        );
        callback(null, result.rows.map((row) => ({
          v: row.accepted_revision - 1,
          op: row.operation,
          m: {},
          ...(row.source === null || row.sequence === null
            ? {}
            : { src: row.source, seq: row.sequence })
        })));
      } catch (error) {
        callback(error instanceof Error ? error : new Error("Database operation failed."));
      }
    })();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
