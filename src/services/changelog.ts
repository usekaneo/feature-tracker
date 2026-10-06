import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "../db/client";
import { changelogRelease, githubIssue, request, type Product } from "../db/schema";

export const CHANGELOG_PAGE_SIZE = 10;

export function listChangelog(db: DB, product: Product, page: number) {
  const rows = db
    .select({
      tag: changelogRelease.tag,
      version: changelogRelease.version,
      url: changelogRelease.url,
      publishedAt: changelogRelease.publishedAt,
      bodyHtml: changelogRelease.bodyHtml,
    })
    .from(changelogRelease)
    .where(eq(changelogRelease.product, product))
    .orderBy(desc(changelogRelease.publishedAt))
    .limit(CHANGELOG_PAGE_SIZE + 1)
    .offset((page - 1) * CHANGELOG_PAGE_SIZE)
    .all();
  const items = rows.slice(0, CHANGELOG_PAGE_SIZE);
  return { items, hasNext: rows.length > CHANGELOG_PAGE_SIZE, requests: releasedRequests(db, items.map((r) => r.tag)) };
}

/** Public feature requests whose GitHub issue shipped in each release tag. */
function releasedRequests(db: DB, tags: string[]) {
  const map = new Map<string, { id: number; title: string }[]>();
  if (!tags.length) return map;
  const rows = db
    .select({ tag: githubIssue.releaseTag, id: request.id, title: request.title })
    .from(githubIssue)
    .innerJoin(request, eq(request.id, githubIssue.requestId))
    .where(and(inArray(githubIssue.releaseTag, tags), eq(request.hidden, false)))
    .orderBy(asc(request.id))
    .all();
  for (const { tag, ...r } of rows) map.set(tag!, [...(map.get(tag!) ?? []), r]);
  return map;
}
