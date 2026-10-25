import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { ensureDocumentVersionInTransaction } from "./documents.js";
import { HttpError } from "./errors.js";

interface DownloadLinkRow {
  id: string;
  document_id: string;
  max_downloads: number;
  consumed_downloads: number;
  active_reservations: number;
  is_active: boolean;
}

interface ReservationRow {
  id: string;
  reserved_revision: number;
  status: "reserved" | "delivered" | "expired" | "failed";
  expires_at: Date;
}

interface LockedReservation {
  link: DownloadLinkRow;
  reservation: ReservationRow;
}

export interface DownloadReservation {
  id: string;
  revision: number;
  status: ReservationRow["status"];
  expiresAt: string;
}

function toReservation(reservation: ReservationRow): DownloadReservation {
  return {
    id: reservation.id,
    revision: reservation.reserved_revision,
    status: reservation.status,
    expiresAt: reservation.expires_at.toISOString()
  };
}

export async function reserveDownload(
  publicToken: string,
  idempotencyKey: string,
  expiresAt: Date
): Promise<DownloadReservation> {
  const expirationTime = expiresAt.getTime();
  if (
    !publicToken.trim() ||
    !idempotencyKey.trim() ||
    !Number.isFinite(expirationTime) ||
    expirationTime <= Date.now()
  ) {
    throw new HttpError(400, "Invalid download reservation.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const linkResult = await client.query<DownloadLinkRow>(
      `SELECT id, document_id, max_downloads, consumed_downloads,
              active_reservations, is_active
       FROM download_links
       WHERE public_token = $1
       FOR UPDATE`,
      [publicToken]
    );
    const link = linkResult.rows[0];
    if (!link) {
      throw new HttpError(404, "Download link not found.");
    }
    if (!link.is_active) {
      throw new HttpError(410, "Download link is inactive.");
    }

    const existingResult = await client.query<ReservationRow>(
      `SELECT id, reserved_revision, status, expires_at
       FROM download_reservations
       WHERE link_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [link.id, idempotencyKey]
    );
    const existing = existingResult.rows[0];
    if (existing) {
      await client.query("COMMIT");
      return toReservation(existing);
    }

    if (link.consumed_downloads + link.active_reservations >= link.max_downloads) {
      throw new HttpError(410, "Download quota exhausted.");
    }

    const stateResult = await client.query<{ revision: number }>(
      `SELECT revision
       FROM document_states
       WHERE document_id = $1
       FOR SHARE`,
      [link.document_id]
    );
    const state = stateResult.rows[0];
    if (!state) {
      throw new HttpError(404, "Document not found.");
    }
    await ensureDocumentVersionInTransaction(client, link.document_id, state.revision);

    const reservationId = randomUUID();
    await client.query(
      `INSERT INTO download_reservations (
         id, link_id, idempotency_key, reserved_revision, status, expires_at
       ) VALUES ($1, $2, $3, $4, 'reserved', $5)`,
      [reservationId, link.id, idempotencyKey, state.revision, expiresAt]
    );
    const updatedLink = await client.query(
      `UPDATE download_links
       SET active_reservations = active_reservations + 1
       WHERE id = $1
         AND consumed_downloads + active_reservations < max_downloads
       RETURNING id`,
      [link.id]
    );
    if (updatedLink.rowCount !== 1) {
      throw new HttpError(410, "Download quota exhausted.");
    }

    await client.query("COMMIT");
    return {
      id: reservationId,
      revision: state.revision,
      status: "reserved",
      expiresAt: expiresAt.toISOString()
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockReservation(
  client: PoolClient,
  reservationId: string
): Promise<LockedReservation> {
  const linkIdResult = await client.query<{ link_id: string }>(
    "SELECT link_id FROM download_reservations WHERE id = $1",
    [reservationId]
  );
  const linkId = linkIdResult.rows[0]?.link_id;
  if (!linkId) {
    throw new HttpError(404, "Download reservation not found.");
  }

  const linkResult = await client.query<DownloadLinkRow>(
    `SELECT id, document_id, max_downloads, consumed_downloads,
            active_reservations, is_active
     FROM download_links
     WHERE id = $1
     FOR UPDATE`,
    [linkId]
  );
  const link = linkResult.rows[0];
  if (!link) {
    throw new HttpError(404, "Download link not found.");
  }

  const reservationResult = await client.query<ReservationRow>(
    `SELECT id, reserved_revision, status, expires_at
     FROM download_reservations
     WHERE id = $1 AND link_id = $2
     FOR UPDATE`,
    [reservationId, link.id]
  );
  const reservation = reservationResult.rows[0];
  if (!reservation) {
    throw new HttpError(404, "Download reservation not found.");
  }

  return { link, reservation };
}

async function releaseExpiredReservation(
  client: PoolClient,
  link: DownloadLinkRow,
  reservation: ReservationRow
): Promise<DownloadReservation> {
  await client.query(
    `UPDATE download_reservations
     SET status = 'expired'
     WHERE id = $1 AND status = 'reserved'`,
    [reservation.id]
  );
  const updatedLink = await client.query(
    `UPDATE download_links
     SET active_reservations = active_reservations - 1
     WHERE id = $1 AND active_reservations > 0
     RETURNING id`,
    [link.id]
  );
  if (updatedLink.rowCount !== 1) {
    throw new Error("Invalid download reservation counters.");
  }

  return { ...toReservation(reservation), status: "expired" };
}

async function currentTimestamp(
  client: PoolClient
): Promise<Date> {
  const result = await client.query<{ current_time: Date }>(
    "SELECT clock_timestamp() AS current_time"
  );
  return result.rows[0].current_time;
}

export async function confirmDownloadReservation(
  reservationId: string
): Promise<DownloadReservation> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { link, reservation } = await lockReservation(client, reservationId);
    if (reservation.status !== "reserved") {
      await client.query("COMMIT");
      return toReservation(reservation);
    }

    const now = await currentTimestamp(client);
    if (reservation.expires_at <= now) {
      const expired = await releaseExpiredReservation(client, link, reservation);
      await client.query("COMMIT");
      return expired;
    }

    await client.query(
      `UPDATE download_reservations
       SET status = 'delivered', delivered_at = $2
       WHERE id = $1 AND status = 'reserved'`,
      [reservation.id, now]
    );
    const updatedLink = await client.query(
      `UPDATE download_links
       SET active_reservations = active_reservations - 1,
           consumed_downloads = consumed_downloads + 1
       WHERE id = $1 AND active_reservations > 0
       RETURNING id`,
      [link.id]
    );
    if (updatedLink.rowCount !== 1) {
      throw new Error("Invalid download reservation counters.");
    }

    await client.query("COMMIT");
    return { ...toReservation(reservation), status: "delivered" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function expireDownloadReservation(
  reservationId: string
): Promise<DownloadReservation> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { link, reservation } = await lockReservation(client, reservationId);
    if (reservation.status !== "reserved") {
      await client.query("COMMIT");
      return toReservation(reservation);
    }

    const now = await currentTimestamp(client);
    if (reservation.expires_at > now) {
      await client.query("COMMIT");
      return toReservation(reservation);
    }

    const expired = await releaseExpiredReservation(client, link, reservation);
    await client.query("COMMIT");
    return expired;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
