import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { createCollaborationBackend } from "../../src/services/collaboration.js";
import { addDocumentEditor, createDocument } from "../../src/services/documents.js";
import { createSession, findOrCreateEditor } from "../../src/services/editors.js";

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

function cookie(token: string): string {
  return `collab_session=${token}`;
}

function assertApiError(response: { statusCode: number; json(): unknown }, statusCode: number): void {
  assert.equal(response.statusCode, statusCode);
  assert.equal(typeof (response.json() as { error?: unknown }).error, "string");
}

test("document history and restoration", async () => {
  const app = buildApp();
  const writer = createCollaborationBackend();
  const suffix = randomUUID();
  const owner = await findOrCreateEditor("Owner", `history-owner-${suffix}@example.test`);
  const collaborator = await findOrCreateEditor("Collaborator", `history-collaborator-${suffix}@example.test`);
  const ownerSession = await createSession(owner.id);
  const collaboratorSession = await createSession(collaborator.id);
  const document = await createDocument(owner.id, "History document", "");

  try {
    await addDocumentEditor(owner.id, document.id, collaborator.id);
    await submit(writer, owner.id, document.id, "owner-edit", 1, 0, ["A🤖"]);
    await submit(writer, collaborator.id, document.id, "collaborator-edit", 1, 1, [2, "!"]);

    const history = await app.inject({
      method: "GET",
      url: `/documents/${document.id}/history`,
      headers: { cookie: cookie(ownerSession.token) }
    });
    assert.equal(history.statusCode, 200);
    const historyEntries = history.json().history as {
      revision: number;
      insertedCodePoints: number;
      author: { id: string } | null;
      acceptedAt: string | null;
    }[];
    assert.deepEqual(historyEntries[0], {
      revision: 0,
      baseRevision: null,
      insertedCodePoints: 0,
      acceptedAt: document.createdAt,
      author: null
    });
    assert.deepEqual(historyEntries.slice(1).map((entry) => ({
      revision: entry.revision,
      insertedCodePoints: entry.insertedCodePoints,
      authorId: entry.author?.id,
      acceptedAt: typeof entry.acceptedAt
    })), [
      { revision: 1, insertedCodePoints: 2, authorId: owner.id, acceptedAt: "string" },
      { revision: 2, insertedCodePoints: 1, authorId: collaborator.id, acceptedAt: "string" }
    ]);

    const revision = await app.inject({
      method: "GET",
      url: `/documents/${document.id}/history/1`,
      headers: { cookie: cookie(ownerSession.token) }
    });
    assert.equal(revision.statusCode, 200);
    assert.deepEqual(revision.json(), { document: { revision: 1, content: "A🤖" } });

    const initialRevision = await app.inject({
      method: "GET",
      url: `/documents/${document.id}/history/0`,
      headers: { cookie: cookie(ownerSession.token) }
    });
    assert.deepEqual(initialRevision.json(), { document: { revision: 0, content: "" } });

    const deniedRestore = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/history/1/restore`,
      headers: { cookie: cookie(collaboratorSession.token) },
      payload: { currentRevision: 2 }
    });
    assertApiError(deniedRestore, 403);

    const restored = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/history/1/restore`,
      headers: { cookie: cookie(ownerSession.token) },
      payload: { currentRevision: 2 }
    });
    assert.equal(restored.statusCode, 200);
    assert.deepEqual(restored.json(), { document: { revision: 3, content: "A🤖" } });

    const restoredOperation = await pool.query<{
      editor_id: string;
      base_revision: number;
      accepted_revision: number;
      inserted_code_points: number;
      operation: unknown;
    }>(
      `SELECT editor_id, base_revision, accepted_revision, inserted_code_points, operation
       FROM edit_operations
       WHERE document_id = $1 AND accepted_revision = 3`,
      [document.id]
    );
    assert.deepEqual(restoredOperation.rows[0], {
      editor_id: owner.id,
      base_revision: 2,
      accepted_revision: 3,
      inserted_code_points: 0,
      operation: [2, { d: "!" }]
    });

    await submit(writer, collaborator.id, document.id, "concurrent-edit", 1, 3, ["x"]);
    const staleRestore = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/history/1/restore`,
      headers: { cookie: cookie(ownerSession.token) },
      payload: { currentRevision: 3 }
    });
    assertApiError(staleRestore, 409);

    const state = await pool.query<{ content: string; revision: number }>(
      "SELECT content, revision FROM document_states WHERE document_id = $1",
      [document.id]
    );
    assert.deepEqual(state.rows[0], { content: "xA🤖", revision: 4 });

    const creditDocument = await createDocument(owner.id, "Credit history document", "");
    await submit(writer, owner.id, creditDocument.id, "credit-insert", 1, 0, ["é"]);
    await submit(writer, owner.id, creditDocument.id, "credit-delete", 2, 1, [{ d: "é" }]);
    await pool.query(
      `UPDATE daily_credits
       SET used_characters = 10000
       WHERE editor_id = $1 AND credit_date = (NOW() AT TIME ZONE 'UTC')::date`,
      [owner.id]
    );

    const overCreditRestore = await app.inject({
      method: "POST",
      url: `/documents/${creditDocument.id}/history/1/restore`,
      headers: { cookie: cookie(ownerSession.token) },
      payload: { currentRevision: 2 }
    });
    assertApiError(overCreditRestore, 409);

    const creditState = await pool.query<{ content: string; revision: number; used_characters: number }>(
      `SELECT document_states.content, document_states.revision, daily_credits.used_characters
       FROM document_states
       INNER JOIN daily_credits ON daily_credits.editor_id = $2
         AND daily_credits.credit_date = (NOW() AT TIME ZONE 'UTC')::date
       WHERE document_states.document_id = $1`,
      [creditDocument.id, owner.id]
    );
    assert.deepEqual(creditState.rows[0], { content: "", revision: 2, used_characters: 10000 });

    const chargedOwner = await findOrCreateEditor("Charged owner", `history-credit-${suffix}@example.test`);
    const chargedSession = await createSession(chargedOwner.id);
    const chargedDocument = await createDocument(chargedOwner.id, "Charged restore document", "");
    await submit(writer, chargedOwner.id, chargedDocument.id, "charged-insert", 1, 0, ["🤖"]);
    await submit(writer, chargedOwner.id, chargedDocument.id, "charged-delete", 2, 1, [{ d: "🤖" }]);

    const chargedRestore = await app.inject({
      method: "POST",
      url: `/documents/${chargedDocument.id}/history/1/restore`,
      headers: { cookie: cookie(chargedSession.token) },
      payload: { currentRevision: 2 }
    });
    assert.equal(chargedRestore.statusCode, 200);

    const chargedRestoreState = await pool.query<{
      content: string;
      revision: number;
      inserted_code_points: number;
      used_characters: number;
    }>(
      `SELECT document_states.content, document_states.revision,
              edit_operations.inserted_code_points, daily_credits.used_characters
       FROM document_states
       INNER JOIN edit_operations
         ON edit_operations.document_id = document_states.document_id
         AND edit_operations.accepted_revision = 3
       INNER JOIN daily_credits
         ON daily_credits.editor_id = $2
         AND daily_credits.credit_date = (NOW() AT TIME ZONE 'UTC')::date
       WHERE document_states.document_id = $1`,
      [chargedDocument.id, chargedOwner.id]
    );
    assert.deepEqual(chargedRestoreState.rows[0], {
      content: "🤖",
      revision: 3,
      inserted_code_points: 1,
      used_characters: 2
    });

    const invalidRestore = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/history/1/restore`,
      headers: { cookie: cookie(ownerSession.token) },
      payload: { currentRevision: "4" }
    });
    assertApiError(invalidRestore, 400);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => writer.close(() => resolve())),
      app.close()
    ]);
    await pool.end();
  }
});
