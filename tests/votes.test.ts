import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { request, vote } from "../src/db/schema";
import { setup, signedIn, submitRequest } from "./helpers";

const count = (ctx: ReturnType<typeof setup>, id: number) => ctx.deps.db.select().from(request).where(eq(request.id, id)).get()!.voteCount;

describe("votes", () => {
  test("toggle on and off, with an htmx partial", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const id = await submitRequest(alice.browser);
    await alice.browser.get("/");

    const on = await alice.browser.post(`/requests/${id}/vote`, { value: "1", next: "/" }, { htmx: true });
    const html = await on.text();
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("<span>1</span>");
    expect(html).not.toContain("<html");
    expect(count(ctx, id)).toBe(1);

    const off = await alice.browser.post(`/requests/${id}/vote`, { value: "0", next: "/" }, { htmx: true });
    expect(await off.text()).toContain('aria-pressed="false"');
    expect(count(ctx, id)).toBe(0);

    // Without htmx: plain form post and redirect back.
    const plain = await alice.browser.post(`/requests/${id}/vote`, { next: "/?sort=votes" });
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe("/?sort=votes");
    expect(count(ctx, id)).toBe(1);
  });

  test("repeated and concurrent submissions count once per user", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const bob = await signedIn(ctx);
    const id = await submitRequest(alice.browser);
    await alice.browser.get("/");
    await bob.browser.get("/");

    await Promise.all(Array.from({ length: 10 }, () => alice.browser.post(`/requests/${id}/vote`, { value: "1" }, { htmx: true })));
    await Promise.all(Array.from({ length: 5 }, () => bob.browser.post(`/requests/${id}/vote`, { value: "1" }, { htmx: true })));
    expect(count(ctx, id)).toBe(2);
    expect(ctx.deps.db.select().from(vote).where(eq(vote.requestId, id)).all().length).toBe(2);
  });

  test("the database enforces one vote per user and request", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const id = await submitRequest(alice.browser);
    ctx.deps.db.insert(vote).values({ requestId: id, userId: alice.id }).run();
    expect(() => ctx.deps.db.insert(vote).values({ requestId: id, userId: alice.id }).run()).toThrow(/UNIQUE/);
  });

  test("viewer's own votes are reflected in the list", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const a = await submitRequest(alice.browser, "First idea");
    await submitRequest(alice.browser, "Second idea");
    await alice.browser.get("/");
    await alice.browser.post(`/requests/${a}/vote`, { value: "1" });
    const html = await (await alice.browser.get("/")).text();
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
  });

  test("votes are rate limited per user", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const id = await submitRequest(alice.browser);
    await alice.browser.get("/");
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await alice.browser.post(`/requests/${id}/vote`, {}, { htmx: true })).status;
    expect(last).toBe(429);
  });
});

describe("listing and search", () => {
  test("filters by status, sorts, searches and paginates", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const bob = await signedIn(ctx);
    const maya = await signedIn(ctx, "maintainer");
    const ids: number[] = [];
    // Bypass the per-user submission limit by inserting directly.
    for (let i = 0; i < 27; i++) {
      ids.push(
        ctx.deps.db
          .insert(request)
          .values({ title: `Idea number ${i}`, body: "Generic", bodyHtml: "<p>Generic</p>", authorId: alice.id, createdAt: new Date(Date.now() - (30 - i) * 1000) })
          .returning({ id: request.id })
          .get().id,
      );
    }
    const darkId = await submitRequest(alice.browser, "Dark theme for boards", "Night owls need a darker palette");
    await bob.browser.get("/");
    await bob.browser.post(`/requests/${ids[3]}/vote`, { value: "1" });
    await maya.browser.get("/");
    await maya.browser.post(`/requests/${ids[3]}/vote`, { value: "1" });
    await maya.browser.post(`/requests/${ids[5]}/status`, { status: "released" });

    const anon = ctx.browser();
    const newest = await (await anon.get("/")).text();
    expect(newest.indexOf("Dark theme for boards")).toBeLessThan(newest.indexOf("Idea number 26"));
    expect(newest).toContain("Next →");
    expect(newest).not.toContain("Idea number 0<");

    const page2 = await (await anon.get("/?page=2")).text();
    expect(page2).toContain("Idea number 0<");

    const votes = await (await anon.get("/?sort=votes")).text();
    expect(votes.indexOf("Idea number 3<")).toBeLessThan(votes.indexOf("Dark theme"));

    const released = await (await anon.get("/?status=released")).text();
    expect(released).toContain("Idea number 5<");
    expect(released).not.toContain("Idea number 6<");

    const activity = await (await anon.get("/?sort=activity")).text();
    expect(activity.indexOf("Idea number 5<")).toBeLessThan(activity.indexOf("Idea number 26<"));

    const search = await (await anon.get("/?q=darker+pal")).text();
    expect(search).toContain(`href="/requests/${darkId}"`);
    expect(search).not.toContain("Idea number");
    expect(search).toContain("Best match");

    expect(await (await anon.get("/?q=%22unbalanced+(*")).text()).toContain("No matching requests.");
    expect(await (await anon.get("/?q=%21%21%21")).text()).toContain("No matching requests.");

    const partial = await anon.get("/?q=dark", { htmx: true, headers: { "hx-target": "results" } });
    const partialHtml = await partial.text();
    expect(partialHtml).toStartWith('<div id="results">');
    expect(partialHtml).toContain('hx-swap-oob="true"');
  });

  test("anonymous pages are briefly cacheable; signed-in pages are private", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    expect((await ctx.browser().get("/")).headers.get("cache-control")).toContain("public");
    expect((await alice.browser.get("/")).headers.get("cache-control")).toBe("private, no-store");
  });

  test("comments paginate", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const id = await submitRequest(alice.browser);
    const insert = ctx.deps.sqlite.query("insert into comment (request_id, author_id, body, body_html) values (?, ?, ?, ?)");
    for (let i = 0; i < 60; i++) insert.run(id, alice.id, `c${i}`, `<p>Comment ${i}</p>`);
    const html = await (await ctx.browser().get(`/requests/${id}`)).text();
    expect(html).toContain("Comment 49<");
    expect(html).not.toContain("Comment 50<");
    const lastShown = Number(html.match(/after=(\d+)/)![1]);
    const more = await (await ctx.browser().get(`/requests/${id}/comments?after=${lastShown}`, { htmx: true })).text();
    expect(more).toContain("Comment 50<");
    expect(more).toContain("Comment 59<");
    expect(more).not.toContain("Show more");
  });

  test("htmx comment post returns the comment, a fresh form and the new count", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const id = await submitRequest(alice.browser);
    await alice.browser.get(`/requests/${id}`);
    const res = await alice.browser.post(`/requests/${id}/comments`, { body: "Looks **great**" }, { htmx: true });
    const html = await res.text();
    expect(html).toContain("<strong>great</strong>");
    expect(html).toContain('id="comment-form"');
    expect(html).toMatch(/id="comment-count"[^>]*hx-swap-oob="true"[^>]*>1</);

    const invalid = await alice.browser.post(`/requests/${id}/comments`, { body: "   " }, { htmx: true });
    expect(invalid.headers.get("hx-retarget")).toBe("#comment-form");
    expect(await invalid.text()).toContain("Write a comment first.");
  });
});
