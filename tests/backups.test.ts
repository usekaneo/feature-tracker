import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, ScheduledBackups } from "../src/services/backups";
import { silentLogger } from "../src/lib/logger";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tracker-backups-"));
  directories.push(dir);
  const source = join(dir, "source.db");
  const db = new Database(source);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE example (value text); INSERT INTO example VALUES ('committed WAL data')");
  return { dir, source, db };
}

describe("backups", () => {
  test("an online snapshot restores committed WAL data, verifies integrity and has private permissions", () => {
    const { dir, source, db } = fixture();
    const target = join(dir, "backups/restored.db");
    try {
      backupDatabase(source, target);
      const restored = new Database(target);
      try {
        expect(restored.query("SELECT value FROM example").get()).toEqual({ value: "committed WAL data" });
        expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        restored.exec("INSERT INTO example VALUES ('after restore')");
      } finally { restored.close(); }
      expect(db.query("SELECT count(*) as n FROM example").get()).toEqual({ n: 1 });
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(dir, "backups"))).toEqual(["restored.db"]);
      expect(() => backupDatabase(source, target)).toThrow("already exists");
    } finally { db.close(); }
  });

  test("missing or corrupt sources do not publish a backup or create an empty source", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracker-bad-backup-"));
    directories.push(dir);
    expect(() => backupDatabase(join(dir, "missing.db"), join(dir, "backup.db"))).toThrow("does not exist");
    writeFileSync(join(dir, "corrupt.db"), "not a database");
    expect(() => backupDatabase(join(dir, "corrupt.db"), join(dir, "backup.db"))).toThrow();
    expect(readdirSync(dir)).toEqual(["corrupt.db"]);
  });

  test("scheduled backups rotate only complete automatic snapshots after success", async () => {
    const { dir, source, db } = fixture();
    const directory = join(dir, "backups");
    const errors: string[] = [];
    const service = new ScheduledBackups({ databasePath: source, config: { directory, intervalMs: 60_000, keep: 2 },
      logger: { ...silentLogger, error: message => errors.push(message) } });
    try {
      service.start();
      await service.idle();
      writeFileSync(join(directory, "manual.db"), "preserve");
      writeFileSync(join(directory, "tracker-auto-incomplete.db.partial"), "preserve");
      for (let i = 0; i < 3; i++) { service.kick(); service.kick(); await service.idle(); }
      const files = readdirSync(directory);
      expect(errors).toEqual([]);
      expect(files.filter(name => name.startsWith("tracker-auto-") && name.endsWith(".db"))).toHaveLength(2);
      expect(files).toContain("manual.db");
      expect(files).toContain("tracker-auto-incomplete.db.partial");
      const failed = new ScheduledBackups({ databasePath: join(dir, "missing.db"), config: { directory, intervalMs: 60_000, keep: 1 },
        logger: { ...silentLogger, error: message => errors.push(message) } });
      failed.kick(); await failed.idle();
      expect(errors).toHaveLength(1);
      expect(readdirSync(directory).sort()).toEqual(files.sort());
    } finally { service.stop(); db.close(); }
  });
});
