import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { pool } from "./db.js";
import { createCollaborationBackend } from "./services/collaboration.js";

function submit(
  backend: ReturnType<typeof createCollaborationBackend>,
  editorId: string,
  documentId: string,
  source: string,
  operation: unknown[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    backend.submit(
      { protocol: "1.2", custom: { editorId } } as never,
      "documents",
      documentId,
      { src: source, seq: 1, v: 0, op: operation },
      null,
      (error) => error ? reject(error) : resolve()
    );
  });
}

test("concurrent Unicode text operations converge durably", async () => {
  const backend = createCollaborationBackend();
  const documentId = randomUUID();
  const firstEditorId = randomUUID();
  const secondEditorId = randomUUID();
  const suffix = randomUUID();

  try {
    await pool.query(
      `INSERT INTO editors (id, name, email)
       VALUES ($1, 'First editor', $2), ($3, 'Second editor', $4)`,
      [
        firstEditorId,
        `first-${suffix}@example.test`,
        secondEditorId,
        `second-${suffix}@example.test`
      ]
    );
    await pool.query(
      `INSERT INTO documents (id, title)
       VALUES ($1, 'Concurrent document')`,
      [documentId]
    );
    await pool.query(
      `INSERT INTO document_editors (document_id, editor_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'editor')`,
      [documentId, firstEditorId, secondEditorId]
    );
    await pool.query(
      `INSERT INTO document_states (document_id, content, revision)
       VALUES ($1, '', 0)`,
      [documentId]
    );

    await Promise.all([
      submit(backend, firstEditorId, documentId, "first", ["🤖"]),
      submit(backend, secondEditorId, documentId, "second", ["👻"])
    ]);

    const state = await pool.query<{ content: string; revision: number }>(
      "SELECT content, revision FROM document_states WHERE document_id = $1",
      [documentId]
    );
    const operations = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM edit_operations WHERE document_id = $1",
      [documentId]
    );

    assert.equal(state.rows[0].revision, 2);
    assert.equal(Array.from(state.rows[0].content).length, 2);
    assert.equal(operations.rows[0].count, 2);
  } finally {
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await pool.end();
  }
});
