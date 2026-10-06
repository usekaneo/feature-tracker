import { and, asc, count, desc, eq, isNull, lt } from "drizzle-orm";
import type { ChangelogConfig } from "../config";
import type { DB } from "../db/client";
import { changelogRelease, type Product } from "../db/schema";
import type { Logger } from "../lib/logger";
import { renderMarkdown } from "../lib/markdown";
import { GitHubClient, type Commit, type ReleaseNotes } from "./client";

const DAY = 86_400_000;
const SECTIONS: [type: string, heading: string][] = [
  ["feat", "Features"],
  ["fix", "Bug Fixes"],
  ["perf", "Performance"],
];

/**
 * Turns `#123` and `@user` into links, leaving code, existing links and URLs alone.
 * Fenced code blocks are skipped entirely.
 */
export function autolink(markdown: string, repoWebUrl: string): string {
  const origin = new URL(repoWebUrl).origin;
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced || /^\s*(```|~~~)/.test(line)) return line;
      return line
        .split(/(`[^`]*`|\[[^\]]*\]\([^)]*\)|<[^>]+>|https?:\/\/\S+)/)
        .map((part, i) =>
          i % 2 === 1
            ? part
            : part
                .replace(/(^|[^\w/&#])#(\d{1,7})\b/g, (_m, pre: string, n: string) => `${pre}[#${n}](${repoWebUrl}/issues/${n})`)
                .replace(/(^|[^\w/`@])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\b/g, (_m, pre: string, u: string) => `${pre}[@${u}](${origin}/${u})`),
        )
        .join("");
    })
    .join("\n");
}

/** Release-notes style summary of conventional commits; returns "" when nothing user-facing changed. */
export function notesFromCommits(commits: Commit[], packageScope: string): string {
  const sections = new Map<string, string[]>();
  for (const commit of commits) {
    const subject = commit.message.split("\n")[0]!.trim();
    const match = subject.match(/^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/);
    if (!match) continue;
    const [, type, scopes = "", text] = match;
    if (!SECTIONS.some(([t]) => t === type)) continue;
    const scope = scopes
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && s !== packageScope)
      .join(", ");
    const list = sections.get(type!) ?? [];
    list.push(`- ${scope ? `**${scope}:** ` : ""}${text}`);
    sections.set(type!, list);
  }
  return SECTIONS.filter(([t]) => sections.has(t))
    .map(([t, heading]) => `### ${heading}\n\n${sections.get(t)!.join("\n")}`)
    .join("\n\n");
}

export interface ChangelogSyncOptions {
  db: DB;
  client: GitHubClient | null;
  config: ChangelogConfig | null;
  logger: Logger;
  now?: () => number;
}

/** Copies Kaneo and MCP releases from GitHub into SQLite so the changelog never waits on GitHub. */
export class ChangelogSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: ChangelogSyncOptions) {
    this.now = opts.now ?? Date.now;
  }

  get enabled() {
    return this.opts.client !== null;
  }

  get repoName() {
    return this.opts.client?.fullName ?? null;
  }

  start() {
    if (!this.opts.client || !this.opts.config || this.timer) return;
    const run = () => {
      this.sync().catch((error) => this.opts.logger.error("Changelog sync failed", error));
    };
    this.timer = setInterval(run, this.opts.config.syncIntervalMs);
    this.timer.unref?.();
    run();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async idle() {
    await this.current?.catch(() => undefined);
  }

  /** One sync at a time; concurrent callers share the running one. */
  sync(): Promise<void> {
    this.current ??= this.run().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private productOf(release: ReleaseNotes): Product | null {
    const { client, config } = this.opts;
    if (!client || !config || release.draft || release.prerelease || !release.publishedAt) return null;
    if (client.config.releaseTag.test(release.tag)) return "kaneo";
    if (config.mcpTag.test(release.tag)) return "mcp";
    return null;
  }

  private async run() {
    const { client, db } = this.opts;
    if (!client) return;
    const stored = db.select({ n: count() }).from(changelogRelease).get()?.n ?? 0;
    // Backfill everything once; afterwards only the newest pages can change.
    const maxPages = stored === 0 ? 20 : 2;
    for (let page = 1; page <= maxPages; page++) {
      const releases = await client.listReleaseNotes(page);
      for (const release of releases) this.store(release);
      if (releases.length < 100) break;
    }
    await this.buildMcpNotes();
  }

  private store(release: ReleaseNotes) {
    const product = this.productOf(release);
    if (!product) return;
    const db = this.opts.db;
    const existing = db.select().from(changelogRelease).where(eq(changelogRelease.tag, release.tag)).get();
    if (existing && existing.sourceBody === release.body && existing.url === release.url) return;
    const now = new Date(this.now());
    const values = {
      product,
      version: release.tag.replace(/^[a-z-]*?(?=v\d)/i, ""),
      url: release.url,
      publishedAt: new Date(release.publishedAt!),
      sourceBody: release.body,
      body: release.body,
      bodyHtml: this.render(release.body, release.url),
      // MCP notes are rebuilt from commits whenever the published text changes.
      notesBuiltAt: product === "mcp" ? null : now,
      syncedAt: now,
    };
    db.insert(changelogRelease)
      .values({ tag: release.tag, ...values })
      .onConflictDoUpdate({ target: changelogRelease.tag, set: values })
      .run();
  }

  private render(markdown: string, releaseUrl: string) {
    return renderMarkdown(autolink(markdown, releaseUrl.replace(/\/releases\/tag\/.*$/, "")));
  }

  /** MCP releases are published with a generic note; list the package's user-facing commits instead. */
  private async buildMcpNotes() {
    const { client, config, db } = this.opts;
    if (!client || !config) return;
    const pending = db
      .select()
      .from(changelogRelease)
      .where(and(eq(changelogRelease.product, "mcp"), isNull(changelogRelease.notesBuiltAt)))
      .orderBy(asc(changelogRelease.publishedAt))
      .limit(10)
      .all();
    const packageScope = config.mcpPath.split("/").at(-1) ?? "mcp";
    for (const release of pending) {
      const previous = db
        .select()
        .from(changelogRelease)
        .where(and(eq(changelogRelease.product, "mcp"), lt(changelogRelease.publishedAt, release.publishedAt)))
        .orderBy(desc(changelogRelease.publishedAt))
        .limit(1)
        .get();
      // Commits in this tag but not in the previous one. The date window only bounds the
      // listing; the set difference makes it exact for commits merged out of date order.
      const since = previous ? new Date(previous.publishedAt.getTime() - 30 * DAY) : undefined;
      const commits = await client.listCommits({ ref: release.tag, path: config.mcpPath, since, limit: previous ? 100 : 30 });
      const known = previous ? new Set((await client.listCommits({ ref: previous.tag, path: config.mcpPath, since })).map((c) => c.sha)) : new Set();
      const notes = notesFromCommits(
        commits.filter((c) => !known.has(c.sha)),
        packageScope,
      );
      const body = notes ? `${notes}\n\n${release.sourceBody}`.trim() : release.sourceBody;
      db.update(changelogRelease)
        .set({ body, bodyHtml: this.render(body, release.url), notesBuiltAt: new Date(this.now()) })
        .where(eq(changelogRelease.tag, release.tag))
        .run();
    }
  }
}
