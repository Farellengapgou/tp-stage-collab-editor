import { Readable } from "node:stream";
import PDFDocument from "pdfkit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  confirmDownloadReservation,
  capturePublicationRevision,
  createPublication,
  createDownloadLink,
  failDownloadReservation,
  getPublication,
  listPublications,
  reserveDownload
  ,updatePublicationQuota,
  withdrawPublication
} from "../services/downloads.js";
import {
  getPreparedDocumentPdf,
  prepareDocumentPdf,
  type PdfStorageClient
} from "../services/pdf.js";
import { HttpError } from "../services/errors.js";
import { requireEditor } from "./auth.js";
import { bodyRecord, requireUuid } from "./validation.js";
import { createDocument } from "../services/documents.js";

interface DownloadRouteOptions {
  bucket?: string;
  storage?: PdfStorageClient;
}

async function readPdf(stream: Readable): Promise<Buffer> {
  const read = (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  })();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("PDF storage timed out.")), 15_000));
  const buffer = await Promise.race([read, timeout]);
  if (buffer.length < 5 || !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Invalid PDF object.");
  return buffer;
}

function isQuotaError(error: unknown): boolean {
  return error instanceof HttpError && error.message === "Download quota exhausted.";
}

function isTemporarilyUnavailableError(error: unknown): boolean {
  return error instanceof HttpError && error.message === "Download availability is temporarily reserved.";
}

export function registerDownloadRoutes(app: FastifyInstance, options: DownloadRouteOptions = {}): void {
  if (process.env.NODE_ENV !== "production") {
    const diagnosticPdf = (text: string): Promise<Buffer> => new Promise((resolve, reject) => {
      const pdf = new PDFDocument(); const chunks: Buffer[] = [];
      pdf.on("data", (chunk: Buffer) => chunks.push(chunk)); pdf.on("end", () => resolve(Buffer.concat(chunks))); pdf.on("error", reject);
      pdf.text(text); pdf.end();
    });
    const sendDiagnosticPdf = async (reply: import("fastify").FastifyReply, text: string) => {
      const pdf = await diagnosticPdf(text);
      reply.header("Content-Type", "application/pdf").header("Content-Disposition", "attachment; filename=diagnostic.pdf").send(pdf);
    };
    app.get("/diagnostic/pdf/static", async (_request, reply) => sendDiagnosticPdf(reply, "PDF statique Collab Editor"));
    app.get("/diagnostic/pdf/generated", async (_request, reply) => sendDiagnosticPdf(reply, "Bonjour Collab Editor"));
    app.post("/diagnostic/pdf/published", async (request, reply) => {
      const owner = await requireEditor(request);
      const document = await createDocument(owner.id, "Diagnostic PDF", "Bonjour Collab Editor");
      const prepared = await prepareDocumentPdf(document.id, 0, options);
      if (prepared.status !== "ready") throw new HttpError(503, "Diagnostic PDF preparation failed.");
      const publication = await createPublication(owner.id, document.id, 0, 5);
      reply.code(201); return { publication };
    });
  }
  app.get("/journal", async () => ({ publications: await listPublications() }));

  app.get("/journal/:token", async (request) => {
    const params = request.params as { token?: unknown };
    if (typeof params.token !== "string" || !params.token) throw new HttpError(400, "Publication token is invalid.");
    return { publication: await getPublication(params.token) };
  });

  app.post("/documents/:id/publication", async (request, reply) => {
    const owner = await requireEditor(request);
    const params = request.params as { id?: unknown };
    const documentId = requireUuid(params.id, "document id");
    const body = bodyRecord(request.body, ["maxDownloads"]);
    const maxDownloads = body.maxDownloads;
    if (typeof maxDownloads !== "number" || !Number.isInteger(maxDownloads) || maxDownloads <= 0 || maxDownloads > 2_147_483_647) {
      throw new HttpError(400, "maxDownloads is invalid.");
    }
    const revision = await capturePublicationRevision(owner.id, documentId);
    let prepared;
    try {
      prepared = await prepareDocumentPdf(documentId, revision, options);
    } catch (error) {
      request.log.error({ err: error, documentId, revision }, "PDF publication preparation failed");
      throw new HttpError(503, "PDF storage is unavailable. Please try again later.");
    }
    if (prepared.status !== "ready") {
      reply.code(prepared.status === "preparing" ? 202 : 503);
      return { status: prepared.status, revision };
    }
    const publication = await createPublication(owner.id, documentId, revision, maxDownloads);
    reply.code(201);
    return { publication };
  });

  app.patch("/documents/:id/publication", async (request) => {
    const owner = await requireEditor(request);
    const params = request.params as { id?: unknown };
    const documentId = requireUuid(params.id, "document id");
    const body = bodyRecord(request.body, ["maxDownloads"]);
    if (typeof body.maxDownloads !== "number") throw new HttpError(400, "maxDownloads is invalid.");
    return { publication: await updatePublicationQuota(owner.id, documentId, body.maxDownloads) };
  });

  app.delete("/documents/:id/publication", async (request, reply) => {
    const owner = await requireEditor(request);
    const params = request.params as { id?: unknown };
    await withdrawPublication(owner.id, requireUuid(params.id, "document id"));
    reply.code(204);
  });

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
    request.log.info("PDF download: request received");
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
      request.log.info("PDF download: reserving quota");
      reservation = await reserveDownload(params.token, body.idempotencyKey);
      request.log.info({ revision: reservation.revision, status: reservation.status }, "PDF download: quota reserved");
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
      request.log.info({ revision: reservation.revision }, "PDF download: preparing artifact");
      prepared = await prepareDocumentPdf(reservation.documentId, reservation.revision, options);
      request.log.info({ status: prepared.status }, "PDF download: artifact preparation completed");
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
    let pdf: Buffer;
    try {
      request.log.info("PDF download: requesting S3 object");
      stream = await getPreparedDocumentPdf(prepared.objectKey, options);
      request.log.info("PDF download: reading S3 object");
      pdf = await readPdf(stream);
      request.log.info({ bytes: pdf.length }, "PDF download: PDF validated");
    } catch {
      await failDownloadReservation(reservation.id);
      reply.code(503);
      return { status: "failed", revision: reservation.revision };
    }
    request.log.info({
      requestDestroyed: request.raw.destroyed,
      requestComplete: request.raw.complete,
      responseDestroyed: reply.raw.destroyed,
      responseWritableEnded: reply.raw.writableEnded,
      responseHeadersSent: reply.raw.headersSent
    }, "PDF download: response state after validation");
    reply.raw.once("close", () => request.log.info("PDF download: response close"));
    reply.raw.once("finish", () => request.log.info("PDF download: response finish"));

    request.log.info("PDF download: confirming quota");
    const confirmed = await confirmDownloadReservation(reservation.id);
    request.log.info({ status: confirmed.status }, "PDF download: quota confirmation completed");
    if (confirmed.status !== "delivered") {
      reply.code(410);
      return { status: "failed", revision: reservation.revision };
    }

    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `attachment; filename="document-revision-${reservation.revision}.pdf"`);
    reply.header("Content-Length", pdf.length);
    reply.header("X-Pdf-Status", "ready");
    request.log.info("PDF download: sending response");
    return reply.send(pdf);
  });
}
