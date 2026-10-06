import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { githubIssue, request } from "../src/db/schema";
import { GitHubClient, GitHubError, parseIssueNumber, type FetchLike } from "../src/github/client";
import { loadConfig } from "../src/config";
import { createRequest, setStatus as changeStatus, updateRequest } from "../src/services/requests";
import { setRequestHidden } from "../src/services/moderation";
import { startFakeGitHub } from "./fake-github";
import { ORIGIN, setup, signedIn, submitRequest } from "./helpers";

let fake: ReturnType<typeof startFakeGitHub> | null = null;
afterEach(() => {
  fake?.stop();
  fake = null;
});

const SHA = "8a3235fca1df4b05a928b3ae40fc2ebb1b72e344";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function world(env: Record<string, string> = {}, opts: { githubFetch?: FetchLike } = {}) {
  let transactionDuringCall = false;
  let sqliteRef: { inTransaction: boolean } | null = null;
  const clock = { now: Date.now() };
  fake = startFakeGitHub({
    onCreate: () => {
      if (sqliteRef?.inTransaction) transactionDuringCall = true;
    },
  });
  const ctx = setup(
    { GITHUB_REPO: fake.full, GITHUB_TOKEN: fake.token, GITHUB_API_URL: fake.url, ...env },
    { now: () => clock.now, ...opts },
  );
  sqliteRef = ctx.deps.sqlite;
  const author = await signedIn(ctx);
  const maya = await signedIn(ctx, "maintainer");
  const id = await submitRequest(author.browser, "Recurring tasks", "Repeat a task **every week**.");
  await maya.browser.get(`/requests/${id}`);
  const row = () => ctx.deps.db.select().from(githubIssue).where(eq(githubIssue.requestId, id)).get();
  const status = () => ctx.deps.db.select({ s: request.status }).from(request).where(eq(request.id, id)).get()!.s;
  const setStatus = async (value = "accepted") => {
    const res = await maya.browser.post(`/requests/${id}/status`, { status: value });
    expect(res.status).toBe(303);
  };
  const settle = () => ctx.deps.issues.idle();
  const later = async (ms: number) => {
    clock.now += ms;
    await ctx.deps.issues.processDue();
  };
  const check = async (ms = 10 * 60_000) => {
    clock.now += ms;
    await ctx.deps.issues.checkDue();
  };
  /** Accept and wait for the issue to exist; returns its number. */
  const acceptAndCreate = async () => {
    await setStatus("accepted");
    await settle();
    expect(row()!.state).toBe("created");
    return row()!.issueNumber!;
  };
  return { ctx, fake: fake!, author, maya, id, row, status, setStatus, settle, later, check, acceptAndCreate, transactionDuringCall: () => transactionDuringCall };
}

describe("accepting a request", () => {
  test.each(["hide", "decline", "open"])("pauses queued creation after %s and resumes without duplicates", async (action) => {
    const w = await world();
    changeStatus(w.ctx.deps.db, w.id, "accepted", w.maya.id);
    const ref = w.row()!.ref;
    if (action === "hide") setRequestHidden(w.ctx.deps.db, w.id, true, w.maya.id);
    else changeStatus(w.ctx.deps.db, w.id, action === "decline" ? "declined" : "open", w.maya.id);
    await w.ctx.deps.issues.process(w.id);
    await w.ctx.deps.issues.processDue();
    expect(w.fake.issues).toHaveLength(0);
    expect(w.row()!.attempts).toBe(0);
    if (action === "hide") setRequestHidden(w.ctx.deps.db, w.id, false, w.maya.id);
    changeStatus(w.ctx.deps.db, w.id, "accepted", w.maya.id);
    await w.ctx.deps.issues.processDue();
    await w.ctx.deps.issues.processDue();
    expect(w.fake.issues).toHaveLength(1);
    expect(w.row()!.ref).toBe(ref);
  });

  test("paused work does not fill the batch ahead of eligible requests", async () => {
    const w = await world();
    for (let i = 0; i < 25; i++) {
      const id = createRequest(w.ctx.deps.db, { title: `Hidden ${i}`, body: "Not public", authorId: w.author.id });
      changeStatus(w.ctx.deps.db, id, "accepted", w.maya.id);
      setRequestHidden(w.ctx.deps.db, id, true, w.maya.id);
    }
    const eligible = createRequest(w.ctx.deps.db, { title: "Accepted after paused queue", body: "Public", authorId: w.author.id });
    changeStatus(w.ctx.deps.db, eligible, "accepted", w.maya.id);
    await w.ctx.deps.issues.processDue();
    expect(w.fake.issues.map(issue => issue.title)).toEqual(["Accepted after paused queue"]);
  });

  test.each(["hide", "decline", "edit"])("rechecks the request after an in-flight label lookup: %s", async (action) => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const w = await world({}, { githubFetch: async (url, init) => {
      if (url.endsWith("/labels/feature")) { entered(); await gate; }
      return fetch(url, init);
    } });
    await w.setStatus("accepted");
    await started;
    if (action === "hide") setRequestHidden(w.ctx.deps.db, w.id, true, w.maya.id);
    else if (action === "decline") changeStatus(w.ctx.deps.db, w.id, "declined", w.maya.id);
    else updateRequest(w.ctx.deps.db, w.id, { title: "Edited before publishing", body: "Current description" });
    release();
    await w.settle();
    if (action === "edit") {
      expect(w.fake.issues[0]!.title).toBe("Edited before publishing");
      expect(w.fake.issues[0]!.body).toContain("Current description");
    } else {
      expect(w.fake.issues).toHaveLength(0);
      expect(w.row()!.state).toBe("pending");
      expect(w.row()!.attempts).toBe(0);
      expect(w.row()!.leaseUntil).toBeNull();
      setRequestHidden(w.ctx.deps.db, w.id, false, w.maya.id);
      changeStatus(w.ctx.deps.db, w.id, "accepted", w.maya.id);
      await w.ctx.deps.issues.processDue();
      expect(w.fake.issues).toHaveLength(1);
    }
  });

  test("persists the operation, then opens one labelled issue with description and backlink", async () => {
    const w = await world();
    expect(w.fake.labels.has("feature")).toBe(false);
    await w.setStatus("accepted");
    expect(w.row()?.state).toBeOneOf(["pending", "processing"]);
    await w.settle();

    const row = w.row()!;
    expect(row.state).toBe("created");
    expect(row.issueNumber).toBe(100);
    expect(row.issueUrl).toBe(`https://github.com/${w.fake.full}/issues/100`);
    expect(w.transactionDuringCall()).toBe(false);

    expect(w.fake.issues).toHaveLength(1);
    const issue = w.fake.issues[0]!;
    expect(issue.title).toBe("Recurring tasks");
    expect(issue.labels).toEqual(["feature"]);
    expect(w.fake.labels.has("feature")).toBe(true);
    expect(issue.body).toContain("Repeat a task **every week**.");
    expect(issue.body).toContain(`${ORIGIN}/requests/${w.id}`);
    expect(issue.body).toContain(`<!-- feature-track-ref: ${row.ref} -->`);

    const page = await (await w.ctx.browser().get(`/requests/${w.id}`)).text();
    expect(page).toContain(`href="https://github.com/${w.fake.full}/issues/100"`);
    expect(page).toContain("Issue #100");
  });

  test("uses a configured label and reuses an existing one", async () => {
    const w = await world({ GITHUB_ISSUE_LABEL: "enhancement" });
    await w.acceptAndCreate();
    expect(w.fake.issues[0]!.labels).toEqual(["enhancement"]);
    expect(w.fake.count("POST /repos/usekaneo/kaneo/labels")).toBe(0);
  });

  test("repeated clicks, concurrent acceptances and later status changes reuse the issue", async () => {
    const w = await world();
    await Promise.all([...Array.from({ length: 5 }, () => w.setStatus("accepted")), w.ctx.deps.issues.processDue(), w.ctx.deps.issues.processDue()]);
    await w.settle();
    for (const s of ["declined", "accepted", "in_progress", "accepted"]) await w.setStatus(s);
    await w.settle();
    await w.later(24 * 3600_000);
    expect(w.fake.issues).toHaveLength(1);
    expect(w.fake.count("POST /repos/usekaneo/kaneo/issues")).toBe(1);
    expect(w.ctx.deps.db.select().from(githubIssue).all()).toHaveLength(1);
  });

  test("re-submitting Accepted opens an issue that is missing", async () => {
    const w = await world();
    w.ctx.deps.sqlite.query("update request set status = 'accepted' where id = ?").run(w.id);
    await w.setStatus("accepted");
    await w.settle();
    expect(w.row()!.state).toBe("created");
  });

  test("declining or opening does not create an issue", async () => {
    const w = await world();
    await w.setStatus("declined");
    await w.setStatus("open");
    await w.settle();
    expect(w.row()).toBeUndefined();
    expect(w.fake.issues).toHaveLength(0);
  });
});

describe("issue creation failures", () => {
  test("a rejected request is stored as failed and the maintainer retry creates the issue once", async () => {
    const w = await world();
    w.fake.queue("reject");
    await w.setStatus();
    await w.settle();
    expect(w.row()!.state).toBe("failed");
    expect(w.row()!.lastError).toContain("403");
    expect(await (await w.ctx.browser().get(`/requests/${w.id}`)).text()).toContain("couldn&#39;t be opened");
    const panel = await (await w.maya.browser.get(`/requests/${w.id}`)).text();
    expect(panel).toContain("Resource not accessible by personal access token");

    await w.author.browser.get(`/requests/${w.id}`);
    expect((await w.author.browser.post(`/requests/${w.id}/github/retry`)).status).toBe(403);
    expect((await w.maya.browser.post(`/requests/${w.id}/github/retry`)).status).toBe(303);
    await w.settle();
    expect(w.row()!.state).toBe("created");
    expect(w.fake.issues).toHaveLength(1);
    // The retry looked for an existing issue before creating.
    expect(w.fake.count("GET /repos/usekaneo/kaneo/issues")).toBe(1);
  });

  test("ambiguous failure after GitHub created the issue is reconciled instead of duplicated", async () => {
    const w = await world();
    w.fake.queue("create-then-error");
    await w.setStatus();
    await w.settle();
    expect(w.row()!.state).toBe("pending");
    expect(w.fake.issues).toHaveLength(1);
    expect(await (await w.ctx.browser().get(`/requests/${w.id}`)).text()).toContain("GitHub issue <span");

    await w.later(1000);
    expect(w.row()!.attempts).toBe(1);
    await w.later(60_000);
    expect(w.row()!.state).toBe("created");
    expect(w.row()!.issueNumber).toBe(100);
    expect(w.fake.count("POST /repos/usekaneo/kaneo/issues")).toBe(1);
  });

  test("a client timeout while GitHub still creates the issue is reconciled", async () => {
    const w = await world({ GITHUB_TIMEOUT_MS: "100" });
    w.fake.setSlowMs(300);
    w.fake.queue("slow-create");
    await w.setStatus();
    await w.settle();
    expect(w.row()!.lastError).toContain("timed out");
    await Bun.sleep(300);
    await w.later(60_000);
    expect(w.row()!.state).toBe("created");
    expect(w.fake.issues).toHaveLength(1);
  });

  test("when GitHub can't confirm, nothing is re-created and it ends up for maintainer review", async () => {
    const w = await world();
    w.fake.queue("error");
    await w.setStatus();
    await w.settle();
    w.fake.setListFails(true);
    for (let i = 0; i < 6; i++) await w.later(2 * 3600_000);
    expect(w.row()!.state).toBe("failed");
    expect(w.row()!.attempts).toBe(5);
    expect(w.fake.count("POST /repos/usekaneo/kaneo/issues")).toBe(1);
    const panel = await (await w.maya.browser.get(`/requests/${w.id}`)).text();
    expect(panel).toContain("Failed after 5 attempts.");
    expect(panel).toContain(`/requests/${w.id}/github/link`);

    w.fake.setListFails(false);
    await w.maya.browser.post(`/requests/${w.id}/github/retry`);
    await w.settle();
    expect(w.row()!.state).toBe("created");
    expect(w.fake.issues).toHaveLength(1);
  });

  test("rate limiting is retried automatically", async () => {
    const w = await world();
    w.fake.queue("rate-limited");
    await w.setStatus();
    await w.settle();
    expect(w.row()!.state).toBe("pending");
    await w.later(60_000);
    expect(w.row()!.state).toBe("created");
  });

  test("an attempt interrupted by a crash is recovered after its lease expires", async () => {
    const w = await world();
    const { setStatus } = await import("../src/services/requests");
    setStatus(w.ctx.deps.db, w.id, "accepted", w.maya.id);
    const op = w.row()!;
    w.ctx.deps.db.update(githubIssue).set({ state: "processing", attempts: 1, leaseUntil: new Date(Date.now() + 120_000) }).where(eq(githubIssue.requestId, w.id)).run();
    const now = new Date().toISOString();
    w.fake.issues.push({ number: 555, title: "Recurring tasks", body: `x\n<!-- feature-track-ref: ${op.ref} -->`, labels: ["feature"], created_at: now, updated_at: now });

    await w.later(1000);
    expect(w.row()!.state).toBe("processing");
    await w.later(120_000);
    expect(w.row()!.state).toBe("created");
    expect(w.row()!.issueNumber).toBe(555);
    expect(w.fake.count("POST /repos/usekaneo/kaneo/issues")).toBe(0);
  });

  test("maintainers can link an existing issue during review", async () => {
    const w = await world();
    w.fake.queue("reject");
    await w.setStatus();
    await w.settle();
    const now = new Date().toISOString();
    w.fake.issues.push({ number: 777, title: "Manual", body: "", labels: [], created_at: now, updated_at: now });
    w.fake.issues.push({ number: 778, title: "A PR", body: "", labels: [], created_at: now, updated_at: now, pull_request: {} });

    const wrongRepo = await w.maya.browser.post(`/requests/${w.id}/github/link`, { issue: "https://github.com/other/repo/issues/777" });
    expect(wrongRepo.status).toBe(400);
    expect((await w.maya.browser.post(`/requests/${w.id}/github/link`, { issue: "#778" })).status).toBe(400);
    expect((await w.maya.browser.post(`/requests/${w.id}/github/link`, { issue: "999" })).status).toBe(400);

    const ok = await w.maya.browser.post(`/requests/${w.id}/github/link`, { issue: `https://github.com/${w.fake.full}/issues/777` });
    expect(ok.status).toBe(303);
    expect(w.row()!.state).toBe("created");
    expect(w.row()!.issueNumber).toBe(777);
  });
});

describe("progress from GitHub", () => {
  test("open PR → in progress, merged → merged, nightly → in nightly, final release → released", async () => {
    const w = await world();
    const number = await w.acceptAndCreate();

    await w.check();
    expect(w.status()).toBe("accepted");

    w.fake.linkPr(number, { number: 1924, state: "OPEN", merged: false, mergedAt: null, mergeSha: null });
    await w.check();
    expect(w.status()).toBe("in_progress");
    expect(w.row()!.prNumber).toBe(1924);

    w.fake.linkPr(number, { number: 1924, state: "MERGED", merged: true, mergedAt: minutesAgo(30), mergeSha: SHA });
    w.fake.releases.push({ tag: "v2.33.0", publishedAt: minutesAgo(60), contains: [] });
    await w.check();
    expect(w.status()).toBe("merged");
    expect(w.row()!.mergeSha).toBe(SHA);

    w.fake.releases.push({ tag: "nightly", prerelease: true, publishedAt: minutesAgo(600), contains: [SHA] });
    await w.check();
    expect(w.status()).toBe("nightly");
    expect(w.row()!.nightlyTag).toBe("nightly");

    // A release of another package doesn't count, nor does one without the merge.
    w.fake.releases.push({ tag: "mcp-v0.1.13", publishedAt: minutesAgo(5), contains: [SHA] });
    w.fake.releases.push({ tag: "v2.33.1", publishedAt: minutesAgo(4), contains: [] });
    await w.check();
    expect(w.status()).toBe("nightly");

    w.fake.releases.push({ tag: "v2.34.0", publishedAt: minutesAgo(1), contains: [SHA] });
    await w.check();
    expect(w.status()).toBe("released");
    expect(w.row()!.releaseTag).toBe("v2.34.0");

    const page = await (await w.ctx.browser().get(`/requests/${w.id}`)).text();
    expect(page).toContain(`href="https://github.com/${w.fake.full}/pull/1924"`);
    expect(page).toContain(`href="https://github.com/${w.fake.full}/releases/tag/v2.34.0"`);
    for (const label of ["Released · GitHub", "In nightly · GitHub", "Merged · GitHub", "In progress · GitHub"]) expect(page).toContain(label);

    // Released requests are no longer polled.
    const before = w.fake.count("POST /graphql");
    await w.check();
    expect(w.fake.count("POST /graphql")).toBe(before);
  });

  test("goes straight from merged to released when there are no nightlies", async () => {
    const w = await world();
    const number = await w.acceptAndCreate();
    w.fake.linkPr(number, { number: 5, state: "MERGED", merged: true, mergedAt: minutesAgo(30), mergeSha: SHA, viaCloser: true });
    await w.check();
    expect(w.status()).toBe("merged");
    w.fake.releases.push({ tag: "v3.0.0", publishedAt: minutesAgo(1), contains: [SHA] });
    await w.check();
    expect(w.status()).toBe("released");
  });

  test("ignores PRs from other repositories and PRs merged into other branches", async () => {
    const w = await world();
    const number = await w.acceptAndCreate();
    w.fake.linkPr(number, { number: 17599, state: "MERGED", merged: true, mergedAt: minutesAgo(10), mergeSha: "aaa", repository: "community-scripts/ProxmoxVE" });
    w.fake.linkPr(number, { number: 6, state: "MERGED", merged: true, mergedAt: minutesAgo(10), mergeSha: "bbb", baseRefName: "feature-branch" });
    await w.check();
    expect(w.status()).toBe("accepted");
    expect(w.row()!.prNumber).toBeNull();
  });

  test("never overrides a maintainer's decision or moves backwards", async () => {
    const w = await world();
    const number = await w.acceptAndCreate();
    w.fake.linkPr(number, { number: 7, state: "MERGED", merged: true, mergedAt: minutesAgo(10), mergeSha: SHA });

    await w.setStatus("declined");
    await w.check();
    expect(w.status()).toBe("declined");

    await w.setStatus("released");
    await w.check();
    expect(w.status()).toBe("released");
  });

  test("checks respect the sync interval; maintainers can check now", async () => {
    const w = await world();
    const number = await w.acceptAndCreate();
    await w.check();
    const calls = w.fake.count("POST /graphql");
    await w.check(60_000);
    expect(w.fake.count("POST /graphql")).toBe(calls);

    w.fake.linkPr(number, { number: 8, state: "OPEN", merged: false, mergedAt: null, mergeSha: null });
    await w.author.browser.get(`/requests/${w.id}`);
    expect((await w.author.browser.post(`/requests/${w.id}/github/check`)).status).toBe(403);
    expect((await w.maya.browser.post(`/requests/${w.id}/github/check`)).status).toBe(303);
    expect(w.status()).toBe("in_progress");
  });

  test("check failures are recorded without changing status", async () => {
    const w = await world();
    await w.acceptAndCreate();
    w.ctx.deps.db.update(githubIssue).set({ issueNumber: 4040 }).where(eq(githubIssue.requestId, w.id)).run();
    await w.check();
    expect(w.row()!.checkError).toContain("Could not resolve");
    expect(w.status()).toBe("accepted");
    expect(await (await w.maya.browser.get(`/requests/${w.id}`)).text()).toContain("Could not resolve");
  });
});

describe("without GitHub configuration", () => {
  test("acceptance is stored and shown as pending", async () => {
    const ctx = setup();
    const author = await signedIn(ctx);
    const maya = await signedIn(ctx, "maintainer");
    const id = await submitRequest(author.browser);
    await maya.browser.get(`/requests/${id}`);
    await maya.browser.post(`/requests/${id}/status`, { status: "accepted" });
    await ctx.deps.issues.processDue();
    expect(ctx.deps.db.select().from(githubIssue).get()!.state).toBe("pending");
    expect(await (await ctx.browser().get(`/requests/${id}`)).text()).toContain("GitHub issue <span");
    expect(await (await maya.browser.get(`/requests/${id}`)).text()).toContain("GitHub isn&#39;t configured");
  });
});

describe("GitHub client", () => {
  const config = loadConfig({ NODE_ENV: "test", GITHUB_REPO: "usekaneo/kaneo", GITHUB_TOKEN: "secret", GITHUB_API_URL: "http://gh.invalid" }).repo!;

  test("classifies responses", async () => {
    const kind = async (status: number, headers: Record<string, string> = {}) => {
      const client = new GitHubClient(config, async () => Response.json({ message: "x" }, { status, headers }));
      try {
        await client.createIssue({ title: "t", body: "b" });
      } catch (error) {
        return (error as GitHubError).kind;
      }
    };
    expect(await kind(401)).toBe("rejected");
    expect(await kind(403)).toBe("rejected");
    expect(await kind(422)).toBe("rejected");
    expect(await kind(403, { "x-ratelimit-remaining": "0" })).toBe("retryable");
    expect(await kind(403, { "retry-after": "60" })).toBe("retryable");
    expect(await kind(429)).toBe("retryable");
    expect(await kind(500)).toBe("ambiguous");
    const unreadable = new GitHubClient(config, async () => new Response("<html>", { status: 201 }));
    await expect(unreadable.createIssue({ title: "t", body: "b" })).rejects.toMatchObject({ kind: "ambiguous" });
  });

  test("refused connections are safe to retry", async () => {
    const client = new GitHubClient({ ...config, apiUrl: "http://127.0.0.1:1" });
    await expect(client.createIssue({ title: "t", body: "b" })).rejects.toMatchObject({ kind: "retryable" });
  });

  test("sends the token only as a bearer header and uses the Enterprise GraphQL path", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const client = new GitHubClient({ ...config, apiUrl: "https://ghe.example.com/api/v3" }, async (url, init) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ data: { repository: { defaultBranchRef: { name: "main" }, issue: { closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] } } } } });
    });
    await client.getProgress(1);
    expect(seen[0]).toEqual({ url: "https://ghe.example.com/api/graphql", auth: "Bearer secret" });
  });

  test("parses issue references", () => {
    expect(parseIssueNumber("123", "usekaneo/kaneo")).toBe(123);
    expect(parseIssueNumber("#123", "usekaneo/kaneo")).toBe(123);
    expect(parseIssueNumber("https://github.com/usekaneo/kaneo/issues/123#issuecomment-1", "usekaneo/kaneo")).toBe(123);
    expect(parseIssueNumber("https://github.com/UseKaneo/Kaneo/issues/9", "usekaneo/kaneo")).toBe(9);
    expect(parseIssueNumber("https://github.com/other/repo/issues/123", "usekaneo/kaneo")).toBeNull();
    expect(parseIssueNumber("../../x", "usekaneo/kaneo")).toBeNull();
  });

  test("rejects invalid repository settings", () => {
    expect(() => loadConfig({ GITHUB_REPO: "just-a-name", GITHUB_TOKEN: "x" })).toThrow("GITHUB_REPO must look like owner/name");
    expect(() => loadConfig({ GITHUB_REPO: "a/b", GITHUB_TOKEN: "x", GITHUB_RELEASE_TAG_PATTERN: "(" })).toThrow("not a valid regular expression");
  });
});
