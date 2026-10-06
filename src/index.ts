import { createApp } from "./app";
import { isDevSecret, loadConfig } from "./config";
import { createDeps } from "./deps";
import { ScheduledBackups } from "./services/backups";

const config = loadConfig();
const deps = createDeps(config);
const { logger, sqlite, issues, changelog, labeler, notifier, mailer } = deps;
const backups = config.backups ? new ScheduledBackups({ databasePath: config.databasePath, config: config.backups, logger }) : null;

try {
  sqlite.query("select 1 from request limit 1").get();
} catch {
  logger.error(`Database at ${config.databasePath} is not migrated. Run: bun run db:migrate`);
  process.exit(1);
}

if (isDevSecret(config)) logger.warn("BETTER_AUTH_SECRET is not set; using an insecure development secret.");
if (!config.github) logger.warn("GitHub sign-in disabled: GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not set.");
if (config.mail.transport === "disabled") logger.warn("Email delivery disabled: SMTP_HOST not set. Verification and reset emails won't be sent.");
if (config.mail.transport === "dev") logger.warn(`Dev mail transport: emails are printed here and listed at ${config.appUrl}/dev/mail`);
if (!config.changelog) logger.warn("Changelog disabled: set CHANGELOG_REPO or GITHUB_REPO.");
if (!config.repo) logger.warn("GitHub issues disabled: GITHUB_REPO / GITHUB_TOKEN not set. Accepted requests stay pending.");

const app = createApp(deps);
if (config.env === "production") {
  try { await mailer.verify?.(); }
  catch (error) {
    logger.error("SMTP verification failed. Check the host, port, TLS and credentials before starting the app.", error);
    sqlite.close();
    process.exit(1);
  }
}
const server = Bun.serve({ port: config.port, fetch: app.fetch });
issues.start();
notifier.start();
labeler.start();
changelog.start();
backups?.start();
logger.info(`Kaneo Feature Track listening on ${server.url} (public URL ${config.appUrl})`);

async function shutdown() {
  issues.stop();
  notifier.stop();
  labeler.stop();
  changelog.stop();
  backups?.stop();
  await server.stop();
  // Let in-flight GitHub calls record their outcome; anything cut off is reconciled on next start.
  await Promise.race([Promise.all([issues.idle(), changelog.idle(), labeler.idle(), notifier.idle(), backups?.idle()]), Bun.sleep(25_000)]);
  sqlite.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
