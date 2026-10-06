import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { request } from "../src/db/schema";
import { ORIGIN, setup, signedIn, submitRequest } from "./helpers";

describe("RSS feed", () => {
  test("lists public requests with stable ids and safe descriptions", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    const maya = await signedIn(ctx, "maintainer");
    const visible = await submitRequest(alice.browser, "Tags & <filters>", "Use **bold** and <script>alert('x')</script> here");
    const hidden = await submitRequest(alice.browser, "Secret spam", "spam");
    await maya.browser.get("/");
    await maya.browser.post(`/requests/${hidden}/hide`, { hidden: "1" });

    const res = await ctx.browser().get("/feed.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    const xml = await res.text();
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"');
    expect(xml).toContain("<title>Tags &amp; &lt;filters&gt;</title>");
    expect(xml).toContain(`<guid isPermaLink="true">${ORIGIN}/requests/${visible}</guid>`);
    expect(xml).toContain(`<link>${ORIGIN}/requests/${visible}</link>`);
    expect(xml).toMatch(/<pubDate>\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/);
    expect(xml).toContain("<description>Use bold and here</description>");
    expect(xml).not.toContain("<script");
    expect(xml).not.toContain("Secret spam");
    expect(xml).not.toContain(alice.email);
    expect(xml).not.toContain("@example.test");
    expect(xml).toContain(`<atom:link href="${ORIGIN}/feed.xml" rel="self"`);
  });

  test("supports conditional requests", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    await submitRequest(alice.browser, "First");
    const first = await ctx.browser().get("/feed.xml");
    const etag = first.headers.get("etag")!;
    const lastModified = first.headers.get("last-modified")!;
    expect(etag).toMatch(/^"\w+"$/);
    expect(new Date(lastModified).toString()).not.toBe("Invalid Date");

    const byEtag = await ctx.browser().get("/feed.xml", { headers: { "if-none-match": etag } });
    expect(byEtag.status).toBe(304);
    expect(await byEtag.text()).toBe("");
    const byDate = await ctx.browser().get("/feed.xml", { headers: { "if-modified-since": lastModified } });
    expect(byDate.status).toBe(304);

    // Hiding a request changes both validators.
    const id = ctx.deps.db.select({ id: request.id }).from(request).get()!.id;
    ctx.deps.db.update(request).set({ hidden: true, updatedAt: new Date(Date.now() + 2000) }).where(eq(request.id, id)).run();
    expect((await ctx.browser().get("/feed.xml", { headers: { "if-none-match": etag } })).status).toBe(200);
    expect((await ctx.browser().get("/feed.xml", { headers: { "if-modified-since": lastModified } })).status).toBe(200);
  });

  test("pages advertise the feed", async () => {
    const ctx = setup();
    const html = await (await ctx.browser().get("/")).text();
    expect(html).toContain('<link rel="alternate" type="application/rss+xml" title="Kaneo Feature Track" href="/feed.xml"/>');
    expect(html).toContain('<a href="/feed.xml"');
  });
});
