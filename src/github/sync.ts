import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { githubIssue, request, statusChange, type GithubIssue, type Status } from "../db/schema";
import type { Logger } from "../lib/logger";
import { notifyStatus } from "../services/notifications";
import { GitHubClient, GitHubError, parseIssueNumber, type Issue, type Release } from "./client";

/** Long enough to cover the label check, a reconciliation lookup and the create call. */
const LEASE_MS = 120_000;
const MAX_AUTOMATIC_ATTEMPTS = 5;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const CHECK_BATCH = 50;

// Apply this before the batch limit so paused work cannot starve accepted requests.
const eligibleForCreation = sql`exists (
  select 1 from ${request}
  where ${request.id} = ${githubIssue.requestId}
    and ${request.hidden} = 0 and ${request.status} in ('accepted', 'in_progress')
)`;

/** Order of the statuses GitHub progress can move a request through. */
const PROGRESS_RANK: Partial<Record<Status, number>> = { accepted: 1, in_progress: 2, merged: 3, nightly: 4, released: 5 };

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export interface GitHubSyncOptions {
  db: DB;
  client: GitHubClient | null;
  appUrl: string;
  logger: Logger;
  now?: () => number;
  /** Called after a status change committed, to send notification emails. */
  onNotify?: () => void;
}

/**
 * Two jobs, both durable and outside SQLite transactions:
 *
 * 1. Issue creation outbox. Accepting a request inserts a row in the same
 *    transaction; the GitHub call happens afterwards. GitHub has no
 *    idempotency keys, so every issue body carries a unique ref, and any
 *    attempt after the first looks for that ref before creating. If the
 *    lookup fails, the operation waits and eventually lands in `failed` for
 *    maintainer review instead of risking a duplicate.
 *
 * 2. Progress tracking. Created issues are polled for linked pull requests
 *    merged into the default branch, then for nightly and final releases whose
 *    tag contains the merge commit. Statuses only ever move forward.
 */
export class GitHubSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<number>();
  private inflight = new Set<Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly opts: GitHubSyncOptions) {
    this.now = opts.now ?? Date.now;
  }

  get enabled() {
    return this.opts.client !== null;
  }

  get repoName() {
    return this.opts.client?.fullName ?? null;
  }

  /** Call inside the acceptance transaction. Never creates a second operation for a request. */
  static enqueue(tx: Tx, requestId: number, actorId: string) {
    tx.insert(githubIssue)
      // Due immediately, independent of clock skew between SQLite and the process.
      .values({ requestId, ref: `ft-${crypto.randomUUID()}`, requestedBy: actorId, nextAttemptAt: new Date(0) })
      .onConflictDoNothing({ target: githubIssue.requestId })
      .run();
  }

  /** Fire-and-forget issue creation after a commit. */
  kick(requestId: number) {
    if (this.enabled) this.track(this.process(requestId));
  }

  private track(work: Promise<unknown>) {
    const job = work
      .then(() => undefined)
      .catch((error) => this.opts.logger.error("GitHub sync failed", error))
      .finally(() => this.inflight.delete(job));
    this.inflight.add(job);
  }

  /** Resolves when all background jobs have finished. */
  async idle() {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /** Maintainer retry for failed operations. Returns false when there is nothing to retry. */
  retry(requestId: number): boolean {
    const now = new Date(this.now());
    const rows = this.opts.db
      .update(githubIssue)
      .set({ state: "pending", nextAttemptAt: now, updatedAt: now })
      .where(and(eq(githubIssue.requestId, requestId), eq(githubIssue.state, "failed")))
      .returning({ requestId: githubIssue.requestId })
      .all();
    return rows.length > 0;
  }

  /** Maintainer review: attach an existing issue, e.g. one found after an ambiguous failure. */
  async linkExisting(requestId: number, input: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const client = this.opts.client;
    if (!client) return { ok: false, error: "GitHub isn't configured." };
    const number = parseIssueNumber(input, client.fullName);
    if (!number) return { ok: false, error: `Enter an issue number or URL from ${client.fullName}.` };
    let issue: Issue;
    try {
      issue = await client.getIssue(number);
    } catch (error) {
      return { ok: false, error: error instanceof GitHubError ? error.message : "Couldn't reach GitHub." };
    }
    const now = new Date(this.now());
    const rows = this.opts.db
      .update(githubIssue)
      .set({ state: "created", issueNumber: issue.number, issueUrl: issue.url, lastError: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(githubIssue.requestId, requestId), or(eq(githubIssue.state, "failed"), eq(githubIssue.state, "pending"))))
      .returning({ requestId: githubIssue.requestId })
      .all();
    return rows.length ? { ok: true } : { ok: false, error: "This request already has an issue or is being processed." };
  }

  start(intervalMs = 30_000) {
    if (!this.enabled || this.timer) return;
    const sweep = () => this.track(this.processDue().then(() => this.checkDue()));
    this.timer = setInterval(sweep, intervalMs);
    this.timer.unref?.();
    sweep();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Issue creation

  /** Processes every due creation operation. */
  async processDue() {
    if (!this.enabled) return;
    const now = new Date(this.now());
    const due = this.opts.db
      .select({ requestId: githubIssue.requestId })
      .from(githubIssue)
      .where(
        and(eligibleForCreation, or(
          and(eq(githubIssue.state, "pending"), lte(githubIssue.nextAttemptAt, now)),
          and(eq(githubIssue.state, "processing"), lte(githubIssue.leaseUntil, now)),
        )),
      )
      .limit(20)
      .all();
    for (const { requestId } of due) await this.process(requestId);
  }

  /** Claims and processes one operation. Safe to call concurrently; only one caller wins the claim. */
  async process(requestId: number): Promise<void> {
    const client = this.opts.client;
    if (!client || this.running.has(requestId)) return;
    const op = this.claim(requestId);
    if (!op) return;
    this.running.add(requestId);
    try {
      await this.attempt(client, op);
    } finally {
      this.running.delete(requestId);
    }
  }

  private claim(requestId: number): GithubIssue | null {
    const now = this.now();
    // Atomic compare-and-set: a pending op that is due, or an in-flight op whose lease expired.
    const rows = this.opts.db
      .update(githubIssue)
      .set({ state: "processing", attempts: sql`${githubIssue.attempts} + 1`, leaseUntil: new Date(now + LEASE_MS), updatedAt: new Date(now) })
      .where(
        and(
          eq(githubIssue.requestId, requestId),
          eligibleForCreation,
          or(
            and(eq(githubIssue.state, "pending"), lte(githubIssue.nextAttemptAt, new Date(now))),
            and(eq(githubIssue.state, "processing"), lte(githubIssue.leaseUntil, new Date(now))),
          ),
        ),
      )
      .returning()
      .all();
    return rows[0] ?? null;
  }

  private async attempt(client: GitHubClient, op: GithubIssue) {
    try {
      await client.ensureLabel();
      // Every attempt after the first may follow one whose outcome is unknown.
      let issue = op.attempts > 1 ? await client.findIssueByRef(op.ref, op.createdAt) : null;
      if (!issue) {
        // Moderation and edits can happen during the preceding network calls.
        // Read current evidence immediately before sending it to GitHub.
        const req = this.opts.db.select().from(request).where(eq(request.id, op.requestId)).get();
        if (!req || req.hidden || !["accepted", "in_progress"].includes(req.status)) {
          this.opts.db.update(githubIssue)
            .set({ state: "pending", attempts: op.attempts - 1, leaseUntil: null,
              lastError: "Issue creation paused while the request is hidden or not accepted.", updatedAt: new Date(this.now()) })
            .where(and(eq(githubIssue.requestId, op.requestId), eq(githubIssue.state, "processing"), eq(githubIssue.attempts, op.attempts)))
            .run();
          return;
        }
        issue = await client.createIssue({ title: req.title, body: this.issueBody(req, op.ref) });
      }
      const now = new Date(this.now());
      this.opts.db
        .update(githubIssue)
        .set({ state: "created", issueNumber: issue.number, issueUrl: issue.url, lastError: null, leaseUntil: null, updatedAt: now })
        .where(and(eq(githubIssue.requestId, op.requestId), eq(githubIssue.state, "processing"), eq(githubIssue.attempts, op.attempts)))
        .run();
    } catch (error) {
      this.fail(op, error);
    }
  }

  private issueBody(req: { id: number; body: string }, ref: string) {
    const url = `${this.opts.appUrl}/requests/${req.id}`;
    return `${req.body.trim()}\n\n---\n\nRequested on Feature Track: ${url}\n\n<!-- feature-track-ref: ${ref} -->`;
  }

  private fail(op: GithubIssue, error: unknown) {
    const ghError = error instanceof GitHubError ? error : null;
    if (!ghError) this.opts.logger.error("Unexpected GitHub sync error", error);
    const kind = ghError?.kind ?? "ambiguous";
    const message = ghError?.message ?? "Unexpected error";
    const giveUp = kind === "rejected" || op.attempts >= MAX_AUTOMATIC_ATTEMPTS;
    const now = this.now();
    const delay = BACKOFF_MS[Math.min(op.attempts - 1, BACKOFF_MS.length - 1)] ?? 60_000;
    this.opts.db
      .update(githubIssue)
      .set({
        state: giveUp ? "failed" : "pending",
        nextAttemptAt: new Date(now + delay),
        leaseUntil: null,
        lastError: kind === "ambiguous" && giveUp ? `${message}. The issue may exist; retrying checks for it first.` : message,
        updatedAt: new Date(now),
      })
      .where(and(eq(githubIssue.requestId, op.requestId), eq(githubIssue.state, "processing"), eq(githubIssue.attempts, op.attempts)))
      .run();
  }

  // Progress tracking

  /** Checks created issues that haven't reached a final release and weren't checked recently. */
  async checkDue() {
    const client = this.opts.client;
    if (!client) return;
    const staleBefore = new Date(this.now() - client.config.syncIntervalMs + 1000);
    const rows = this.opts.db
      .select({ row: githubIssue })
      .from(githubIssue)
      .innerJoin(request, eq(request.id, githubIssue.requestId))
      .where(
        and(
          eq(githubIssue.state, "created"),
          isNull(githubIssue.releaseTag),
          ne(request.status, "declined"),
          or(isNull(githubIssue.checkedAt), lte(githubIssue.checkedAt, staleBefore)),
        ),
      )
      .orderBy(asc(githubIssue.checkedAt))
      .limit(CHECK_BATCH)
      .all()
      .map((r) => r.row);
    let releases: Promise<Release[]> | null = null;
    const listReleases = () => (releases ??= client.listReleases());
    for (const row of rows) await this.checkRow(client, row, listReleases);
  }

  /** Immediate check for one request ("Check now"). */
  async check(requestId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const client = this.opts.client;
    if (!client) return { ok: false, error: "GitHub isn't configured." };
    const row = this.opts.db.select().from(githubIssue).where(eq(githubIssue.requestId, requestId)).get();
    if (row?.state !== "created") return { ok: false, error: "There is no issue to check yet." };
    const error = await this.checkRow(client, row, () => client.listReleases());
    return error ? { ok: false, error } : { ok: true };
  }

  private async checkRow(client: GitHubClient, row: GithubIssue, listReleases: () => Promise<Release[]>): Promise<string | null> {
    const now = new Date(this.now());
    try {
      const progress = await client.getProgress(row.issueNumber!);
      const prs = progress.pullRequests.filter(
        (pr) => pr.repository.toLowerCase() === client.fullName.toLowerCase() && pr.baseRefName === progress.defaultBranch,
      );
      const merged = prs
        .filter((pr) => pr.merged && pr.mergeSha && pr.mergedAt)
        .sort((a, b) => Date.parse(b.mergedAt!) - Date.parse(a.mergedAt!))[0];
      const open = prs.find((pr) => pr.state === "OPEN");

      const update: Partial<typeof githubIssue.$inferInsert> = { checkedAt: now, checkError: null };
      let target: Status | null = null;
      if (merged) {
        const sameMerge = row.mergeSha === merged.mergeSha;
        Object.assign(update, { prNumber: merged.number, prUrl: merged.url, mergeSha: merged.mergeSha, mergedAt: new Date(merged.mergedAt!) });
        target = "merged";
        const found = await this.findReleases(client, await listReleases(), merged.mergeSha!, new Date(merged.mergedAt!), sameMerge ? row.nightlyTag : null);
        if (found.nightly) Object.assign(update, { nightlyTag: found.nightly.tag, nightlyUrl: found.nightly.url });
        else if (!sameMerge) Object.assign(update, { nightlyTag: null, nightlyUrl: null });
        if (found.nightly || (sameMerge && row.nightlyTag)) target = "nightly";
        if (found.release) {
          Object.assign(update, { releaseTag: found.release.tag, releaseUrl: found.release.url, releasedAt: now });
          target = "released";
        }
      } else if (open) {
        Object.assign(update, { prNumber: open.number, prUrl: open.url });
        target = "in_progress";
      }

      this.opts.db.update(githubIssue).set(update).where(eq(githubIssue.requestId, row.requestId)).run();
      if (target) this.advance(row.requestId, target);
      return null;
    } catch (error) {
      const message = error instanceof GitHubError ? error.message : "Unexpected error";
      if (!(error instanceof GitHubError)) this.opts.logger.error("GitHub progress check failed", error);
      this.opts.db.update(githubIssue).set({ checkedAt: now, checkError: message }).where(eq(githubIssue.requestId, row.requestId)).run();
      return message;
    }
  }

  /** First final release containing the merge, and a nightly containing it if no final release does yet. */
  private async findReleases(client: GitHubClient, releases: Release[], sha: string, mergedAt: Date, knownNightly: string | null) {
    const { releaseTag, nightlyTag } = client.config;
    const stable = releases
      .filter((r) => !r.prerelease && releaseTag.test(r.tag) && (!r.publishedAt || Date.parse(r.publishedAt) >= mergedAt.getTime()))
      .sort((a, b) => Date.parse(a.publishedAt ?? "") - Date.parse(b.publishedAt ?? ""))
      .slice(0, 5);
    for (const candidate of stable) {
      if (await client.tagContains(candidate.tag, sha)) return { release: candidate, nightly: null };
    }
    if (knownNightly) return { release: null, nightly: null };
    // Nightly tags may be rolling (moved daily), so their publish date says nothing; check the newest few.
    const nightlies = releases
      .filter((r) => nightlyTag.test(r.tag) && !(releaseTag.test(r.tag) && !r.prerelease))
      .sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""))
      .slice(0, 3);
    for (const candidate of nightlies) {
      if (await client.tagContains(candidate.tag, sha)) return { release: null, nightly: candidate };
    }
    return { release: null, nightly: null };
  }

  /** Moves a request forward along accepted → in progress → merged → nightly → released. */
  advance(requestId: number, target: Status): boolean {
    const advanced = this.opts.db.transaction(
      (tx) => {
        const current = tx.select({ status: request.status }).from(request).where(eq(request.id, requestId)).get();
        const from = current ? PROGRESS_RANK[current.status] : undefined;
        const to = PROGRESS_RANK[target];
        // Open and declined are maintainer decisions; automation never overrides them.
        if (!current || from === undefined || to === undefined || to <= from) return false;
        const now = new Date(this.now());
        tx.update(request).set({ status: target, updatedAt: now, lastActivityAt: now }).where(eq(request.id, requestId)).run();
        tx.insert(statusChange).values({ requestId, fromStatus: current.status, toStatus: target, actorId: null, createdAt: now }).run();
        notifyStatus(tx, { requestId, fromStatus: current.status, toStatus: target, actorId: null, at: now });
        return true;
      },
      { behavior: "immediate" },
    );
    if (advanced) this.opts.onNotify?.();
    return advanced;
  }
}
