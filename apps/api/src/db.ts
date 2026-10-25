// centralise la connection entre notre api et Node.js 
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be defined.");
}

export const pool = new Pool({
  connectionString: databaseUrl,
});

export async function checkDatabaseConnection(): Promise<void> {
  await pool.query("SELECT 1");
}
