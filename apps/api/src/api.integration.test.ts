import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { hashSessionToken } from "./services/editors.js";

function sessionCookie(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(value);
  return value.split(";")[0];
}

test("editor and document API", async () => {
  const app = buildApp();
  const suffix = randomUUID();

  try {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);

    const invalidEditor = await app.inject({
      method: "POST",
      url: "/editors",
      payload: {
        displayName: "Alice",
        email: "not-an-email",
        is_admin: true
      }
    });
    assert.equal(invalidEditor.statusCode, 400);

    const firstEditor = await app.inject({
      method: "POST",
      url: "/editors",
      payload: {
        displayName: "Alice",
        email: ` Alice-${suffix}@Example.Test `
      }
    });
    assert.equal(firstEditor.statusCode, 201);
    const alice = firstEditor.json().editor as {
      id: string;
      email: string;
      isAdmin: boolean;
    };
    assert.equal(alice.email, `alice-${suffix}@example.test`);
    assert.equal(alice.isAdmin, false);
    const aliceCookie = sessionCookie(firstEditor.headers["set-cookie"]);
    const aliceToken = aliceCookie.split("=")[1];

    const reusedEditor = await app.inject({
      method: "POST",
      url: "/editors",
      payload: {
        displayName: "Other Alice",
        email: `alice-${suffix}@example.test`
      }
    });
    assert.equal(reusedEditor.statusCode, 201);
    assert.equal(reusedEditor.json().editor.id, alice.id);

    const storedSession = await pool.query<{ token_hash: string }>(
      `SELECT token_hash FROM editor_sessions
       WHERE token_hash = $1`,
      [hashSessionToken(aliceToken)]
    );
    assert.equal(storedSession.rows[0].token_hash.length, 64);
    assert.notEqual(storedSession.rows[0].token_hash, aliceCookie.split("=")[1]);

    const currentEditor = await app.inject({
      method: "GET",
      url: "/editors/me",
      headers: { cookie: aliceCookie }
    });
    assert.equal(currentEditor.statusCode, 200);
    assert.equal(currentEditor.json().editor.id, alice.id);

    const documentResponse = await app.inject({
      method: "POST",
      url: "/documents",
      headers: { cookie: aliceCookie },
      payload: {
        title: "Premier document",
        description: "Description"
      }
    });
    assert.equal(documentResponse.statusCode, 201);
    const document = documentResponse.json().document as { id: string; role: string };
    assert.equal(document.role, "owner");

    const documentRows = await pool.query<{
      role: string;
      revision: number;
    }>(
      `SELECT document_editors.role, document_states.revision
       FROM document_editors
       INNER JOIN document_states
         ON document_states.document_id = document_editors.document_id
       WHERE document_editors.document_id = $1
         AND document_editors.editor_id = $2`,
      [document.id, alice.id]
    );
    assert.deepEqual(documentRows.rows, [{ role: "owner", revision: 0 }]);

    const secondEditor = await app.inject({
      method: "POST",
      url: "/editors",
      payload: {
        displayName: "Bob",
        email: `bob-${suffix}@example.test`
      }
    });
    assert.equal(secondEditor.statusCode, 201);
    const bob = secondEditor.json().editor as { id: string };
    const bobCookie = sessionCookie(secondEditor.headers["set-cookie"]);

    const thirdEditor = await app.inject({
      method: "POST",
      url: "/editors",
      payload: {
        displayName: "Charlie",
        email: `charlie-${suffix}@example.test`
      }
    });
    assert.equal(thirdEditor.statusCode, 201);
    const charlieCookie = sessionCookie(thirdEditor.headers["set-cookie"]);

    const deniedDocument = await app.inject({
      method: "GET",
      url: `/documents/${document.id}`,
      headers: { cookie: bobCookie }
    });
    assert.equal(deniedDocument.statusCode, 403);

    const deniedInvitation = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/editors`,
      headers: { cookie: charlieCookie },
      payload: { editorId: bob.id }
    });
    assert.equal(deniedInvitation.statusCode, 403);

    const invitation = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/editors`,
      headers: { cookie: aliceCookie },
      payload: { editorId: bob.id }
    });
    assert.equal(invitation.statusCode, 201);

    const accessibleDocuments = await app.inject({
      method: "GET",
      url: "/documents",
      headers: { cookie: bobCookie }
    });
    assert.equal(accessibleDocuments.statusCode, 200);
    assert.equal(accessibleDocuments.json().documents[0].id, document.id);

    const duplicateInvitation = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/editors`,
      headers: { cookie: aliceCookie },
      payload: { editorId: bob.id }
    });
    assert.equal(duplicateInvitation.statusCode, 409);

    await pool.query(
      `UPDATE editor_sessions
       SET created_at = NOW() - INTERVAL '2 days',
           expires_at = NOW() - INTERVAL '1 second'
       WHERE token_hash = $1`,
      [hashSessionToken(aliceToken)]
    );
    const expiredSession = await app.inject({
      method: "GET",
      url: "/editors/me",
      headers: { cookie: aliceCookie }
    });
    assert.equal(expiredSession.statusCode, 401);

    const missingSession = await app.inject({
      method: "GET",
      url: "/documents"
    });
    assert.equal(missingSession.statusCode, 401);
  } finally {
    await app.close();
    await pool.end();
  }
});
