import type { Database } from "bun:sqlite";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import { CLIENT_IP_HEADER, type Auth } from "./auth/auth";
import type { Config } from "./config";
import type { DB } from "./db/client";
import type { Role } from "./db/schema";
import type { ChangelogSync } from "./github/changelog";
import type { GitHubSync } from "./github/sync";
import type { AutoLabeler } from "./labeler/worker";
import { csrfToken, verifyCsrfToken } from "./lib/csrf";
import type { Logger } from "./lib/logger";
import type { Mailer } from "./lib/mailer";
import type { NotificationEmails } from "./services/notification-emails";
import { openReportCount } from "./services/moderation";
import { unreadCount } from "./services/notifications";
import type { RateLimiter, RateLimits } from "./lib/rate-limit";

export interface Deps {
  config: Config;
  db: DB;
  sqlite: Database;
  auth: Auth;
  mailer: Mailer;
  logger: Logger;
  issues: GitHubSync;
  labeler: AutoLabeler;
  changelog: ChangelogSync;
  notifier: NotificationEmails;
  limits: RateLimits;
}

export interface Viewer {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Unread notifications, shown in the header. */
  unread: number;
  /** Suspended accounts can read but not post, vote or report. */
  banned: boolean;
  /** Open moderation reports; always 0 for non-maintainers. */
  openReports: number;
}

export type AppEnv = {
  Variables: {
    deps: Deps;
    viewer: Viewer | null;
    sessionId: string | null;
    csrf: string | null;
    ip: string;
  };
};

export type Ctx = Context<AppEnv>;

export const isMaintainer = (viewer: Viewer | null) => viewer?.role === "maintainer";

export function clientIp(c: Ctx, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Request headers for Better Auth calls, with the resolved client IP. */
export function authHeaders(c: Ctx, captchaToken?: string): Headers {
  const headers = new Headers(c.req.raw.headers);
  if (captchaToken !== undefined) headers.set("x-captcha-response", captchaToken);
  headers.set(CLIENT_IP_HEADER, c.get("ip"));
  return headers;
}

/** Copies Set-Cookie headers from a Better Auth response onto the Hono response. */
export function forwardCookies(c: Ctx, response: Response | Headers) {
  const headers = response instanceof Headers ? response : response.headers;
  for (const cookie of headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
}

const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

export const hasSessionCookie = (c: Ctx) => SESSION_COOKIE.test(c.req.header("cookie") ?? "");

export function loadSession(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get("deps");
    c.set("ip", clientIp(c, deps.config.trustProxy));
    c.set("viewer", null);
    c.set("sessionId", null);
    c.set("csrf", null);
    // Skip the session lookup entirely for anonymous visitors.
    if (hasSessionCookie(c)) {
      const result = await deps.auth.api.getSession({ headers: authHeaders(c), returnHeaders: true });
      if (result.response) {
        const { user, session } = result.response;
        const role = (user.role as Role) ?? "user";
        c.set("viewer", {
          id: user.id,
          name: user.name,
          email: user.email,
          role,
          unread: unreadCount(deps.db, user.id, role === "maintainer"),
          banned: !!user.bannedAt,
          openReports: role === "maintainer" ? openReportCount(deps.db) : 0,
        });
        c.set("sessionId", session.id);
        c.set("csrf", csrfToken(deps.config.authSecret, session.id));
      }
      forwardCookies(c, result.headers);
    }
    await next();
  };
}

/**
 * Authenticated writes must carry the session-bound token (form field or
 * htmx header) in addition to passing the Origin / Fetch Metadata check.
 */
export function requireCsrfToken(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const sessionId = c.get("sessionId");
    if (c.req.method === "POST" && sessionId) {
      let token = c.req.header("x-csrf-token");
      if (!token) {
        const type = c.req.header("content-type") ?? "";
        if (type.includes("form")) {
          const body = await c.req.parseBody();
          token = typeof body._csrf === "string" ? body._csrf : undefined;
        }
      }
      if (!verifyCsrfToken(c.get("deps").config.authSecret, sessionId, token)) {
        return c.text("Your session changed. Reload the page and try again.", 403);
      }
    }
    await next();
  };
}

export function noStore(c: Ctx) {
  c.header("Cache-Control", "private, no-store");
}

/** Returns a 429 response when the limiter is exhausted, otherwise null. */
export function limited(c: Ctx, limiter: RateLimiter, key: string): Response | null {
  const result = limiter.hit(key);
  if (result.ok) return null;
  c.header("Retry-After", String(result.retryAfter));
  return c.text("Too many requests. Try again in a moment.", 429);
}

export function isHtmx(c: Ctx) {
  return c.req.header("hx-request") === "true";
}

/** Only allow same-site relative redirect targets. */
export function safeNext(value: string | undefined | null, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}

export function formString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

export function parseId(value: string | undefined): number | null {
  if (!value || !/^\d{1,12}$/.test(value)) return null;
  return Number(value);
}
