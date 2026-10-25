import type { FastifyInstance } from "fastify";
import {
  addDocumentEditor,
  createDocument,
  getDocument,
  listDocuments
} from "../services/documents.js";
import { requireEditor } from "./auth.js";
import { bodyRecord, optionalText, requiredText, requireUuid } from "./validation.js";

export function registerDocumentRoutes(app: FastifyInstance): void {
  app.post("/documents", async (request, reply) => {
    const editor = await requireEditor(request);
    const body = bodyRecord(request.body, ["title", "description"]);
    const title = requiredText(body, "title", 255);
    const description = optionalText(body, "description", 10_000);
    const document = await createDocument(editor.id, title, description);

    reply.code(201);
    return { document };
  });

  app.get("/documents", async (request) => {
    const editor = await requireEditor(request);
    const documents = await listDocuments(editor.id);
    return { documents };
  });

  app.get("/documents/:id", async (request) => {
    const editor = await requireEditor(request);
    const params = request.params as { id?: unknown };
    const documentId = requireUuid(params.id, "document id");
    const document = await getDocument(editor.id, documentId);
    return { document };
  });

  app.post("/documents/:id/editors", async (request, reply) => {
    const owner = await requireEditor(request);
    const params = request.params as { id?: unknown };
    const documentId = requireUuid(params.id, "document id");
    const body = bodyRecord(request.body, ["editorId"]);
    const editorId = requireUuid(body.editorId, "editorId");

    await addDocumentEditor(owner.id, documentId, editorId);
    reply.code(201);
    return { documentId, editorId, role: "editor" };
  });
}
