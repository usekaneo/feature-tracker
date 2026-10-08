import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { runMigrations } from "../src/db/client";
import { account, user, type Role } from "../src/db/schema";
import { createDeps } from "../src/deps";
import type { Deps } from "../src/http";
import type { FetchLike } from "../src/github/client";
import type { LabelerFetch } from "../src/labeler/assess";
import { silentLogger } from "../src/lib/logger";

export const ORIGIN = "http://localhost:3000";
export const PASSWORD = "correct horse battery";

export function setup(env: Record<string, string> = {}, opts: { captchaFetch?: import("../src/lib/captcha").CaptchaFetch; githubFetch?: FetchLike; labelerFetch?: LabelerFetch; now?: () => number } = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    APP_URL: ORIGIN,
    DATABASE_PATH: ":memory:",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
    MAIL_TRANSPORT: "dev",
    // Each Browser gets its own address so per-IP rate limits behave like separate clients.
    TRUST_PROXY: "true",
    ...env,
  });
  const deps = createDeps(config, { logger: silentLogger, captchaFetch: opts.captchaFetch, githubFetch: opts.githubFetch, labelerFetch: opts.labelerFetch, now: opts.now });
  runMigrations(deps.db);
  const app = createApp(deps);
  return { deps, app, browser: () => new Browser(app) };
}

type App = ReturnType<typeof createApp>;

/** Minimal browser: cookie jar, Origin header on writes, manual redirects. */
export class Browser {
  cookies = new Map<string, string>();
  lastHtml = "";
  ip = `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

  constructor(private app: App) {}

  async request(path: string, init: RequestInit & { form?: Record<string, string | string[]>; htmx?: boolean } = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", this.ip);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    let body = init.body;
    if (init.form) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(init.form)) for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
      body = params.toString();
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
    if (init.htmx) headers.set("hx-request", "true");
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    const res = await this.app.request(url, { ...init, headers, body, redirect: "manual" });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair, ...attrs] = cookie.split(";");
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim())) || value === "";
      if (expired) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
    return res;
  }

  async get(path: string, init: RequestInit & { htmx?: boolean } = {}) {
    const res = await this.request(path, init);
    if ((res.headers.get("content-type") ?? "").includes("html")) this.lastHtml = await res.clone().text();
    return res;
  }

  /** Posts a form, adding the CSRF token from the last page when signed in. */
  async post(path: string, form: Record<string, string | string[]> = {}, init: RequestInit & { htmx?: boolean; csrf?: boolean } = {}) {
    const token = init.csrf === false ? undefined : this.csrf();
    return this.request(path, { ...init, method: "POST", form: token ? { _csrf: token, ...form } : form });
  }

  csrf(): string | undefined {
    return this.lastHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
  }

  get signedIn() {
    return [...this.cookies.keys()].some((k) => k.endsWith("session_token"));
  }

  async login(email: string, password = PASSWORD) {
    const res = await this.post("/login", { email, password, next: "/" }, { csrf: false });
    if (res.status !== 303) throw new Error(`login failed: ${res.status} ${await res.text()}`);
    await this.get("/");
    return res;
  }
}

let counter = 0;

/** Creates a verified email/password user directly in the database. */
export async function createUser(deps: Deps, opts: { role?: Role; email?: string; name?: string; verified?: boolean } = {}) {
  const id = crypto.randomUUID();
  const email = opts.email ?? `user${++counter}-${id.slice(0, 6)}@example.test`;
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id", memoryCost: 1024, timeCost: 1 });
  deps.db
    .insert(user)
    .values({ id, name: opts.name ?? `User ${counter}`, email, emailVerified: opts.verified ?? true, role: opts.role ?? "user" })
    .run();
  deps.db.insert(account).values({ id: crypto.randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash }).run();
  return { id, email };
}

export async function signedIn(ctx: ReturnType<typeof setup>, role: Role = "user") {
  const u = await createUser(ctx.deps, { role });
  const b = ctx.browser();
  await b.login(u.email);
  return { ...u, browser: b };
}

export async function submitRequest(b: Browser, title = "Dark mode", body = "Please add **dark mode**.") {
  await b.get("/requests/new");
  const res = await b.post("/requests", { title, body });
  if (res.status !== 303) throw new Error(`submit failed: ${res.status}`);
  return Number(res.headers.get("location")!.split("/").pop());
}

export function getUserRow(deps: Deps, id: string) {
  return deps.db.select().from(user).where(eq(user.id, id)).get();
}
