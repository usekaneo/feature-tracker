import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb, runMigrations } from "../src/db/client";
import { comment, request, user } from "../src/db/schema";
import { createUser, setup, signedIn, submitRequest } from "./helpers";

describe("anonymous visitors", () => {
  test("can read but writes redirect to sign-in", async () => {
    const ctx = setup();
    const author = await signedIn(ctx);
    const id = await submitRequest(author.browser);
    const anon = ctx.browser();

    expect((await anon.get("/")).status).toBe(200);
    expect((await anon.get(`/requests/${id}`)).status).toBe(200);
    const newPage = await anon.get("/requests/new");
    expect(newPage.status).toBe(303);
    expect(newPage.headers.get("location")).toBe("/login?next=%2Frequests%2Fnew");

    for (const path of ["/requests", `/requests/${id}/vote`, `/requests/${id}/comments`, `/requests/${id}/status`]) {
      const res = await anon.post(path, { title: "x", body: "y", status: "accepted" });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toStartWith("/login");
    }
    const htmx = await anon.post(`/requests/${id}/vote`, {}, { htmx: true });
    expect(htmx.status).toBe(401);
    expect(htmx.headers.get("hx-redirect")).toStartWith("/login");
  });
});

describe("authors", () => {
  test("submit, edit their own request, and cannot edit others'", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const bob = await signedIn(ctx);
    const id = await submitRequest(alice.browser, "Recurring tasks", "Weekly please");

    await alice.browser.get(`/requests/${id}/edit`);
    const edit = await alice.browser.post(`/requests/${id}/edit`, { title: "Recurring tasks v2", body: "Weekly and monthly" });
    expect(edit.status).toBe(303);
    const page = await (await alice.browser.get(`/requests/${id}`)).text();
    expect(page).toContain("Recurring tasks v2");
    expect(page).toContain("edited");

    expect((await bob.browser.get(`/requests/${id}/edit`)).status).toBe(403);
    await bob.browser.get("/");
    expect((await bob.browser.post(`/requests/${id}/edit`, { title: "Hijacked", body: "x" })).status).toBe(403);
    expect(ctx.deps.db.select().from(request).where(eq(request.id, id)).get()!.title).toBe("Recurring tasks v2");
  });

  test("validation keeps input and explains the problem", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    await alice.browser.get("/requests/new");
    const res = await alice.browser.post("/requests", { title: "ab", body: "" });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("Title is too short.");
    expect(html).toContain("Add a description.");
  });

  test("edit their own comments only", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const bob = await signedIn(ctx);
    const id = await submitRequest(alice.browser);
    await bob.browser.get(`/requests/${id}`);
    const posted = await bob.browser.post(`/requests/${id}/comments`, { body: "First!" });
    expect(posted.status).toBe(303);
    const commentId = Number(posted.headers.get("location")!.split("#comment-")[1]);

    expect((await alice.browser.get(`/comments/${commentId}/edit`)).status).toBe(403);
    expect((await alice.browser.post(`/comments/${commentId}`, { body: "Edited by Alice" })).status).toBe(403);

    const form = await bob.browser.get(`/comments/${commentId}/edit`, { htmx: true });
    expect(await form.text()).toContain("First!");
    const saved = await bob.browser.post(`/comments/${commentId}`, { body: "First, edited" }, { htmx: true });
    expect(await saved.text()).toContain("First, edited");
    expect(ctx.deps.db.select().from(comment).where(eq(comment.id, commentId)).get()!.editedAt).not.toBeNull();
  });

  test("markdown is sanitized", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const id = await submitRequest(alice.browser, "XSS attempt", `<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n<img src=x onerror=alert(1)>`);
    const res = await ctx.browser().get(`/requests/${id}`);
    const html = await res.text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onerror");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
  });
});

describe("limits", () => {
  test("oversized bodies are rejected", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    await alice.browser.get("/requests/new");
    const res = await alice.browser.post("/requests", { title: "Huge", body: "x".repeat(200_000) });
    expect(res.status).toBe(413);
  });

  test("request submissions are rate limited per user", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    for (let i = 0; i < 5; i++) await submitRequest(alice.browser, `Idea ${i}`);
    const res = await alice.browser.post("/requests", { title: "One too many", body: "x" });
    expect(res.status).toBe(429);
  });
});

describe("CSRF", () => {
  test("signed-in writes need the session token and a same-origin request", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const noToken = await alice.browser.post("/requests", { title: "No token", body: "x" }, { csrf: false });
    expect(noToken.status).toBe(403);
    const wrongToken = await alice.browser.request("/requests", { method: "POST", form: { _csrf: "x".repeat(32), title: "Bad", body: "x" } });
    expect(wrongToken.status).toBe(403);
    const crossSite = await alice.browser.request("/requests", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      form: { _csrf: alice.browser.csrf()!, title: "Cross", body: "x" },
    });
    expect(crossSite.status).toBe(403);
    expect(ctx.deps.db.select().from(request).all().length).toBe(0);
    // Header form used by htmx.
    const viaHeader = await alice.browser.request("/requests", {
      method: "POST",
      headers: { "x-csrf-token": alice.browser.csrf()! },
      form: { title: "Header token", body: "x" },
    });
    expect(viaHeader.status).toBe(303);
  });
});

describe("maintainers", () => {
  test("only maintainers change status, labels, lock and hide", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const id = await submitRequest(alice.browser);
    await alice.browser.get(`/requests/${id}`);
    for (const [path, form] of [
      [`/requests/${id}/status`, { status: "accepted" }],
      [`/requests/${id}/labels`, { label: "1" }],
      [`/requests/${id}/lock`, { locked: "1" }],
      [`/requests/${id}/hide`, { hidden: "1" }],
      [`/requests/${id}/github/retry`, {}],
      [`/requests/${id}/github/link`, { issue: "1" }],
      [`/requests/${id}/github/check`, {}],
      ["/labels", { name: "API" }],
    ] as const) {
      expect((await alice.browser.post(path, form)).status).toBe(403);
    }
    expect((await alice.browser.get("/labels")).status).toBe(403);
    const row = ctx.deps.db.select().from(request).where(eq(request.id, id)).get()!;
    expect(row.status).toBe("open");
    expect(row.locked).toBe(false);
    expect(row.hidden).toBe(false);
  });

  test("status changes are recorded with actor and shown as history", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const maya = await signedIn(ctx, "maintainer");
    const id = await submitRequest(alice.browser);
    await maya.browser.get(`/requests/${id}`);
    await maya.browser.post(`/requests/${id}/status`, { status: "declined" });
    await maya.browser.post(`/requests/${id}/status`, { status: "open" });
    const html = await (await ctx.browser().get(`/requests/${id}`)).text();
    expect(html).toContain('aria-label="Status history"');
    expect(html).toMatch(/Declined · User \d+/);
    const history = ctx.deps.sqlite.query("select from_status, to_status, actor_id from status_change where request_id = ? order by id").all(id);
    expect(history).toEqual([
      { from_status: "open", to_status: "declined", actor_id: maya.id },
      { from_status: "declined", to_status: "open", actor_id: maya.id },
    ]);
  });

  test("labels can be created and assigned", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const maya = await signedIn(ctx, "maintainer");
    const id = await submitRequest(alice.browser);
    await maya.browser.get("/labels");
    expect((await maya.browser.post("/labels", { name: "Integrations" })).status).toBe(303);
    expect((await maya.browser.post("/labels", { name: "integrations" })).status).toBe(422);
    const labelId = (ctx.deps.sqlite.query("select id from label").get() as { id: number }).id;
    await maya.browser.post(`/requests/${id}/labels`, { label: [String(labelId), "9999"] });
    expect(await (await ctx.browser().get("/")).text()).toContain('<span class="chip">Integrations</span>');
  });

  test("hidden requests disappear for everyone but maintainers", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const maya = await signedIn(ctx, "maintainer");
    const id = await submitRequest(alice.browser, "Spammy request", "Buy things");
    await maya.browser.get(`/requests/${id}`);
    await maya.browser.post(`/requests/${id}/hide`, { hidden: "1" });

    expect((await ctx.browser().get(`/requests/${id}`)).status).toBe(404);
    expect((await alice.browser.get(`/requests/${id}`)).status).toBe(404);
    expect(await (await ctx.browser().get("/")).text()).not.toContain("Spammy request");
    expect(await (await ctx.browser().get("/?q=spammy")).text()).not.toContain("Spammy request");
    expect((await alice.browser.post(`/requests/${id}/comments`, { body: "hi" })).status).toBe(404);
    expect((await alice.browser.post(`/requests/${id}/vote`, { value: "1" })).status).toBe(404);
    const own = await maya.browser.get(`/requests/${id}`);
    expect(own.status).toBe(200);
    expect(await own.text()).toContain("hidden from the public");
  });

  test("locked discussions block new comments except from maintainers", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const maya = await signedIn(ctx, "maintainer");
    const id = await submitRequest(alice.browser);
    await maya.browser.get(`/requests/${id}`);
    await maya.browser.post(`/requests/${id}/lock`, { locked: "1" });

    const page = await (await alice.browser.get(`/requests/${id}`)).text();
    expect(page).toContain("Discussion is locked.");
    expect((await alice.browser.post(`/requests/${id}/comments`, { body: "Can I?" })).status).toBe(403);
    expect((await maya.browser.post(`/requests/${id}/comments`, { body: "Closing this out." })).status).toBe(303);
    expect(ctx.deps.db.select().from(comment).all().map((c) => c.body)).toEqual(["Closing this out."]);
  });

  test("hidden comments are removed from public view and counts", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const maya = await signedIn(ctx, "maintainer");
    const id = await submitRequest(alice.browser);
    await alice.browser.get(`/requests/${id}`);
    const posted = await alice.browser.post(`/requests/${id}/comments`, { body: "Rude remark" });
    const commentId = Number(posted.headers.get("location")!.split("#comment-")[1]);
    await maya.browser.get(`/requests/${id}`);
    await maya.browser.post(`/comments/${commentId}/hide`, { hidden: "1" });

    expect(await (await ctx.browser().get(`/requests/${id}`)).text()).not.toContain("Rude remark");
    expect(ctx.deps.db.select().from(request).where(eq(request.id, id)).get()!.commentCount).toBe(0);
    expect((await alice.browser.get(`/comments/${commentId}/edit`)).status).toBe(404);
    expect(await (await maya.browser.get(`/requests/${id}`)).text()).toContain("Rude remark");
  });

  test("role changes take effect on the next request", async () => {
    const ctx = setup();
    const maya = await signedIn(ctx, "maintainer");
    expect((await maya.browser.get("/labels")).status).toBe(200);
    ctx.deps.db.update(user).set({ role: "user" }).where(eq(user.id, maya.id)).run();
    expect((await maya.browser.get("/labels")).status).toBe(403);
  });
});

describe("maintainer command", () => {
  test("grants only to existing verified accounts", async () => {
    const path = join(tmpdir(), `ft-maint-${crypto.randomUUID()}.db`);
    const { db, sqlite } = createDb(path);
    runMigrations(db);
    const deps = { db } as Parameters<typeof createUser>[0];
    await createUser(deps, { email: "lead@example.com" });
    await createUser(deps, { email: "pending@example.com", verified: false });
    sqlite.close();

    const run = (...args: string[]) =>
      Bun.spawnSync(["bun", "scripts/maintainer.ts", ...args], { env: { ...process.env, DATABASE_PATH: path, NODE_ENV: "test" } });

    expect(run("grant", "missing@example.com").exitCode).toBe(1);
    expect(run("grant", "pending@example.com").exitCode).toBe(1);
    const ok = run("grant", "Lead@Example.com");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain("is now a maintainer");
    expect(run("list").stdout.toString()).toContain("lead@example.com");
    expect(run("revoke", "lead@example.com").exitCode).toBe(0);
    expect(run("list").stdout.toString()).toContain("No maintainers.");
  });
});
