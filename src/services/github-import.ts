import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db/client";
import { comment, githubIssue, label, request, requestLabel, user } from "../db/schema";
import { renderMarkdown } from "../lib/markdown";
import { AutoLabeler } from "../labeler/worker";

const author = z.object({ login: z.string().regex(/^(?:app\/)?[A-Za-z0-9_-]+(?:\[bot\])?$/) });
const date = z.string().datetime();
const snapshotSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  issues: z.array(z.object({
    number: z.number().int().positive(), title: z.string().min(1).max(300), body: z.string(),
    url: z.string().url(), author, createdAt: date, updatedAt: date,
    labels: z.array(z.object({ name: z.string().min(1).max(100) })),
    comments: z.array(z.object({ id: z.number().int().positive(), body: z.string(), author, createdAt: date, updatedAt: date, url: z.string().url() })),
  })),
});

/** Snapshot copy only: no network calls, auth identities, subscriptions or outboxes. */
export function importGitHubFeatures(db: DB, raw: unknown, appUrl: string) {
  const snapshot = snapshotSchema.parse(raw);
  const numbers = new Set<number>();
  for (const issue of snapshot.issues) {
    if (numbers.has(issue.number)) throw new Error("Duplicate source issue");
    numbers.add(issue.number);
    if (issue.url !== `https://github.com/${snapshot.repo}/issues/${issue.number}`) throw new Error("Unexpected source URL");
    if (!issue.labels.some(l => l.name === "enhancement") && !/^feat[:(]/i.test(issue.title)) throw new Error("Source is not a feature request");
    for (const c of issue.comments) if (c.url !== `${issue.url}#issuecomment-${c.id}`) throw new Error("Unexpected comment URL");
  }
  return db.transaction(tx => {
    const createdUsers: string[] = [];
    const createdLabels: number[] = [];
    const identities = new Map<string, string>();
    const importedAuthor = (login: string, createdAt: Date) => {
      const cached = identities.get(login);
      if (cached) return cached;
      const id = `github-import:${snapshot.repo}:${login}`;
      const existing = tx.select().from(user).where(eq(user.id, id)).get();
      if (!existing) {
        // Inert historical attribution. Real OAuth logins retain their own account.
        const hash = createHash("sha256").update(id).digest("hex").slice(0, 24);
        tx.insert(user).values({ id, name: `${login} (GitHub)`, email: `${hash}@github-import.invalid`, emailVerified: false,
          role: "user", emailOnStatus: false, emailOnComment: false, createdAt, updatedAt: createdAt }).run();
        createdUsers.push(id);
      }
      identities.set(login, id);
      return id;
    };
    const mappings = snapshot.issues.map(issue => {
      const ref = `github-import:${snapshot.repo}:${issue.number}`;
      const existing = tx.select().from(githubIssue).where(eq(githubIssue.ref, ref)).get();
      if (existing) return { sourceNumber: issue.number, sourceUrl: issue.url, requestId: existing.requestId,
        targetUrl: `${appUrl}/requests/${existing.requestId}`, created: false, comments: 0 };
      const createdAt = new Date(issue.createdAt), updatedAt = new Date(issue.updatedAt);
      const authorId = importedAuthor(issue.author.login, createdAt);
      const body = `${issue.body}\n\n---\n\nOriginally requested by [@${issue.author.login}](https://github.com/${issue.author.login.startsWith("app/") ? `apps/${issue.author.login.slice(4)}` : issue.author.login}) on ${issue.createdAt.slice(0, 10)}. [Original GitHub request #${issue.number}](${issue.url}).`;
      const row = tx.insert(request).values({ title: issue.title, body, bodyHtml: renderMarkdown(body), authorId,
        createdAt, updatedAt, lastActivityAt: updatedAt, commentCount: issue.comments.length }).returning({ id: request.id }).get();
      tx.insert(githubIssue).values({ requestId: row.id, ref, state: "created", issueNumber: issue.number, issueUrl: issue.url,
        requestedBy: authorId, createdAt, updatedAt }).run();
      for (const l of issue.labels) {
        const inserted = tx.insert(label).values({ name: l.name }).onConflictDoNothing().returning({ id: label.id }).get();
        if (inserted) createdLabels.push(inserted.id);
        const found = inserted ?? tx.select({ id: label.id }).from(label).where(sql`lower(${label.name}) = ${l.name.toLowerCase()}`).get();
        if (!found) throw new Error("Imported label unavailable");
        tx.insert(requestLabel).values({ requestId: row.id, labelId: found.id }).onConflictDoNothing().run();
      }
      // Preserve upstream decisions and avoid provider calls during quiet copying.
      AutoLabeler.override(tx, row.id);
      for (const c of issue.comments) {
        const body = `${c.body}\n\n[Original GitHub comment](${c.url})`;
        tx.insert(comment).values({ requestId: row.id, authorId: importedAuthor(c.author.login, new Date(c.createdAt)),
          body, bodyHtml: renderMarkdown(body), createdAt: new Date(c.createdAt),
          editedAt: c.updatedAt !== c.createdAt ? new Date(c.updatedAt) : null }).run();
      }
      return { sourceNumber: issue.number, sourceUrl: issue.url, requestId: row.id,
        targetUrl: `${appUrl}/requests/${row.id}`, created: true, comments: issue.comments.length };
    });
    return { repo: snapshot.repo, mappings, createdUsers, createdLabels };
  }, { behavior: "immediate" });
}
