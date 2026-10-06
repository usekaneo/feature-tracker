import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { notification, request } from "../src/db/schema";
import { silentLogger } from "../src/lib/logger";
import type { Mailer, MailMessage } from "../src/lib/mailer";
import { NotificationEmails } from "../src/services/notification-emails";
import { createUser, ORIGIN, setup, signedIn, submitRequest } from "./helpers";

async function world() {
  const ctx = setup();
  const author = await signedIn(ctx);
  const voter = await signedIn(ctx);
  const maya = await signedIn(ctx, "maintainer");
  const id = await submitRequest(author.browser, "Recurring tasks", "Repeat weekly.");
  await voter.browser.get(`/requests/${id}`);
  await voter.browser.post(`/requests/${id}/vote`, { value: "1" });
  await maya.browser.get(`/requests/${id}`);
  const setStatus = async (status: string) => {
    expect((await maya.browser.post(`/requests/${id}/status`, { status })).status).toBe(303);
    await ctx.deps.notifier.idle();
  };
  const mails = () => ctx.deps.mailer.outbox();
  const rows = (userId: string) => ctx.deps.db.select().from(notification).where(eq(notification.userId, userId)).all();
  return { ctx, author, voter, maya, id, setStatus, mails, rows };
}

describe("following", () => {
  test("authors and voters follow automatically and get status changes, but not their own", async () => {
    const w = await world();
    await w.setStatus("accepted");

    for (const who of [w.author, w.voter]) {
      const [row] = w.rows(who.id);
      expect(row).toMatchObject({ kind: "status", fromStatus: "open", toStatus: "accepted", actorId: w.maya.id, readAt: null, emailState: "sent" });
    }
    expect(w.rows(w.maya.id)).toHaveLength(0);

    const sent = w.mails();
    expect(sent.map((m) => m.to).sort()).toEqual([w.author.email, w.voter.email].sort());
    expect(sent[0]!.subject).toBe('"Recurring tasks" is now Accepted');
    expect(sent[0]!.text).toContain(`${ORIGIN}/requests/${w.id}`);
    expect(sent[0]!.text).toContain(`${ORIGIN}/unfollow?`);
  });

  test("commenters follow, and comments notify in-app; comment emails are opt-in", async () => {
    const w = await world();
    const carol = await signedIn(w.ctx);
    await carol.browser.get(`/requests/${w.id}`);
    await carol.browser.post(`/requests/${w.id}/comments`, { body: "Monthly **too**, please." });
    await w.ctx.deps.notifier.idle();

    const [row] = w.rows(w.author.id);
    expect(row).toMatchObject({ kind: "comment", actorId: carol.id, emailState: null });
    expect(w.rows(carol.id)).toHaveLength(0);
    expect(w.mails()).toHaveLength(0);

    // Carol now follows: the author's reply reaches her.
    await w.author.browser.get(`/requests/${w.id}`);
    await w.author.browser.post(`/requests/${w.id}/comments`, { body: "Thanks!" });
    expect(w.rows(carol.id)).toHaveLength(1);

    // Opting in to comment emails.
    await w.voter.browser.get("/notifications");
    const saved = await w.voter.browser.post("/notifications/settings", { status: "1", comment: "1" });
    expect(saved.headers.get("location")).toBe("/notifications?saved=1");
    await carol.browser.post(`/requests/${w.id}/comments`, { body: "Any update?" });
    await w.ctx.deps.notifier.idle();
    const mail = w.mails().find((m) => m.to === w.voter.email)!;
    expect(mail.subject).toBe('New comment on "Recurring tasks"');
    expect(mail.text).toContain("Any update?");
    expect(mail.text).toMatch(/#comment-\d+/);
  });

  test("unfollowing stops notifications and survives voting again", async () => {
    const w = await world();
    const page = await (await w.voter.browser.get(`/requests/${w.id}`)).text();
    expect(page).toContain(">Following<");

    const res = await w.voter.browser.post(`/requests/${w.id}/follow`, { value: "0" }, { htmx: true });
    const html = await res.text();
    expect(html).toContain(">Follow<");
    expect(html).not.toContain("<html");

    await w.voter.browser.post(`/requests/${w.id}/vote`, { value: "0" });
    await w.voter.browser.post(`/requests/${w.id}/vote`, { value: "1" });
    await w.setStatus("accepted");
    expect(w.rows(w.voter.id)).toHaveLength(0);
    expect(w.rows(w.author.id)).toHaveLength(1);

    await w.voter.browser.post(`/requests/${w.id}/follow`, { value: "1" });
    await w.setStatus("in_progress");
    expect(w.rows(w.voter.id)).toHaveLength(1);
  });

  test("the unfollow link in emails works signed out, but only after confirming", async () => {
    const w = await world();
    await w.setStatus("accepted");
    const link = w.mails().find((m) => m.to === w.voter.email)!.text.match(/(http\S+\/unfollow\?\S+)/)![1]!;

    const anon = w.ctx.browser();
    const confirm = await anon.get(link);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("Unfollow this request?");
    await w.setStatus("in_progress");
    expect(w.rows(w.voter.id)).toHaveLength(2);

    const params = new URL(link).searchParams;
    const done = await anon.post("/unfollow", { u: params.get("u")!, r: params.get("r")!, t: params.get("t")! });
    expect(await done.text()).toContain("Unfollowed");
    await w.setStatus("merged");
    expect(w.rows(w.voter.id)).toHaveLength(2);

    const forged = await anon.post("/unfollow", { u: w.author.id, r: params.get("r")!, t: params.get("t")! });
    expect(forged.status).toBe(400);
    expect((await anon.get(`/unfollow?u=${w.author.id}&r=${w.id}&t=nope`)).status).toBe(400);
  });

  test("anonymous visitors can't follow", async () => {
    const w = await world();
    const res = await w.ctx.browser().post(`/requests/${w.id}/follow`, { value: "1" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toStartWith("/login");
  });
});

describe("inbox", () => {
  test("shows an unread count, lists notifications, and reading clears them", async () => {
    const w = await world();
    await w.setStatus("accepted");
    await w.maya.browser.post(`/requests/${w.id}/comments`, { body: "On it." });

    const home = await (await w.voter.browser.get("/")).text();
    expect(home).toContain('aria-label="Notifications (2 unread)"');

    const inbox = await (await w.voter.browser.get("/notifications")).text();
    expect(inbox).toContain("Recurring tasks");
    expect(inbox).toContain("changed the status to");
    expect(inbox).toContain("commented");
    expect(inbox).toContain("On it.");
    expect(inbox).toContain("Mark all as read");

    // Opening the request reads its notifications, and the header reflects it right away.
    const detail = await (await w.voter.browser.get(`/requests/${w.id}`)).text();
    expect(detail).toContain('aria-label="Notifications"');
    expect(w.rows(w.voter.id).every((r) => r.readAt)).toBe(true);

    await w.setStatus("in_progress");
    await w.author.browser.get("/notifications");
    await w.author.browser.post("/notifications/read");
    expect(w.rows(w.author.id).every((r) => r.readAt)).toBe(true);
  });

  test("the inbox requires sign-in", async () => {
    const ctx = setup();
    const res = await ctx.browser().get("/notifications");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?next=%2Fnotifications");
  });

  test("hidden requests notify nobody, and hidden comments drop out of the inbox", async () => {
    const w = await world();
    await w.maya.browser.post(`/requests/${w.id}/comments`, { body: "Spam link" });
    const commentId = w.rows(w.voter.id)[0]!.commentId!;
    await w.maya.browser.post(`/comments/${commentId}/hide`, { hidden: "1" });
    const inbox = await (await w.voter.browser.get("/notifications")).text();
    expect(inbox).not.toContain("Spam link");
    expect(inbox).toContain('aria-label="Notifications"');

    await w.maya.browser.post(`/requests/${w.id}/hide`, { hidden: "1" });
    await w.setStatus("declined");
    expect(w.rows(w.voter.id)).toHaveLength(1);
  });
});

describe("GitHub progress", () => {
  test("automatic status changes notify everyone, attributed to GitHub", async () => {
    const w = await world();
    await w.setStatus("accepted");
    expect(w.ctx.deps.issues.advance(w.id, "merged")).toBe(true);
    await w.ctx.deps.notifier.idle();

    // Maya only changed the status; that doesn't make her follow.
    expect(w.rows(w.maya.id)).toHaveLength(0);
    const latest = w.rows(w.author.id).at(-1)!;
    expect(latest).toMatchObject({ toStatus: "merged", actorId: null, emailState: "sent" });
    const mail = w.mails().find((m) => m.subject.includes("Merged"))!;
    expect(mail.text).toContain('"Recurring tasks" moved from Accepted to Merged.');
    expect(await (await w.author.browser.get("/notifications")).text()).toContain("GitHub changed the status to");
  });
});

describe("email delivery", () => {
  function failingMailer(failures: number) {
    const sent: MailMessage[] = [];
    let left = failures;
    const mailer: Mailer = {
      transport: "smtp",
      async send(message) {
        if (left-- > 0) throw new Error("SMTP down");
        sent.push(message);
      },
      outbox: () => [],
    };
    return { mailer, sent };
  }

  test("retries failed sends and gives up after five attempts", async () => {
    const w = await world();
    const { mailer, sent } = failingMailer(Infinity);
    const emails = new NotificationEmails({ db: w.ctx.deps.db, mailer, appUrl: ORIGIN, secret: "s", logger: silentLogger });
    // Queue without the app's own sender picking it up.
    w.ctx.deps.db.update(request).set({ status: "accepted" }).where(eq(request.id, w.id)).run();
    w.ctx.deps.db.insert(notification).values({ userId: w.voter.id, requestId: w.id, kind: "status", fromStatus: "open", toStatus: "accepted", emailState: "pending" }).run();

    for (let i = 0; i < 5; i++) await emails.sendDue();
    const row = w.rows(w.voter.id)[0]!;
    expect(row).toMatchObject({ emailState: "failed", emailAttempts: 5 });
    expect(sent).toHaveLength(0);
  });

  test("skips stale, superseded and unwanted emails", async () => {
    const w = await world();
    const { mailer, sent } = failingMailer(0);
    const now = { t: Date.now() };
    const emails = new NotificationEmails({ db: w.ctx.deps.db, mailer, appUrl: ORIGIN, secret: "s", logger: silentLogger, now: () => now.t });
    const queue = (toStatus: "accepted" | "declined", userId = w.voter.id) =>
      w.ctx.deps.db.insert(notification).values({ userId, requestId: w.id, kind: "status", fromStatus: "open", toStatus, emailState: "pending" }).returning().get().id;
    w.ctx.deps.db.update(request).set({ status: "accepted" }).where(eq(request.id, w.id)).run();

    const superseded = queue("declined");
    const fresh = queue("accepted");
    await emails.sendDue();
    expect(sent).toHaveLength(1);
    const state = (id: number) => w.ctx.deps.db.select().from(notification).where(eq(notification.id, id)).get()!.emailState;
    expect(state(superseded)).toBe("skipped");
    expect(state(fresh)).toBe("sent");

    const stale = queue("accepted");
    now.t += 3 * 24 * 60 * 60_000;
    await emails.sendDue();
    expect(state(stale)).toBe("skipped");

    now.t = Date.now();
    await w.voter.browser.get("/notifications");
    await w.voter.browser.post("/notifications/settings", {});
    const optedOut = queue("accepted");
    await emails.sendDue();
    expect(state(optedOut)).toBe("skipped");
  });

  test("unverified accounts get in-app notifications but no email", async () => {
    const w = await world();
    const ghost = await createUser(w.ctx.deps, { verified: false });
    // Followed before verifying, e.g. through GitHub sign-in with an unverified address.
    w.ctx.deps.db.run(sql`insert into subscription (request_id, user_id) values (${w.id}, ${ghost.id})`);
    await w.setStatus("accepted");
    expect(w.rows(ghost.id)[0]).toMatchObject({ emailState: null });
  });
});
