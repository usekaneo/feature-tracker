import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Query-only view of the FTS5 table created in drizzle/0001_search.sql.
 * Kept out of schema.ts so drizzle-kit doesn't try to manage it.
 */
export const requestFts = sqliteTable("request_fts", {
  rowid: integer("rowid").notNull(),
  title: text("title"),
  body: text("body"),
});
