// Consistent online backup of the SQLite database (safe while the server runs).
//   bun run db:backup [target-file]
import { backupDatabase } from "../src/services/backups";

const target = process.argv[2] ?? `./backups/tracker-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
// Recovery tools must still work when unrelated SMTP/auth configuration is broken.
try {
  backupDatabase(process.env.DATABASE_PATH?.trim() || "./data/tracker.db", target);
  console.log(`Verified backup written to ${target}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Backup failed");
  process.exit(1);
}
