import { createHmac, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DB } from "../db/client";
import { comment, notification, request, subscription, user, type NotificationKind, type Status } from "../db/schema";

export const NOTIFICATION_PAGE_SIZE = 30;

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

// Subscriptions

/** Follows a request as a side effect of submitting, voting or commenting. Never overrides an explicit unfollow. */
export function autoFollow(tx: Tx, requestId: number, userId: string) {
  tx.insert(subscription).values({ requestId, userId }).onConflictDoNothing().run();
}

export function setFollowing(db: DB, requestId: number, userId: string, active: boolean) {
  db.insert(subscription)
    .values({ requestId, userId, active })
    .onConflictDoUpdate({ target: [subscription.requestId, subscription.userId], set: { active } })
    .run();
}

export function isFollowing(db: DB, requestId: number, userId: string): boolean {
  const row = db
    .select({ active: subscription.active })
    .from(subscription)
    .where(and(eq(subscription.requestId, requestId), eq(subscription.userId, userId)))
    .get();
  return row?.active ?? false;
}

// Fan-out

interface Event {
  requestId: number;
  kind: NotificationKind;
  /** Null for automatic changes from GitHub. */
  actorId: string | null;
  commentId?: number;
  fromStatus?: Status;
  toStatus?: Status;
  at: Date;
}

/**
 * Notifies every active follower except the actor, in the caller's transaction.
 * Hidden requests notify nobody. Emails are queued per the recipient's settings
 * and sent by NotificationEmails after commit.
 */
function fanOut(tx: Tx, e: Event) {
  const pref = sql.raw(e.kind === "status" ? "email_on_status" : "email_on_comment");
  tx.run(sql`
    insert into ${notification} (user_id, request_id, kind, actor_id, comment_id, from_status, to_status, email_state, created_at)
    select s.user_id, ${e.requestId}, ${e.kind}, ${e.actorId}, ${e.commentId ?? null}, ${e.fromStatus ?? null}, ${e.toStatus ?? null},
      case when u.email_verified = 1 and u.${pref} = 1 then 'pending' end, ${e.at.getTime()}
    from ${subscription} s
    join ${user} u on u.id = s.user_id
    join ${request} r on r.id = s.request_id
    where s.request_id = ${e.requestId} and s.active = 1 and r.hidden = 0 and s.user_id is not ${e.actorId}
  `);
}

export function notifyStatus(tx: Tx, e: { requestId: number; fromStatus: Status; toStatus: Status; actorId: string | null; at: Date }) {
  fanOut(tx, { ...e, kind: "status" });
}

export function notifyComment(tx: Tx, e: { requestId: number; commentId: number; actorId: string; at: Date }) {
  fanOut(tx, { ...e, kind: "comment" });
}

// Inbox

export interface NotificationItem {
  id: number;
  kind: NotificationKind;
  requestId: number;
  requestTitle: string;
  commentId: number | null;
  commentHtml: string | null;
  fromStatus: Status | null;
  toStatus: Status | null;
  /** Null for automatic changes from GitHub. */
  actorName: string | null;
  read: boolean;
  createdAt: Date;
}

const actor = alias(user, "actor");

/** Hides notifications about hidden requests and comments from everyone but maintainers. */
function visible(includeHidden: boolean): SQL | undefined {
  if (includeHidden) return undefined;
  return and(eq(request.hidden, false), or(isNull(comment.id), eq(comment.hidden, false)));
}

export function listNotifications(db: DB, userId: string, opts: { page: number; includeHidden: boolean }) {
  const rows = db
    .select({
      id: notification.id,
      kind: notification.kind,
      requestId: notification.requestId,
      requestTitle: request.title,
      commentId: notification.commentId,
      commentHtml: comment.bodyHtml,
      fromStatus: notification.fromStatus,
      toStatus: notification.toStatus,
      actorName: actor.name,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    })
    .from(notification)
    .innerJoin(request, eq(request.id, notification.requestId))
    .leftJoin(comment, eq(comment.id, notification.commentId))
    .leftJoin(actor, eq(actor.id, notification.actorId))
    .where(and(eq(notification.userId, userId), visible(opts.includeHidden)))
    .orderBy(desc(notification.id))
    .limit(NOTIFICATION_PAGE_SIZE + 1)
    .offset((opts.page - 1) * NOTIFICATION_PAGE_SIZE)
    .all();
  const items: NotificationItem[] = rows.slice(0, NOTIFICATION_PAGE_SIZE).map(({ readAt, ...r }) => ({ ...r, read: readAt !== null }));
  return { items, hasNext: rows.length > NOTIFICATION_PAGE_SIZE };
}

export function unreadCount(db: DB, userId: string, includeHidden: boolean): number {
  const row = db
    .select({ n: count() })
    .from(notification)
    .innerJoin(request, eq(request.id, notification.requestId))
    .leftJoin(comment, eq(comment.id, notification.commentId))
    .where(and(eq(notification.userId, userId), isNull(notification.readAt), visible(includeHidden)))
    .get();
  return row?.n ?? 0;
}

/** Marks the viewer's notifications for one request as read, e.g. when they open it. Returns how many changed. */
export function markRequestRead(db: DB, userId: string, requestId: number): number {
  return db
    .update(notification)
    .set({ readAt: new Date() })
    .where(and(eq(notification.userId, userId), eq(notification.requestId, requestId), isNull(notification.readAt)))
    .returning({ id: notification.id })
    .all().length;
}

export function markAllRead(db: DB, userId: string) {
  db.update(notification)
    .set({ readAt: new Date() })
    .where(and(eq(notification.userId, userId), isNull(notification.readAt)))
    .run();
}

// Email settings

export interface EmailPrefs {
  status: boolean;
  comment: boolean;
}

export function getEmailPrefs(db: DB, userId: string): EmailPrefs {
  const row = db.select({ status: user.emailOnStatus, comment: user.emailOnComment }).from(user).where(eq(user.id, userId)).get();
  return row ?? { status: false, comment: false };
}

export function setEmailPrefs(db: DB, userId: string, prefs: EmailPrefs) {
  db.update(user).set({ emailOnStatus: prefs.status, emailOnComment: prefs.comment }).where(eq(user.id, userId)).run();
}

// Unfollow links in emails work without signing in.

export function unfollowToken(secret: string, userId: string, requestId: number): string {
  return createHmac("sha256", secret).update(`unfollow:${userId}:${requestId}`).digest("base64url").slice(0, 32);
}

export function verifyUnfollowToken(secret: string, userId: string, requestId: number, token: string): boolean {
  const expected = Buffer.from(unfollowToken(secret, userId, requestId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function unfollowUrl(appUrl: string, secret: string, userId: string, requestId: number): string {
  const params = new URLSearchParams({ u: userId, r: String(requestId), t: unfollowToken(secret, userId, requestId) });
  return `${appUrl}/unfollow?${params}`;
}
