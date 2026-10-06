import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { ROOT } from "../lib/root";
import * as schema from "./schema";

export type DB = ReturnType<typeof createDb>["db"];

export const MIGRATIONS_DIR = join(ROOT, "drizzle");

export function createDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA synchronous = NORMAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  sqlite.exec("PRAGMA cache_size = -20000");
  sqlite.exec("PRAGMA temp_store = MEMORY");
  // Keeps planner statistics fresh for long-lived connections (cheap when nothing changed).
  sqlite.exec("PRAGMA optimize = 0x10002");
  const db = drizzle({ client: sqlite, schema });
  return { sqlite, db };
}

export function runMigrations(db: DB, migrationsFolder = MIGRATIONS_DIR) {
  migrate(db, { migrationsFolder });
}
