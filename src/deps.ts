import type { CaptchaFetch } from "./lib/captcha";
import { createAuth } from "./auth/auth";
import type { Config } from "./config";
import { createDb } from "./db/client";
import type { Deps } from "./http";
import { GitHubClient, type FetchLike } from "./github/client";
import { ChangelogSync } from "./github/changelog";
import { GitHubSync } from "./github/sync";
import { consoleLogger, type Logger } from "./lib/logger";
import { createMailer, type Mailer } from "./lib/mailer";
import { createRateLimits } from "./lib/rate-limit";
import { NotificationEmails } from "./services/notification-emails";
import { AutoLabeler } from "./labeler/worker";
import type { LabelerFetch } from "./labeler/assess";

export function createDeps(
  config: Config,
  overrides: { captchaFetch?: CaptchaFetch; logger?: Logger; mailer?: Mailer; githubFetch?: FetchLike; labelerFetch?: LabelerFetch; now?: () => number } = {},
): Deps {
  const logger = overrides.logger ?? consoleLogger;
  const { db, sqlite } = createDb(config.databasePath);
  const mailer = overrides.mailer ?? createMailer(config.mail, logger);
  const auth = createAuth({ db, config, mailer, logger, captchaFetch: overrides.captchaFetch });
  const client = config.repo ? new GitHubClient(config.repo, overrides.githubFetch) : null;
  const notifier = new NotificationEmails({ db, mailer, appUrl: config.appUrl, secret: config.authSecret, logger, now: overrides.now });
  const issues = new GitHubSync({ db, client, appUrl: config.appUrl, logger, now: overrides.now, onNotify: () => notifier.kick() });
  const changelogClient = config.changelog ? new GitHubClient(config.changelog.repo, overrides.githubFetch) : null;
  const changelog = new ChangelogSync({ db, client: changelogClient, config: config.changelog, logger, now: overrides.now });
  const labeler = new AutoLabeler({ db, provider: config.labeler, logger, fetcher: overrides.labelerFetch, now: overrides.now });
  return { config, db, sqlite, auth, mailer, logger, issues, changelog, labeler, notifier, limits: createRateLimits() };
}
