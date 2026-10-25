import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pool } from "../db.js";
import type { PublicEditor } from "../types/api.js";

const sessionDurationMs = 30 * 24 * 60 * 60 * 1000;

interface EditorRow {
  id: string;
  name: string;
  email: string;
  is_admin: boolean;
  created_at: Date;
}

function toPublicEditor(editor: EditorRow): PublicEditor {
  return {
    id: editor.id,
    displayName: editor.name,
    email: editor.email,
    isAdmin: editor.is_admin,
    createdAt: editor.created_at.toISOString()
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function findOrCreateEditor(
  displayName: string,
  email: string
): Promise<PublicEditor> {
  const result = await pool.query<EditorRow>(
    `INSERT INTO editors (id, name, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, name, email, is_admin, created_at`,
    [randomUUID(), displayName, email]
  );

  return toPublicEditor(result.rows[0]);
}

export async function createSession(editorId: string): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDurationMs);

  await pool.query(
    `INSERT INTO editor_sessions (id, editor_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), editorId, hashSessionToken(token), expiresAt]
  );

  return { token, expiresAt };
}

export async function getEditorFromSession(
  token: string
): Promise<PublicEditor | null> {
  const result = await pool.query<EditorRow>(
    `SELECT editors.id, editors.name, editors.email, editors.is_admin,
            editors.created_at
     FROM editor_sessions
     INNER JOIN editors ON editors.id = editor_sessions.editor_id
     WHERE editor_sessions.token_hash = $1
       AND editor_sessions.expires_at > NOW()`,
    [hashSessionToken(token)]
  );

  const editor = result.rows[0];
  return editor ? toPublicEditor(editor) : null;
}
