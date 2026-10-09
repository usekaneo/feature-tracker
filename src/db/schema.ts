import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
const flag = (name: string) => integer(name, { mode: "boolean" }).notNull().default(false);

export const STATUSES = ["open", "accepted", "in_progress", "merged", "nightly", "released", "declined"] as const;
export type Status = (typeof STATUSES)[number];

export const ROLES = ["user", "maintainer"] as const;
export type Role = (typeof ROLES)[number];

// Better Auth tables

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: flag("email_verified"),
  image: text("image"),
  role: text("role", { enum: ROLES }).notNull().default("user"),
  /** Suspended accounts can still sign in and read, but not write. */
  bannedAt: timestamp("banned_at"),
  banReason: text("ban_reason"),
  /** Notification email settings. */
  emailOnStatus: integer("email_on_status", { mode: "boolean" }).notNull().default(true),
  emailOnComment: flag("email_on_comment"),
  createdAt: timestamp("created_at").notNull().default(now),
  updatedAt: timestamp("updated_at").notNull().default(now),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").notNull().default(now),
    updatedAt: timestamp("updated_at").notNull().default(now),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().default(now),
    updatedAt: timestamp("updated_at").notNull().default(now),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().default(now),
    updatedAt: timestamp("updated_at").notNull().default(now),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// Tracker tables

export const request = sqliteTable(
  "request",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    bodyHtml: text("body_html").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    status: text("status", { enum: STATUSES }).notNull().default("open"),
    voteCount: integer("vote_count").notNull().default(0),
    commentCount: integer("comment_count").notNull().default(0),
    locked: flag("locked"),
    hidden: flag("hidden"),
    createdAt: timestamp("created_at").notNull().default(now),
    /** Any change to content, status or visibility. Drives feed Last-Modified. */
    updatedAt: timestamp("updated_at").notNull().default(now),
    /** New comments and status changes. Drives "recent activity" sort. */
    lastActivityAt: timestamp("last_activity_at").notNull().default(now),
    editedAt: timestamp("edited_at"),
  },
  (t) => [
    index("request_new_idx").on(t.hidden, t.id),
    index("request_status_new_idx").on(t.hidden, t.status, t.id),
    index("request_votes_idx").on(t.hidden, t.voteCount, t.id),
    index("request_status_votes_idx").on(t.hidden, t.status, t.voteCount, t.id),
    index("request_activity_idx").on(t.hidden, t.lastActivityAt, t.id),
    index("request_status_activity_idx").on(t.hidden, t.status, t.lastActivityAt, t.id),
    index("request_author_idx").on(t.authorId),
    index("request_updated_idx").on(t.updatedAt),
  ],
);

export const vote = sqliteTable(
  "vote",
  {
    requestId: integer("request_id")
      .notNull()
      .references(() => request.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.userId] }), index("vote_user_idx").on(t.userId)],
);

export const comment = sqliteTable(
  "comment",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: integer("request_id")
      .notNull()
      .references(() => request.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    body: text("body").notNull(),
    bodyHtml: text("body_html").notNull(),
    hidden: flag("hidden"),
    createdAt: timestamp("created_at").notNull().default(now),
    editedAt: timestamp("edited_at"),
  },
  (t) => [index("comment_request_idx").on(t.requestId, t.hidden, t.id), index("comment_author_idx").on(t.authorId)],
);

export const label = sqliteTable(
  "label",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("label_name_idx").on(sql`${t.name} collate nocase`)],
);

export const requestLabel = sqliteTable(
  "request_label",
  {
    requestId: integer("request_id")
      .notNull()
      .references(() => request.id, { onDelete: "cascade" }),
    labelId: integer("label_id")
      .notNull()
      .references(() => label.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.labelId] }), index("request_label_label_idx").on(t.labelId)],
);

/** Durable auto-labeling work; revision guards against edits and maintainer overrides in flight. */
export const autoLabelJob = sqliteTable(
  "auto_label_job",
  {
    requestId: integer("request_id").primaryKey().references(() => request.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    state: text("state", { enum: ["pending", "processing", "done", "failed"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().default(now),
    leaseUntil: timestamp("lease_until"),
    manualOverride: flag("manual_override"),
    managedLabelIds: text("managed_label_ids", { mode: "json" }).$type<number[]>().notNull().default(sql`'[]'`),
    assessment: text("assessment", { mode: "json" }).$type<import("../labeler/assess").TopicAssessment>(),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at").notNull().default(now),
  },
  (t) => [index("auto_label_job_due_idx").on(t.state, t.nextAttemptAt)],
);

export const REPORT_REASONS = ["spam", "abuse", "off_topic", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATES = ["open", "resolved", "dismissed"] as const;
export type ReportState = (typeof REPORT_STATES)[number];

/**
 * A user's report about a request (commentId null) or a comment. One row per
 * reporter and target; reporting again reopens it.
 */
export const report = sqliteTable(
  "report",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: integer("request_id")
      .notNull()
      .references(() => request.id, { onDelete: "cascade" }),
    commentId: integer("comment_id").references(() => comment.id, { onDelete: "cascade" }),
    reporterId: text("reporter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    reason: text("reason", { enum: REPORT_REASONS }).notNull(),
    note: text("note"),
    state: text("state", { enum: REPORT_STATES }).notNull().default("open"),
    resolvedBy: text("resolved_by").references(() => user.id),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("report_reporter_target_idx").on(t.reporterId, t.requestId, sql`coalesce(${t.commentId}, 0)`),
    index("report_state_idx").on(t.state, t.id),
    index("report_target_idx").on(t.requestId, t.commentId),
  ],
);

export const MODERATION_ACTIONS = [
  "hide_request",
  "unhide_request",
  "lock_request",
  "unlock_request",
  "hide_comment",
  "unhide_comment",
  "dismiss_reports",
  "ban_user",
  "unban_user",
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** Audit trail of maintainer moderation actions. */
export const moderationLog = sqliteTable(
  "moderation_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id),
    action: text("action", { enum: MODERATION_ACTIONS }).notNull(),
    targetUserId: text("target_user_id").references(() => user.id, { onDelete: "set null" }),
    requestId: integer("request_id").references(() => request.id, { onDelete: "set null" }),
    commentId: integer("comment_id").references(() => comment.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().default(now),
  },
  (t) => [index("moderation_log_target_user_idx").on(t.targetUserId)],
);

export const statusChange = sqliteTable(
  "status_change",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: integer("request_id")
      .notNull()
      .references(() => request.id, { onDelete: "cascade" }),
    fromStatus: text("from_status", { enum: STATUSES }).notNull(),
    toStatus: text("to_status", { enum: STATUSES }).notNull(),
    /** Null for automatic changes driven by GitHub. */
    actorId: text("actor_id").references(() => user.id),
    createdAt: timestamp("created_at").notNull().default(now),
  },
  (t) => [index("status_change_request_idx").on(t.requestId, t.id)],
);

export const ISSUE_STATES = ["pending", "processing", "created", "failed"] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

/**
 * One row per request: the durable issue-creation operation, the resulting
 * GitHub issue, and what the tracker has learned about its PR and releases.
 * The primary key prevents duplicate issues.
 */
export const githubIssue = sqliteTable(
  "github_issue",
  {
    requestId: integer("request_id")
      .primaryKey()
      .references(() => request.id, { onDelete: "cascade" }),
    state: text("state", { enum: ISSUE_STATES }).notNull().default("pending"),
    /** Unique marker embedded in the issue body, used to reconcile ambiguous failures. */
    ref: text("ref").notNull().unique(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().default(now),
    leaseUntil: timestamp("lease_until"),
    lastError: text("last_error"),
    issueNumber: integer("issue_number"),
    issueUrl: text("issue_url"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    mergeSha: text("merge_sha"),
    mergedAt: timestamp("merged_at"),
    nightlyTag: text("nightly_tag"),
    nightlyUrl: text("nightly_url"),
    releaseTag: text("release_tag"),
    releaseUrl: text("release_url"),
    releasedAt: timestamp("released_at"),
    checkedAt: timestamp("checked_at"),
    checkError: text("check_error"),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at").notNull().default(now),
    updatedAt: timestamp("updated_at").notNull().default(now),
  },
  (t) => [index("github_issue_due_idx").on(t.state, t.nextAttemptAt), index("github_issue_tracking_idx").on(t.state, t.releaseTag, t.checkedAt)],
);

export const PRODUCTS = ["kaneo", "mcp"] as const;
export type Product = (typeof PRODUCTS)[number];

/** Releases synced from GitHub for the changelog page. */
export const changelogRelease = sqliteTable(
  "changelog_release",
  {
    tag: text("tag").primaryKey(),
    product: text("product", { enum: PRODUCTS }).notNull(),
    version: text("version").notNull(),
    url: text("url").notNull(),
    publishedAt: timestamp("published_at").notNull(),
    /** Release notes exactly as published on GitHub; used to detect edits. */
    sourceBody: text("source_body").notNull(),
    /** Displayed notes (for MCP: built from commits plus the published text). */
    body: text("body").notNull(),
    bodyHtml: text("body_html").notNull(),
    /** Null until notes for MCP releases have been built from commits. */
    notesBuiltAt: timestamp("notes_built_at"),
    syncedAt: timestamp("synced_at").notNull().default(now),
  },
  (t) => [index("changelog_release_product_idx").on(t.product, t.publishedAt)],
);

export const NOTIFICATION_KINDS = ["status", "comment"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const EMAIL_STATES = ["pending", "sent", "skipped", "failed"] as const;
export type EmailState = (typeof EMAIL_STATES)[number];

/** Who follows which request. Authors, voters and commenters follow automatically. */
export const subscription = sqliteTable(
  "subscription",
  {
    requestId: integer("request_id")
      .notNull()
      .references(() => request.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** False after an explicit unfollow, so voting or commenting again doesn't resubscribe. */
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: timestamp("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.userId] }), index("subscription_user_idx").on(t.userId)],
);

export const notification = sqliteTable(
  "notification",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    requestId: integer("request_id")
      .notNull()
      .references(() => request.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    /** Null for automatic changes driven by GitHub. */
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    commentId: integer("comment_id").references(() => comment.id, { onDelete: "cascade" }),
    fromStatus: text("from_status", { enum: STATUSES }),
    toStatus: text("to_status", { enum: STATUSES }),
    readAt: timestamp("read_at"),
    /** Null when no email is wanted. */
    emailState: text("email_state", { enum: EMAIL_STATES }),
    emailAttempts: integer("email_attempts").notNull().default(0),
    createdAt: timestamp("created_at").notNull().default(now),
  },
  (t) => [
    index("notification_user_idx").on(t.userId, t.id),
    index("notification_unread_idx").on(t.userId, t.requestId).where(sql`read_at is null`),
    index("notification_email_idx").on(t.id).where(sql`email_state = 'pending'`),
    index("notification_request_idx").on(t.requestId),
    index("notification_created_idx").on(t.createdAt),
  ],
);

export type User = typeof user.$inferSelect;
export type Request = typeof request.$inferSelect;
export type Comment = typeof comment.$inferSelect;
export type GithubIssue = typeof githubIssue.$inferSelect;
export type ChangelogRelease = typeof changelogRelease.$inferSelect;
export type Label = typeof label.$inferSelect;
export type Report = typeof report.$inferSelect;
