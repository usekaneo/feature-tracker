import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { LabelerConfig } from "../config";
import type { DB } from "../db/client";
import { autoLabelJob, label, request, requestLabel } from "../db/schema";
import type { Logger } from "../lib/logger";
import { assessRequest, isManagedName, LabelerError, suggestedNames, type LabelerFetch, type Scored } from "./assess";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const evidenceHash = (title: string, body: string) => createHash("sha256").update(JSON.stringify([title, body])).digest("hex");

export class AutoLabeler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = new Set<Promise<void>>();
  private now: () => number;

  constructor(private opts: { db: DB; provider: LabelerConfig | null; logger: Logger; fetcher?: LabelerFetch; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  get enabled() { return this.opts.provider !== null; }

  /** Called in the content transaction; identical edits and manual overrides cost no provider calls. */
  static enqueue(tx: Tx, requestId: number, force = false): boolean {
    const req = tx.select().from(request).where(eq(request.id, requestId)).get();
    if (!req || req.hidden) return false;
    const previous = tx.select().from(autoLabelJob).where(eq(autoLabelJob.requestId, requestId)).get();
    const hash = evidenceHash(req.title, req.body);
    if (!force && previous && (previous.manualOverride || previous.evidenceHash === hash)) return false;
    const values = {
      requestId, revision: crypto.randomUUID(), evidenceHash: hash, state: "pending" as const,
      attempts: 0, nextAttemptAt: new Date(0), leaseUntil: null, manualOverride: false,
      assessment: null, lastError: null, updatedAt: new Date(),
    };
    tx.insert(autoLabelJob).values(values).onConflictDoUpdate({ target: autoLabelJob.requestId, set: values }).run();
    return true;
  }

  /** Saving labels wins even when an assessment is currently in flight. */
  static override(tx: Tx, requestId: number) {
    const req = tx.select().from(request).where(eq(request.id, requestId)).get();
    if (!req) return;
    tx.insert(autoLabelJob).values({ requestId, revision: crypto.randomUUID(), evidenceHash: evidenceHash(req.title, req.body), state: "done", manualOverride: true })
      .onConflictDoUpdate({ target: autoLabelJob.requestId, set: { revision: crypto.randomUUID(), state: "done", manualOverride: true, leaseUntil: null, lastError: null, updatedAt: new Date() } }).run();
  }

  requeue(requestId: number) {
    if (!this.enabled) return false;
    return this.opts.db.transaction(tx => AutoLabeler.enqueue(tx, requestId, true), { behavior: "immediate" });
  }

  kick(requestId: number) { if (this.enabled) this.track(this.process(requestId)); }

  private track(work: Promise<void>) {
    const job = work.catch(() => this.opts.logger.error("Auto-labeler background job failed."))
      .finally(() => this.inflight.delete(job));
    this.inflight.add(job);
  }

  async idle() { while (this.inflight.size) await Promise.all([...this.inflight]); }

  start(intervalMs = 30_000) {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.track(this.processDue()), intervalMs);
    this.timer.unref?.();
    this.track(this.processDue());
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async processDue() {
    if (!this.enabled) return;
    const now = new Date(this.now());
    const rows = this.opts.db.select({ requestId: autoLabelJob.requestId }).from(autoLabelJob)
      .where(or(and(eq(autoLabelJob.state, "pending"), lte(autoLabelJob.nextAttemptAt, now)), and(eq(autoLabelJob.state, "processing"), lte(autoLabelJob.leaseUntil, now))))
      .orderBy(asc(autoLabelJob.nextAttemptAt)).limit(20).all();
    for (const row of rows) await this.process(row.requestId);
  }

  async process(requestId: number) {
    const { db, provider } = this.opts;
    if (!provider) return;
    const now = this.now();
    // Claim a new revision for every attempt, so an expired lease cannot apply a late response.
    const op = db.update(autoLabelJob).set({ state: "processing", revision: crypto.randomUUID(), attempts: sql`${autoLabelJob.attempts} + 1`, leaseUntil: new Date(now + LEASE_MS) })
      .where(and(eq(autoLabelJob.requestId, requestId), eq(autoLabelJob.manualOverride, false),
        or(and(eq(autoLabelJob.state, "pending"), lte(autoLabelJob.nextAttemptAt, new Date(now))), and(eq(autoLabelJob.state, "processing"), lte(autoLabelJob.leaseUntil, new Date(now))))))
      .returning().get();
    if (!op) return;
    const guard = and(eq(autoLabelJob.requestId, requestId), eq(autoLabelJob.revision, op.revision), eq(autoLabelJob.state, "processing"));
    const req = db.select().from(request).where(eq(request.id, requestId)).get();
    if (!req || req.hidden) {
      db.update(autoLabelJob).set({ state: "done", leaseUntil: null }).where(guard).run();
      return;
    }
    const areas = db.select({ id: label.id, name: label.name }).from(label).orderBy(asc(label.id)).all().filter(l => !isManagedName(l.name)).slice(0, 100);
    try {
      const scored = await assessRequest(provider, req, areas, this.opts.fetcher);
      db.transaction(tx => {
        const current = tx.select().from(autoLabelJob).where(guard).get();
        const latest = tx.select().from(request).where(eq(request.id, requestId)).get();
        if (!current || current.manualOverride) return;
        if (!latest || latest.hidden || evidenceHash(latest.title, latest.body) !== op.evidenceHash) {
          tx.update(autoLabelJob).set({ state: "done", leaseUntil: null }).where(guard).run();
          return;
        }
        this.apply(tx, requestId, current.managedLabelIds, scored);
        tx.update(autoLabelJob).set({ state: "done", assessment: scored, leaseUntil: null, lastError: null, updatedAt: new Date(this.now()) }).where(guard).run();
        tx.update(request).set({ updatedAt: new Date(this.now()) }).where(eq(request.id, requestId)).run();
      }, { behavior: "immediate" });
    } catch (error) {
      const retry = error instanceof LabelerError && error.retryable && op.attempts < MAX_ATTEMPTS;
      db.update(autoLabelJob).set({ state: retry ? "pending" : "failed", leaseUntil: null,
        nextAttemptAt: new Date(this.now() + Math.min(60_000 * 2 ** (op.attempts - 1), 60 * 60_000)),
        lastError: error instanceof LabelerError ? error.message : "Auto-labeling failed. Try again.", updatedAt: new Date(this.now()) }).where(guard).run();
    }
  }

  private apply(tx: Tx, requestId: number, previous: number[], scored: Scored) {
    // Only remove labels we actually added. Unrelated labels always survive a re-score.
    if (previous.length) tx.delete(requestLabel).where(and(eq(requestLabel.requestId, requestId), inArray(requestLabel.labelId, previous))).run();
    const ids: number[] = [];
    for (const name of suggestedNames(scored)) {
      tx.insert(label).values({ name }).onConflictDoNothing().run();
      const found = tx.select({ id: label.id }).from(label).where(sql`${label.name} = ${name} collate nocase`).get();
      if (found) ids.push(found.id);
    }
    if (scored.areaId && tx.select({ id: label.id }).from(label).where(eq(label.id, scored.areaId)).get()) ids.push(scored.areaId);
    const managed: number[] = [];
    for (const labelId of ids) {
      const added = tx.insert(requestLabel).values({ requestId, labelId }).onConflictDoNothing().returning().get();
      if (added) managed.push(labelId);
    }
    tx.update(autoLabelJob).set({ managedLabelIds: managed }).where(eq(autoLabelJob.requestId, requestId)).run();
  }
}
