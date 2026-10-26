import type { FastifyInstance } from "fastify";
import {
  createSession,
  findEditorByEmail,
  findOrCreateEditor,
  isValidEmail,
  normalizeEmail
} from "../services/editors.js";
import { HttpError } from "../services/errors.js";
import { requireEditor, setSessionCookie } from "./auth.js";
import { bodyRecord, requiredText } from "./validation.js";

export function registerEditorRoutes(app: FastifyInstance): void {
  app.post("/editors", async (request, reply) => {
    const body = bodyRecord(request.body, ["displayName", "email"]);
    const displayName = requiredText(body, "displayName", 255);
    const email = normalizeEmail(requiredText(body, "email", 320));

    if (!isValidEmail(email)) {
      throw new HttpError(400, "email is invalid.");
    }

    const editor = await findOrCreateEditor(displayName, email);
    const session = await createSession(editor.id);
    setSessionCookie(reply, session.token);

    reply.code(201);
    return { editor };
  });

  app.get("/editors/me", async (request) => {
    const editor = await requireEditor(request);
    return { editor };
  });

  app.get("/editors/lookup", async (request) => {
    await requireEditor(request);
    const query = request.query as { email?: unknown };
    const email = normalizeEmail(typeof query.email === "string" ? query.email : "");
    if (!isValidEmail(email)) {
      throw new HttpError(400, "email is invalid.");
    }
    const editor = await findEditorByEmail(email);
    if (!editor) {
      throw new HttpError(404, "Editor not found.");
    }
    return { editor };
  });
}
