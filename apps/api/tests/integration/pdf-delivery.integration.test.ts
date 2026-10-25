import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { createCollaborationBackend } from "../../src/services/collaboration.js";
import { createDocument } from "../../src/services/documents.js";
import { reserveDownload } from "../../src/services/downloads.js";
import { createSession, findOrCreateEditor } from "../../src/services/editors.js";
import { type PdfStorageClient } from "../../src/services/pdf.js";

class MemoryPdfStorage implements PdfStorageClient {
  readonly objects = new Map<string, Buffer>();
  failGet = false;

  async send(command: PutObjectCommand | GetObjectCommand): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const body = command.input.Body;
      assert.ok(body instanceof Buffer);
      assert.ok(command.input.Key);
      this.objects.set(command.input.Key, body);
      return {};
    }
    if (this.failGet) {
      throw new Error("Simulated S3 read failure");
    }
    const body = this.objects.get(command.input.Key ?? "");
    if (!body) {
      throw new Error("PDF object not found");
    }
    return { Body: Readable.from([body]) };
  }
}

function submit(
  backend: ReturnType<typeof createCollaborationBackend>,
  editorId: string,
  documentId: string,
  source: string,
  version: number,
  operation: unknown[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    backend.submit(
      { protocol: "1.2", custom: { editorId } } as never,
      "documents",
      documentId,
      { src: source, seq: 1, v: version, op: operation },
      null,
      (error) => error ? reject(error) : resolve()
    );
  });
}

function closeBackend(backend: ReturnType<typeof createCollaborationBackend>): Promise<void> {
  return new Promise((resolve) => backend.close(() => resolve()));
}

function cookie(token: string): string {
  return `collab_session=${token}`;
}

test("PDF delivery reserves, captures and consumes downloads", async () => {
  const storage = new MemoryPdfStorage();
  const app = buildApp({ pdfBucket: "test-private-pdfs", pdfStorage: storage });
  const writer = createCollaborationBackend();
  const suffix = randomUUID();
  const owner = await findOrCreateEditor("PDF owner", `pdf-delivery-${suffix}@example.test`);
  const outsider = await findOrCreateEditor("PDF outsider", `pdf-outsider-${suffix}@example.test`);
  const ownerSession = await createSession(owner.id);
  const outsiderSession = await createSession(outsider.id);
  const document = await createDocument(owner.id, "PDF delivery", "");

  try {
    await submit(writer, owner.id, document.id, "first", 0, ["Initial 🤖 text"]);
    const denied = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/download-link`,
      headers: { cookie: cookie(outsiderSession.token) },
      payload: { maxDownloads: 1 }
    });
    assert.equal(denied.statusCode, 403);

    const linkResponse = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/download-link`,
      headers: { cookie: cookie(ownerSession.token) },
      payload: { maxDownloads: 1 }
    });
    assert.equal(linkResponse.statusCode, 201);
    const publicToken = (linkResponse.json().link as { publicToken: string }).publicToken;
    assert.ok(publicToken.length >= 40);

    const duplicateLink = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/download-link`,
      headers: { cookie: cookie(ownerSession.token) },
      payload: { maxDownloads: 1 }
    });
    assert.equal(duplicateLink.statusCode, 409);

    const invalidIdempotencyKey = await app.inject({
      method: "POST",
      url: `/downloads/${publicToken}`,
      payload: { idempotencyKey: "x".repeat(256) }
    });
    assert.equal(invalidIdempotencyKey.statusCode, 400);

    const reservation = await reserveDownload(publicToken, "first-download");
    assert.equal(reservation.revision, 1);
    await submit(writer, owner.id, document.id, "second", 1, [14, " changed"]);

    const delivery = await app.inject({
      method: "POST",
      url: `/downloads/${publicToken}`,
      payload: { idempotencyKey: "first-download" }
    });
    assert.equal(delivery.statusCode, 200);
    assert.equal(delivery.headers["content-type"], "application/pdf");
    assert.equal(delivery.body.slice(0, 5), "%PDF-");

    const delivered = await pool.query<{
      reserved_revision: number;
      status: string;
      active_reservations: number;
      consumed_downloads: number;
    }>(
      `SELECT download_reservations.reserved_revision, download_reservations.status,
              download_links.active_reservations, download_links.consumed_downloads
       FROM download_reservations
       INNER JOIN download_links ON download_links.id = download_reservations.link_id
       WHERE download_links.public_token = $1`,
      [publicToken]
    );
    assert.deepEqual(delivered.rows[0], {
      reserved_revision: 1,
      status: "delivered",
      active_reservations: 0,
      consumed_downloads: 1
    });
    assert.ok(storage.objects.has(`documents/${document.id}/revisions/1.pdf`));
    assert.equal(storage.objects.has(`documents/${document.id}/revisions/2.pdf`), false);

    const replay = await app.inject({
      method: "POST",
      url: `/downloads/${publicToken}`,
      payload: { idempotencyKey: "first-download" }
    });
    assert.equal(replay.statusCode, 409);

    const exhausted = await app.inject({
      method: "POST",
      url: `/downloads/${publicToken}`,
      payload: { idempotencyKey: "second-download" }
    });
    assert.equal(exhausted.statusCode, 410);
    assert.deepEqual(exhausted.json(), { status: "exhausted" });
  } finally {
    await app.close();
    await closeBackend(writer);
  }
});

test("PDF delivery releases the reservation when private S3 reads fail", async () => {
  const storage = new MemoryPdfStorage();
  const app = buildApp({ pdfBucket: "test-private-pdfs", pdfStorage: storage });
  const suffix = randomUUID();
  const owner = await findOrCreateEditor("PDF owner", `pdf-read-failure-${suffix}@example.test`);
  const ownerSession = await createSession(owner.id);
  const document = await createDocument(owner.id, "PDF failure", "");

  try {
    const linkResponse = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/download-link`,
      headers: { cookie: cookie(ownerSession.token) },
      payload: { maxDownloads: 1 }
    });
    const publicToken = (linkResponse.json().link as { publicToken: string }).publicToken;
    storage.failGet = true;
    const failure = await app.inject({
      method: "POST",
      url: `/downloads/${publicToken}`,
      payload: { idempotencyKey: "s3-read-failure" }
    });
    assert.equal(failure.statusCode, 503);
    assert.deepEqual(failure.json(), { status: "failed", revision: 0 });

    const reservation = await pool.query<{ status: string; active_reservations: number; consumed_downloads: number }>(
      `SELECT download_reservations.status, download_links.active_reservations, download_links.consumed_downloads
       FROM download_reservations
       INNER JOIN download_links ON download_links.id = download_reservations.link_id
       WHERE download_links.public_token = $1`,
      [publicToken]
    );
    assert.deepEqual(reservation.rows[0], {
      status: "failed",
      active_reservations: 0,
      consumed_downloads: 0
    });
  } finally {
    await app.close();
    await pool.end();
  }
});
