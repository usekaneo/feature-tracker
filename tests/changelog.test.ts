import { afterEach, describe, expect, test } from "bun:test";
import { changelogRelease, githubIssue, request } from "../src/db/schema";
import { autolink, notesFromCommits } from "../src/github/changelog";
import { startFakeGitHub } from "./fake-github";
import { createUser, setup } from "./helpers";

let fake: ReturnType<typeof startFakeGitHub> | null = null;
afterEach(() => {
  fake?.stop();
  fake = null;
});

const day = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000).toISOString();

const KANEO_NOTES = `### Features

- make cross-column dragged card sortable: #1894
- **i18n:** add zh-TW locale: #1893

### Bug Fixes

- **web:** show the task label editor on narrow screens: #1924

### Credits

Huge thanks to @VictorOnwukwe and @tinsever for helping!`;

function seedReleases(f: ReturnType<typeof startFakeGitHub>) {
  f.releases.push(
    { tag: "v2.33.0", body: KANEO_NOTES, publishedAt: day(5), contains: [] },
    { tag: "v2.32.0", body: "### Features\n\n- older thing: #1800", publishedAt: day(3), contains: [] },
    { tag: "v2.34.0-rc.1", prerelease: true, body: "pre", publishedAt: day(6), contains: [] },
    { tag: "v2.35.0", draft: true, body: "draft", publishedAt: day(7), contains: [] },
    { tag: "planka-import-v0.2.0", body: "Published planka import", publishedAt: day(2), contains: [] },
    { tag: "mcp-v0.1.11", name: "@kaneo/mcp v0.1.11", body: "Published [@kaneo/mcp@0.1.11](https://www.npmjs.com/package/@kaneo/mcp/v/0.1.11) to npm.", publishedAt: day(-20), contains: [] },
    { tag: "mcp-v0.1.12", name: "@kaneo/mcp v0.1.12", body: "Published [@kaneo/mcp@0.1.12](https://www.npmjs.com/package/@kaneo/mcp/v/0.1.12) to npm.", publishedAt: day(1), contains: [] },
  );
  const old = { sha: "c1", message: "feat(mcp): list projects", date: day(-25), path: "packages/mcp/src/tools.ts" };
  f.setHistory("mcp-v0.1.11", [old]);
  f.setHistory("mcp-v0.1.12", [
    old,
    { sha: "c2", message: "feat(mcp): get tasks by ticket ID (#1839)\n\nLonger body", date: day(-2), path: "packages/mcp/src/tasks.ts" },
    { sha: "c3", message: "fix(mcp): support whoami with API keys (#1748)", date: day(-5), path: "packages/mcp/src/auth.ts" },
    { sha: "c4", message: "chore(deps): bump things", date: day(-4), path: "packages/mcp/package.json" },
    { sha: "c5", message: "fix(api,mcp): share tools", date: day(-3), path: "packages/mcp/src/shared.ts" },
  ]);
}

function world(env: Record<string, string> = {}) {
  fake = startFakeGitHub();
  seedReleases(fake);
  const ctx = setup({ CHANGELOG_REPO: fake.full, GITHUB_API_URL: fake.url, ...env });
  return { ctx, fake, sync: () => ctx.deps.changelog.sync() };
}

describe("changelog sync", () => {
  test("stores final Kaneo and MCP releases only, without needing a token", async () => {
    const w = world();
    await w.sync();
    const tags = w.ctx.deps.db.select({ tag: changelogRelease.tag, product: changelogRelease.product }).from(changelogRelease).all();
    expect(tags.sort((a, b) => a.tag.localeCompare(b.tag))).toEqual([
      { tag: "mcp-v0.1.11", product: "mcp" },
      { tag: "mcp-v0.1.12", product: "mcp" },
      { tag: "v2.32.0", product: "kaneo" },
      { tag: "v2.33.0", product: "kaneo" },
    ]);
    expect(w.fake.count("POST")).toBe(0);
  });

  test("Kaneo notes are rendered with linked PRs and people", async () => {
    const w = world();
    await w.sync();
    const res = await w.ctx.browser().get("/changelog");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">v2.33.0</a>");
    expect(html.indexOf("v2.33.0")).toBeLessThan(html.indexOf("v2.32.0"));
    expect(html).toContain(`<a href="https://github.com/${w.fake.full}/issues/1894" rel="nofollow ugc noopener noreferrer">#1894</a>`);
    expect(html).toContain(`<a href="https://github.com/tinsever" rel="nofollow ugc noopener noreferrer">@tinsever</a>`);
    expect(html).toContain("<h3>Bug Fixes</h3>");
    expect(html).not.toContain("mcp-v0.1.12");
    expect(html).not.toContain("planka");
    expect(html).not.toContain("v2.34.0-rc.1");
    expect(html).toContain('aria-current="page">Kaneo</a>');
  });

  test("MCP notes are built from the package's commits since the previous MCP release", async () => {
    const w = world();
    await w.sync();
    const html = await (await w.ctx.browser().get("/changelog?product=mcp")).text();
    expect(html).toContain('aria-current="page">MCP</a>');
    expect(html).toContain(">v0.1.12</a>");
    const latest = html.slice(html.indexOf('id="mcp-v0.1.12"'), html.indexOf('id="mcp-v0.1.11"'));
    expect(latest).toContain("<h3>Features</h3>");
    expect(latest).toContain("get tasks by ticket ID (");
    expect(latest).toContain(`issues/1839`);
    expect(latest).toContain("<h3>Bug Fixes</h3>");
    expect(latest).toContain("support whoami with API keys");
    expect(latest).toContain("<strong>api:</strong> share tools");
    expect(latest).not.toContain("bump things");
    expect(latest).not.toContain("list projects");
    expect(latest).toContain("to npm.");
    expect(html).not.toContain(">v2.33.0<");
  });

  test("edited notes on GitHub are picked up; unchanged releases are not rewritten", async () => {
    const w = world();
    await w.sync();
    const before = w.ctx.deps.db.select().from(changelogRelease).all();
    w.fake.releases.find((r) => r.tag === "v2.33.0")!.body = "Rewritten <script>alert(1)</script> notes";
    await w.sync();
    const after = w.ctx.deps.db.select().from(changelogRelease).all();
    const edited = after.find((r) => r.tag === "v2.33.0")!;
    expect(edited.bodyHtml).toContain("Rewritten");
    expect(edited.bodyHtml).not.toContain("<script");
    expect(after.find((r) => r.tag === "v2.32.0")!.syncedAt).toEqual(before.find((r) => r.tag === "v2.32.0")!.syncedAt);
  });

  test("lists feature requests that shipped in each release", async () => {
    const w = world();
    await w.sync();
    const author = await createUser(w.ctx.deps);
    const db = w.ctx.deps.db;
    const shipped = db.insert(request).values({ title: "Sortable columns", body: "x", bodyHtml: "x", authorId: author.id, status: "released" }).returning().get();
    const hidden = db.insert(request).values({ title: "Hidden one", body: "x", bodyHtml: "x", authorId: author.id, status: "released", hidden: true }).returning().get();
    for (const r of [shipped, hidden]) {
      db.insert(githubIssue).values({ requestId: r.id, ref: `ref-${r.id}`, requestedBy: author.id, state: "created", issueNumber: r.id, releaseTag: "v2.33.0" }).run();
    }
    const html = await (await w.ctx.browser().get("/changelog")).text();
    expect(html).toContain(`<a href="/requests/${shipped.id}" class="link">Sortable columns</a>`);
    expect(html).not.toContain("Hidden one");
  });

  test("paginates and keeps serving stored releases when GitHub is down", async () => {
    const w = world();
    for (let i = 0; i < 12; i++) w.fake.releases.push({ tag: `v1.${i}.0`, body: `old ${i}`, publishedAt: day(-100 + i), contains: [] });
    await w.sync();
    const first = await (await w.ctx.browser().get("/changelog")).text();
    expect(first).toContain('href="/changelog?page=2"');
    const second = await (await w.ctx.browser().get("/changelog?page=2")).text();
    expect(second).toContain(">v1.0.0</a>");

    w.fake.setDown(true);
    await expect(w.sync()).rejects.toThrow("503");
    expect((await w.ctx.browser().get("/changelog")).status).toBe(200);
    expect(await (await w.ctx.browser().get("/changelog")).text()).toContain(">v2.33.0</a>");
  });

  test("shows a short message when no repository is configured", async () => {
    const ctx = setup();
    const html = await (await ctx.browser().get("/changelog")).text();
    expect(html).toContain("Changelog isn&#39;t available yet.");
    expect(html).toContain('href="/changelog"');
  });
});

describe("changelog formatting", () => {
  const repo = "https://github.com/usekaneo/kaneo";

  test("autolinks references outside code and existing links", () => {
    expect(autolink("fix: #12 and @ada", repo)).toBe(`fix: [#12](${repo}/issues/12) and [@ada](https://github.com/ada)`);
    expect(autolink("`#12` [#13](https://x.y) https://x.y/#14 a@b.com", repo)).toBe("`#12` [#13](https://x.y) https://x.y/#14 a@b.com");
    expect(autolink("### Features", repo)).toBe("### Features");
    expect(autolink("```\n#12\n```\n#13", repo)).toBe(`\`\`\`\n#12\n\`\`\`\n[#13](${repo}/issues/13)`);
  });

  test("summarizes conventional commits", () => {
    const notes = notesFromCommits(
      [
        { sha: "a", message: "feat(mcp): new tool", url: "" },
        { sha: "b", message: "fix(web,mcp): bug", url: "" },
        { sha: "c", message: "docs: readme", url: "" },
        { sha: "d", message: "not conventional", url: "" },
      ],
      "mcp",
    );
    expect(notes).toBe("### Features\n\n- new tool\n\n### Bug Fixes\n\n- **web:** bug");
    expect(notesFromCommits([{ sha: "x", message: "chore: x", url: "" }], "mcp")).toBe("");
  });
});
