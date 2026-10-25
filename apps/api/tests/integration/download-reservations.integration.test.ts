import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { pool } from "../../src/db.js";
import { createDocument } from "../../src/services/documents.js";
import {
  confirmDownloadReservation,
  expireDownloadReservation,
  reserveDownload
} from "../../src/services/downloads.js";
import { findOrCreateEditor } from "../../src/services/editors.js";

function futureExpiration(): Date {
  return new Date(Date.now() + 60_000);
}

async function createLink(maxDownloads: number, isActive = true): Promise<{
  documentId: string;
  publicToken: string;
}> {
  const suffix = randomUUID();
  const editor = await findOrCreateEditor("Download owner", `download-${suffix}@example.test`);
  const document = await createDocument(editor.id, "Download document", "");
  const publicToken = randomUUID();
  await pool.query(
    `INSERT INTO download_links (
       id, document_id, public_token, max_downloads, is_active
     ) VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), document.id, publicToken, maxDownloads, isActive]
  );
  return { documentId: document.id, publicToken };
}

function isHttpError(statusCode: number) {
  return (error: { statusCode?: number }) => error.statusCode === statusCode;
}

test("download reservations are transactional and idempotent", async (t) => {
  await t.test("replays the same reservation after the quota is full", async () => {
    const link = await createLink(1);
    const first = await reserveDownload(link.publicToken, "attempt-one", futureExpiration());
    const replay = await reserveDownload(link.publicToken, "attempt-one", futureExpiration());
    assert.deepEqual(replay, first);
    await assert.rejects(
      reserveDownload(link.publicToken, "attempt-two", futureExpiration()),
      isHttpError(410)
    );

    const rows = await pool.query<{
      active_reservations: number;
      count: number;
      reserved_revision: number;
    }>(
      `SELECT download_links.active_reservations,
              (SELECT COUNT(*)::int FROM download_reservations WHERE link_id = download_links.id) AS count,
              (SELECT reserved_revision FROM download_reservations WHERE link_id = download_links.id) AS reserved_revision
       FROM download_links
       WHERE public_token = $1`,
      [link.publicToken]
    );
    assert.deepEqual(rows.rows[0], { active_reservations: 1, count: 1, reserved_revision: 0 });
    const version = await pool.query<{ snapshot_reference: string }>(
      `SELECT snapshot_reference
       FROM document_versions
       WHERE document_id = $1 AND revision = 0`,
      [link.documentId]
    );
    assert.equal(version.rows[0].snapshot_reference, `edit_operations:${link.documentId}:0`);
  });

  await t.test("refuses an inactive link", async () => {
    const link = await createLink(1, false);
    await assert.rejects(
      reserveDownload(link.publicToken, "inactive-attempt", futureExpiration()),
      isHttpError(410)
    );
    const count = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM download_reservations
       INNER JOIN download_links ON download_links.id = download_reservations.link_id
       WHERE download_links.public_token = $1`,
      [link.publicToken]
    );
    assert.equal(count.rows[0].count, 0);
  });

  await t.test("reclaims an expired reservation before checking the quota", async () => {
    const link = await createLink(1);
    const expiredReservation = await reserveDownload(link.publicToken, "expired-attempt", futureExpiration());
    await pool.query(
      `UPDATE download_reservations
       SET created_at = clock_timestamp() - INTERVAL '2 minutes',
           expires_at = clock_timestamp() - INTERVAL '1 second'
       WHERE id = $1`,
      [expiredReservation.id]
    );

    const replacement = await reserveDownload(link.publicToken, "replacement-attempt", futureExpiration());
    assert.notEqual(replacement.id, expiredReservation.id);
    const rows = await pool.query<{
      active_reservations: number;
      consumed_downloads: number;
      statuses: string[];
    }>(
      `SELECT download_links.active_reservations, download_links.consumed_downloads,
              ARRAY_AGG(download_reservations.status ORDER BY download_reservations.id) AS statuses
       FROM download_links
       INNER JOIN download_reservations ON download_reservations.link_id = download_links.id
       WHERE download_links.public_token = $1
       GROUP BY download_links.id`,
      [link.publicToken]
    );
    assert.equal(rows.rows[0].active_reservations, 1);
    assert.equal(rows.rows[0].consumed_downloads, 0);
    assert.deepEqual(rows.rows[0].statuses.sort(), ["expired", "reserved"]);
  });

  await t.test("confirms a reservation only once", async () => {
    const link = await createLink(1);
    const reservation = await reserveDownload(link.publicToken, "confirm-once", futureExpiration());
    const delivered = await confirmDownloadReservation(reservation.id);
    const replay = await confirmDownloadReservation(reservation.id);
    assert.equal(delivered.status, "delivered");
    assert.deepEqual(replay, delivered);

    const counters = await pool.query<{ active_reservations: number; consumed_downloads: number }>(
      `SELECT active_reservations, consumed_downloads
       FROM download_links
       WHERE public_token = $1`,
      [link.publicToken]
    );
    assert.deepEqual(counters.rows[0], { active_reservations: 0, consumed_downloads: 1 });
  });

  await t.test("expires a reservation only once without consumption", async () => {
    const link = await createLink(1);
    const reservation = await reserveDownload(link.publicToken, "expire-once", futureExpiration());
    await pool.query(
      `UPDATE download_reservations
       SET created_at = clock_timestamp() - INTERVAL '2 minutes',
           expires_at = clock_timestamp() - INTERVAL '1 second'
       WHERE id = $1`,
      [reservation.id]
    );
    const expired = await expireDownloadReservation(reservation.id);
    const replay = await expireDownloadReservation(reservation.id);
    assert.equal(expired.status, "expired");
    assert.deepEqual(replay, expired);

    const counters = await pool.query<{ active_reservations: number; consumed_downloads: number }>(
      `SELECT active_reservations, consumed_downloads
       FROM download_links
       WHERE public_token = $1`,
      [link.publicToken]
    );
    assert.deepEqual(counters.rows[0], { active_reservations: 0, consumed_downloads: 0 });
  });

  await t.test("resolves concurrent confirmation and expiration once", async () => {
    const link = await createLink(1);
    const reservation = await reserveDownload(link.publicToken, "transition-race", futureExpiration());
    await pool.query(
      `UPDATE download_reservations
       SET created_at = clock_timestamp() - INTERVAL '2 minutes',
           expires_at = clock_timestamp() - INTERVAL '1 second'
       WHERE id = $1`,
      [reservation.id]
    );
    const transitions = await Promise.all([
      confirmDownloadReservation(reservation.id),
      expireDownloadReservation(reservation.id)
    ]);
    assert.deepEqual(transitions.map((transition) => transition.status), ["expired", "expired"]);

    const counters = await pool.query<{
      active_reservations: number;
      consumed_downloads: number;
      status: string;
    }>(
      `SELECT download_links.active_reservations, download_links.consumed_downloads,
              download_reservations.status
       FROM download_links
       INNER JOIN download_reservations ON download_reservations.link_id = download_links.id
       WHERE download_reservations.id = $1`,
      [reservation.id]
    );
    assert.deepEqual(counters.rows[0], {
      active_reservations: 0,
      consumed_downloads: 0,
      status: "expired"
    });
  });

  await t.test("allows only one of fifty concurrent reservations for one place", async () => {
    const link = await createLink(1);
    const attempts = await Promise.allSettled(
      Array.from({ length: 50 }, (_, index) =>
        reserveDownload(link.publicToken, `concurrent-${index}`, futureExpiration())
      )
    );
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 49);

    const rows = await pool.query<{ active_reservations: number; consumed_downloads: number; count: number }>(
      `SELECT active_reservations, consumed_downloads,
              (SELECT COUNT(*)::int FROM download_reservations WHERE link_id = download_links.id) AS count
       FROM download_links
       WHERE public_token = $1`,
      [link.publicToken]
    );
    assert.deepEqual(rows.rows[0], { active_reservations: 1, consumed_downloads: 0, count: 1 });
  });

  await pool.end();
});
