import Fastify, { LogController } from "fastify";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerEditorRoutes } from "./routes/editors.js";
import { registerDownloadRoutes } from "./routes/downloads.js";
import { HttpError } from "./services/errors.js";
import { installCollaboration } from "./services/collaboration.js";
import type { PdfStorageClient } from "./services/pdf.js";

declare module "fastify" {
  interface FastifyInstance {
    collaborationBackend: import("sharedb") | null;
  }
}

export function buildApp(options: { pdfBucket?: string; pdfStorage?: PdfStorageClient } = {}) {
  const app = Fastify({
    logger: true,
    logController: new LogController({ disableRequestLogging: true })
  });
  app.decorate("collaborationBackend", null);

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerEditorRoutes(app);
  registerDocumentRoutes(app);
  registerDownloadRoutes(app, { bucket: options.pdfBucket, storage: options.pdfStorage });
  installCollaboration(app);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({ error: error.message });
      return;
    }

    const databaseCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;

    if (databaseCode === "23505" || databaseCode === "23503") {
      reply.code(409).send({ error: "Conflict." });
      return;
    }

    if (databaseCode === "23514" || databaseCode === "22P02") {
      reply.code(400).send({ error: "Invalid request." });
      return;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      reply.code(error.statusCode).send({ error: "Bad request." });
      return;
    }

    app.log.error({ err: error }, "Unhandled request error");
    reply.code(500).send({ error: "Internal server error." });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "Not found." });
  });

  return app;
}
