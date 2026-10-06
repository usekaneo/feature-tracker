import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Config } from "../config";
import type { DB } from "../db/client";
import { account, session, user, verification } from "../db/schema";
import type { Mailer } from "../lib/mailer";
import type { Logger } from "../lib/logger";

/** Header carrying the client IP resolved by the app; incoming values are always overwritten. */
export const CLIENT_IP_HEADER = "x-ft-client-ip";

export function createAuth(opts: { db: DB; config: Config; mailer: Mailer; logger: Logger }) {
  const { db, config, mailer, logger } = opts;

  const deliver = (to: string, subject: string, text: string) => {
    // Not awaited: response timing must not reveal whether an account exists.
    mailer.send({ to, subject, text }).catch((error) => logger.error("Email delivery failed", error));
  };

  return betterAuth({
    appName: "Kaneo Feature Track",
    baseURL: config.appUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: [config.appUrl],
    database: drizzleAdapter(db, { provider: "sqlite", schema: { user, session, account, verification } }),
    telemetry: { enabled: false },
    logger: { level: config.env === "production" ? "error" : "warn", disabled: config.env === "test" },
    user: {
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "user", input: false },
        bannedAt: { type: "date", required: false, input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: (password) => Bun.password.hash(password, { algorithm: "argon2id" }),
        verify: ({ hash, password }) => Bun.password.verify(password, hash),
      },
      sendResetPassword: async ({ user, url }) => {
        deliver(
          user.email,
          "Reset your password",
          `Use this link to choose a new password for Kaneo Feature Track:\n\n${url}\n\nThe link expires in one hour. If you didn't ask for this, ignore this email.`,
        );
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        deliver(
          user.email,
          "Verify your email",
          `Confirm your email address for Kaneo Feature Track:\n\n${url}\n\nIf you didn't create an account, ignore this email.`,
        );
      },
    },
    socialProviders: config.github
      ? { github: { clientId: config.github.clientId, clientSecret: config.github.clientSecret } }
      : {},
    account: {
      accountLinking: { enabled: true, trustedProviders: ["github"] },
    },
    rateLimit: {
      enabled: config.env !== "test",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 300, max: 10 },
        "/sign-up/email": { window: 3600, max: 5 },
        "/request-password-reset": { window: 900, max: 5 },
        "/send-verification-email": { window: 900, max: 5 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      useSecureCookies: config.appUrl.startsWith("https://"),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type SessionData = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
