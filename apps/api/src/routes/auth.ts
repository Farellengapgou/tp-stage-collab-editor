import type { FastifyReply, FastifyRequest } from "fastify";
import { getEditorFromSession } from "../services/editors.js";
import { HttpError } from "../services/errors.js";
import type { PublicEditor } from "../types/api.js";

const sessionCookieName = "collab_session";
const sessionMaxAgeSeconds = 30 * 24 * 60 * 60;

export function readCookie(
  request: FastifyRequest,
  name: string
): string | null {
  const header = request.headers.cookie;
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      return value.join("=") || null;
    }
  }

  return null;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}${secure}`
  );
}

export async function requireEditor(
  request: FastifyRequest
): Promise<PublicEditor> {
  const token = readCookie(request, sessionCookieName);
  if (!token) {
    throw new HttpError(401, "Session required.");
  }

  const editor = await getEditorFromSession(token);
  if (!editor) {
    throw new HttpError(401, "Invalid or expired session.");
  }

  return editor;
}
