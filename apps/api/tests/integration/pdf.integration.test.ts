import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { pool } from "../../src/db.js";
import { createCollaborationBackend } from "../../src/services/collaboration.js";
import { createDocument } from "../../src/services/documents.js";
import { findOrCreateEditor } from "../../src/services/editors.js";
import {
  generateDocumentPdf,
  prepareDocumentPdf,
  type PdfStorageClient
} from "../../src/services/pdf.js";

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

    const uploads: Array<{ Bucket?: string; Key?: string; Body?: unknown }> = [];
    const storage: PdfStorageClient = {
      async send(command: PutObjectCommand): Promise<unknown> {
        uploads.push(command.input);
        return {};
      }
    };
    const prepared = await prepareDocumentPdf(document.id, 1, {
      bucket: "test-private-pdfs",
      storage
    });
    const reused = await prepareDocumentPdf(document.id, 1, {
      bucket: "test-private-pdfs",
      storage
    });
    assert.deepEqual(prepared, reused);
    assert.equal(prepared.status, "ready");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].Bucket, "test-private-pdfs");
    assert.equal(uploads[0].Key, `documents/${document.id}/revisions/1.pdf`);
    assert.ok(uploads[0].Body instanceof Buffer);
    assert.equal((uploads[0].Body as Buffer).subarray(0, 5).toString(), "%PDF-");

    const failed = await prepareDocumentPdf(document.id, 2, {
      bucket: "test-private-pdfs",
      storage: {
        async send(): Promise<unknown> {
          throw new Error("simulated S3 failure");
        }
      }
    });
    assert.equal(failed.status, "failed");

    let signalUploadStarted: () => void = () => {};
    const uploadStarted = new Promise<void>((resolve) => {
      signalUploadStarted = resolve;
    });
    let releaseUpload: () => void = () => {};
    const uploadReleased = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const delayedStorage: PdfStorageClient = {
      async send(): Promise<unknown> {
        signalUploadStarted();
        await uploadReleased;
        return {};
      }
    };
    const preparing = prepareDocumentPdf(document.id, 3, {
      bucket: "test-private-pdfs",
      storage: delayedStorage
    });
    await uploadStarted;
    const concurrent = await prepareDocumentPdf(document.id, 3, {
      bucket: "test-private-pdfs",
      storage: delayedStorage
    });
    assert.equal(concurrent.status, "preparing");
    releaseUpload();
    assert.equal((await preparing).status, "ready");

    const artifacts = await pool.query<{
      revision: number;
      status: string;
      generated_at: Date | null;
    }>(
      `SELECT revision, status, generated_at
       FROM pdf_artifacts
       WHERE document_id = $1
       ORDER BY revision`,
      [document.id]
    );
    assert.deepEqual(artifacts.rows.map((artifact) => ({
      revision: artifact.revision,
      status: artifact.status,
      generated: artifact.generated_at instanceof Date
    })), [
      { revision: 1, status: "ready", generated: true },
      { revision: 2, status: "failed", generated: false },
      { revision: 3, status: "ready", generated: true }
    ]);
  } finally {
    await closeBackend(backend);
    await pool.end();
  }
});
