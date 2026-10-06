import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const production = {
  NODE_ENV: "production", APP_URL: "https://feedback.example.test",
  BETTER_AUTH_SECRET: "production-test-secret-0123456789012345",
  SMTP_HOST: "smtp.example.test", MAIL_FROM: "Tracker <no-reply@example.test>",
};

describe("production configuration", () => {
  test("requires SMTP and a sender instead of silently disabling verification emails", () => {
    expect(() => loadConfig({ ...production, SMTP_HOST: "" })).toThrow("SMTP_HOST is required");
    expect(() => loadConfig({ ...production, MAIL_FROM: "" })).toThrow("MAIL_FROM is required");
    for (const transport of ["dev", "disabled", "smtpp"]) {
      expect(() => loadConfig({ ...production, MAIL_TRANSPORT: transport })).toThrow("Production requires MAIL_TRANSPORT=smtp");
    }
    expect(loadConfig(production).mail.transport).toBe("smtp");
  });

  test("validates credentials, port and TLS while allowing unauthenticated relays", () => {
    expect(() => loadConfig({ ...production, SMTP_USER: "user" })).toThrow("Set SMTP_USER and SMTP_PASS together");
    expect(() => loadConfig({ ...production, SMTP_PASS: "secret" })).toThrow("Set SMTP_USER and SMTP_PASS together");
    for (const port of ["0", "65536", "abc", "1.5"]) expect(() => loadConfig({ ...production, SMTP_PORT: port })).toThrow("SMTP_PORT");
    expect(() => loadConfig({ ...production, SMTP_SECURE: "yes" })).toThrow("SMTP_SECURE");
    const mail = loadConfig({ ...production, SMTP_PORT: "465", SMTP_SECURE: "" }).mail;
    expect(mail.transport === "smtp" && mail.smtp.secure).toBe(true);
    expect(loadConfig({ ...production, SMTP_USER: "user", SMTP_PASS: "secret" }).mail.transport).toBe("smtp");
  });

  test("the production start command sets NODE_ENV explicitly", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(pkg.scripts.start).toStartWith("NODE_ENV=production ");
    const example = await Bun.file(new URL("../.env.example", import.meta.url)).text();
    expect(example).toContain("\nMAIL_TRANSPORT=\n");
  });

  test("automatic backups default to daily snapshots beside the database with seven retained", () => {
    expect(loadConfig({ ...production, DATABASE_PATH: "/data/tracker.db" }).backups).toEqual({ directory: "/data/backups", intervalMs: 86_400_000, keep: 7 });
    expect(loadConfig({ ...production, BACKUP_ENABLED: "false" }).backups).toBeNull();
    expect(loadConfig({ NODE_ENV: "development" }).backups).toBeNull();
    expect(() => loadConfig({ ...production, BACKUP_KEEP: "0" })).toThrow("BACKUP_KEEP");
    expect(() => loadConfig({ ...production, BACKUP_INTERVAL_HOURS: "NaN" })).toThrow("BACKUP_INTERVAL_HOURS");
    expect(() => loadConfig({ ...production, DATABASE_PATH: ":memory:" })).toThrow("file-backed database");
  });
});
