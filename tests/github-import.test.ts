import { expect, test } from "bun:test";
import { importGitHubFeatures } from "../src/services/github-import";
import { account, autoLabelJob, comment, githubIssue, label, notification, request, subscription, user, vote } from "../src/db/schema";
import { setup } from "./helpers";
const issue = {
  number: 42, title: "feat: recurring tasks", body: "Repeat tasks weekly. <script>unsafe()</script>",
  url: "https://github.com/usekaneo/kaneo/issues/42", author: { login: "octocat" },
  createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-02T10:00:00Z",
  labels: [{ name: "enhancement" }, { name: "priority:medium" }],
  comments: [{ id: 123, body: "Keep the due date.", author: { login: "maintainer" },
    createdAt: "2026-09-02T10:00:00Z", updatedAt: "2026-09-02T10:00:00Z",
    url: "https://github.com/usekaneo/kaneo/issues/42#issuecomment-123" }],
};
const data = { repo: "usekaneo/kaneo", issues: [issue] };
test("quiet import preserves source attribution, dates, labels and discussion without authentication or notifications", async () => {
  const { deps, browser } = setup();
  deps.db.insert(label).values({ name: "Enhancement" }).run();
  const result = importGitHubFeatures(deps.db, data, deps.config.appUrl);
  expect(result.mappings[0]?.created).toBe(true);
  expect(result.mappings[0]?.targetUrl).toEndWith("/requests/1");
  const r = deps.db.select().from(request).get()!;
  expect(r.title).toBe(issue.title);
  expect(r.createdAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  expect(r.body).toContain(issue.url);
  expect(r.bodyHtml).not.toContain("<script>");
  expect(r.status).toBe("open");
  expect(r.commentCount).toBe(1);
  expect(deps.db.select().from(comment).get()?.body).toContain("Keep the due date.");
  expect(deps.db.select().from(githubIssue).get()?.state).toBe("created");
  expect(deps.db.select().from(githubIssue).get()?.issueNumber).toBe(42);
  expect(deps.db.select().from(autoLabelJob).get()?.manualOverride).toBe(true);
  for (const table of [account, notification, subscription, vote]) expect(deps.db.select().from(table).all()).toHaveLength(0);
  for (const person of deps.db.select().from(user).all()) {
    expect(person.email).toEndWith("@github-import.invalid");
    expect(person.emailVerified).toBe(false);
    expect(person.role).toBe("user");
    expect(person.emailOnStatus).toBe(false);
  }
  expect(deps.mailer.outbox()).toHaveLength(0);
  expect(await (await browser().get("/requests/1")).text()).toContain("octocat (GitHub)");
});
test("reruns leave existing copies and later local edits untouched", () => {
  const { deps } = setup();
  importGitHubFeatures(deps.db, data, deps.config.appUrl);
  deps.sqlite.exec("update request set title='Local revision' where id=1");
  const again = importGitHubFeatures(deps.db, data, deps.config.appUrl);
  expect(again.mappings[0]?.created).toBe(false);
  expect(deps.db.select().from(request).all()).toHaveLength(1);
  expect(deps.db.select().from(comment).all()).toHaveLength(1);
  expect(deps.db.select().from(user).all()).toHaveLength(2);
  expect(deps.db.select().from(request).get()?.title).toBe("Local revision");
});
test("invalid source URLs, duplicate issues and non-features cannot partially import", () => {
  const { deps } = setup();
  for (const invalid of [
    { ...data, issues: [issue, { ...issue, number: 43, url: "https://evil.invalid/issues/43" }] },
    { ...data, issues: [issue, issue] },
    { ...data, issues: [{ ...issue, title: "Bug report", labels: [] }] },
  ]) expect(() => importGitHubFeatures(deps.db, invalid, deps.config.appUrl)).toThrow();
  expect(deps.db.select().from(request).all()).toHaveLength(0);
  expect(deps.db.select().from(user).all()).toHaveLength(0);
});
