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

test("PDF delivery permits exactly three isolated downloads and leaves no active reservation", async () => {
  const storage = new MemoryPdfStorage();
  const app = buildApp({ pdfBucket: "test-private-pdfs", pdfStorage: storage });
  const suffix = randomUUID();
  const owner = await findOrCreateEditor("PDF quota owner", `pdf-quota-${suffix}@example.test`);
  const ownerSession = await createSession(owner.id);
  const document = await createDocument(owner.id, "PDF quota", "");

  try {
    const linkResponse = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/download-link`,
      headers: { cookie: cookie(ownerSession.token) },
      payload: { maxDownloads: 3 }
    });
    assert.equal(linkResponse.statusCode, 201);
    const publicToken = (linkResponse.json().link as { publicToken: string }).publicToken;

    for (const idempotencyKey of ["quota-one", "quota-two", "quota-three"]) {
      const delivery = await app.inject({
        method: "POST",
        url: `/downloads/${publicToken}`,
        payload: { idempotencyKey }
      });
      assert.equal(delivery.statusCode, 200);
      assert.equal(delivery.headers["content-type"], "application/pdf");
      assert.equal(delivery.body.slice(0, 5), "%PDF-");
    }

    const refused = await app.inject({
      method: "POST",
      url: `/downloads/${publicToken}`,
      payload: { idempotencyKey: "quota-four" }
    });
    assert.equal(refused.statusCode, 410);
    assert.deepEqual(refused.json(), { status: "exhausted" });

    const counters = await pool.query<{ consumed_downloads: number; active_reservations: number }>(
      `SELECT consumed_downloads, active_reservations
       FROM download_links WHERE public_token = $1`,
      [publicToken]
    );
    assert.deepEqual(counters.rows[0], { consumed_downloads: 3, active_reservations: 0 });
  } finally {
    await app.close();
  }
});

test("a publication link delivers the latest durable revision without changing its quota", async () => {
  const storage = new MemoryPdfStorage();
  const app = buildApp({ pdfBucket: "test-private-pdfs", pdfStorage: storage });
  const writer = createCollaborationBackend();
  const suffix = randomUUID();
  const owner = await findOrCreateEditor("PDF revision owner", `pdf-revision-${suffix}@example.test`);
  const ownerSession = await createSession(owner.id);
  const document = await createDocument(owner.id, "PDF current revision", "");

  try {
    await submit(writer, owner.id, document.id, "first", 0, ["Version N"]);
    const publicationResponse = await app.inject({
      method: "POST",
      url: `/documents/${document.id}/publication`,
      headers: { cookie: cookie(ownerSession.token) },
      payload: { maxDownloads: 3 }
    });
    assert.equal(publicationResponse.statusCode, 201);
    const publicToken = (publicationResponse.json().publication as { publicToken: string }).publicToken;

    const firstDelivery = await app.inject({
      method: "POST",
      url: `/downloads/${publicToken}`,
      payload: { idempotencyKey: "revision-n" }
    });
    assert.equal(firstDelivery.statusCode, 200);
    assert.equal(firstDelivery.body.slice(0, 5), "%PDF-");
    assert.ok(storage.objects.has(`documents/${document.id}/revisions/1.pdf`));

    await submit(writer, owner.id, document.id, "second", 1, [9, " plus récente"]);
    const state = await pool.query<{ revision: number; content: string }>(
      "SELECT revision, content FROM document_states WHERE document_id = $1",
      [document.id]
    );
    assert.deepEqual(state.rows[0], { revision: 2, content: "Version N plus récente" });

    const secondDelivery = await app.inject({
      method: "POST",
      url: `/downloads/${publicToken}`,
      payload: { idempotencyKey: "revision-n-plus-one" }
    });
    assert.equal(secondDelivery.statusCode, 200);
    assert.equal(secondDelivery.body.slice(0, 5), "%PDF-");
    assert.ok(storage.objects.has(`documents/${document.id}/revisions/2.pdf`));
    assert.notDeepEqual(secondDelivery.rawPayload, firstDelivery.rawPayload);

    const currentLength = Array.from("Version N plus récente").length;
    await Promise.all([
      submit(writer, owner.id, document.id, "concurrent-a", 2, [currentLength, " A"]),
      submit(writer, owner.id, document.id, "concurrent-b", 2, [currentLength, " B"])
    ]);
    const concurrentState = await pool.query<{ revision: number; content: string }>(
      "SELECT revision, content FROM document_states WHERE document_id = $1",
      [document.id]
    );
    assert.equal(concurrentState.rows[0].revision, 4);
    assert.match(concurrentState.rows[0].content, / A/);
    assert.match(concurrentState.rows[0].content, / B/);

    const thirdDelivery = await app.inject({
      method: "POST",
      url: `/downloads/${publicToken}`,
      payload: { idempotencyKey: "revision-n-plus-two" }
    });
    assert.equal(thirdDelivery.statusCode, 200);
    assert.ok(storage.objects.has(`documents/${document.id}/revisions/4.pdf`));

    const fourthDelivery = await app.inject({
      method: "POST",
      url: `/downloads/${publicToken}`,
      payload: { idempotencyKey: "revision-n-plus-three" }
    });
    assert.equal(fourthDelivery.statusCode, 410);
    assert.deepEqual(fourthDelivery.json(), { status: "exhausted" });

    const counters = await pool.query<{ consumed_downloads: number; active_reservations: number; published_revision: number }>(
      `SELECT consumed_downloads, active_reservations, published_revision
       FROM download_links WHERE public_token = $1`,
      [publicToken]
    );
    assert.deepEqual(counters.rows[0], {
      consumed_downloads: 3,
      active_reservations: 0,
      published_revision: 1
    });
  } finally {
    await app.close();
    await closeBackend(writer);
  }
});

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
