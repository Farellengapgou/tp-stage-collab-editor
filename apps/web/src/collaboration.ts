import ShareDB from "sharedb/lib/client";
import { type as textUnicode } from "ot-text-unicode";

function transformPosition(position: number, operation: unknown[], isOwnOperation: boolean): number {
  let sourcePosition = 0;
  let transformedPosition = 0;
  for (const component of operation) {
    if (typeof component === "number") {
      if (position <= sourcePosition + component) return transformedPosition + position - sourcePosition;
      sourcePosition += component;
      transformedPosition += component;
    } else if (typeof component === "string") {
      if (position > sourcePosition || (position === sourcePosition && isOwnOperation)) {
        transformedPosition += Array.from(component).length;
      }
    } else if (typeof component === "object" && component !== null && "d" in component) {
      const deleted = typeof component.d === "string" ? Array.from(component.d).length : component.d;
      if (typeof deleted !== "number") continue;
      if (position <= sourcePosition + deleted) return transformedPosition;
      sourcePosition += deleted;
    }
  }
  return transformedPosition + position - sourcePosition;
}

Object.assign(textUnicode, {
  transformPresence(value: unknown, operation: unknown[], isOwnOperation: boolean): unknown {
    if (
      typeof value !== "object" || value === null || !("selection" in value) ||
      typeof value.selection !== "object" || value.selection === null ||
      !("anchor" in value.selection) || !("focus" in value.selection) ||
      typeof value.selection.anchor !== "number" || typeof value.selection.focus !== "number"
    ) return value;
    return {
      ...value,
      selection: {
        anchor: transformPosition(value.selection.anchor, operation, isOwnOperation),
        focus: transformPosition(value.selection.focus, operation, isOwnOperation)
      }
    };
  }
});

ShareDB.types.register(textUnicode);

export interface CollaborationState {
  content: string;
  revision: number;
  connected: boolean;
  synchronizing: boolean;
  saving: boolean;
  remotePresences: Record<string, { editorId?: string; selection?: { anchor: number; focus: number }; typing?: boolean }>;
}

function websocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export class CollaborativeDocument {
  private connection: any;
  private document: any;
  private presence: any;
  private localPresence: any;
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private stopped = false;
  private saving = false;
  private initialized = false;
  private selection = { anchor: 0, focus: 0 };
  private typingTimer: number | null = null;
  private typing = false;

  constructor(
    private readonly documentId: string,
    private readonly onState: (state: CollaborationState) => void,
    private readonly onError: (message: string) => void
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.typingTimer !== null) window.clearTimeout(this.typingTimer);
    this.connection?.close();
    this.socket?.close();
  }

  blur(): void {
    if (this.typingTimer !== null) window.clearTimeout(this.typingTimer);
    this.typing = false;
    this.publishPresence(false);
  }

  submitChange(next: string): void {
    const previous = typeof this.document?.data === "string" ? this.document.data : "";
    if (!this.document || previous === next) return;
    const from = Array.from(previous);
    const to = Array.from(next);
    let prefix = 0;
    while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) prefix++;
    let suffix = 0;
    while (suffix < from.length - prefix && suffix < to.length - prefix && from[from.length - suffix - 1] === to[to.length - suffix - 1]) suffix++;
    const operation: unknown[] = [];
    if (prefix) operation.push(prefix);
    const deleted = from.slice(prefix, from.length - suffix).join("");
    if (deleted) operation.push({ d: deleted });
    const inserted = to.slice(prefix, to.length - suffix).join("");
    if (inserted) operation.push(inserted);
    this.saving = true;
    this.setTyping(true);
    this.document.submitOp(operation, (error: Error | null) => {
      this.saving = false;
      if (error) {
        this.onError(error.message);
        this.document.fetch();
      }
      this.emit();
    });
  }

  updateSelection(value: string, selectionStart: number, selectionEnd: number): void {
    const points = (offset: number) => Array.from(value.slice(0, offset)).length;
    this.selection = { anchor: points(selectionStart), focus: points(selectionEnd) };
    this.publishPresence(this.typing);
  }

  private setTyping(typing: boolean): void {
    this.typing = typing;
    this.publishPresence(typing);
    if (this.typingTimer !== null) window.clearTimeout(this.typingTimer);
    if (typing) {
      this.typingTimer = window.setTimeout(() => {
        this.typing = false;
        this.publishPresence(false);
      }, 900);
    }
  }

  private publishPresence(typing: boolean): void {
    if (!this.localPresence) return;
    this.localPresence.submit({ selection: this.selection, typing }, (error: Error | null) => {
      if (error) return this.onError(error.message);
      this.localPresence.send((sendError: Error | null) => {
        if (sendError) this.onError(sendError.message);
      });
    });
  }

  private connect(): void {
    this.socket = new WebSocket(websocketUrl());
    if (this.connection) {
      this.connection.bindToSocket(this.socket);
      return;
    }
    this.connection = new ShareDB.Connection(this.socket);
    this.connection.on("state", (state: string) => {
      if (state === "connected" && this.localPresence) this.publishPresence(this.typing);
      this.emit();
      if (state === "disconnected" && !this.stopped) {
        this.reconnectTimer = window.setTimeout(() => this.connect(), 1_000);
      }
    });
    this.connection.on("error", (error: Error) => this.onError(error.message));
    this.document = this.connection.get("documents", this.documentId);
    this.document.subscribe((error: Error | null) => {
      if (error) return this.onError(error.message);
      if (this.initialized) return;
      this.initialized = true;
      this.document.on("op", () => this.emit());
      this.document.on("load", () => this.emit());
      this.presence = this.connection.getDocPresence("documents", this.documentId);
      this.presence.on("receive", () => this.emit());
      this.presence.on("error", (presenceError: Error) => this.onError(presenceError.message));
      this.presence.subscribe((presenceError: Error | null) => {
        if (presenceError) return this.onError(presenceError.message);
        this.localPresence = this.presence.create("cursor");
        this.publishPresence(false);
        this.emit();
      });
      this.emit();
    });
  }

  private emit(): void {
    this.onState({
      content: typeof this.document?.data === "string" ? this.document.data : "",
      revision: typeof this.document?.version === "number" ? this.document.version : 0,
      connected: this.connection?.state === "connected",
      synchronizing: this.connection?.state === "connecting" || !this.initialized,
      saving: this.saving || Boolean(this.document?.hasPending?.()),
      remotePresences: this.connection?.state === "connected" ? this.presence?.remotePresences ?? {} : {}
    });
  }
}
