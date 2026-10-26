import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool, type PoolConfig } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const rdsCertificateAuthority = readFileSync(
  fileURLToPath(new URL("../assets/certs/rds-eu-north-1-bundle.pem", import.meta.url)),
  "utf8"
);

export function databasePoolConfig(url: string): PoolConfig {
  const connection = new URL(url);
  const sslMode = connection.searchParams.get("sslmode");
  connection.searchParams.delete("sslmode");

  const requiresTls =
    process.env.NODE_ENV === "production" ||
    connection.hostname.endsWith(".rds.amazonaws.com") ||
    sslMode === "require" ||
    sslMode === "verify-ca" ||
    sslMode === "verify-full";
  return {
    connectionString: connection.toString(),
    ...(requiresTls
      ? { ssl: { ca: rdsCertificateAuthority, rejectUnauthorized: true } }
      : {})
  };
}

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be defined.");
}

export const pool = new Pool(databasePoolConfig(databaseUrl));

export async function checkDatabaseConnection(): Promise<void> {
  await pool.query("SELECT 1");
}
