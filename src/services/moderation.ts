import { and, count, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DB } from "../db/client";
import {
  comment,
  moderationLog,
  report,
  request,
  user,
  type ModerationAction,
  type ReportReason,
  type ReportState,
  type Role,
} from "../db/schema";
import { plainText } from "../lib/markdown";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export const REPORT_NOTE_MAX = 500;
export const BAN_REASON_MAX = 500;
const QUEUE_ROWS = 1000;
const LOG_SIZE = 50;

/** A request (commentId null) or one of its comments. */
export interface Target {
  requestId: number;
  commentId: number | null;
}

const targetWhere = (t: Target) =>
  and(eq(report.requestId, t.requestId), t.commentId === null ? isNull(report.commentId) : eq(report.commentId, t.commentId));

function log(tx: Tx, entry: { actorId: string; action: ModerationAction; targetUserId?: string | null; note?: string | null } & Partial<Target>) {
  tx.insert(moderationLog).values(entry).run();
}

function closeReports(tx: Tx, where: SQL | undefined, state: Exclude<ReportState, "open">, actorId: string) {
  return tx
    .update(report)
    .set({ state, resolvedBy: actorId, resolvedAt: new Date() })
    .where(and(eq(report.state, "open"), where))
    .returning({ id: report.id })
    .all().length;
}

const commentCountSql = sql`(select count(*) from ${comment} where ${comment.requestId} = ${request.id} and ${comment.hidden} = 0)`;

// Reports

/** Files or reopens the reporter's report on a target. */
export function fileReport(db: DB, input: Target & { reporterId: string; reason: ReportReason; note: string }) {
  db.transaction(
    (tx) => {
      const existing = tx
        .select({ id: report.id })
        .from(report)
        .where(and(eq(report.reporterId, input.reporterId), targetWhere(input)))
        .get();
      const values = { reason: input.reason, note: input.note || null, state: "open" as const, resolvedBy: null, resolvedAt: null, createdAt: new Date() };
      if (existing) tx.update(report).set(values).where(eq(report.id, existing.id)).run();
      else tx.insert(report).values({ ...values, requestId: input.requestId, commentId: input.commentId, reporterId: input.reporterId }).run();
    },
    { behavior: "immediate" },
  );
}

export function openReportCount(db: DB): number {
  return db.select({ n: count() }).from(report).where(eq(report.state, "open")).get()?.n ?? 0;
}

export interface QueueItem extends Target {
  title: string;
  excerpt: string;
  hidden: boolean;
  authorId: string;
  authorName: string;
  authorRole: Role;
  authorBanned: boolean;
  reports: { reporterName: string; reason: ReportReason; note: string | null; createdAt: Date }[];
}

/** Open reports grouped by target, oldest first. */
export function reportQueue(db: DB): QueueItem[] {
  const reporter = alias(user, "reporter");
  const rows = db
    .select({
      requestId: report.requestId,
      commentId: report.commentId,
      reason: report.reason,
      note: report.note,
      createdAt: report.createdAt,
      reporterName: reporter.name,
    })
    .from(report)
    .innerJoin(reporter, eq(reporter.id, report.reporterId))
    .where(eq(report.state, "open"))
    .orderBy(report.id)
    .limit(QUEUE_ROWS)
    .all();
  if (!rows.length) return [];

  const groups = new Map<string, Target & { reports: QueueItem["reports"] }>();
  for (const { requestId, commentId, ...r } of rows) {
    const key = `${requestId}:${commentId ?? 0}`;
    const group = groups.get(key) ?? { requestId, commentId, reports: [] };
    group.reports.push(r);
    groups.set(key, group);
  }

  const author = { authorId: user.id, authorName: user.name, authorRole: user.role, bannedAt: user.bannedAt };
  const requestIds = [...new Set([...groups.values()].map((g) => g.requestId))];
  const commentIds = [...groups.values()].flatMap((g) => (g.commentId === null ? [] : [g.commentId]));
  const requests = new Map(
    db
      .select({ id: request.id, title: request.title, bodyHtml: request.bodyHtml, hidden: request.hidden, ...author })
      .from(request)
      .innerJoin(user, eq(user.id, request.authorId))
      .where(inArray(request.id, requestIds))
      .all()
      .map((r) => [r.id, r]),
  );
  const comments = new Map(
    (commentIds.length
      ? db
          .select({ id: comment.id, bodyHtml: comment.bodyHtml, hidden: comment.hidden, ...author })
          .from(comment)
          .innerJoin(user, eq(user.id, comment.authorId))
          .where(inArray(comment.id, commentIds))
          .all()
      : []
    ).map((c) => [c.id, c]),
  );

  const items: QueueItem[] = [];
  for (const g of groups.values()) {
    const req = requests.get(g.requestId);
    const target = g.commentId === null ? req : comments.get(g.commentId);
    if (!req || !target) continue;
    items.push({
      ...g,
      title: req.title,
      excerpt: plainText(target.bodyHtml, 280),
      hidden: target.hidden,
      authorId: target.authorId,
      authorName: target.authorName,
      authorRole: target.authorRole,
      authorBanned: !!target.bannedAt,
    });
  }
  return items;
}

export function dismissReports(db: DB, target: Target, actorId: string) {
  db.transaction(
    (tx) => {
      if (closeReports(tx, targetWhere(target), "dismissed", actorId)) log(tx, { actorId, action: "dismiss_reports", ...target });
    },
    { behavior: "immediate" },
  );
}

// Content actions. Hiding resolves the target's open reports.

export function setRequestHidden(db: DB, id: number, hidden: boolean, actorId: string) {
  db.transaction(
    (tx) => {
      const row = tx.update(request).set({ hidden, updatedAt: new Date() }).where(eq(request.id, id)).returning({ authorId: request.authorId }).get();
      if (!row) return;
      // Hiding a request hides its discussion too, so reports on its comments are settled as well.
      if (hidden) closeReports(tx, eq(report.requestId, id), "resolved", actorId);
      log(tx, { actorId, action: hidden ? "hide_request" : "unhide_request", requestId: id, targetUserId: row.authorId });
    },
    { behavior: "immediate" },
  );
}

export function setRequestLocked(db: DB, id: number, locked: boolean, actorId: string) {
  db.transaction(
    (tx) => {
      const row = tx.update(request).set({ locked }).where(eq(request.id, id)).returning({ id: request.id }).get();
      if (row) log(tx, { actorId, action: locked ? "lock_request" : "unlock_request", requestId: id });
    },
    { behavior: "immediate" },
  );
}

export function setCommentHidden(db: DB, id: number, hidden: boolean, actorId: string) {
  db.transaction(
    (tx) => {
      const row = tx
        .update(comment)
        .set({ hidden })
        .where(eq(comment.id, id))
        .returning({ requestId: comment.requestId, authorId: comment.authorId })
        .get();
      if (!row) return;
      tx.update(request).set({ commentCount: commentCountSql }).where(eq(request.id, row.requestId)).run();
      if (hidden) closeReports(tx, eq(report.commentId, id), "resolved", actorId);
      log(tx, { actorId, action: hidden ? "hide_comment" : "unhide_comment", requestId: row.requestId, commentId: id, targetUserId: row.authorId });
    },
    { behavior: "immediate" },
  );
}

// Bans

export type BanResult = "ok" | "not_found" | "maintainer";

/**
 * Suspends an account: it can still sign in and read, but not post, vote or
 * report. With `hideContent`, all of the user's requests and comments are
 * hidden and the reports about them resolved.
 */
export function banUser(db: DB, input: { userId: string; actorId: string; reason: string; hideContent: boolean }): BanResult {
  return db.transaction(
    (tx) => {
      const target = tx.select({ role: user.role }).from(user).where(eq(user.id, input.userId)).get();
      if (!target) return "not_found";
      if (target.role === "maintainer") return "maintainer";
      const now = new Date();
      tx.update(user).set({ bannedAt: now, banReason: input.reason || null, updatedAt: now }).where(eq(user.id, input.userId)).run();
      if (input.hideContent) {
        const authored = tx.select({ id: request.id }).from(request).where(eq(request.authorId, input.userId));
        const commented = tx.select({ id: comment.requestId }).from(comment).where(eq(comment.authorId, input.userId));
        tx.update(request).set({ hidden: true, updatedAt: now }).where(and(eq(request.authorId, input.userId), eq(request.hidden, false))).run();
        tx.update(comment).set({ hidden: true }).where(eq(comment.authorId, input.userId)).run();
        tx.update(request).set({ commentCount: commentCountSql }).where(inArray(request.id, commented)).run();
        const theirComments = tx.select({ id: comment.id }).from(comment).where(eq(comment.authorId, input.userId));
        closeReports(tx, sql`(${and(inArray(report.requestId, authored), isNull(report.commentId))} or ${inArray(report.commentId, theirComments)})`, "resolved", input.actorId);
      }
      log(tx, { actorId: input.actorId, action: "ban_user", targetUserId: input.userId, note: [input.reason, input.hideContent ? "(content hidden)" : ""].filter(Boolean).join(" ") || null });
      return "ok";
    },
    { behavior: "immediate" },
  );
}

/** Lifts a suspension. Hidden content stays hidden. */
export function unbanUser(db: DB, userId: string, actorId: string): boolean {
  return db.transaction(
    (tx) => {
      const row = tx
        .update(user)
        .set({ bannedAt: null, banReason: null, updatedAt: new Date() })
        .where(and(eq(user.id, userId), isNotNull(user.bannedAt)))
        .returning({ id: user.id })
        .get();
      if (row) log(tx, { actorId, action: "unban_user", targetUserId: userId });
      return !!row;
    },
    { behavior: "immediate" },
  );
}

export function getModeratedUser(db: DB, id: string) {
  const row = db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      bannedAt: user.bannedAt,
      banReason: user.banReason,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.id, id))
    .get();
  if (!row) return null;
  const n = (q: { get(): { n: number } | undefined }) => q.get()?.n ?? 0;
  return {
    ...row,
    requests: n(db.select({ n: count() }).from(request).where(eq(request.authorId, id))),
    comments: n(db.select({ n: count() }).from(comment).where(eq(comment.authorId, id))),
    reports: n(
      db
        .select({ n: count() })
        .from(report)
        .innerJoin(request, eq(request.id, report.requestId))
        .leftJoin(comment, eq(comment.id, report.commentId))
        .where(and(eq(report.state, "open"), sql`coalesce(${comment.authorId}, ${request.authorId}) = ${id}`)),
    ),
  };
}

export type ModeratedUser = NonNullable<ReturnType<typeof getModeratedUser>>;

export function bannedUsers(db: DB) {
  return db
    .select({ id: user.id, name: user.name, email: user.email, bannedAt: user.bannedAt, banReason: user.banReason })
    .from(user)
    .where(isNotNull(user.bannedAt))
    .orderBy(desc(user.bannedAt))
    .all() as { id: string; name: string; email: string; bannedAt: Date; banReason: string | null }[];
}

export function recentActions(db: DB) {
  const actor = alias(user, "actor");
  const target = alias(user, "target");
  return db
    .select({
      id: moderationLog.id,
      action: moderationLog.action,
      actorName: actor.name,
      targetUserId: moderationLog.targetUserId,
      targetUserName: target.name,
      requestId: moderationLog.requestId,
      commentId: moderationLog.commentId,
      note: moderationLog.note,
      createdAt: moderationLog.createdAt,
    })
    .from(moderationLog)
    .innerJoin(actor, eq(actor.id, moderationLog.actorId))
    .leftJoin(target, eq(target.id, moderationLog.targetUserId))
    .orderBy(desc(moderationLog.id))
    .limit(LOG_SIZE)
    .all();
}

export type LogEntry = ReturnType<typeof recentActions>[number];
