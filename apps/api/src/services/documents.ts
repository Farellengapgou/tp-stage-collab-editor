import { randomUUID } from "node:crypto";
import ShareDB from "sharedb";
import { type as textUnicode, type TextOp } from "ot-text-unicode";
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

interface OperationRow {
  accepted_revision: number;
  operation: unknown;
}

interface HistoryRow extends OperationRow {
  base_revision: number;
  inserted_code_points: number;
  accepted_at: Date;
  editor_id: string;
  name: string;
}

export interface DocumentHistoryEntry {
  revision: number;
  baseRevision: number | null;
  insertedCodePoints: number;
  acceptedAt: string | null;
  author: {
    id: string;
    displayName: string;
  } | null;
}

export interface DocumentRevision {
  revision: number;
  content: string;
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

async function getCurrentDocumentState(documentId: string): Promise<{ content: string; revision: number }> {
  const result = await pool.query<{ content: string; revision: number }>(
    "SELECT content, revision FROM document_states WHERE document_id = $1",
    [documentId]
  );
  const state = result.rows[0];
  if (!state) {
    throw new HttpError(404, "Document not found.");
  }
  return state;
}

async function getRevisionContent(documentId: string, revision: number): Promise<string> {
  const operations = await pool.query<OperationRow>(
    `SELECT accepted_revision, operation
     FROM edit_operations
     WHERE document_id = $1 AND accepted_revision <= $2
     ORDER BY accepted_revision`,
    [documentId, revision]
  );

  let content = "";
  let expectedRevision = 1;
  for (const operation of operations.rows) {
    if (operation.accepted_revision !== expectedRevision || !Array.isArray(operation.operation)) {
      throw new Error("Invalid document operation history.");
    }
    content = textUnicode.apply(content, operation.operation as TextOp);
    expectedRevision++;
  }

  if (expectedRevision !== revision + 1) {
    throw new HttpError(404, "Document revision not found.");
  }

  return content;
}

export async function getDocumentHistory(
  editorId: string,
  documentId: string
): Promise<DocumentHistoryEntry[]> {
  const document = await getDocument(editorId, documentId);
  const result = await pool.query<HistoryRow>(
    `SELECT edit_operations.accepted_revision, edit_operations.base_revision,
            edit_operations.inserted_code_points, edit_operations.accepted_at,
            editors.id AS editor_id, editors.name
     FROM edit_operations
     INNER JOIN editors ON editors.id = edit_operations.editor_id
     WHERE edit_operations.document_id = $1
     ORDER BY edit_operations.accepted_revision`,
    [documentId]
  );

  return [
    {
      revision: 0,
      baseRevision: null,
      insertedCodePoints: 0,
      acceptedAt: document.createdAt,
      author: null
    },
    ...result.rows.map((operation) => ({
      revision: operation.accepted_revision,
      baseRevision: operation.base_revision,
      insertedCodePoints: operation.inserted_code_points,
      acceptedAt: operation.accepted_at.toISOString(),
      author: {
        id: operation.editor_id,
        displayName: operation.name
      }
    }))
  ];
}

export async function getDocumentRevision(
  editorId: string,
  documentId: string,
  revision: number
): Promise<DocumentRevision> {
  await getDocument(editorId, documentId);
  const current = await getCurrentDocumentState(documentId);
  if (revision > current.revision) {
    throw new HttpError(404, "Document revision not found.");
  }

  return { revision, content: await getRevisionContent(documentId, revision) };
}

function replacementOperation(current: string, target: string): TextOp {
  const currentPoints = Array.from(current);
  const targetPoints = Array.from(target);
  let prefixLength = 0;
  while (
    prefixLength < currentPoints.length &&
    prefixLength < targetPoints.length &&
    currentPoints[prefixLength] === targetPoints[prefixLength]
  ) {
    prefixLength++;
  }

  let suffixLength = 0;
  while (
    suffixLength < currentPoints.length - prefixLength &&
    suffixLength < targetPoints.length - prefixLength &&
    currentPoints[currentPoints.length - suffixLength - 1] ===
      targetPoints[targetPoints.length - suffixLength - 1]
  ) {
    suffixLength++;
  }

  const operation: TextOp = [];
  if (prefixLength > 0) {
    operation.push(prefixLength);
  }
  const deleted = currentPoints.slice(prefixLength, currentPoints.length - suffixLength).join("");
  if (deleted) {
    operation.push({ d: deleted });
  }
  const inserted = targetPoints.slice(prefixLength, targetPoints.length - suffixLength).join("");
  if (inserted) {
    operation.push(inserted);
  }
  return operation;
}

function submitRestoration(
  backend: ShareDB,
  editorId: string,
  documentId: string,
  revision: number,
  operation: TextOp
): Promise<void> {
  return new Promise((resolve, reject) => {
    backend.submit(
      {
        protocol: "1.2",
        custom: { editorId, restoreExpectedRevision: revision }
      } as never,
      "documents",
      documentId,
      { src: `restore-${randomUUID()}`, seq: 0, v: revision, op: operation },
      null,
      (error) => error ? reject(error) : resolve()
    );
  });
}

export async function restoreDocument(
  editorId: string,
  documentId: string,
  targetRevision: number,
  expectedRevision: number,
  backend: ShareDB
): Promise<DocumentRevision> {
  const document = await getDocument(editorId, documentId);
  if (document.role !== "owner") {
    throw new HttpError(403, "Only the document owner can restore revisions.");
  }

  const current = await getCurrentDocumentState(documentId);
  if (targetRevision > current.revision) {
    throw new HttpError(404, "Document revision not found.");
  }
  if (expectedRevision !== current.revision) {
    throw new HttpError(409, "Document changed before restoration.");
  }

  const targetContent = await getRevisionContent(documentId, targetRevision);
  if (targetContent === current.content) {
    throw new HttpError(409, "Document already matches this revision.");
  }

  try {
    await submitRestoration(
      backend,
      editorId,
      documentId,
      expectedRevision,
      replacementOperation(current.content, targetContent)
    );
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
    if (code === "RESTORE_CONFLICT") {
      throw new HttpError(409, "Document changed before restoration.");
    }
    if (code === "CREDIT_EXHAUSTED") {
      throw new HttpError(409, "Daily Unicode code point credit exhausted.");
    }
    throw error;
  }

  return { revision: expectedRevision + 1, content: targetContent };
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
