// Queue existing requests without replacing maintainer choices or previous assessments.
// The app's background worker processes the queue; this command makes no provider calls.
import { asc, gt } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db/client";
import { request } from "../src/db/schema";
import { AutoLabeler } from "../src/labeler/worker";

const config = loadConfig();
if (!config.labeler) {
  console.error("Configure OPENROUTER_API_KEY or TYPESAFE_API_KEY and enable auto-labeling first.");
  process.exit(1);
}
const { db, sqlite } = createDb(config.databasePath);
let queued = 0;
let lastId = 0;
try {
  while (true) {
    const ids = db.select({ id: request.id }).from(request).where(gt(request.id, lastId)).orderBy(asc(request.id)).limit(500).all();
    if (!ids.length) break;
    queued += db.transaction(tx => ids.reduce((count, row) => count + Number(AutoLabeler.enqueue(tx, row.id)), 0), { behavior: "immediate" });
    lastId = ids.at(-1)!.id;
  }
  console.log(`Queued ${queued} requests. The running app will label them in the background.`);
} finally {
  sqlite.close();
}
