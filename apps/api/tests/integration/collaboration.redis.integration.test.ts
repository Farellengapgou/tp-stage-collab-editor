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
  bindToSocket(socket: ShareDbWebSocket): void;
  get(collection: string, id: string): ShareDocument;
  close(): void;
}

const require = createRequire(import.meta.url);
const ShareDbConnection = require("sharedb/lib/client").Connection as new (
  socket: ShareDbWebSocket
) => ShareConnection;

class ShareDbWebSocket {
  readyState = 0;
  private discardIncoming = false;
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
    socket.on("message", (data) => {
      if (!this.discardIncoming) {
        this.onmessage({ data: data.toString() });
      }
    });
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }

  discardIncomingMessages(): void {
    this.discardIncoming = true;
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

async function reconnect(
  connection: ShareConnection,
  url: string,
  sessionToken: string
): Promise<ShareDbWebSocket> {
  const rawSocket = new WebSocket(url, {
    headers: { Cookie: `collab_session=${sessionToken}` }
  });
  const socket = new ShareDbWebSocket(rawSocket);
  connection.bindToSocket(socket);
  await new Promise<void>((resolve, reject) => {
    connection.on("connected", () => resolve());
    connection.on("error", reject);
  });
  return socket;
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

function restoreRedisUrl(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = value;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for ShareDB synchronization.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Redis Pub/Sub synchronizes separate ShareDB backends", { skip: !process.env.REDIS_URL }, async (t) => {
  const redisUrl = process.env.REDIS_URL;
  const initialRedisUrl = redisUrl;

  await t.test("an unavailable configured Redis prevents server startup", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    const app = buildApp();
    try {
      await assert.rejects(app.listen({ port: 0, host: "127.0.0.1" }));
    } finally {
      await app.close();
      restoreRedisUrl(initialRedisUrl);
    }
  });

  await t.test("operations propagate in both directions after PostgreSQL commits", async () => {
    const firstApp = buildApp();
    const secondApp = buildApp();
    const suffix = randomUUID();
    const documentId = randomUUID();
    const firstEditor = await findOrCreateEditor("First", `redis-first-${suffix}@example.test`);
    const secondEditor = await findOrCreateEditor("Second", `redis-second-${suffix}@example.test`);
    const firstSession = await createSession(firstEditor.id);
    const secondSession = await createSession(secondEditor.id);
    let firstClient: { connection: ShareConnection; socket: ShareDbWebSocket } | undefined;
    let secondClient: { connection: ShareConnection; socket: ShareDbWebSocket } | undefined;

    try {
      await pool.query("INSERT INTO documents (id, title) VALUES ($1, 'Redis document')", [documentId]);
      await pool.query(
        `INSERT INTO document_editors (document_id, editor_id, role)
         VALUES ($1, $2, 'owner'), ($1, $3, 'editor')`,
        [documentId, firstEditor.id, secondEditor.id]
      );
      await pool.query(
        "INSERT INTO document_states (document_id, content, revision) VALUES ($1, '', 0)",
        [documentId]
      );

      await Promise.all([
        firstApp.listen({ port: 0, host: "127.0.0.1" }),
        secondApp.listen({ port: 0, host: "127.0.0.1" })
      ]);
      const firstAddress = firstApp.server.address() as AddressInfo;
      const secondAddress = secondApp.server.address() as AddressInfo;
      firstClient = await connect(`ws://127.0.0.1:${firstAddress.port}/ws`, firstSession.token);
      secondClient = await connect(`ws://127.0.0.1:${secondAddress.port}/ws`, secondSession.token);

      const firstDocument = firstClient.connection.get("documents", documentId);
      const secondDocument = secondClient.connection.get("documents", documentId);
      await Promise.all([subscribe(firstDocument), subscribe(secondDocument)]);

      await submit(firstDocument, ["A"]);
      await new Promise<void>((resolve) => secondDocument.whenNothingPending(resolve));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(secondDocument.data, "A");

      await submit(secondDocument, [1, "B"]);
      await new Promise<void>((resolve) => firstDocument.whenNothingPending(resolve));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(firstDocument.data, "AB");
      assert.equal(secondDocument.data, "AB");

      const stored = await pool.query<{ content: string; revision: number; current_revision: number; count: number }>(
        `SELECT document_states.content, document_states.revision, documents.current_revision,
                (SELECT COUNT(*)::int FROM edit_operations WHERE document_id = $1) AS count
         FROM document_states
         INNER JOIN documents ON documents.id = document_states.document_id
         WHERE document_states.document_id = $1`,
        [documentId]
      );
      assert.deepEqual(stored.rows[0], {
        content: "AB",
        revision: 2,
        current_revision: 2,
        count: 2
      });
    } finally {
      firstClient?.connection.close();
      secondClient?.connection.close();
      await Promise.all([firstApp.close(), secondApp.close()]);
    }
  });

  await t.test("a client catches up and retransmits an unacknowledged operation on another instance", async () => {
    const firstApp = buildApp();
    const secondApp = buildApp();
    const suffix = randomUUID();
    const documentId = randomUUID();
    const recoveringEditor = await findOrCreateEditor("Recovering", `recovering-${suffix}@example.test`);
    const activeEditor = await findOrCreateEditor("Active", `active-${suffix}@example.test`);
    const recoveringSession = await createSession(recoveringEditor.id);
    const activeSession = await createSession(activeEditor.id);
    let recoveringClient: { connection: ShareConnection; socket: ShareDbWebSocket } | undefined;
    let activeClient: { connection: ShareConnection; socket: ShareDbWebSocket } | undefined;
    let firstAppClosed = false;

    try {
      await pool.query("INSERT INTO documents (id, title) VALUES ($1, 'Recovery document')", [documentId]);
      await pool.query(
        `INSERT INTO document_editors (document_id, editor_id, role)
         VALUES ($1, $2, 'owner'), ($1, $3, 'editor')`,
        [documentId, recoveringEditor.id, activeEditor.id]
      );
      await pool.query(
        "INSERT INTO document_states (document_id, content, revision) VALUES ($1, '', 0)",
        [documentId]
      );
      await Promise.all([
        firstApp.listen({ port: 0, host: "127.0.0.1" }),
        secondApp.listen({ port: 0, host: "127.0.0.1" })
      ]);
      const firstAddress = firstApp.server.address() as AddressInfo;
      const secondAddress = secondApp.server.address() as AddressInfo;
      const firstUrl = `ws://127.0.0.1:${firstAddress.port}/ws`;
      const secondUrl = `ws://127.0.0.1:${secondAddress.port}/ws`;
      recoveringClient = await connect(firstUrl, recoveringSession.token);
      activeClient = await connect(secondUrl, activeSession.token);
      const recoveringDocument = recoveringClient.connection.get("documents", documentId);
      const activeDocument = activeClient.connection.get("documents", documentId);
      await Promise.all([subscribe(recoveringDocument), subscribe(activeDocument)]);

      recoveringClient.socket.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await firstApp.close();
      firstAppClosed = true;
      await submit(activeDocument, ["B"]);
      await new Promise<void>((resolve) => activeDocument.whenNothingPending(resolve));

      recoveringClient.socket = await reconnect(recoveringClient.connection, secondUrl, recoveringSession.token);
      await waitFor(() => recoveringDocument.data === "B");

      recoveringClient.socket.discardIncomingMessages();
      const unacknowledgedSubmission = submit(recoveringDocument, [1, "C"]);
      await waitFor(async () => {
        const state = await pool.query<{ revision: number }>(
          "SELECT revision FROM document_states WHERE document_id = $1",
          [documentId]
        );
        return state.rows[0].revision === 2;
      });

      recoveringClient.socket.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      recoveringClient.socket = await reconnect(recoveringClient.connection, secondUrl, recoveringSession.token);
      await unacknowledgedSubmission;
      await waitFor(() => recoveringDocument.data === "BC");

      const stored = await pool.query<{ content: string; revision: number; count: number }>(
        `SELECT document_states.content, document_states.revision,
                (SELECT COUNT(*)::int FROM edit_operations WHERE document_id = $1) AS count
         FROM document_states
         WHERE document_states.document_id = $1`,
        [documentId]
      );
      const credit = await pool.query<{ used_characters: number }>(
        `SELECT used_characters FROM daily_credits
         WHERE editor_id = $1 AND credit_date = (NOW() AT TIME ZONE 'UTC')::date`,
        [recoveringEditor.id]
      );
      assert.deepEqual(stored.rows[0], { content: "BC", revision: 2, count: 2 });
      assert.equal(credit.rows[0].used_characters, 1);
    } finally {
      recoveringClient?.connection.close();
      activeClient?.connection.close();
      await Promise.all([firstAppClosed ? Promise.resolve() : firstApp.close(), secondApp.close()]);
    }
  });

  await pool.end();
});
