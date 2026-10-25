import Fastify from "fastify";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerEditorRoutes } from "./routes/editors.js";
import { HttpError } from "./services/errors.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerEditorRoutes(app);
  registerDocumentRoutes(app);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({ error: error.message });
      return;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      reply.code(409).send({ error: "Conflict." });
      return;
    }

    app.log.error(error);
    reply.code(500).send({ error: "Internal server error." });
  });

  return app;
}
