import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocket } from "ws";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { createSession, findOrCreateEditor } from "../../src/services/editors.js";

interface ShareDocument {
  data: unknown;
  subscribe(callback: (error: Error | null) => void): void;
  submitOp(operation: unknown[], callback: (error: Error | null) => void): void;
  whenNothingPending(callback: () => void): void;
}

interface ShareConnection {
  on(event: string, callback: (error?: Error) => void): void;
  get(collection: string, id: string): ShareDocument;
  close(): void;
}

const require = createRequire(import.meta.url);
const ShareDbConnection = require("sharedb/lib/client").Connection as new (
  socket: ShareDbWebSocket
) => ShareConnection;

class ShareDbWebSocket {
  readyState = 0;
  onopen: () => void = () => {};
  onclose: () => void = () => {};
  onmessage: (event: { data: string }) => void = () => {};
  onerror: () => void = () => {};

  constructor(private readonly socket: WebSocket) {
    socket.on("open", () => {
      this.readyState = 1;
      this.onopen();
    });
    socket.on("close", () => {
      this.readyState = 3;
      this.onclose();
    });
    socket.on("error", () => this.onerror());
    socket.on("message", (data) => this.onmessage({ data: data.toString() }));
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }
}

async function connect(
  url: string,
  sessionToken: string
): Promise<{ connection: ShareConnection; socket: ShareDbWebSocket }> {
  const rawSocket = new WebSocket(url, {
    headers: { Cookie: `collab_session=${sessionToken}` }
  });
  const socket = new ShareDbWebSocket(rawSocket);
  const connection = new ShareDbConnection(socket);

  await new Promise<void>((resolve, reject) => {
    connection.on("connected", () => resolve());
    connection.on("error", reject);
  });

  return { connection, socket };
}

function subscribe(document: ShareDocument): Promise<void> {
  return new Promise((resolve, reject) => {
    document.subscribe((error) => error ? reject(error) : resolve());
  });
}

function submit(document: ShareDocument, operation: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    document.submitOp(operation, (error) => error ? reject(error) : resolve());
  });
}

test("ShareDB synchronizes authenticated WebSocket clients and persists operations", async () => {
  const app = buildApp();
  const suffix = randomUUID();
  const documentId = randomUUID();
  const firstEditor = await findOrCreateEditor("First", `first-${suffix}@example.test`);
  const secondEditor = await findOrCreateEditor("Second", `second-${suffix}@example.test`);
  const outsider = await findOrCreateEditor("Outsider", `outsider-${suffix}@example.test`);
  const firstSession = await createSession(firstEditor.id);
  const secondSession = await createSession(secondEditor.id);
  const outsiderSession = await createSession(outsider.id);
  let firstClient: { connection: ShareConnection; socket: ShareDbWebSocket } | undefined;
  let secondClient: { connection: ShareConnection; socket: ShareDbWebSocket } | undefined;
  let outsiderClient: { connection: ShareConnection; socket: ShareDbWebSocket } | undefined;

  try {
    await pool.query("INSERT INTO documents (id, title) VALUES ($1, 'WebSocket document')", [documentId]);
    await pool.query(
      `INSERT INTO document_editors (document_id, editor_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'editor')`,
      [documentId, firstEditor.id, secondEditor.id]
    );
    await pool.query(
      "INSERT INTO document_states (document_id, content, revision) VALUES ($1, '', 0)",
      [documentId]
    );

    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    const webSocketUrl = `ws://127.0.0.1:${address.port}/ws`;

    firstClient = await connect(webSocketUrl, firstSession.token);
    secondClient = await connect(webSocketUrl, secondSession.token);
    outsiderClient = await connect(webSocketUrl, outsiderSession.token);

    const firstDocument = firstClient.connection.get("documents", documentId);
    const secondDocument = secondClient.connection.get("documents", documentId);
    const outsiderDocument = outsiderClient.connection.get("documents", documentId);

    await Promise.all([subscribe(firstDocument), subscribe(secondDocument)]);
    await assert.rejects(subscribe(outsiderDocument));

    await Promise.all([
      submit(firstDocument, ["🤖"]),
      submit(secondDocument, ["👻"])
    ]);
    await Promise.all([
      new Promise<void>((resolve) => firstDocument.whenNothingPending(resolve)),
      new Promise<void>((resolve) => secondDocument.whenNothingPending(resolve))
    ]);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(firstDocument.data, secondDocument.data);
    assert.equal(Array.from(firstDocument.data as string).length, 2);

    const stored = await pool.query<{ content: string; revision: number; count: number }>(
      `SELECT document_states.content, document_states.revision,
              (SELECT COUNT(*)::int FROM edit_operations WHERE document_id = $1) AS count
       FROM document_states
       WHERE document_states.document_id = $1`,
      [documentId]
    );
    assert.equal(stored.rows[0].content, firstDocument.data);
    assert.equal(stored.rows[0].revision, 2);
    assert.equal(stored.rows[0].count, 2);
  } finally {
    firstClient?.connection.close();
    secondClient?.connection.close();
    outsiderClient?.connection.close();
    await app.close();
    await pool.end();
  }
});
