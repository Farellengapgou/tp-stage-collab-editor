import { randomUUID } from "node:crypto";
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
