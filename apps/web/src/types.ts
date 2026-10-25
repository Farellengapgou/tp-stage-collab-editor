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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}
