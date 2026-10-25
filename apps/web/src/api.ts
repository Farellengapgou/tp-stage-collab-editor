import {
  ApiError,
  type DocumentEditor,
  type DocumentSummary,
  type Editor,
  type HistoryEntry,
  type Publication
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

export async function publishDocument(documentId: string, maxDownloads: number): Promise<{ publication?: Publication; status?: string; revision: number }> {
  return request(`/documents/${documentId}/publication`, { method: "POST", body: JSON.stringify({ maxDownloads }) });
}

export async function listPublications(): Promise<Publication[]> {
  return (await request<{ publications: Publication[] }>("/journal")).publications;
}

export async function getPublication(token: string): Promise<Publication> {
  return (await request<{ publication: Publication }>(`/journal/${token}`)).publication;
}

export async function downloadPublication(token: string): Promise<Blob> {
  const idempotencyKey = crypto.randomUUID();
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await fetch(`/api/downloads/${token}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey })
    });
    if (response.status === 202) {
      if (attempt === 11) throw new ApiError("Le PDF est toujours en préparation. Réessayez plus tard.", 202);
      await new Promise(resolve => window.setTimeout(resolve, 500));
      continue;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { status?: string; error?: string } | null;
      throw new ApiError(body?.status === "exhausted" ? "Quota atteint" : body?.error ?? "Téléchargement indisponible.", response.status);
    }
    if (!response.headers.get("content-type")?.includes("application/pdf")) {
      throw new ApiError("Le serveur n’a pas livré de PDF.", response.status);
    }
    return response.blob();
  }
  throw new ApiError("Le PDF est toujours en préparation.", 202);
}

export async function diagnosticPdf(path: string, options: RequestInit = {}): Promise<{ blob: Blob; status: number; contentType: string }> {
  const response = await fetch(`/api${path}`, { ...options, credentials: "include", headers: options.body ? { "Content-Type": "application/json" } : undefined });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("application/pdf")) throw new ApiError(await response.text(), response.status);
  return { blob: await response.blob(), status: response.status, contentType };
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
