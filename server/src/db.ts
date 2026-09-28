import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgres://localhost/seamline";

export const pool = new pg.Pool({
  connectionString: url,
  // Hosted Postgres (Neon) requires TLS; local Postgres does not.
  ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: true } : undefined,
  max: 5,
});

export const query = <T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) =>
  pool.query<T>(text, params);

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const migrationsDir = fileURLToPath(new URL("../../db/migrations", import.meta.url));

export async function migrate() {
  await query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await tx(async (c) => {
      await c.query(sql);
      await c.query("insert into schema_migrations (name) values ($1)", [file]);
    });
    console.log(`migrated ${file}`);
  }
}
