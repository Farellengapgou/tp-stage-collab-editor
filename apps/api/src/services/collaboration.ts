import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import ShareDB from "sharedb";
import { type as textUnicode } from "ot-text-unicode";
import { WebSocket, WebSocketServer } from "ws";
import type { FastifyInstance } from "fastify";
import { getEditorFromSession } from "./editors.js";
import { readCookieHeader } from "../routes/auth.js";
import { DocumentShareDb } from "./sharedb-db.js";
import { pool } from "../db.js";

const collectionName = "documents";
const sessionCookieName = "collab_session";

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

export function createCollaborationBackend(): ShareDB {
  ShareDB.types.register(textUnicode);
  const backend = new ShareDB({ db: new DocumentShareDb(), doNotCommitNoOps: true });

  backend.use("connect", (request, next) => {
    request.agent.custom.editorId = request.req.editorId;
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

export function installCollaboration(app: FastifyInstance): void {
  const backend = createCollaborationBackend();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const upgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/ws") {
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
          backend.listen(new WebSocketJsonStream(webSocket), { editorId: editor.id });
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
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });
}
