// Load test against a production-mode server on a synthetic dataset.
//   bun run bench [--requests 10000] [--seconds 10] [--concurrency 32]
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { cpus, totalmem, type } from "node:os";
import { join } from "node:path";
import { csrfToken } from "../src/lib/csrf";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const REQUESTS = arg("requests", 10_000);
const SECONDS = arg("seconds", 10);
const CONCURRENCY = arg("concurrency", 32);
const PORT = 3997;
const ORIGIN = `http://localhost:${PORT}`;
const SECRET = "bench-secret-bench-secret-bench-secret-0001";
const root = join(import.meta.dir, "..");
const dbPath = "/tmp/kaneo-ft-bench.db";

for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
const env = { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: "production", APP_URL: ORIGIN, PORT: String(PORT), BETTER_AUTH_SECRET: SECRET, MAIL_TRANSPORT: "smtp" };
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd: root, env: { ...env, NODE_ENV: "development" }, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
};
run(["bun", "scripts/migrate.ts"]);
run(["bun", "scripts/seed.ts", "--large", String(REQUESTS)]);

// Mint sessions for synthetic users (same format Better Auth issues).
const db = new Database(dbPath);
const users = db.query("select id from user where id like 'synthetic-%' limit 500").all() as { id: string }[];
const insertSession = db.query("insert into session (id, expires_at, token, created_at, updated_at, user_id) values (?, ?, ?, ?, ?, ?)");
const sessions = users.map(({ id }) => {
  const sessionId = crypto.randomUUID();
  const token = crypto.randomUUID().replaceAll("-", "");
  const now = Date.now();
  insertSession.run(sessionId, now + 7 * 86_400_000, token, now, now, id);
  const signature = createHmac("sha256", SECRET).update(token).digest("base64");
  return { cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`, csrf: csrfToken(SECRET, sessionId) };
});
const maxId = (db.query("select max(id) as n from request").get() as { n: number }).n;
const stats = db.query("select (select count(*) from request) r, (select count(*) from vote) v, (select count(*) from comment) c, (select count(*) from user) u").get() as Record<string, number>;
db.close();
const words = ["dark", "recurring", "calendar", "export", "slack", "templates", "mobile", "gantt", "webhooks", "filters", "import linear", "time tracking"];

const entry = existsSync(join(root, "dist/server.js")) ? "dist/server.js" : "src/index.ts";
const server = Bun.spawn(["bun", entry], { cwd: root, env, stdout: "ignore", stderr: "inherit" });
for (let i = 0; i < 50; i++) {
  if (await fetch(`${ORIGIN}/healthz`).then((r) => r.ok).catch(() => false)) break;
  await Bun.sleep(100);
}
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)]!;
const randomId = () => 1 + Math.floor(Math.random() * maxId);

// Sanity check: minted sessions are accepted.
const probe = await (await fetch(`${ORIGIN}/`, { headers: { cookie: sessions[0]!.cookie } })).text();
if (!probe.includes("Sign out")) throw new Error("Minted session was not accepted");

type Scenario = { name: string; request: () => [string, RequestInit?] };
const scenarios: Scenario[] = [
  { name: "GET / (anonymous, newest)", request: () => ["/"] },
  { name: "GET / (signed in)", request: () => ["/", { headers: { cookie: pick(sessions).cookie } }] },
  { name: "GET /?status=open&sort=votes&page=1..5", request: () => [`/?status=open&sort=votes&page=${1 + Math.floor(Math.random() * 5)}`] },
  { name: "GET /?q=… (search)", request: () => [`/?q=${encodeURIComponent(pick(words))}`] },
  { name: "GET /requests/:id", request: () => [`/requests/${randomId()}`] },
  {
    name: "POST /requests/:id/vote (htmx)",
    request: () => {
      const s = pick(sessions);
      return [
        `/requests/${randomId()}/vote`,
        {
          method: "POST",
          headers: { cookie: s.cookie, origin: ORIGIN, "hx-request": "true", "x-csrf-token": s.csrf, "content-type": "application/x-www-form-urlencoded" },
          body: "next=%2F",
        },
      ];
    },
  },
  { name: "GET /feed.xml", request: () => ["/feed.xml"] },
];

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

async function measure(s: Scenario, seconds: number) {
  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  let errors = 0;
  const end = performance.now() + seconds * 1000;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (performance.now() < end) {
        const [path, init] = s.request();
        const start = performance.now();
        try {
          const res = await fetch(ORIGIN + path, { ...init, redirect: "manual" });
          await res.arrayBuffer();
          statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
          if (res.status >= 400) errors++;
        } catch {
          errors++;
        }
        latencies.push(performance.now() - start);
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  return { latencies, statuses, errors };
}

const cpu = cpus()[0]?.model ?? "unknown";
console.log(`\nEnvironment: ${cpu}, ${cpus().length} cores, ${(totalmem() / 2 ** 30).toFixed(0)} GB RAM, ${type()}, Bun ${Bun.version}`);
console.log(`Server: ${entry}, NODE_ENV=production, SQLite WAL, single process; load generator on the same machine`);
console.log(`Data: ${stats.r} requests, ${stats.v} votes, ${stats.c} comments, ${stats.u} users; DB ${(statSync(dbPath).size / 2 ** 20).toFixed(1)} MB`);
console.log(`Workload: ${CONCURRENCY} concurrent clients, ${SECONDS}s per scenario after 2s warm-up, random ids/pages/terms\n`);
console.log("| Scenario | Requests | Req/s | p50 ms | p90 ms | p99 ms | max ms | Errors |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
for (const s of scenarios) {
  await measure(s, 2);
  const { latencies, statuses, errors } = await measure(s, SECONDS);
  const f = (n: number) => n.toFixed(1);
  const codes = [...statuses].map(([k, v]) => `${k}×${v}`).join(" ");
  console.log(
    `| ${s.name} | ${latencies.length} | ${(latencies.length / SECONDS).toFixed(0)} | ${f(pct(latencies, 50))} | ${f(pct(latencies, 90))} | ${f(pct(latencies, 99))} | ${f(latencies.at(-1)!)} | ${errors}${errors ? ` (${codes})` : ""} |`,
  );
}
server.kill();
await server.exited;
