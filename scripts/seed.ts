// Development seed data.
//   bun run db:seed              small, realistic dataset with sign-in accounts
//   bun run db:seed --large 10000  synthetic dataset for benchmarks
import { loadConfig } from "../src/config";
import { createDb } from "../src/db/client";
import { STATUSES, type Status } from "../src/db/schema";
import { renderMarkdown } from "../src/lib/markdown";

const config = loadConfig();
if (config.env === "production" && !process.argv.includes("--force")) {
  console.error("Refusing to seed a production database (pass --force to override).");
  process.exit(1);
}
const largeIndex = process.argv.indexOf("--large");
const large = largeIndex > -1 ? Number(process.argv[largeIndex + 1] ?? 10000) : 0;

const { sqlite } = createDb(config.databasePath);
if ((sqlite.query("select count(*) as n from request").get() as { n: number }).n > 0) {
  console.error("Database already has requests; seed only an empty database.");
  process.exit(1);
}

// Deterministic PRNG so runs are comparable.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
const DAY = 86_400_000;
const now = Date.now();

const PASSWORD = "password123";
const people = [
  { name: "Maya Maintainer", email: "maintainer@example.com", role: "maintainer" },
  { name: "Ada Lovelace", email: "ada@example.com", role: "user" },
  { name: "Linus Park", email: "linus@example.com", role: "user" },
  { name: "Grace Kim", email: "grace@example.com", role: "user" },
];

const titles = [
  "Dark mode for the public board",
  "Recurring tasks",
  "Gantt chart dependencies",
  "Slack notifications per project",
  "Bulk edit task labels",
  "Keyboard shortcut cheat sheet",
  "Custom fields on the list view",
  "Time tracking reports by member",
  "Import from Linear",
  "Two-factor authentication",
  "Task templates",
  "Mobile app for iOS",
  "Webhooks for status changes",
  "Calendar sync with Google Calendar",
  "Archive completed tasks automatically",
  "Markdown tables in descriptions",
  "Sub-task progress on cards",
  "Guest access for clients",
  "Export board as CSV",
  "Saved filters",
  "Due date reminders by email",
  "Swimlanes grouped by assignee",
  "Emoji reactions on comments",
  "SSO with OpenID Connect",
  "Burndown chart per sprint",
  "Drag tasks between projects",
  "Mention teammates in descriptions",
  "Public roadmap view",
  "GitLab merge request linking",
  "Workload view across projects",
];
const bodies = [
  "It would help our team to have this built in instead of relying on a workaround.\n\n- Works with existing projects\n- Respects permissions",
  "We moved from another tool and **miss this a lot**. Happy to test an early version.",
  "Right now we track this in a spreadsheet. Ideally it lives next to the tasks.\n\n```\nexample: weekly on Monday\n```",
  "Small thing, but it comes up in every planning meeting. See also the discussion in the community chat.",
];
const comments = [
  "+1, this would save us a lot of time.",
  "We'd use this daily.",
  "Could this also cover archived projects?",
  "Is there a workaround in the meantime?",
  "Thanks for considering it!",
  "Would love an API for this too.",
];

const insertUser = sqlite.query(
  "insert into user (id, name, email, email_verified, role, created_at, updated_at) values (?, ?, ?, 1, ?, ?, ?)",
);
const insertAccount = sqlite.query(
  "insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values (?, ?, 'credential', ?, ?, ?, ?)",
);
const insertRequest = sqlite.query(
  "insert into request (title, body, body_html, author_id, status, created_at, updated_at, last_activity_at) values (?, ?, ?, ?, ?, ?, ?, ?) returning id",
);
const insertVote = sqlite.query("insert or ignore into vote (request_id, user_id, created_at) values (?, ?, ?)");
const insertComment = sqlite.query(
  "insert into comment (request_id, author_id, body, body_html, created_at) values (?, ?, ?, ?, ?)",
);
const insertStatus = sqlite.query(
  "insert into status_change (request_id, from_status, to_status, actor_id, created_at) values (?, 'open', ?, ?, ?)",
);

const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
const renderedBodies = bodies.map(renderMarkdown);
const renderedComments = comments.map(renderMarkdown);

sqlite.transaction(() => {
  const userIds: string[] = [];
  for (const p of people) {
    const id = crypto.randomUUID();
    insertUser.run(id, p.name, p.email, p.role, now - 90 * DAY, now - 90 * DAY);
    insertAccount.run(crypto.randomUUID(), id, id, hash, now - 90 * DAY, now - 90 * DAY);
    userIds.push(id);
  }
  const syntheticUsers = large ? Math.max(200, Math.floor(large / 5)) : 24;
  for (let i = 0; i < syntheticUsers; i++) {
    const id = `synthetic-${i}`;
    insertUser.run(id, `User ${i}`, `user${i}@example.test`, "user", now - 200 * DAY, now - 200 * DAY);
    userIds.push(id);
  }
  const maintainerId = userIds[0]!;

  for (const name of ["API", "Board", "Integrations", "Mobile", "Notifications"]) {
    sqlite.query("insert into label (name) values (?)").run(name);
  }

  const total = large || titles.length;
  const statusWeights: Status[] = ["open", "open", "open", "open", "open", "accepted", "in_progress", "merged", "released", "declined"];
  for (let i = 0; i < total; i++) {
    const title = large ? `${pick(titles)} (${i + 1})` : titles[i]!;
    const bodyIndex = Math.floor(rand() * bodies.length);
    const created = now - Math.floor(rand() * (large ? 365 : 60) * DAY);
    const status = i < 3 && !large ? "open" : pick(statusWeights);
    const author = pick(userIds);
    const { id } = insertRequest.get(title, bodies[bodyIndex]!, renderedBodies[bodyIndex]!, author, status, created, created, created) as { id: number };
    if (status !== "open") insertStatus.run(id, status, maintainerId, created + DAY);
    // Skewed vote distribution: a few requests collect most votes.
    const votes = Math.floor(rand() ** 3 * Math.min(userIds.length, large ? 300 : userIds.length));
    for (let v = 0; v < votes; v++) insertVote.run(id, pick(userIds), created + v * 1000);
    const commentCount = Math.floor(rand() ** 2 * (large ? 12 : 6));
    let last = created;
    for (let k = 0; k < commentCount; k++) {
      last = created + (k + 1) * 3_600_000;
      const ci = Math.floor(rand() * comments.length);
      insertComment.run(id, pick(userIds), comments[ci]!, renderedComments[ci]!, last);
    }
    sqlite.query("update request set last_activity_at = ? where id = ?").run(last, id);
    if (rand() < 0.3) sqlite.query("insert or ignore into request_label (request_id, label_id) values (?, ?)").run(id, 1 + Math.floor(rand() * 5));
  }
  sqlite.exec(`
    update request set
      vote_count = (select count(*) from vote where vote.request_id = request.id),
      comment_count = (select count(*) from comment where comment.request_id = request.id and comment.hidden = 0);
  `);
})();

sqlite.exec("ANALYZE");
const counts = sqlite
  .query("select (select count(*) from user) u, (select count(*) from request) r, (select count(*) from vote) v, (select count(*) from comment) c")
  .get() as { u: number; r: number; v: number; c: number };
sqlite.close();
console.log(`Seeded ${counts.r} requests, ${counts.v} votes, ${counts.c} comments, ${counts.u} users.`);
if (!large) console.log(`Sign in as maintainer@example.com (maintainer) or ada@example.com with password "${PASSWORD}".`);
