// point d'entrée pour le backend de collaboration en temps réel , il relie le serveur WebSocket à ShareDB et gère l'authentification des éditeurs

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { createRequire } from "node:module";
import ShareDB from "sharedb";
import { type as textUnicode } from "ot-text-unicode";
import { createClient } from "redis";
import { WebSocket, WebSocketServer } from "ws";
import type { FastifyInstance } from "fastify";
import { getEditorFromSession } from "./editors.js";
import { readCookieHeader } from "../routes/auth.js";
import { DocumentShareDb } from "./sharedb-db.js";
import { pool } from "../db.js";

const collectionName = "documents";
const sessionCookieName = "collab_session";
const require = createRequire(import.meta.url);
const RedisPubSub = require("sharedb-redis-pubsub");

interface Selection {
  anchor: number;
  focus: number;
}

interface EditorPresence {
  editorId: string;
  selection: Selection;
}

function isSelection(value: unknown): value is Selection {
  return (
    typeof value === "object" &&
    value !== null &&
    "anchor" in value &&
    "focus" in value &&
    typeof value.anchor === "number" &&
    Number.isInteger(value.anchor) &&
    value.anchor >= 0 &&
    typeof value.focus === "number" &&
    Number.isInteger(value.focus) &&
    value.focus >= 0
  );
}

function transformPosition(position: number, operation: unknown[], isOwnOperation: boolean): number {
  let sourcePosition = 0;
  let transformedPosition = 0;

  for (const component of operation) {
    if (typeof component === "number") {
      if (position <= sourcePosition + component) {
        return transformedPosition + position - sourcePosition;
      }
      sourcePosition += component;
      transformedPosition += component;
      continue;
    }

    if (typeof component === "string") {
      if (position > sourcePosition || (position === sourcePosition && isOwnOperation)) {
        transformedPosition += Array.from(component).length;
      }
      continue;
    }

    if (
      typeof component === "object" &&
      component !== null &&
      "d" in component &&
      (typeof component.d === "number" || typeof component.d === "string")
    ) {
      const deleted = typeof component.d === "number" ? component.d : Array.from(component.d).length;
      if (position <= sourcePosition + deleted) {
        return transformedPosition;
      }
      sourcePosition += deleted;
    }
  }

  return transformedPosition + position - sourcePosition;
}

function transformEditorPresence(
  value: unknown,
  operation: unknown[],
  isOwnOperation: boolean
): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    !("selection" in value) ||
    !isSelection(value.selection)
  ) {
    return value;
  }

  return {
    ...value,
    selection: {
      anchor: transformPosition(value.selection.anchor, operation, isOwnOperation),
      focus: transformPosition(value.selection.focus, operation, isOwnOperation)
    }
  };
}

Object.assign(textUnicode, { transformPresence: transformEditorPresence });

class WebSocketJsonStream extends Duplex {
  constructor(private readonly socket: WebSocket) {
    super({ objectMode: true });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.destroy(new Error("Binary WebSocket messages are not supported."));
        return;
      }

      try {
        this.push(JSON.parse(data.toString()));
      } catch {
        this.destroy(new Error("Invalid WebSocket JSON message."));
      }
    });
    socket.on("close", () => this.push(null));
    socket.on("error", (error) => this.destroy(error));
  }

  _read(): void {}

  _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      callback(new Error("WebSocket is closed."));
      return;
    }

    this.socket.send(JSON.stringify(chunk), callback);
  }
}

async function hasDocumentAccess(editorId: string, documentId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM document_editors WHERE document_id = $1 AND editor_id = $2",
    [documentId, editorId]
  );
  return result.rowCount === 1;
}

export function createCollaborationBackend(pubsub?: ShareDB.PubSub): ShareDB {
  ShareDB.types.register(textUnicode);
  const backend = new ShareDB({
    db: new DocumentShareDb(),
    doNotCommitNoOps: true,
    doNotForwardSendPresenceErrorsToClient: true,
    presence: true,
    ...(pubsub ? { pubsub } : {})
  });

  backend.use("connect", (request, next) => {
    request.agent.custom.editorId = request.req.editorId;
    next();
  });

  backend.use("receive", (request, next) => {
    const data = request.data as { a?: string; c?: unknown; d?: unknown; ch?: unknown };
    if (!(["p", "ps", "pr"].includes(data.a ?? ""))) {
      next();
      return;
    }

    const documentId = typeof data.d === "string"
      ? data.d
      : typeof data.ch === "string" && data.ch.startsWith(`${collectionName}.`)
        ? data.ch.slice(collectionName.length + 1)
        : undefined;
    const editorId = request.agent.custom.editorId;
    if (
      !editorId ||
      data.c !== undefined && data.c !== collectionName ||
      !documentId ||
      (typeof data.ch === "string" && data.ch !== `${collectionName}.${documentId}`)
    ) {
      next(new Error("Document presence rejected."));
      return;
    }

    void hasDocumentAccess(editorId, documentId)
      .then((allowed) => next(allowed ? undefined : new Error("Document access denied.")))
      .catch(next);
  });

  backend.use("receivePresence", (request, next) => {
    const editorId = request.agent.custom.editorId;
    const presence = request.presence as { p: unknown; c?: string; d?: string; ch: string };
    if (
      !editorId ||
      presence.c !== collectionName ||
      !presence.d ||
      presence.ch !== `${collectionName}.${presence.d}` ||
      (presence.p !== null && (
        typeof presence.p !== "object" ||
        presence.p === null ||
        !("selection" in presence.p) ||
        !isSelection(presence.p.selection)
      ))
    ) {
      next(new Error("Document presence rejected."));
      return;
    }

    if (presence.p !== null) {
      const selection = (presence.p as { selection: Selection }).selection;
      presence.p = {
        editorId,
        selection
      } satisfies EditorPresence;
    }
    next();
  });

  backend.use("submit", (request, next) => {
    const editorId = request.agent.custom.editorId;
    const operation = request.op as {
      create?: unknown;
      del?: unknown;
      op?: unknown[];
      m?: Record<string, unknown>;
    };
    if (
      request.collection !== collectionName ||
      !editorId ||
      operation.create ||
      operation.del ||
      !Array.isArray(operation.op)
    ) {
      next(new Error("Document operation rejected."));
      return;
    }

    void hasDocumentAccess(editorId, request.id)
      .then((allowed) => {
        if (!allowed) {
          next(new Error("Document access denied."));
          return;
        }

        operation.m = { editorId };
        next();
      })
      .catch(next);
  });

  backend.use("readSnapshots", (request, next) => {
    const editorId = request.agent.custom.editorId;
    const snapshotRequest = request as typeof request & {
      rejectSnapshotRead: (snapshot: unknown, error: Error) => void;
    };
    void Promise.all(request.snapshots.map(async (snapshot) => {
      const allowed = editorId && await hasDocumentAccess(editorId, snapshot.id);
      if (!allowed) {
        snapshotRequest.rejectSnapshotRead(snapshot, new Error("Document access denied."));
      }
    }))
      .then(() => next())
      .catch(next);
  });

  return backend;
}

async function closeRedisClient(client: { isOpen: boolean; close(): Promise<void> }): Promise<void> {
  if (client.isOpen) {
    await client.close();
  }
}

export async function createRedisPubSub(
  redisUrl: string,
  onError: (error: Error) => void
): Promise<ShareDB.PubSub> {
  const client = createClient({
    url: redisUrl,
    socket: { reconnectStrategy: false }
  });
  const observer = client.duplicate();
  client.on("error", onError);
  observer.on("error", onError);

  try {
    await Promise.all([client.connect(), observer.connect()]);
    return new RedisPubSub({ client, observer }) as ShareDB.PubSub;
  } catch (error) {
    await Promise.allSettled([closeRedisClient(client), closeRedisClient(observer)]);
    throw error;
  }
}

export function installCollaboration(app: FastifyInstance): void {
  let backend: ShareDB | undefined;
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    app.addHook("onReady", async () => {
      const pubsub = await createRedisPubSub(redisUrl, (error) => {
        app.log.error({ err: error }, "Redis Pub/Sub error");
      });
      backend = createCollaborationBackend(pubsub);
    });
  } else {
    backend = createCollaborationBackend();
  }
  const webSocketServer = new WebSocketServer({ noServer: true });
  const upgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/ws") {
      return;
    }

    if (!backend) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const token = readCookieHeader(request.headers.cookie, sessionCookieName);
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    void getEditorFromSession(token)
      .then((editor) => {
        if (!editor) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }

        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          backend?.listen(new WebSocketJsonStream(webSocket), { editorId: editor.id });
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
        socket.destroy();
      });
  };

  app.server.on("upgrade", upgrade);
  app.addHook("onClose", async () => {
    app.server.removeListener("upgrade", upgrade);
    webSocketServer.close();
    if (backend) {
      const currentBackend = backend;
      await new Promise<void>((resolve) => currentBackend.close(() => resolve()));
    }
  });
}
