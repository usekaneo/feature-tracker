import assert from "node:assert/strict";
import { resolve } from "node:path";

const image = process.argv[2] ?? "kaneo-feature-track:check";
const suffix = crypto.randomUUID().slice(0, 8);
const network = `tracker-check-${suffix}`;
const smtp = `${network}-smtp`;
const app = `${network}-app`;

function docker(...args: string[]) {
  const result = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString().trim();
}

async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error(message);
}

try {
  docker("network", "create", network);
  docker("run", "-d", "--name", smtp, "--network", network, "--network-alias", "smtp",
    "-v", `${resolve("tests/fake-smtp.ts")}:/tmp/fake-smtp.ts:ro`, image,
    "bun", "-e", "import {startFakeSmtp} from '/tmp/fake-smtp.ts'; const smtp=startFakeSmtp({hostname:'0.0.0.0',port:1025}); Bun.serve({hostname:'0.0.0.0',port:8025,fetch:()=>Response.json(smtp.messages)}); console.log('SMTP test sink ready');");
  await until(() => docker("logs", smtp).includes("SMTP test sink ready"), "SMTP test sink did not start");
  const env = ["APP_URL=http://localhost:3000", "BETTER_AUTH_SECRET=docker-smoke-only-secret-0123456789012345",
    "MAIL_FROM=Tracker <tracker@example.test>", "SMTP_HOST=smtp", "SMTP_PORT=1025", "SMTP_SECURE=false",
    "BACKUP_INTERVAL_HOURS=0.0001", "BACKUP_KEEP=2"];
  docker("run", "-d", "--name", app, "--network", network, "-p", "127.0.0.1::3000", ...env.flatMap(value => ["-e", value]), image);
  const address = docker("port", app, "3000/tcp");
  const base = `http://${address}`;
  await until(async () => (await fetch(`${base}/healthz`)).ok, "Production server did not start");
  assert.equal((await fetch(`${base}/dev/mail`)).status, 404);
  const home = await fetch(base);
  assert.equal(home.status, 200);
  for (const match of (await home.text()).matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)) {
    const asset = await fetch(`${base}${match[1]}`);
    assert.equal(asset.status, 200, `Asset missing: ${match[1]}`);
  }
  const registration = await fetch(`${base}/register`, { method: "POST", headers: { origin: "http://localhost:3000" },
    body: new URLSearchParams({ name: "Smoke", email: "smoke@example.test", password: "correct horse battery" }) });
  assert.equal(registration.status, 200);
  await until(() => {
    const mails = JSON.parse(docker("exec", app, "bun", "-e", "console.log(JSON.stringify(await (await fetch('http://smtp:8025')).json()))"));
    return mails.some((mail: { to: string }) => mail.to === "smoke@example.test");
  }, "Production verification email did not reach SMTP");
  await until(() => Number(docker("exec", app, "bun", "-e", "console.log(require('node:fs').readdirSync('/data/backups').filter(n=>n.endsWith('.db')).length)")) === 2,
    "Automatic backups did not run and rotate");
  docker("exec", app, "bun", "-e", "const fs=require('node:fs'); const {Database}=require('bun:sqlite'); for(const name of fs.readdirSync('/data/backups').filter(n=>n.endsWith('.db'))) { const db=new Database('/data/backups/'+name,{readonly:true}); if(db.query('PRAGMA integrity_check').get().integrity_check!=='ok') process.exit(1); db.close(); }");
  console.log("Docker smoke passed: production startup, assets, SMTP delivery, verified backup rotation, dev mail unavailable.");
} catch (error) {
  try { console.error(docker("logs", app)); } catch {}
  throw error;
} finally {
  for (const name of [app, smtp]) Bun.spawnSync(["docker", "rm", "-f", "-v", name], { stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync(["docker", "network", "rm", network], { stdout: "ignore", stderr: "ignore" });
}
