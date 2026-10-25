export interface PublicEditor {
  id: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  createdAt: string;
}

export type DocumentRole = "owner" | "editor";

export interface DocumentSummary {
  id: string;
  title: string;
  description: string;
  publishedAt: string | null;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
  role: DocumentRole;
}
