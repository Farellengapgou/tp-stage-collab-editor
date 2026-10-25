import type { FastifyInstance } from "fastify";
import {
  createSession,
  findOrCreateEditor,
  isValidEmail,
  normalizeEmail
} from "../services/editors.js";
import { requireEditor, setSessionCookie } from "./auth.js";
import { bodyRecord, requiredText } from "./validation.js";

export function registerEditorRoutes(app: FastifyInstance): void {
  app.post("/editors", async (request, reply) => {
    const body = bodyRecord(request.body, ["displayName", "email"]);
    const displayName = requiredText(body, "displayName", 255);
    const email = normalizeEmail(requiredText(body, "email", 320));

    if (!isValidEmail(email)) {
      reply.code(400);
      return { error: "email is invalid." };
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
}
