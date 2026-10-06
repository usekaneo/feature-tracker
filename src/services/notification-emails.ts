import { and, asc, eq, gt, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DB } from "../db/client";
import { comment, githubIssue, notification, request, subscription, user } from "../db/schema";
import type { Logger } from "../lib/logger";
import type { Mailer } from "../lib/mailer";
import { plainText } from "../lib/markdown";
import { STATUS_LABELS } from "../views/components";
import { unfollowUrl } from "./notifications";

const BATCH = 50;
const MAX_ATTEMPTS = 5;
/** Older queued emails are dropped, e.g. after SMTP was down or unconfigured for a while. */
const STALE_MS = 2 * 24 * 60 * 60_000;
/** Notifications are kept this long, read or not. */
const RETENTION_MS = 180 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;

export interface NotificationEmailsOptions {
  db: DB;
  mailer: Mailer;
  appUrl: string;
  secret: string;
  logger: Logger;
  now?: () => number;
}

const actor = alias(user, "actor");

/**
 * Sends queued notification emails after the transaction that created them
 * committed. Rows stay `pending` until sent, so a sweep picks up anything a
 * restart interrupted. A crash between sending and recording can repeat one
 * email; that's preferred over losing it.
 */
export class NotificationEmails {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private lastPrune = 0;
  private readonly now: () => number;

  constructor(private readonly opts: NotificationEmailsOptions) {
    this.now = opts.now ?? Date.now;
  }

  get enabled() {
    return this.opts.mailer.transport !== "disabled";
  }

  /** Fire-and-forget delivery after a commit. Coalesces with a run already in progress. */
  kick() {
    if (!this.enabled) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.sendDue();
      } while (this.again);
    })()
      .catch((error) => this.opts.logger.error("Notification emails failed", error))
      .finally(() => {
        this.running = null;
      });
  }

  /** Resolves when no delivery run is in progress. */
  async idle() {
    while (this.running) await this.running;
  }

  start(intervalMs = 60_000) {
    if (this.timer) return;
    const sweep = () => {
      this.prune();
      this.kick();
    };
    this.timer = setInterval(sweep, intervalMs);
    this.timer.unref?.();
    sweep();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Sends every pending email once; failures are retried by later sweeps. */
  async sendDue() {
    let afterId = 0;
    for (;;) {
      const rows = this.due(afterId);
      for (const row of rows) await this.deliver(row);
      if (rows.length < BATCH) return;
      afterId = rows.at(-1)!.id;
    }
  }

  private due(afterId: number) {
    return this.opts.db
      .select({
        id: notification.id,
        kind: notification.kind,
        userId: notification.userId,
        requestId: notification.requestId,
        commentId: notification.commentId,
        fromStatus: notification.fromStatus,
        toStatus: notification.toStatus,
        attempts: notification.emailAttempts,
        createdAt: notification.createdAt,
        to: user.email,
        emailOnStatus: user.emailOnStatus,
        emailOnComment: user.emailOnComment,
        title: request.title,
        currentStatus: request.status,
        requestHidden: request.hidden,
        commentHtml: comment.bodyHtml,
        commentHidden: comment.hidden,
        actorName: actor.name,
        following: subscription.active,
        nightlyTag: githubIssue.nightlyTag,
        nightlyUrl: githubIssue.nightlyUrl,
        releaseTag: githubIssue.releaseTag,
        releaseUrl: githubIssue.releaseUrl,
      })
      .from(notification)
      .innerJoin(user, eq(user.id, notification.userId))
      .innerJoin(request, eq(request.id, notification.requestId))
      .leftJoin(comment, eq(comment.id, notification.commentId))
      .leftJoin(actor, eq(actor.id, notification.actorId))
      .leftJoin(subscription, and(eq(subscription.requestId, notification.requestId), eq(subscription.userId, notification.userId)))
      .leftJoin(githubIssue, eq(githubIssue.requestId, notification.requestId))
      .where(and(eq(notification.emailState, "pending"), gt(notification.id, afterId)))
      .orderBy(asc(notification.id))
      .limit(BATCH)
      .all();
  }

  private async deliver(row: ReturnType<NotificationEmails["due"]>[number]) {
    const { db, mailer, logger } = this.opts;
    const set = (values: Partial<typeof notification.$inferInsert>) => db.update(notification).set(values).where(eq(notification.id, row.id)).run();

    // Re-checked at send time: things may have changed since the notification was created.
    const skip =
      row.createdAt.getTime() < this.now() - STALE_MS ||
      row.requestHidden ||
      row.commentHidden === true ||
      !row.following ||
      !(row.kind === "status" ? row.emailOnStatus : row.emailOnComment) ||
      // A later change superseded this one and has its own notification.
      (row.kind === "status" && row.currentStatus !== row.toStatus);
    if (skip) return set({ emailState: "skipped" });

    try {
      await mailer.send({ to: row.to, ...this.compose(row) });
      set({ emailState: "sent", emailAttempts: row.attempts + 1 });
    } catch (error) {
      logger.error(`Notification email ${row.id} failed`, error);
      const attempts = row.attempts + 1;
      set({ emailState: attempts >= MAX_ATTEMPTS ? "failed" : "pending", emailAttempts: attempts });
    }
  }

  private compose(row: ReturnType<NotificationEmails["due"]>[number]): { subject: string; text: string } {
    const { appUrl, secret } = this.opts;
    const url = `${appUrl}/requests/${row.requestId}`;
    const footer = [
      "You're receiving this because you follow this request.",
      `Unfollow: ${unfollowUrl(appUrl, secret, row.userId, row.requestId)}`,
      `Email settings: ${appUrl}/notifications`,
    ].join("\n");

    if (row.kind === "comment") {
      const who = row.actorName ?? "Someone";
      return {
        subject: `New comment on "${row.title}"`,
        text: `${who} commented on "${row.title}":\n\n${plainText(row.commentHtml ?? "", 1000)}\n\n${url}#comment-${row.commentId}\n\n--\n${footer}`,
      };
    }

    const to = STATUS_LABELS[row.toStatus!];
    const from = STATUS_LABELS[row.fromStatus!];
    const lines = [row.actorName ? `${row.actorName} moved "${row.title}" from ${from} to ${to}.` : `"${row.title}" moved from ${from} to ${to}.`];
    if (row.toStatus === "released" && row.releaseUrl) lines.push(`Released in ${row.releaseTag}: ${row.releaseUrl}`);
    if (row.toStatus === "nightly" && row.nightlyUrl) lines.push(`Available in ${row.nightlyTag}: ${row.nightlyUrl}`);
    return { subject: `"${row.title}" is now ${to}`, text: `${lines.join("\n")}\n\n${url}\n\n--\n${footer}` };
  }

  /** Deletes old notifications at most once a day. */
  prune() {
    const now = this.now();
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    this.opts.db.delete(notification).where(lt(notification.createdAt, new Date(now - RETENTION_MS))).run();
  }
}
