import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";

const migrationDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const migrationLockKey = "726183976245091";

async function run(): Promise<void> {
  const files = (await readdir(migrationDirectory))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/i.test(file))
    .sort();
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [migrationLockKey]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename VARCHAR(255) PRIMARY KEY,
         checksum CHAR(64) NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
       )`
    );

    for (const filename of files) {
      const sql = await readFile(`${migrationDirectory}/${filename}`, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      await client.query("BEGIN");
      try {
        const applied = await client.query<{ checksum: string }>(
          "SELECT checksum FROM schema_migrations WHERE filename = $1 FOR UPDATE",
          [filename]
        );
        if (applied.rows[0]) {
          if (applied.rows[0].checksum !== checksum) {
            throw new Error(`Migration checksum mismatch: ${filename}`);
          }
        } else {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
            [filename, checksum]
          );
          process.stdout.write(`Applied migration: ${filename}\n`);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [migrationLockKey]);
    } finally {
      client.release();
      await pool.end();
    }
  }
}

await run();
