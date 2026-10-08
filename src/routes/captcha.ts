import { Hono } from "hono";
import type { AppEnv } from "../http";
import { RateLimiter } from "../lib/rate-limit";

/** Public challenge/solver proxy. Admin and siteverify are deliberately absent. */
export function captchaRoutes() {
  const app = new Hono<AppEnv>();
  const limiter = new RateLimiter(60, 60_000);
  app.all("*", async c => {
    const config = c.get("deps").config.captcha;
    if (!config) return c.notFound();
    const path = c.req.path.slice("/captcha/".length);
    const asset = /^assets\/(widget\.js|cap_wasm_bg\.wasm|hashwx\.wasm)$/.test(path);
    if (!(asset && c.req.method === "GET") && !(c.req.method === "POST" && ["challenge", "redeem"].includes(path))) return c.notFound();
    if (!asset && !limiter.hit(c.get("ip")).ok) return c.text("Too many challenges. Try again shortly.", 429);
    try {
      const response = await fetch(`${config.serverUrl}/${asset ? path : `${config.siteKey}/${path}`}`, {
        method: c.req.method, redirect: "error", signal: AbortSignal.timeout(10_000),
        ...(!asset ? { headers: { "Content-Type": "application/json" }, body: await c.req.text() } : {}),
      });
      const headers = new Headers({ "Cache-Control": asset ? "public, max-age=3600" : "no-store" });
      headers.set("Content-Type", response.headers.get("Content-Type") ?? (asset ? "application/octet-stream" : "application/json"));
      return new Response(response.body, { status: response.status, headers });
    } catch { return c.text("Bot verification is temporarily unavailable. Try again shortly.", 503); }
  });
  return app;
}
