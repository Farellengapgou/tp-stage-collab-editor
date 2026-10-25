import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  confirmDownloadReservation,
  createDownloadLink,
  failDownloadReservation,
  reserveDownload
} from "../services/downloads.js";
import {
  getPreparedDocumentPdf,
  prepareDocumentPdf,
  type PdfStorageClient
} from "../services/pdf.js";
import { HttpError } from "../services/errors.js";
import { requireEditor } from "./auth.js";
import { bodyRecord, requireUuid } from "./validation.js";

interface DownloadRouteOptions {
  bucket?: string;
  storage?: PdfStorageClient;
}

function firstChunk(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener("readable", onReadable);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
    };
    const onReadable = () => {
      const chunk = stream.read();
      if (chunk !== null) {
        cleanup();
        resolve(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("PDF object is empty."));
    };
    stream.on("readable", onReadable);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

function isQuotaError(error: unknown): boolean {
  return error instanceof HttpError && error.message === "Download quota exhausted.";
}

function isTemporarilyUnavailableError(error: unknown): boolean {
  return error instanceof HttpError && error.message === "Download availability is temporarily reserved.";
}

export function registerDownloadRoutes(app: FastifyInstance, options: DownloadRouteOptions = {}): void {
  app.post("/documents/:id/download-link", async (request, reply) => {
    const owner = await requireEditor(request);
    const params = request.params as { id?: unknown };
    const documentId = requireUuid(params.id, "document id");
    const body = bodyRecord(request.body, ["maxDownloads"]);
    const maxDownloads = body.maxDownloads;
    if (
      typeof maxDownloads !== "number" ||
      !Number.isInteger(maxDownloads) ||
      maxDownloads <= 0 ||
      maxDownloads > 2_147_483_647
    ) {
      throw new HttpError(400, "maxDownloads is invalid.");
    }
    const link = await createDownloadLink(owner.id, documentId, maxDownloads);
    reply.code(201);
    return { link };
  });

  app.post("/downloads/:token", async (request, reply) => {
    const params = request.params as { token?: unknown };
    if (typeof params.token !== "string" || !params.token) {
      throw new HttpError(400, "Download token is invalid.");
    }
    const body = bodyRecord(request.body, ["idempotencyKey"]);
    if (
      typeof body.idempotencyKey !== "string" ||
      !body.idempotencyKey.trim() ||
      body.idempotencyKey.length > 255
    ) {
      throw new HttpError(400, "idempotencyKey is invalid.");
    }

    let reservation;
    try {
      reservation = await reserveDownload(params.token, body.idempotencyKey);
    } catch (error) {
      if (isQuotaError(error)) {
        reply.code(410);
        return { status: "exhausted" };
      }
      if (isTemporarilyUnavailableError(error)) {
        reply.code(409);
        return { status: "temporarily_unavailable" };
      }
      throw error;
    }
    if (reservation.status !== "reserved") {
      reply.code(409);
      return { status: "failed", revision: reservation.revision };
    }

    let prepared;
    try {
      prepared = await prepareDocumentPdf(reservation.documentId, reservation.revision, options);
    } catch {
      await failDownloadReservation(reservation.id);
      reply.code(503);
      return { status: "failed", revision: reservation.revision };
    }
    if (prepared.status === "preparing") {
      reply.code(202);
      return { status: "preparing", revision: reservation.revision };
    }
    if (prepared.status === "failed") {
      await failDownloadReservation(reservation.id);
      reply.code(503);
      return { status: "failed", revision: reservation.revision };
    }

    let stream: Readable;
    let chunk: Buffer;
    try {
      stream = await getPreparedDocumentPdf(prepared.objectKey, options);
      chunk = await firstChunk(stream);
    } catch {
      await failDownloadReservation(reservation.id);
      reply.code(503);
      return { status: "failed", revision: reservation.revision };
    }
    if ((request as FastifyRequest).raw.destroyed) {
      await failDownloadReservation(reservation.id);
      return reply;
    }

    const confirmed = await confirmDownloadReservation(reservation.id);
    if (confirmed.status !== "delivered") {
      reply.code(410);
      return { status: "failed", revision: reservation.revision };
    }

    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("Content-Type", "application/pdf");
    reply.raw.setHeader(
      "Content-Disposition",
      `attachment; filename="document-revision-${reservation.revision}.pdf"`
    );
    reply.raw.setHeader("X-Pdf-Status", "ready");
    reply.raw.write(chunk);
    stream.on("error", () => reply.raw.destroy());
    stream.pipe(reply.raw);
    return reply;
  });
}
