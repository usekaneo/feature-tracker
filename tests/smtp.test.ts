import { expect, test } from "bun:test";
import { createMailer } from "../src/lib/mailer";
import { silentLogger } from "../src/lib/logger";
import { setup, PASSWORD } from "./helpers";
import { startFakeSmtp } from "./fake-smtp";

test("SMTP verification connects and auth emails reach an actual SMTP transport", async () => {
  const smtp = startFakeSmtp();
  const ctx = setup({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_SECURE: "false", MAIL_FROM: "Tracker <tracker@example.test>" });
  try {
    await ctx.deps.mailer.verify!();
    const b = ctx.browser();
    const res = await b.post("/register", { name: "Ada", email: "ada@example.test", password: PASSWORD });
    expect(res.status).toBe(200);
    await waitForMail(1);
    expect(smtp.messages[0]!.to).toBe("ada@example.test");
    expect(smtp.messages[0]!.content).toContain("Subject: Verify your email");
    // Decode quoted-printable so the verification URL can be followed.
    const mail = smtp.messages[0]!.content.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const url = mail.match(/http:\/\/localhost:3000\/api\/auth\/verify-email\?[^\s]+/)![0];
    const verified = await b.get(url);
    expect(verified.status).toBe(302);
    expect(b.signedIn).toBe(true);
    await ctx.browser().post("/forgot-password", { email: "ada@example.test" });
    await waitForMail(2);
    expect(smtp.messages[1]!.content).toContain("Subject: Reset your password");
  } finally { smtp.stop(); ctx.deps.sqlite.close(); }

  async function waitForMail(count: number) {
    const deadline = Date.now() + 3000;
    while (smtp.messages.length < count && Date.now() < deadline) await Bun.sleep(10);
    expect(smtp.messages).toHaveLength(count);
  }
});

test("SMTP verification fails when the configured server cannot be reached", async () => {
  const smtp = startFakeSmtp();
  const port = smtp.port;
  smtp.stop();
  const mailer = createMailer({ transport: "smtp", from: "tracker@example.test", smtp: { host: "127.0.0.1", port, secure: false } }, silentLogger);
  await expect(mailer.verify!()).rejects.toThrow();
});
