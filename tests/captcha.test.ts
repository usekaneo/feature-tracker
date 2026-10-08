import { expect, test } from "bun:test";
import { verifyCaptcha } from "../src/lib/captcha";
import { PASSWORD, setup } from "./helpers";
const env = { CAP_SERVER_URL: "http://cap.internal", CAP_SITE_KEY: "abc1234567", CAP_SECRET_KEY: "private-test-key" };
const cap = { serverUrl: env.CAP_SERVER_URL, siteKey: env.CAP_SITE_KEY, secretKey: env.CAP_SECRET_KEY };
test("missing proofs block forms and direct auth API without sending email", async () => {
  const ctx = setup(env);
  const b = ctx.browser();
  expect(await (await b.get("/register")).text()).toContain("cap-widget");
  const form = await b.post("/register", { name: "Tester", email: "test@example.com", password: PASSWORD });
  expect(form.status).toBe(400);
  expect(await form.text()).toContain("Complete the bot check");
  for (const path of ["sign-up/email", "sign-in/email", "request-password-reset", "send-verification-email"]) {
    const res = await b.request(`/api/auth/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Tester", email: "test@example.com", password: PASSWORD }) });
    expect(res.status).toBe(403);
  }
  expect(ctx.deps.mailer.outbox()).toHaveLength(0);
  expect((await b.post("/forgot-password", { email: "test@example.com" })).status).toBe(403);
  expect((await b.post("/captcha/siteverify", {})).status).toBe(404);
  expect((await b.get("/captcha/server/keys")).status).toBe(404);
}, 20000);
test("a consumed proof cannot be replayed for another account", async () => {
  let consumed = false;
  const ctx = setup(env, { captchaFetch: async (_, init) => {
    expect(JSON.parse(String(init.body)).secret).toBe(cap.secretKey);
    const success = !consumed; consumed = true; return Response.json({ success });
  } });
  const b = ctx.browser();
  const fields = { name: "Tester", email: "test@example.com", password: PASSWORD, "cap-token": "abc1234567:proof:token" };
  expect((await b.post("/register", fields)).status).toBe(200);
  expect((await b.post("/register", { ...fields, email: "another@example.com" })).status).toBe(400);
  expect(ctx.deps.mailer.outbox()).toHaveLength(1);
});
test("verification errors fail closed", async () => {
  for (const fetcher of [async () => { throw new Error("unavailable"); }, async () => new Response("oops"), async () => Response.json({ success: "true" }), async () => Response.json({ success: true }, { status: 500 })]) {
    expect(await verifyCaptcha(cap, "abc1234567:a:b", fetcher)).toBe(false);
  }
  expect(await verifyCaptcha(cap, "wrong:a:b", async () => { throw new Error("must not fetch"); })).toBe(false);
});
