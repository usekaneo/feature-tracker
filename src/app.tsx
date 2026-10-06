import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { authHeaders, clientIp, loadSession, noStore, requireCsrfToken, type AppEnv, type Deps } from "./http";
import { PUBLIC_DIR } from "./lib/assets";
import { loggablePath } from "./lib/logger";
import { authRoutes } from "./routes/auth";
import { changelogRoutes } from "./routes/changelog";
import { feedRoutes } from "./routes/feed";
import { moderationRoutes } from "./routes/moderation";
import { notificationRoutes } from "./routes/notifications";
import { requestRoutes } from "./routes/requests";
import { DevMailPage, MessagePage } from "./views/misc";
import { PrivacyPage } from "./views/privacy";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { config, logger } = deps;
  const appOrigin = new URL(config.appUrl).origin;

  if (config.env !== "test") {
    app.use("*", async (c, next) => {
      const start = performance.now();
      await next();
      // Paths only: query strings and auth path segments can carry tokens.
      logger.info(`${c.req.method} ${loggablePath(c.req.path)} ${c.res.status} ${(performance.now() - start).toFixed(1)}ms`);
    });
  }

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'", "https://github.com"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
      // Reset and verification URLs carry tokens; never send them to other origins.
      referrerPolicy: "same-origin",
      strictTransportSecurity: config.appUrl.startsWith("https://") ? "max-age=31536000; includeSubDomains" : false,
    }),
  );

  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.status === 200) c.header("Cache-Control", "public, max-age=31536000, immutable");
  });
  app.use("/assets/*", serveStatic({ root: PUBLIC_DIR }));

  app.get("/healthz", (c) => {
    deps.sqlite.query("select 1").get();
    return c.text("ok");
  });

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("ip", clientIp(c, config.trustProxy));
    await next();
  });

  // Better Auth endpoints: OAuth callbacks, email verification and reset links.
  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    c.header("Cache-Control", "no-store");
    return deps.auth.handler(new Request(c.req.raw, { headers: authHeaders(c) }));
  });

  // Largest legitimate form is a 20k-character description.
  app.use("*", bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.text("Request too large.", 413) }));
  // Origin / Fetch Metadata check for all form writes, signed in or not.
  app.use("*", csrf({ origin: appOrigin }));
  app.use("*", loadSession());
  app.use("*", requireCsrfToken());

  app.get("/privacy", (c) => {
    noStore(c);
    return c.html(<PrivacyPage viewer={c.get("viewer")} csrf={c.get("csrf")} canonical={`${config.appUrl}/privacy`} />);
  });

  app.route("/", authRoutes());
  app.route("/", feedRoutes());
  app.route("/", changelogRoutes());
  app.route("/", requestRoutes());
  app.route("/", notificationRoutes());
  app.route("/", moderationRoutes());

  if (config.env !== "production" && deps.mailer.transport === "dev") {
    app.get("/dev/mail", (c) => c.html(<DevMailPage viewer={c.get("viewer")} csrf={c.get("csrf")} mails={deps.mailer.outbox()} />));
  }

  app.notFound((c) => {
    const viewer = c.var.viewer ?? null;
    return c.html(<MessagePage viewer={viewer} csrf={c.var.csrf ?? null} title="Not found" message="This page doesn't exist or was removed." />, 404);
  });

  app.onError((error, c) => {
    if ("getResponse" in error && typeof error.getResponse === "function") return error.getResponse();
    logger.error(`Unhandled error on ${c.req.method} ${loggablePath(c.req.path)}`, error);
    return c.html(<MessagePage viewer={null} csrf={null} title="Something went wrong" message="Try again in a moment." />, 500);
  });

  return app;
}
