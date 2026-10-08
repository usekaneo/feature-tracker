import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { account, session, user } from "../src/db/schema";
import { loggablePath } from "../src/lib/logger";
import { createUser, ORIGIN, PASSWORD, setup } from "./helpers";

const linkIn = (text: string) => text.match(/https?:\/\/\S+/)![0];

describe("email and password", () => {
  test("register → verify email → signed in; unverified sign-in is refused", async () => {
    const ctx = setup();
    const b = ctx.browser();

    const reg = await b.post("/register", { name: "Ada", email: "Ada@Example.com", password: PASSWORD, next: "/" });
    expect(reg.status).toBe(200);
    expect(await reg.text()).toContain("Check your email");
    const mail = ctx.deps.mailer.outbox()[0]!;
    expect(mail.to).toBe("ada@example.com");
    expect(mail.subject).toBe("Verify your email");
    expect(b.signedIn).toBe(false);

    // Sign-in before verification fails and re-sends the link.
    const early = await b.post("/login", { email: "ada@example.com", password: PASSWORD });
    expect(early.status).toBe(403);
    expect(await early.text()).toContain("Verify your email first");
    expect(ctx.deps.mailer.outbox().length).toBe(2);

    const verify = await b.get(linkIn(mail.text));
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toStartWith("/email-verified");
    expect(b.signedIn).toBe(true);
    const done = await b.get(verify.headers.get("location")!);
    expect(done.headers.get("location")).toBe("/");
    const home = await b.get("/");
    const html = await home.text();
    expect(html).toContain("Sign out");
    expect(html).not.toContain(">Login<");
    const row = ctx.deps.db.select().from(user).where(eq(user.email, "ada@example.com")).get()!;
    expect(row.emailVerified).toBe(true);
    expect(row.role).toBe("user");
  });

  test("first signup is not a maintainer and role cannot be set through the form", async () => {
    const ctx = setup();
    const b = ctx.browser();
    await b.post("/register", { name: "First", email: "first@example.com", password: PASSWORD, role: "maintainer" });
    const row = ctx.deps.db.select().from(user).where(eq(user.email, "first@example.com")).get()!;
    expect(row.role).toBe("user");
  });

  test("registering an existing email looks identical and creates nothing", async () => {
    const ctx = setup();
    await createUser(ctx.deps, { email: "taken@example.com" });
    const res = await ctx.browser().post("/register", { name: "X", email: "taken@example.com", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your email");
    expect(ctx.deps.db.select().from(user).where(eq(user.email, "taken@example.com")).all().length).toBe(1);
  });

  test("validation errors are short and specific", async () => {
    const ctx = setup();
    const b = ctx.browser();
    expect(await (await b.post("/register", { name: "A", email: "nope", password: PASSWORD })).text()).toContain("Enter a valid email.");
    expect(await (await b.post("/register", { name: "A", email: "a@b.co", password: "short" })).text()).toContain("at least 8 characters");
  });

  test("wrong password is rejected", async () => {
    const ctx = setup();
    const u = await createUser(ctx.deps);
    const res = await ctx.browser().post("/login", { email: u.email, password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Wrong email or password.");
  });

  test("password reset via emailed link revokes old sessions", async () => {
    const ctx = setup();
    const u = await createUser(ctx.deps);
    const old = ctx.browser();
    await old.login(u.email);

    const b = ctx.browser();
    const res = await b.post("/forgot-password", { email: u.email });
    expect(await res.text()).toContain("If an account exists");
    const mail = ctx.deps.mailer.outbox()[0]!;
    expect(mail.subject).toBe("Reset your password");

    const link = await b.get(linkIn(mail.text));
    expect(link.status).toBe(302);
    const target = link.headers.get("location")!;
    expect(target).toStartWith(`${ORIGIN}/reset-password?token=`);
    const token = new URL(target).searchParams.get("token")!;
    const page = await b.get(target);
    expect(page.headers.get("referrer-policy")).toBe("same-origin");

    const reset = await b.post("/reset-password", { token, password: "a brand new password" });
    expect(await reset.text()).toContain("Password updated");

    expect((await ctx.browser().post("/login", { email: u.email, password: PASSWORD })).status).toBe(401);
    await ctx.browser().login(u.email, "a brand new password");
    // The session created before the reset is gone.
    expect(await (await old.get("/")).text()).toContain(">Login<");

    // Tokens are single-use.
    const again = await b.post("/reset-password", { token, password: "another new password" });
    expect(again.status).toBe(400);
  });

  test("forgot password does not reveal unknown emails", async () => {
    const ctx = setup();
    const res = await ctx.browser().post("/forgot-password", { email: "nobody@example.com" });
    expect(await res.text()).toContain("If an account exists");
    expect(ctx.deps.mailer.outbox().length).toBe(0);
  });

  test("sign out requires the CSRF token and ends the session", async () => {
    const ctx = setup();
    const u = await createUser(ctx.deps);
    const b = ctx.browser();
    await b.login(u.email);
    expect((await b.post("/logout", {}, { csrf: false })).status).toBe(403);
    const out = await b.post("/logout");
    expect(out.status).toBe(303);
    expect(b.signedIn).toBe(false);
    expect(ctx.deps.db.select().from(session).where(eq(session.userId, u.id)).all().length).toBe(0);
  });

  test("sign-in attempts are rate limited per client", async () => {
    const ctx = setup();
    const b = ctx.browser();
    for (let i = 0; i < 10; i++) await b.post("/login", { email: "x@example.com", password: "nope-nope" });
    const res = await b.post("/login", { email: "x@example.com", password: "nope-nope" });
    expect(res.status).toBe(429);
    // Another client is unaffected.
    expect((await ctx.browser().post("/login", { email: "x@example.com", password: "nope-nope" })).status).toBe(401);
  });

  test("auth forms reject cross-site posts", async () => {
    const ctx = setup();
    const res = await ctx.browser().request("/login", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      form: { email: "a@b.co", password: "x" },
    });
    expect(res.status).toBe(403);
  });

  test("logs never include tokens", () => {
    expect(loggablePath("/api/auth/reset-password/abc123secret")).toBe("/api/auth/reset-password");
    expect(loggablePath("/api/auth/verify-email")).toBe("/api/auth/verify-email");
  });
});

describe("GitHub", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("hidden when not configured", async () => {
    const ctx = setup();
    const page = await (await ctx.browser().get("/login")).text();
    expect(page).not.toContain("Continue with GitHub");
    expect((await ctx.browser().post("/login/github", {})).headers.get("location")).toBe("/login");
  });

  test.each([["4242", "user"], ["44305048", "maintainer"], ["176929823", "maintainer"], ["127273550", "maintainer"]] as const)("OAuth identity %s gets role %s", async (githubId, expectedRole) => {
    const ctx = setup({ GITHUB_CLIENT_ID: "gh-client", GITHUB_CLIENT_SECRET: "gh-secret", MAINTAINER_GITHUB_IDS: "44305048,176929823,127273550" });
    const b = ctx.browser();
    expect(await (await b.get("/login")).text()).toContain("Continue with GitHub");

    const start = await b.post("/login/github", { next: "/requests/new" });
    expect(start.status).toBe(303);
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("gh-client");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/github`);
    const state = authorize.searchParams.get("state")!;
    expect(state).toBeTruthy();

    // Simulate GitHub's token and user endpoints.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return Response.json({ access_token: "gho_test", token_type: "bearer", scope: "read:user,user:email" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: Number(githubId), login: "octo", name: "Octo Cat", email: null, avatar_url: "https://avatars.example/octo" });
      }
      if (url === "https://api.github.com/user/emails") {
        return Response.json([{ email: "octo@example.com", primary: true, verified: true, visibility: "private" }]);
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const callback = await b.get(`/api/auth/callback/github?code=abc&state=${encodeURIComponent(state)}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/requests/new");
    expect(b.signedIn).toBe(true);

    const row = ctx.deps.db.select().from(user).where(eq(user.email, "octo@example.com")).get()!;
    expect(row.name).toBe("Octo Cat");
    expect(row.emailVerified).toBe(true);
    expect(row.role).toBe(expectedRole);
    const linked = ctx.deps.db.select().from(account).where(eq(account.userId, row.id)).get()!;
    expect(linked.providerId).toBe("github");
    expect(await (await b.get("/requests/new")).text()).toContain("New request");
  });

  test("callback with a forged state is rejected", async () => {
    const ctx = setup({ GITHUB_CLIENT_ID: "gh-client", GITHUB_CLIENT_SECRET: "gh-secret" });
    const b = ctx.browser();
    const res = await b.get("/api/auth/callback/github?code=abc&state=forged");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error");
    expect(b.signedIn).toBe(false);
  });
});
