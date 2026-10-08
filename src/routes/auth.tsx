import { Hono } from "hono";
import { APIError } from "better-auth/api";
import { authHeaders, forwardCookies, formString, noStore, safeNext, type AppEnv, type Ctx } from "../http";
import { CheckEmailPage, ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from "../views/auth";
import { MessagePage } from "../views/misc";

const errorCode = (error: unknown) => (error instanceof APIError ? String((error.body as { code?: string })?.code ?? "") : "");

const verifiedCallback = (next: string) => `/email-verified?next=${encodeURIComponent(next)}`;

export function authRoutes() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    noStore(c);
    await next();
  });

  app.get("/login", (c) => {
    const next = safeNext(c.req.query("next"));
    if (c.get("viewer")) return c.redirect(next);
    const error = c.req.query("error") ? "GitHub sign-in didn't complete. Try again." : undefined;
    return c.html(<LoginPage captcha={!!c.get("deps").config.captcha} next={next} github={!!c.get("deps").config.github} error={error} />);
  });

  app.post("/login", async (c) => {
    const { auth, config, limits } = c.get("deps");
    const body = await c.req.parseBody();
    const email = formString(body, "email").toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const next = safeNext(formString(body, "next"));
    const render = (error: string, status: 400 | 401 | 403 | 429) =>
      c.html(<LoginPage captcha={!!c.get("deps").config.captcha} next={next} github={!!config.github} email={email} error={error} />, status);

    const blocked = limits.signIn.hit(`ip:${c.get("ip")}`);
    if (!blocked.ok) return render("Too many attempts. Try again in a few minutes.", 429);
    if (!email || !password) return render("Enter your email and password.", 400);

    try {
      const { headers } = await auth.api.signInEmail({
        body: { email, password, callbackURL: verifiedCallback(next) },
        headers: authHeaders(c, formString(body, "cap-token")),
        returnHeaders: true,
      });
      forwardCookies(c, headers);
      return c.redirect(next, 303);
    } catch (error) {
      if (errorCode(error) === "CAPTCHA_REQUIRED") return render("Complete the bot check and try again.", 403);
      if (errorCode(error) === "EMAIL_NOT_VERIFIED") return render("Verify your email first. We sent you a new link.", 403);
      if (error instanceof APIError) return render("Wrong email or password.", 401);
      throw error;
    }
  });

  app.post("/login/github", async (c) => {
    const { auth, config } = c.get("deps");
    if (!config.github) return c.redirect("/login", 303);
    const body = await c.req.parseBody();
    const next = safeNext(formString(body, "next"));
    const { headers, response } = await auth.api.signInSocial({
      body: { provider: "github", callbackURL: next, errorCallbackURL: "/login?error=github" },
      headers: authHeaders(c),
      returnHeaders: true,
    });
    if (!response?.url) return c.redirect("/login?error=github", 303);
    forwardCookies(c, headers);
    return c.redirect(response.url, 303);
  });

  app.get("/register", (c) => {
    const next = safeNext(c.req.query("next"));
    if (c.get("viewer")) return c.redirect(next);
    return c.html(<RegisterPage captcha={!!c.get("deps").config.captcha} next={next} />);
  });

  app.post("/register", async (c) => {
    const { auth, limits } = c.get("deps");
    const body = await c.req.parseBody();
    const name = formString(body, "name").slice(0, 60);
    const email = formString(body, "email").toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const next = safeNext(formString(body, "next"));
    const render = (error: string, status: 400 | 429) => c.html(<RegisterPage captcha={!!c.get("deps").config.captcha} next={next} name={name} email={email} error={error} />, status);

    if (!limits.signUp.hit(`ip:${c.get("ip")}`).ok) return render("Too many sign-ups from your network. Try again later.", 429);
    if (!name) return render("Enter your name.", 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return render("Enter a valid email.", 400);
    if (password.length < 8) return render("Password must be at least 8 characters.", 400);
    if (password.length > 128) return render("Password is too long.", 400);

    try {
      await auth.api.signUpEmail({
        body: { name, email, password, callbackURL: verifiedCallback(next) },
        headers: authHeaders(c, formString(body, "cap-token")),
      });
    } catch (error) {
      const code = errorCode(error);
      if (code === "CAPTCHA_REQUIRED") return render("Complete the bot check and try again.", 400);
      if (code === "INVALID_EMAIL") return render("Enter a valid email.", 400);
      if (code === "PASSWORD_TOO_SHORT") return render("Password must be at least 8 characters.", 400);
      if (code === "PASSWORD_TOO_LONG") return render("Password is too long.", 400);
      // Existing accounts get the same response as new ones to avoid revealing which emails are registered.
      if (!(error instanceof APIError)) throw error;
    }
    return c.html(<CheckEmailPage email={email} />);
  });

  app.get("/email-verified", (c) => {
    if (c.req.query("error")) {
      return c.html(
        <MessagePage viewer={c.get("viewer")} csrf={c.get("csrf")} title="Link expired" message="Sign in to get a new verification link." />,
        400,
      );
    }
    return c.redirect(safeNext(c.req.query("next")));
  });

  app.get("/forgot-password", (c) => c.html(<ForgotPasswordPage captcha={!!c.get("deps").config.captcha} />));

  app.post("/forgot-password", async (c) => {
    const { auth, limits } = c.get("deps");
    const body = await c.req.parseBody();
    const email = formString(body, "email").toLowerCase();
    if (!limits.emailLink.hit(`ip:${c.get("ip")}`).ok) {
      return c.html(<ForgotPasswordPage captcha={!!c.get("deps").config.captcha} error="Too many requests. Try again later." />, 429);
    }
    if (!email) return c.html(<ForgotPasswordPage captcha={!!c.get("deps").config.captcha} error="Enter your email." />, 400);
    try {
      await auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" }, headers: authHeaders(c, formString(body, "cap-token")) });
    } catch (error) {
      if (errorCode(error) === "CAPTCHA_REQUIRED") return c.html(<ForgotPasswordPage captcha={!!c.get("deps").config.captcha} error="Complete the bot check and try again." />, 403);
      if (!(error instanceof APIError)) throw error;
    }
    return c.html(<ForgotPasswordPage captcha={!!c.get("deps").config.captcha} sent />);
  });

  app.get("/reset-password", (c) => {
    const token = c.req.query("error") ? "" : (c.req.query("token") ?? "");
    return c.html(<ResetPasswordPage token={token} />);
  });

  app.post("/reset-password", async (c) => {
    const { auth, limits } = c.get("deps");
    const body = await c.req.parseBody();
    const token = formString(body, "token");
    const password = typeof body.password === "string" ? body.password : "";
    if (!limits.emailLink.hit(`reset:${c.get("ip")}`).ok) {
      return c.html(<ResetPasswordPage token={token} error="Too many attempts. Try again later." />, 429);
    }
    if (password.length < 8) return c.html(<ResetPasswordPage token={token} error="Password must be at least 8 characters." />, 400);
    if (password.length > 128) return c.html(<ResetPasswordPage token={token} error="Password is too long." />, 400);
    try {
      await auth.api.resetPassword({ body: { newPassword: password, token }, headers: authHeaders(c) });
    } catch (error) {
      if (error instanceof APIError) return c.html(<ResetPasswordPage token="" />, 400);
      throw error;
    }
    return c.html(<LoginPage captcha={!!c.get("deps").config.captcha} next="/" github={!!c.get("deps").config.github} notice="Password updated. Sign in with your new password." />);
  });

  app.post("/logout", async (c: Ctx) => {
    const { auth } = c.get("deps");
    try {
      const { headers } = await auth.api.signOut({ headers: authHeaders(c), returnHeaders: true });
      forwardCookies(c, headers);
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
    }
    return c.redirect("/", 303);
  });

  return app;
}
