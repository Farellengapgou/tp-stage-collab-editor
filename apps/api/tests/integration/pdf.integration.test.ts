import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { pool } from "../../src/db.js";
import { createCollaborationBackend } from "../../src/services/collaboration.js";
import { createDocument } from "../../src/services/documents.js";
import { findOrCreateEditor } from "../../src/services/editors.js";
import { generateDocumentPdf } from "../../src/services/pdf.js";

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

function closeBackend(backend: ReturnType<typeof createCollaborationBackend>): Promise<void> {
  return new Promise((resolve) => backend.close(() => resolve()));
}

test("PDF generation reconstructs immutable document revisions", async () => {
  const backend = createCollaborationBackend();
  const suffix = randomUUID();
  const editor = await findOrCreateEditor("PDF owner", `pdf-${suffix}@example.test`);
  const document = await createDocument(editor.id, "PDF document", "");

  try {
    await pool.query(
      `INSERT INTO download_links (id, document_id, public_token, max_downloads)
       VALUES ($1, $2, $3, 1)`,
      [randomUUID(), document.id, randomUUID()]
    );
    await submit(backend, editor.id, document.id, "pdf-first", 1, 0, ["Bonjour éàç"]);
    const first = await generateDocumentPdf(document.id, 1);
    await submit(backend, editor.id, document.id, "pdf-second", 1, 1, [11, " monde"]);
    const second = await generateDocumentPdf(document.id, 2);
    await submit(backend, editor.id, document.id, "pdf-third", 1, 2, [17, " !"]);
    const firstAfterLaterEdit = await generateDocumentPdf(document.id, 1);

    assert.equal(first.revision, 1);
    assert.equal(first.content, "Bonjour éàç");
    assert.equal(second.revision, 2);
    assert.equal(second.content, "Bonjour éàç monde");
    assert.equal(firstAfterLaterEdit.content, first.content);
    assert.notDeepEqual(second.buffer, first.buffer);
    for (const pdf of [first.buffer, second.buffer]) {
      assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
      assert.ok(pdf.includes(Buffer.from("%%EOF")));
    }
    const quota = await pool.query<{ consumed_downloads: number; active_reservations: number }>(
      "SELECT consumed_downloads, active_reservations FROM download_links WHERE document_id = $1",
      [document.id]
    );
    assert.deepEqual(quota.rows[0], { consumed_downloads: 0, active_reservations: 0 });
  } finally {
    await closeBackend(backend);
    await pool.end();
  }
});
