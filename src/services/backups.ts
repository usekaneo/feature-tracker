import { Database } from "bun:sqlite";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config";
import type { Logger } from "../lib/logger";
import { ROOT } from "../lib/root";

/** VACUUM INTO gives a consistent snapshot, including committed WAL data. */
export function backupDatabase(source: string, target: string) {
  if (source === ":memory:" || !existsSync(source)) throw new Error(`Database does not exist: ${source}`);
  if (existsSync(target)) throw new Error(`Backup already exists: ${target}`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // SQLite creates the output itself; a private directory protects it during the copy.
  const staging = mkdtempSync(join(dirname(target), ".tracker-backup-"));
  const partial = join(staging, "snapshot.db");
  try {
    const db = new Database(source, { readonly: true, strict: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.query("VACUUM INTO ?").run(partial);
    } finally { db.close(); }
    const check = new Database(partial, { readonly: true });
    try {
      const rows = check.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
      if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") throw new Error("Backup integrity check failed");
    } finally { check.close(); }
    chmodSync(partial, 0o600);
    // Publish only a complete, verified file. Hard linking never replaces an existing target.
    linkSync(partial, target);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

const AUTO_BACKUP = /^tracker-auto-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[\da-f-]+\.db$/;

/** Backup in a child process so large snapshots don't block HTTP requests. */
export class ScheduledBackups {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly opts: {
    databasePath: string;
    config: NonNullable<Config["backups"]>;
    logger: Logger;
  }) {}

  start() {
    if (this.timer) return;
    this.kick();
    this.timer = setInterval(() => this.kick(), this.opts.config.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  kick() {
    if (this.running) return;
    this.running = this.run()
      .catch(error => this.opts.logger.error("Automatic backup failed; existing backups were kept", error))
      .finally(() => { this.running = null; });
  }

  async idle() { if (this.running) await this.running; }

  private async run() {
    const { databasePath, config, logger } = this.opts;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(config.directory, `tracker-auto-${stamp}-${crypto.randomUUID()}.db`);
    const script = join(ROOT, existsSync(join(ROOT, "scripts/backup.ts")) ? "scripts/backup.ts" : "dist/scripts/backup.js");
    const child = Bun.spawn([process.execPath, script, target], {
      env: { ...process.env, DATABASE_PATH: databasePath },
      stdout: "ignore", stderr: "pipe",
    });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(error.trim() || `Backup process exited ${code}`);
    logger.info(`Verified automatic backup: ${target}`);
    // Only rotate our own complete snapshots, and only after a successful backup.
    const files = readdirSync(config.directory).filter(name => AUTO_BACKUP.test(name)).sort().reverse();
    for (const name of files.slice(config.keep)) unlinkSync(join(config.directory, name));
  }
}
