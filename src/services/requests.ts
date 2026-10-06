import { and, asc, desc, eq, gt, inArray, max, sql, type SQL } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  comment,
  autoLabelJob,
  githubIssue,
  label,
  request,
  requestLabel,
  statusChange,
  user,
  vote,
  type GithubIssue,
  type Label,
  type Role,
  type Status,
} from "../db/schema";
import { requestFts } from "../db/fts";
import { GitHubSync } from "../github/sync";
import { renderMarkdown } from "../lib/markdown";
import { AutoLabeler } from "../labeler/worker";
import { autoFollow, notifyComment, notifyStatus } from "./notifications";

export const PAGE_SIZE = 25;
export const COMMENT_PAGE_SIZE = 50;
export const SORTS = ["new", "votes", "activity", "relevance"] as const;
export type Sort = (typeof SORTS)[number];

/** Entering one of these statuses ensures a GitHub issue exists. */
export const ISSUE_STATUSES: readonly Status[] = ["accepted", "in_progress"];

export const LIMITS = { titleMin: 3, titleMax: 140, bodyMax: 20_000, commentMax: 10_000, labelMax: 32 };

export interface ListItem {
  id: number;
  title: string;
  status: Status;
  voteCount: number;
  commentCount: number;
  createdAt: Date;
  authorName: string;
  labels: Pick<Label, "id" | "name">[];
  voted: boolean;
}

export interface ListQuery {
  q?: string;
  status?: Status;
  sort: Sort;
  page: number;
  viewerId?: string;
}

/** Turns user input into a safe FTS5 prefix query, e.g. `dark mode` → `"dark"* "mode"*`. */
export function ftsQuery(input: string | undefined): string | null {
  const terms = input?.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 8);
  return terms?.length ? terms.map((t) => `"${t}"*`).join(" ") : null;
}

export function listRequests(db: DB, query: ListQuery): { items: ListItem[]; hasNext: boolean } {
  const match = ftsQuery(query.q);
  // A query without searchable terms matches nothing rather than everything.
  if (query.q?.trim() && !match) return { items: [], hasNext: false };
  const where: SQL[] = [eq(request.hidden, false)];
  if (query.status) where.push(eq(request.status, query.status));
  if (match) where.push(sql`request_fts match ${match}`);

  const order =
    query.sort === "relevance" && match
      ? [sql`bm25(request_fts, 10.0, 1.0)`, desc(request.id)]
      : query.sort === "votes"
        ? [desc(request.voteCount), desc(request.id)]
        : query.sort === "activity"
          ? [desc(request.lastActivityAt), desc(request.id)]
          : [desc(request.id)];

  const base = db
    .select({
      id: request.id,
      title: request.title,
      status: request.status,
      voteCount: request.voteCount,
      commentCount: request.commentCount,
      createdAt: request.createdAt,
      authorName: user.name,
    })
    .from(request)
    .innerJoin(user, eq(user.id, request.authorId))
    .$dynamic();
  const rows = (match ? base.innerJoin(requestFts, eq(requestFts.rowid, request.id)) : base)
    .where(and(...where))
    .orderBy(...order)
    .limit(PAGE_SIZE + 1)
    .offset((query.page - 1) * PAGE_SIZE)
    .all();

  const hasNext = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const ids = page.map((r) => r.id);
  const labels = labelsFor(db, ids);
  const voted = query.viewerId ? votedSet(db, query.viewerId, ids) : new Set<number>();
  return {
    items: page.map((r) => ({ ...r, labels: labels.get(r.id) ?? [], voted: voted.has(r.id) })),
    hasNext,
  };
}

function labelsFor(db: DB, ids: number[]) {
  const map = new Map<number, Pick<Label, "id" | "name">[]>();
  if (!ids.length) return map;
  const rows = db
    .select({ requestId: requestLabel.requestId, id: label.id, name: label.name })
    .from(requestLabel)
    .innerJoin(label, eq(label.id, requestLabel.labelId))
    .where(inArray(requestLabel.requestId, ids))
    .orderBy(asc(label.name))
    .all();
  for (const { requestId, ...l } of rows) {
    const list = map.get(requestId) ?? [];
    list.push(l);
    map.set(requestId, list);
  }
  return map;
}

function votedSet(db: DB, userId: string, ids: number[]) {
  if (!ids.length) return new Set<number>();
  const rows = db
    .select({ requestId: vote.requestId })
    .from(vote)
    .where(and(eq(vote.userId, userId), inArray(vote.requestId, ids)))
    .all();
  return new Set(rows.map((r) => r.requestId));
}

export interface RequestDetail {
  id: number;
  title: string;
  body: string;
  bodyHtml: string;
  status: Status;
  voteCount: number;
  commentCount: number;
  locked: boolean;
  hidden: boolean;
  createdAt: Date;
  editedAt: Date | null;
  authorId: string;
  authorName: string;
  labels: Pick<Label, "id" | "name">[];
  voted: boolean;
  issue: Pick<
    GithubIssue,
    "state" | "attempts" | "lastError" | "issueNumber" | "issueUrl" | "prNumber" | "prUrl" | "nightlyTag" | "nightlyUrl" | "releaseTag" | "releaseUrl" | "checkedAt" | "checkError"
  > | null;
  labeling: typeof autoLabelJob.$inferSelect | null;
  /** actorName is null for automatic changes from GitHub. */
  history: { fromStatus: Status; toStatus: Status; actorName: string | null; createdAt: Date }[];
}

export function getRequest(db: DB, id: number, viewerId?: string): RequestDetail | null {
  const row = db
    .select({
      id: request.id,
      title: request.title,
      body: request.body,
      bodyHtml: request.bodyHtml,
      status: request.status,
      voteCount: request.voteCount,
      commentCount: request.commentCount,
      locked: request.locked,
      hidden: request.hidden,
      createdAt: request.createdAt,
      editedAt: request.editedAt,
      authorId: request.authorId,
      authorName: user.name,
      issue: {
        state: githubIssue.state,
        attempts: githubIssue.attempts,
        lastError: githubIssue.lastError,
        issueNumber: githubIssue.issueNumber,
        issueUrl: githubIssue.issueUrl,
        prNumber: githubIssue.prNumber,
        prUrl: githubIssue.prUrl,
        nightlyTag: githubIssue.nightlyTag,
        nightlyUrl: githubIssue.nightlyUrl,
        releaseTag: githubIssue.releaseTag,
        releaseUrl: githubIssue.releaseUrl,
        checkedAt: githubIssue.checkedAt,
        checkError: githubIssue.checkError,
      },
    })
    .from(request)
    .innerJoin(user, eq(user.id, request.authorId))
    .leftJoin(githubIssue, eq(githubIssue.requestId, request.id))
    .where(eq(request.id, id))
    .get();
  if (!row) return null;

  const history = db
    .select({
      fromStatus: statusChange.fromStatus,
      toStatus: statusChange.toStatus,
      actorName: user.name,
      createdAt: statusChange.createdAt,
    })
    .from(statusChange)
    .leftJoin(user, eq(user.id, statusChange.actorId))
    .where(eq(statusChange.requestId, id))
    .orderBy(desc(statusChange.id))
    .limit(10)
    .all();

  const { issue, ...rest } = row;
  return {
    ...rest,
    labels: labelsFor(db, [id]).get(id) ?? [],
    voted: viewerId ? votedSet(db, viewerId, [id]).has(id) : false,
    // Left join: all columns are null when no issue operation exists.
    issue: issue?.state ? (issue as RequestDetail["issue"]) : null,
    labeling: db.select().from(autoLabelJob).where(eq(autoLabelJob.requestId, id)).get() ?? null,
    history,
  };
}

export interface CommentItem {
  id: number;
  requestId: number;
  authorId: string;
  authorName: string;
  authorRole: Role;
  bodyHtml: string;
  hidden: boolean;
  createdAt: Date;
  editedAt: Date | null;
}

const commentColumns = {
  id: comment.id,
  requestId: comment.requestId,
  authorId: comment.authorId,
  authorName: user.name,
  authorRole: user.role,
  bodyHtml: comment.bodyHtml,
  hidden: comment.hidden,
  createdAt: comment.createdAt,
  editedAt: comment.editedAt,
};

export function listComments(
  db: DB,
  requestId: number,
  opts: { includeHidden: boolean; afterId?: number },
): { items: CommentItem[]; hasMore: boolean } {
  const where: SQL[] = [eq(comment.requestId, requestId)];
  if (!opts.includeHidden) where.push(eq(comment.hidden, false));
  if (opts.afterId) where.push(gt(comment.id, opts.afterId));
  const rows = db
    .select(commentColumns)
    .from(comment)
    .innerJoin(user, eq(user.id, comment.authorId))
    .where(and(...where))
    .orderBy(asc(comment.id))
    .limit(COMMENT_PAGE_SIZE + 1)
    .all();
  return { items: rows.slice(0, COMMENT_PAGE_SIZE), hasMore: rows.length > COMMENT_PAGE_SIZE };
}

export function getComment(db: DB, id: number): CommentItem | null {
  return (
    db.select(commentColumns).from(comment).innerJoin(user, eq(user.id, comment.authorId)).where(eq(comment.id, id)).get() ??
    null
  );
}

export function getCommentSource(db: DB, id: number) {
  return db.select({ id: comment.id, body: comment.body, requestId: comment.requestId, authorId: comment.authorId, hidden: comment.hidden }).from(comment).where(eq(comment.id, id)).get() ?? null;
}

export function getRequestMeta(db: DB, id: number) {
  return (
    db
      .select({ id: request.id, authorId: request.authorId, hidden: request.hidden, locked: request.locked, status: request.status })
      .from(request)
      .where(eq(request.id, id))
      .get() ?? null
  );
}

// Validation

export type FieldErrors = Partial<Record<"title" | "body", string>>;

export function validateRequest(title: string, body: string): FieldErrors {
  const errors: FieldErrors = {};
  if (title.length < LIMITS.titleMin) errors.title = "Title is too short.";
  else if (title.length > LIMITS.titleMax) errors.title = `Keep the title under ${LIMITS.titleMax} characters.`;
  if (!body) errors.body = "Add a description.";
  else if (body.length > LIMITS.bodyMax) errors.body = "Description is too long.";
  return errors;
}

export function validateComment(body: string): string | null {
  if (!body) return "Write a comment first.";
  if (body.length > LIMITS.commentMax) return "Comment is too long.";
  return null;
}

// Writes

export function createRequest(db: DB, input: { title: string; body: string; authorId: string }): number {
  return db.transaction(tx => {
    const row = tx.insert(request)
      .values({ title: input.title, body: input.body, bodyHtml: renderMarkdown(input.body), authorId: input.authorId })
      .returning({ id: request.id }).get();
    AutoLabeler.enqueue(tx, row.id);
    autoFollow(tx, row.id, input.authorId);
    return row.id;
  }, { behavior: "immediate" });
}

export function updateRequest(db: DB, id: number, input: { title: string; body: string }) {
  const now = new Date();
  db.transaction(tx => {
    tx.update(request)
      .set({ title: input.title, body: input.body, bodyHtml: renderMarkdown(input.body), editedAt: now, updatedAt: now })
      .where(eq(request.id, id)).run();
    AutoLabeler.enqueue(tx, id);
  }, { behavior: "immediate" });
}

/** Sets the viewer's vote to `want` (or toggles when undefined). Idempotent for repeated submissions. */
export function setVote(db: DB, requestId: number, userId: string, want?: boolean) {
  return db.transaction(
    (tx) => {
      const req = tx.select({ hidden: request.hidden }).from(request).where(eq(request.id, requestId)).get();
      if (!req || req.hidden) return null;
      const existing = tx
        .select({ userId: vote.userId })
        .from(vote)
        .where(and(eq(vote.requestId, requestId), eq(vote.userId, userId)))
        .get();
      const target = want ?? !existing;
      if (target && !existing) {
        tx.insert(vote).values({ requestId, userId }).onConflictDoNothing().run();
        autoFollow(tx, requestId, userId);
      }
      if (!target && existing) tx.delete(vote).where(and(eq(vote.requestId, requestId), eq(vote.userId, userId))).run();
      const updated = tx
        .update(request)
        .set({ voteCount: sql`(select count(*) from ${vote} where ${vote.requestId} = ${requestId})` })
        .where(eq(request.id, requestId))
        .returning({ voteCount: request.voteCount })
        .get();
      return { voted: target, voteCount: updated?.voteCount ?? 0 };
    },
    { behavior: "immediate" },
  );
}

const commentCountSql = (requestId: number) =>
  sql`(select count(*) from ${comment} where ${comment.requestId} = ${requestId} and ${comment.hidden} = 0)`;

export function addComment(db: DB, input: { requestId: number; authorId: string; body: string }): number {
  return db.transaction(
    (tx) => {
      const now = new Date();
      const row = tx
        .insert(comment)
        .values({ requestId: input.requestId, authorId: input.authorId, body: input.body, bodyHtml: renderMarkdown(input.body) })
        .returning({ id: comment.id })
        .get();
      tx.update(request)
        .set({ commentCount: commentCountSql(input.requestId), lastActivityAt: now })
        .where(eq(request.id, input.requestId))
        .run();
      notifyComment(tx, { requestId: input.requestId, commentId: row.id, actorId: input.authorId, at: now });
      autoFollow(tx, input.requestId, input.authorId);
      return row.id;
    },
    { behavior: "immediate" },
  );
}

export function updateComment(db: DB, id: number, body: string) {
  db.update(comment).set({ body, bodyHtml: renderMarkdown(body), editedAt: new Date() }).where(eq(comment.id, id)).run();
}

/**
 * Changes status, records history and, when entering an accepted status,
 * persists the GitHub issue operation in the same transaction. Returns whether
 * the caller should kick the GitHub worker (after commit).
 */
export function setStatus(db: DB, id: number, next: Status, actorId: string): { changed: boolean; syncIssue: boolean } | null {
  return db.transaction(
    (tx) => {
      const current = tx.select({ status: request.status }).from(request).where(eq(request.id, id)).get();
      if (!current) return null;
      const syncIssue = ISSUE_STATUSES.includes(next);
      // Idempotent: re-submitting an accepted status creates a missing issue, never a second one.
      if (syncIssue) GitHubSync.enqueue(tx, id, actorId);
      if (current.status === next) return { changed: false, syncIssue };
      const now = new Date();
      tx.update(request).set({ status: next, updatedAt: now, lastActivityAt: now }).where(eq(request.id, id)).run();
      tx.insert(statusChange).values({ requestId: id, fromStatus: current.status, toStatus: next, actorId, createdAt: now }).run();
      notifyStatus(tx, { requestId: id, fromStatus: current.status, toStatus: next, actorId, at: now });
      return { changed: true, syncIssue };
    },
    { behavior: "immediate" },
  );
}

export function setRequestFlags(db: DB, id: number, flags: { locked?: boolean; hidden?: boolean }) {
  db.update(request)
    .set({ ...flags, ...(flags.hidden !== undefined ? { updatedAt: new Date() } : {}) })
    .where(eq(request.id, id))
    .run();
}

export function setRequestLabels(db: DB, id: number, labelIds: number[]) {
  db.transaction(
    (tx) => {
      tx.delete(requestLabel).where(eq(requestLabel.requestId, id)).run();
      const valid = labelIds.length ? tx.select({ id: label.id }).from(label).where(inArray(label.id, labelIds)).all() : [];
      if (valid.length) tx.insert(requestLabel).values(valid.map((l) => ({ requestId: id, labelId: l.id }))).run();
      AutoLabeler.override(tx, id);
    },
    { behavior: "immediate" },
  );
}

// Labels

export function listLabels(db: DB) {
  return db
    .select({ id: label.id, name: label.name, count: sql<number>`(select count(*) from ${requestLabel} where ${requestLabel.labelId} = ${label.id})` })
    .from(label)
    .orderBy(asc(label.name))
    .all();
}

export function createLabel(db: DB, name: string): "ok" | "exists" {
  const rows = db.insert(label).values({ name }).onConflictDoNothing().returning({ id: label.id }).all();
  return rows.length ? "ok" : "exists";
}

export function deleteLabel(db: DB, id: number) {
  db.delete(label).where(eq(label.id, id)).run();
}

// Feed

export function feedItems(db: DB, limit = 50) {
  return db
    .select({ id: request.id, title: request.title, bodyHtml: request.bodyHtml, createdAt: request.createdAt })
    .from(request)
    .where(eq(request.hidden, false))
    .orderBy(desc(request.id))
    .limit(limit)
    .all();
}

/** Newest change to any request, including ones that were hidden since. */
export function feedLastModified(db: DB): Date | null {
  return db.select({ value: max(request.updatedAt) }).from(request).get()?.value ?? null;
}
