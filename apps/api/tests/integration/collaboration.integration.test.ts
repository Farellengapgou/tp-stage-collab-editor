import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { pool } from "../../src/db.js";
import { createCollaborationBackend } from "../../src/services/collaboration.js";

function submit(
  backend: ReturnType<typeof createCollaborationBackend>,
  editorId: string,
  documentId: string,
  source: string,
  sequence: number,
  version: number,
  operation: unknown[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    backend.submit(
      { protocol: "1.2", custom: { editorId } } as never,
      "documents",
      documentId,
      { src: source, seq: sequence, v: version, op: operation },
      null,
      (error) => error ? reject(error) : resolve()
    );
  });
}

async function createDocument(editorIds: string[]): Promise<string> {
  const documentId = randomUUID();
  const suffix = randomUUID();
  await Promise.all(editorIds.map((editorId, index) => pool.query(
    "INSERT INTO editors (id, name, email) VALUES ($1, $2, $3)",
    [editorId, `Editor ${index}`, `editor-${suffix}-${index}@example.test`]
  )));
  await pool.query("INSERT INTO documents (id, title) VALUES ($1, $2)", [documentId, "Collaboration document"]);
  await pool.query(
    `INSERT INTO document_editors (document_id, editor_id, role)
     SELECT $1, editor_id, CASE WHEN ordinality = 1 THEN 'owner' ELSE 'editor' END
     FROM UNNEST($2::uuid[]) WITH ORDINALITY AS editors(editor_id, ordinality)`,
    [documentId, editorIds]
  );
  await pool.query(
    "INSERT INTO document_states (document_id, content, revision) VALUES ($1, '', 0)",
    [documentId]
  );
  return documentId;
}

async function closeBackend(backend: ReturnType<typeof createCollaborationBackend>): Promise<void> {
  await new Promise<void>((resolve) => backend.close(() => resolve()));
}

test("ShareDB debits daily Unicode credits atomically and idempotently", async (t) => {
  await t.test("concurrent Unicode operations converge and debit each accepted insertion", async () => {
    const backend = createCollaborationBackend();
    const firstEditorId = randomUUID();
    const secondEditorId = randomUUID();
    const documentId = await createDocument([firstEditorId, secondEditorId]);

    try {
      await Promise.all([
        submit(backend, firstEditorId, documentId, "first", 1, 0, ["🤖"]),
        submit(backend, secondEditorId, documentId, "second", 1, 0, ["👻"])
      ]);

      const state = await pool.query<{ content: string; revision: number; current_revision: number }>(
        `SELECT document_states.content, document_states.revision, documents.current_revision
         FROM document_states
         INNER JOIN documents ON documents.id = document_states.document_id
         WHERE document_states.document_id = $1`,
        [documentId]
      );
      const revisions = await pool.query<{ base_revision: number; accepted_revision: number }>(
        `SELECT base_revision, accepted_revision
         FROM edit_operations
         WHERE document_id = $1
         ORDER BY accepted_revision`,
        [documentId]
      );
      const credits = await pool.query<{ used_characters: number }>(
        `SELECT used_characters FROM daily_credits
         WHERE editor_id = ANY($1::uuid[])
           AND credit_date = (NOW() AT TIME ZONE 'UTC')::date
         ORDER BY used_characters`,
        [[firstEditorId, secondEditorId]]
      );

      assert.equal(state.rows[0].revision, 2);
      assert.equal(state.rows[0].current_revision, 2);
      assert.equal(Array.from(state.rows[0].content).length, 2);
      assert.deepEqual(revisions.rows, [
        { base_revision: 0, accepted_revision: 1 },
        { base_revision: 1, accepted_revision: 2 }
      ]);
      assert.deepEqual(credits.rows.map((row) => row.used_characters), [1, 1]);
    } finally {
      await closeBackend(backend);
    }
  });

  await t.test("an operation over the remaining quota changes neither state nor credits", async () => {
    const backend = createCollaborationBackend();
    const editorId = randomUUID();
    const documentId = await createDocument([editorId]);

    try {
      await pool.query(
        `INSERT INTO daily_credits (editor_id, credit_date, used_characters)
         VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date, 9999)`,
        [editorId]
      );

      await assert.rejects(
        submit(backend, editorId, documentId, "over-limit", 1, 0, ["ab"]),
        (error: { code?: string }) => error.code === "CREDIT_EXHAUSTED"
      );

      const state = await pool.query<{ content: string; revision: number }>(
        "SELECT content, revision FROM document_states WHERE document_id = $1",
        [documentId]
      );
      const credit = await pool.query<{ used_characters: number }>(
        "SELECT used_characters FROM daily_credits WHERE editor_id = $1 AND credit_date = (NOW() AT TIME ZONE 'UTC')::date",
        [editorId]
      );
      const operations = await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM edit_operations WHERE document_id = $1",
        [documentId]
      );

      assert.deepEqual(state.rows[0], { content: "", revision: 0 });
      assert.equal(credit.rows[0].used_characters, 9999);
      assert.equal(operations.rows[0].count, 0);
    } finally {
      await closeBackend(backend);
    }
  });

  await t.test("two backend instances cannot exceed one editor's daily quota", async () => {
    const firstBackend = createCollaborationBackend();
    const secondBackend = createCollaborationBackend();
    const editorId = randomUUID();
    const documentId = await createDocument([editorId]);

    try {
      const results = await Promise.allSettled([
        submit(firstBackend, editorId, documentId, "instance-one", 1, 0, ["a".repeat(6000)]),
        submit(secondBackend, editorId, documentId, "instance-two", 1, 0, ["b".repeat(6000)])
      ]);
      const state = await pool.query<{ revision: number }>(
        "SELECT revision FROM document_states WHERE document_id = $1",
        [documentId]
      );
      const credit = await pool.query<{ used_characters: number }>(
        "SELECT used_characters FROM daily_credits WHERE editor_id = $1 AND credit_date = (NOW() AT TIME ZONE 'UTC')::date",
        [editorId]
      );
      const operations = await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM edit_operations WHERE document_id = $1",
        [documentId]
      );

      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      assert.equal(state.rows[0].revision, 1);
      assert.equal(credit.rows[0].used_characters, 6000);
      assert.equal(operations.rows[0].count, 1);
    } finally {
      await Promise.all([closeBackend(firstBackend), closeBackend(secondBackend)]);
    }
  });

  await t.test("a retransmitted operation is not applied or billed twice", async () => {
    const firstBackend = createCollaborationBackend();
    const secondBackend = createCollaborationBackend();
    const editorId = randomUUID();
    const documentId = await createDocument([editorId]);

    try {
      const firstDelivery = await Promise.allSettled([
        submit(firstBackend, editorId, documentId, "retransmission", 1, 0, ["é"]),
        submit(secondBackend, editorId, documentId, "retransmission", 1, 0, ["é"])
      ]);
      assert.equal(firstDelivery.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(firstDelivery.filter((result) => result.status === "rejected").length, 1);

      await assert.rejects(
        submit(secondBackend, editorId, documentId, "retransmission", 1, 0, ["é"]),
        (error: { code?: string }) => error.code === "ERR_OP_ALREADY_SUBMITTED"
      );

      const state = await pool.query<{ content: string; revision: number }>(
        "SELECT content, revision FROM document_states WHERE document_id = $1",
        [documentId]
      );
      const credit = await pool.query<{ used_characters: number }>(
        "SELECT used_characters FROM daily_credits WHERE editor_id = $1 AND credit_date = (NOW() AT TIME ZONE 'UTC')::date",
        [editorId]
      );
      const operations = await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM edit_operations WHERE document_id = $1",
        [documentId]
      );

      assert.deepEqual(state.rows[0], { content: "é", revision: 1 });
      assert.equal(credit.rows[0].used_characters, 1);
      assert.equal(operations.rows[0].count, 1);
    } finally {
      await Promise.all([closeBackend(firstBackend), closeBackend(secondBackend)]);
    }
  });

  await pool.end();
});
