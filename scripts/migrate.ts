import { loadConfig } from "../src/config";
import { createDb, runMigrations } from "../src/db/client";

const config = loadConfig();
const { db, sqlite } = createDb(config.databasePath);
runMigrations(db);
sqlite.close();
console.log(`Migrated ${config.databasePath}`);
