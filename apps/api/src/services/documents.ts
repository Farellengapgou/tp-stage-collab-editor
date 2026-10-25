import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { HttpError } from "./errors.js";
import type { DocumentRole, DocumentSummary } from "../types/api.js";

interface DocumentRow {
  id: string;
  title: string;
  description: string;
  published_at: Date | null;
  current_revision: number;
  created_at: Date;
  updated_at: Date;
  role: DocumentRole;
}

function toDocumentSummary(document: DocumentRow): DocumentSummary {
  return {
    id: document.id,
    title: document.title,
    description: document.description,
    publishedAt: document.published_at?.toISOString() ?? null,
    currentRevision: document.current_revision,
    createdAt: document.created_at.toISOString(),
    updatedAt: document.updated_at.toISOString(),
    role: document.role
  };
}

const documentFields = `documents.id, documents.title, documents.description,
  documents.published_at, documents.current_revision, documents.created_at,
  documents.updated_at, document_editors.role`;

export async function createDocument(
  editorId: string,
  title: string,
  description: string
): Promise<DocumentSummary> {
  const client = await pool.connect();
  const documentId = randomUUID();

  try {
    await client.query("BEGIN");
    const documentResult = await client.query<DocumentRow>(
      `INSERT INTO documents (id, title, description)
       VALUES ($1, $2, $3)
       RETURNING id, title, description, published_at, current_revision,
                 created_at, updated_at, 'owner'::varchar AS role`,
      [documentId, title, description]
    );
    await client.query(
      `INSERT INTO document_editors (document_id, editor_id, role)
       VALUES ($1, $2, 'owner')`,
      [documentId, editorId]
    );
    await client.query(
      `INSERT INTO document_states (document_id, content, revision)
       VALUES ($1, '', 0)`,
      [documentId]
    );
    await client.query("COMMIT");

    return toDocumentSummary(documentResult.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listDocuments(editorId: string): Promise<DocumentSummary[]> {
  const result = await pool.query<DocumentRow>(
    `SELECT ${documentFields}
     FROM documents
     INNER JOIN document_editors
       ON document_editors.document_id = documents.id
     WHERE document_editors.editor_id = $1
     ORDER BY documents.updated_at DESC, documents.id`,
    [editorId]
  );

  return result.rows.map(toDocumentSummary);
}

export async function getDocument(
  editorId: string,
  documentId: string
): Promise<DocumentSummary> {
  const exists = await pool.query(
    "SELECT 1 FROM documents WHERE id = $1",
    [documentId]
  );

  if (exists.rowCount === 0) {
    throw new HttpError(404, "Document not found.");
  }

  const result = await pool.query<DocumentRow>(
    `SELECT ${documentFields}
     FROM documents
     INNER JOIN document_editors
       ON document_editors.document_id = documents.id
     WHERE documents.id = $1 AND document_editors.editor_id = $2`,
    [documentId, editorId]
  );

  const document = result.rows[0];
  if (!document) {
    throw new HttpError(403, "Document access denied.");
  }

  return toDocumentSummary(document);
}

export async function addDocumentEditor(
  ownerId: string,
  documentId: string,
  editorId: string
): Promise<void> {
  const document = await pool.query(
    "SELECT 1 FROM documents WHERE id = $1",
    [documentId]
  );

  if (document.rowCount === 0) {
    throw new HttpError(404, "Document not found.");
  }

  const owner = await pool.query(
    `SELECT 1 FROM document_editors
     WHERE document_id = $1 AND editor_id = $2 AND role = 'owner'`,
    [documentId, ownerId]
  );

  if (owner.rowCount === 0) {
    throw new HttpError(403, "Only the document owner can add editors.");
  }

  const editor = await pool.query(
    "SELECT 1 FROM editors WHERE id = $1",
    [editorId]
  );

  if (editor.rowCount === 0) {
    throw new HttpError(404, "Editor not found.");
  }

  const result = await pool.query(
    `INSERT INTO document_editors (document_id, editor_id, role)
     VALUES ($1, $2, 'editor')
     ON CONFLICT (document_id, editor_id) DO NOTHING
     RETURNING document_id`,
    [documentId, editorId]
  );

  if (result.rowCount === 0) {
    throw new HttpError(409, "Editor already has access to this document.");
  }
}
