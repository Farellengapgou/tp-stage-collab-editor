export interface Editor {
  id: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  description: string;
  publishedAt: string | null;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
  role: "owner" | "editor";
}

export interface DocumentEditor {
  id: string;
  displayName: string;
  email: string;
  role: "owner" | "editor";
}

export interface HistoryEntry {
  revision: number;
  baseRevision: number | null;
  insertedCodePoints: number;
  acceptedAt: string | null;
  author: { id: string; displayName: string } | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}
