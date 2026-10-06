import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { comment, moderationLog, report, request } from "../src/db/schema";
import { getUserRow, setup, signedIn, submitRequest } from "./helpers";

async function postComment(b: Awaited<ReturnType<typeof signedIn>>["browser"], requestId: number, body = "Buy cheap watches") {
  await b.get(`/requests/${requestId}`);
  const res = await b.post(`/requests/${requestId}/comments`, { body });
  expect(res.status).toBe(303);
  return Number(res.headers.get("location")!.split("#comment-")[1]);
}

async function fileReport(b: Awaited<ReturnType<typeof signedIn>>["browser"], path: string, form: Record<string, string> = { reason: "spam" }) {
  await b.get(path);
  return b.post(path, form);
}

describe("reports", () => {
  test("users report requests and comments; the queue groups them and hiding resolves them", async () => {
    const ctx = setup();
    const author = await signedIn(ctx);
    const alice = await signedIn(ctx);
    const bob = await signedIn(ctx);
    const mod = await signedIn(ctx, "maintainer");
    const id = await submitRequest(author.browser, "Spammy request", "Visit my shop");
    const commentId = await postComment(author.browser, id);

    expect((await alice.browser.get(`/requests/${id}`)).status).toBe(200);
    expect(alice.browser.lastHtml).toContain(`/requests/${id}/report`);
    expect(alice.browser.lastHtml).toContain(`/comments/${commentId}/report`);

    const sent = await fileReport(alice.browser, `/requests/${id}/report`, { reason: "spam", note: "Advertising" });
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain("Report sent");
    expect((await fileReport(bob.browser, `/requests/${id}/report`, { reason: "off_topic" })).status).toBe(200);
    expect((await fileReport(alice.browser, `/comments/${commentId}/report`, { reason: "abuse" })).status).toBe(200);

    await mod.browser.get("/");
    expect(mod.browser.lastHtml).toContain("Moderation");
    const queue = await (await mod.browser.get("/moderation")).text();
    expect(queue).toContain("Spammy request");
    expect(queue).toContain("Advertising");
    expect(queue).toContain("Off-topic");
    expect(queue).toContain("Harassment or abuse");

    const dismiss = await mod.browser.post("/moderation/reports/dismiss", { requestId: String(id), commentId: String(commentId) });
    expect(dismiss.status).toBe(303);
    expect(ctx.deps.db.select().from(report).where(eq(report.commentId, commentId)).get()!.state).toBe("dismissed");
    expect(await (await mod.browser.get("/moderation")).text()).not.toContain("Harassment or abuse");

    // Reported again, then the whole request is hidden: that settles reports on its comments too.
    await fileReport(alice.browser, `/comments/${commentId}/report`, { reason: "abuse" });
    await mod.browser.get("/moderation");
    const hide = await mod.browser.post("/moderation/reports/hide", { requestId: String(id) });
    expect(hide.status).toBe(303);
    expect(ctx.deps.db.select().from(request).where(eq(request.id, id)).get()!.hidden).toBe(true);
    expect(ctx.deps.db.select({ state: report.state }).from(report).all().every((r) => r.state === "resolved")).toBe(true);
    expect(await (await mod.browser.get("/moderation")).text()).toContain("Nothing to review.");

    const actions = ctx.deps.db.select({ action: moderationLog.action, actorId: moderationLog.actorId }).from(moderationLog).all();
    expect(actions.map((a) => a.action)).toEqual(["dismiss_reports", "hide_request"]);
    expect(actions.every((a) => a.actorId === mod.id)).toBe(true);
  });

  test("reporting again reopens the same report instead of adding one", async () => {
    const ctx = setup();
    const author = await signedIn(ctx);
    const alice = await signedIn(ctx);
    const mod = await signedIn(ctx, "maintainer");
    const id = await submitRequest(author.browser);

    await fileReport(alice.browser, `/requests/${id}/report`);
    await mod.browser.get("/moderation");
    await mod.browser.post("/moderation/reports/dismiss", { requestId: String(id) });
    await fileReport(alice.browser, `/requests/${id}/report`, { reason: "other", note: "Still bad" });

    const rows = ctx.deps.db.select().from(report).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "open", reason: "other", note: "Still bad", resolvedBy: null });
  });

  test("validation, own content, hidden content and anonymous visitors", async () => {
    const ctx = setup();
    const author = await signedIn(ctx);
    const alice = await signedIn(ctx);
    const mod = await signedIn(ctx, "maintainer");
    const id = await submitRequest(author.browser);

    const invalid = await fileReport(alice.browser, `/requests/${id}/report`, { reason: "nonsense", note: "x" });
    expect(invalid.status).toBe(422);
    expect(await invalid.text()).toContain("Choose a reason.");
    const long = await fileReport(alice.browser, `/requests/${id}/report`, { reason: "spam", note: "x".repeat(501) });
    expect(long.status).toBe(422);

    expect((await author.browser.get(`/requests/${id}/report`)).status).toBe(403);
    expect(author.browser.lastHtml).not.toContain(`/requests/${id}/report"`);

    await mod.browser.get(`/requests/${id}`);
    await mod.browser.post(`/requests/${id}/hide`, { hidden: "1" });
    expect((await alice.browser.get(`/requests/${id}/report`)).status).toBe(404);

    const anon = ctx.browser();
    const res = await anon.get(`/requests/${id}/report`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toStartWith("/login");
    expect(ctx.deps.db.select().from(report).all()).toHaveLength(0);
  });

  test("hiding from the queue checks that the comment belongs to the request", async () => {
    const ctx = setup();
    const author = await signedIn(ctx);
    const mod = await signedIn(ctx, "maintainer");
    const a = await submitRequest(author.browser, "First");
    const b = await submitRequest(author.browser, "Second");
    const commentId = await postComment(author.browser, a);

    await mod.browser.get("/moderation");
    expect((await mod.browser.post("/moderation/reports/hide", { requestId: String(b), commentId: String(commentId) })).status).toBe(404);
    expect(ctx.deps.db.select().from(comment).where(eq(comment.id, commentId)).get()!.hidden).toBe(false);
  });

  test("only maintainers see the queue", async () => {
    const ctx = setup();
    const alice = await signedIn(ctx);
    expect((await alice.browser.get("/moderation")).status).toBe(403);
    await alice.browser.get("/");
    expect((await alice.browser.post("/moderation/reports/dismiss", { requestId: "1" })).status).toBe(403);
    expect((await alice.browser.post(`/moderation/users/${alice.id}/ban`, {})).status).toBe(403);
  });
});

describe("suspensions", () => {
  test("suspended users can read but not post, edit, vote or report; lifting restores access", async () => {
    const ctx = setup();
    const troll = await signedIn(ctx);
    const other = await signedIn(ctx);
    const mod = await signedIn(ctx, "maintainer");
    const own = await submitRequest(troll.browser, "Troll request");
    const target = await submitRequest(other.browser, "Good request");

    await mod.browser.get(`/moderation/users/${troll.id}`);
    expect(mod.browser.lastHtml).toContain("Suspend account");
    const ban = await mod.browser.post(`/moderation/users/${troll.id}/ban`, { reason: "Repeated spam" });
    expect(ban.status).toBe(303);
    expect(getUserRow(ctx.deps, troll.id)!.bannedAt).not.toBeNull();

    const page = await troll.browser.get(`/requests/${target}`);
    expect(page.status).toBe(200);
    expect(troll.browser.lastHtml).toContain("Your account is suspended.");
    expect(troll.browser.lastHtml).not.toContain(`/requests/${target}/report`);

    expect((await troll.browser.post(`/requests/${target}/comments`, { body: "hi" })).status).toBe(403);
    expect((await troll.browser.post(`/requests/${target}/vote`, { value: "1" })).status).toBe(403);
    expect((await troll.browser.post("/requests", { title: "Another", body: "Spam" })).status).toBe(403);
    expect((await troll.browser.post(`/requests/${own}/edit`, { title: "Edited", body: "x" })).status).toBe(403);
    expect((await troll.browser.post(`/requests/${target}/report`, { reason: "spam" })).status).toBe(403);
    expect((await troll.browser.get("/requests/new")).status).toBe(403);
    // Not part of the content guard: signing out still works.
    await troll.browser.get("/");
    expect((await troll.browser.post("/logout")).status).toBe(303);
    await troll.browser.login(getUserRow(ctx.deps, troll.id)!.email);

    const queue = await (await mod.browser.get("/moderation")).text();
    expect(queue).toContain("Repeated spam");

    await mod.browser.post(`/moderation/users/${troll.id}/unban`);
    expect(getUserRow(ctx.deps, troll.id)!.bannedAt).toBeNull();
    await troll.browser.get(`/requests/${target}`);
    expect((await troll.browser.post(`/requests/${target}/comments`, { body: "Sorry" })).status).toBe(303);

    const actions = ctx.deps.db.select({ action: moderationLog.action, note: moderationLog.note }).from(moderationLog).all();
    expect(actions).toEqual([
      { action: "ban_user", note: "Repeated spam" },
      { action: "unban_user", note: null },
    ]);
  });

  test("suspending with hideContent hides everything the user posted and resolves reports about it", async () => {
    const ctx = setup();
    const troll = await signedIn(ctx);
    const other = await signedIn(ctx);
    const mod = await signedIn(ctx, "maintainer");
    const own = await submitRequest(troll.browser, "Troll request");
    const target = await submitRequest(other.browser, "Good request");
    const trollComment = await postComment(troll.browser, target, "Nonsense");
    await postComment(other.browser, target, "Real feedback");
    await fileReport(other.browser, `/comments/${trollComment}/report`);
    await fileReport(other.browser, `/requests/${own}/report`);

    await mod.browser.get(`/moderation/users/${troll.id}`);
    expect(mod.browser.lastHtml).toContain("2 open reports");
    await mod.browser.post(`/moderation/users/${troll.id}/ban`, { hideContent: "1" });

    const db = ctx.deps.db;
    expect(db.select().from(request).where(eq(request.id, own)).get()!.hidden).toBe(true);
    expect(db.select().from(comment).where(eq(comment.id, trollComment)).get()!.hidden).toBe(true);
    expect(db.select().from(request).where(eq(request.id, target)).get()!.commentCount).toBe(1);
    expect(db.select().from(report).all().every((r) => r.state === "resolved")).toBe(true);
    expect((await other.browser.get(`/requests/${own}`)).status).toBe(404);
  });

  test("maintainers can't be suspended", async () => {
    const ctx = setup();
    const mod = await signedIn(ctx, "maintainer");
    const other = await signedIn(ctx, "maintainer");
    await mod.browser.get(`/moderation/users/${other.id}`);
    expect(mod.browser.lastHtml).toContain("Revoke the role on the server first.");
    expect((await mod.browser.post(`/moderation/users/${other.id}/ban`, { reason: "x" })).status).toBe(400);
    expect(getUserRow(ctx.deps, other.id)!.bannedAt).toBeNull();
    expect((await mod.browser.get("/moderation/users/does-not-exist")).status).toBe(404);
  });

  test("hiding a comment from the request page is logged and resolves its reports", async () => {
    const ctx = setup();
    const author = await signedIn(ctx);
    const alice = await signedIn(ctx);
    const mod = await signedIn(ctx, "maintainer");
    const id = await submitRequest(author.browser);
    const commentId = await postComment(author.browser, id);
    await fileReport(alice.browser, `/comments/${commentId}/report`);

    await mod.browser.get(`/requests/${id}`);
    expect(mod.browser.lastHtml).toContain(`/moderation/users/${author.id}`);
    await mod.browser.post(`/comments/${commentId}/hide`, { hidden: "1" });
    await mod.browser.post(`/requests/${id}/lock`, { locked: "1" });

    expect(ctx.deps.db.select().from(report).get()!.state).toBe("resolved");
    const actions = ctx.deps.db.select({ action: moderationLog.action, commentId: moderationLog.commentId }).from(moderationLog).all();
    expect(actions).toEqual([
      { action: "hide_comment", commentId },
      { action: "lock_request", commentId: null },
    ]);
  });
});
