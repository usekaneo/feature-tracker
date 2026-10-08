import { chmodSync, writeFileSync } from "node:fs";
import { createDb } from "../src/db/client";
import { importGitHubFeatures } from "../src/services/github-import";

const [database, input, mapping, appUrl] = process.argv.slice(2);
if (!database || !input || !mapping || !appUrl) {
  throw new Error("Usage: import-github <existing-db> <private-snapshot.json> <new-private-mapping.json> <app-url>");
}
if (!await Bun.file(database).exists()) throw new Error("Existing database required");
if (await Bun.file(mapping).exists()) throw new Error("Mapping output already exists");
const url = new URL(appUrl);
if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid application URL");
const { db, sqlite } = createDb(database);
try {
  const result = importGitHubFeatures(db, await Bun.file(input).json(), appUrl.replace(/\/$/, ""));
  writeFileSync(mapping, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(mapping, 0o600);
  console.log(JSON.stringify({ copied: result.mappings.filter(m => m.created).length,
    skipped: result.mappings.filter(m => !m.created).length, comments: result.mappings.reduce((n, m) => n + m.comments, 0) }));
} finally { sqlite.close(); }
