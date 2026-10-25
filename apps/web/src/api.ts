import {
  ApiError,
  type DocumentEditor,
  type DocumentSummary,
  type Editor,
  type HistoryEntry
} from "./types";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new ApiError(
      typeof body?.error === "string" ? body.error : "Une erreur est survenue.",
      response.status
    );
  }

  return response.json() as Promise<T>;
}

export async function identify(displayName: string, email: string): Promise<Editor> {
  const response = await request<{ editor: Editor }>("/editors", {
    method: "POST",
    body: JSON.stringify({ displayName, email })
  });
  return response.editor;
}

export async function getCurrentEditor(): Promise<Editor> {
  const response = await request<{ editor: Editor }>("/editors/me");
  return response.editor;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const response = await request<{ documents: DocumentSummary[] }>("/documents");
  return response.documents;
}

export async function createDocument(title: string, description: string): Promise<DocumentSummary> {
  const response = await request<{ document: DocumentSummary }>("/documents", {
    method: "POST",
    body: JSON.stringify({ title, description })
  });
  return response.document;
}

export async function getDocument(documentId: string): Promise<DocumentSummary> {
  const response = await request<{ document: DocumentSummary }>(`/documents/${documentId}`);
  return response.document;
}

export async function lookupEditor(email: string): Promise<Editor> {
  const response = await request<{ editor: Editor }>(`/editors/lookup?email=${encodeURIComponent(email)}`);
  return response.editor;
}

export async function addDocumentEditor(documentId: string, editorId: string): Promise<void> {
  await request(`/documents/${documentId}/editors`, {
    method: "POST",
    body: JSON.stringify({ editorId })
  });
}

export async function listDocumentEditors(documentId: string): Promise<DocumentEditor[]> {
  const response = await request<{ editors: DocumentEditor[] }>(`/documents/${documentId}/editors`);
  return response.editors;
}

export async function getHistory(documentId: string): Promise<HistoryEntry[]> {
  const response = await request<{ history: HistoryEntry[] }>(`/documents/${documentId}/history`);
  return response.history;
}

export async function getRevision(documentId: string, revision: number): Promise<{ revision: number; content: string }> {
  const response = await request<{ document: { revision: number; content: string } }>(`/documents/${documentId}/history/${revision}`);
  return response.document;
}

export async function restoreRevision(documentId: string, revision: number, currentRevision: number): Promise<{ revision: number; content: string }> {
  const response = await request<{ document: { revision: number; content: string } }>(`/documents/${documentId}/history/${revision}/restore`, {
    method: "POST",
    body: JSON.stringify({ currentRevision })
  });
  return response.document;
}
