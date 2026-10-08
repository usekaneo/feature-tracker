import { dirname, join } from "node:path";

export type Env = "development" | "production" | "test";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

export type MailConfig =
  | { transport: "smtp"; from: string; smtp: SmtpConfig }
  | { transport: "dev"; from: string }
  | { transport: "disabled"; from: string };

export interface RepoConfig {
  /** REST/GraphQL base, https://api.github.com unless GitHub Enterprise. */
  apiUrl: string;
  token: string;
  owner: string;
  name: string;
  /** Label added to issues opened for accepted requests; created if missing. */
  label: string;
  /** Tags of final releases, e.g. v2.33.0. */
  releaseTag: RegExp;
  /** Tags of nightly / pre-release builds. */
  nightlyTag: RegExp;
  timeoutMs: number;
  /** How often tracked issues are checked for merged PRs and releases. */
  syncIntervalMs: number;
}

export interface ChangelogConfig {
  /** Connection to the repository whose releases are shown; the token may be empty for public repos. */
  repo: RepoConfig;
  /** Tags of MCP server releases, e.g. mcp-v0.1.12. */
  mcpTag: RegExp;
  /** Directory of the MCP package, used to build MCP notes from commits. */
  mcpPath: string;
  syncIntervalMs: number;
}

export interface Config {
  env: Env;
  port: number;
  appUrl: string;
  databasePath: string;
  authSecret: string;
  github: { clientId: string; clientSecret: string } | null;
  maintainerGithubIds: string[];
  captcha: { serverUrl: string; siteKey: string; secretKey: string } | null;
  mail: MailConfig;
  /** Repository where accepted requests become issues. */
  repo: RepoConfig | null;
  changelog: ChangelogConfig | null;
  labeler: LabelerConfig | null;
  trustProxy: boolean;
  backups: { directory: string; intervalMs: number; keep: number } | null;
}

export interface LabelerConfig {
  name: string;
  url: string;
  key: string;
  model: string;
  context: string;
}

const DEV_SECRET = "dev-only-secret-do-not-use-in-production-0000";

function trimSlash(url: string) {
  return url.replace(/\/+$/, "");
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const get = (key: string) => {
    const value = source[key]?.trim();
    return value ? value : undefined;
  };
  const nodeEnv = get("NODE_ENV");
  const env: Env = nodeEnv === "production" ? "production" : nodeEnv === "test" ? "test" : "development";
  const isProd = env === "production";
  const problems: string[] = [];

  const port = Number(get("PORT") ?? 3000);
  const appUrl = trimSlash(get("APP_URL") ?? `http://localhost:${port}`);
  if (isProd && !get("APP_URL")) problems.push("APP_URL is required in production");
  try {
    new URL(appUrl);
  } catch {
    problems.push("APP_URL must be an absolute URL");
  }

  let authSecret = get("BETTER_AUTH_SECRET");
  if (!authSecret) {
    if (isProd) problems.push("BETTER_AUTH_SECRET is required in production");
    authSecret = DEV_SECRET;
  } else if (isProd && authSecret.length < 32) {
    problems.push("BETTER_AUTH_SECRET must be at least 32 characters");
  }

  const githubId = get("GITHUB_CLIENT_ID");
  const githubSecret = get("GITHUB_CLIENT_SECRET");
  const github = githubId && githubSecret ? { clientId: githubId, clientSecret: githubSecret } : null;

  const maintainerGithubIds = (get("MAINTAINER_GITHUB_IDS") ?? "").split(",").map(v => v.trim()).filter(Boolean);
  if (maintainerGithubIds.some(v => !/^[1-9]\d*$/.test(v))) problems.push("MAINTAINER_GITHUB_IDS must be numeric GitHub account IDs");
  const capUrl = get("CAP_SERVER_URL"), capSite = get("CAP_SITE_KEY"), capSecret = get("CAP_SECRET_KEY");
  const captcha = capUrl && capSite && capSecret ? { serverUrl: trimSlash(capUrl), siteKey: capSite, secretKey: capSecret } : null;
  if ([capUrl, capSite, capSecret].some(Boolean) && !captcha) problems.push("Set CAP_SERVER_URL, CAP_SITE_KEY and CAP_SECRET_KEY together");
  if (captcha) {
    try { const u = new URL(captcha.serverUrl); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error(); }
    catch { problems.push("CAP_SERVER_URL must be an HTTP URL without credentials, query or fragment"); }
    if (!/^[a-f0-9]{10}$/.test(captcha.siteKey)) problems.push("CAP_SITE_KEY must be a CAP site identifier");
  }

  const from = get("MAIL_FROM") ?? "Kaneo Feature Track <no-reply@localhost>";
  if (isProd && !get("MAIL_FROM")) problems.push("MAIL_FROM is required in production");
  const transport = get("MAIL_TRANSPORT") ?? (isProd ? "smtp" : "dev");
  if (!["dev", "smtp", "disabled"].includes(transport)) problems.push("MAIL_TRANSPORT must be smtp, dev or disabled");
  if (isProd && transport !== "smtp") problems.push("Production requires MAIL_TRANSPORT=smtp");
  if (isProd && !get("SMTP_HOST")) problems.push("SMTP_HOST is required in production");
  if (!!get("SMTP_USER") !== !!get("SMTP_PASS")) problems.push("Set SMTP_USER and SMTP_PASS together, or leave both empty for an unauthenticated relay");
  let mail: MailConfig;
  if (transport === "dev") {
    if (isProd) problems.push("MAIL_TRANSPORT=dev is not allowed in production");
    mail = { transport: "dev", from };
  } else if (transport === "smtp" && get("SMTP_HOST")) {
    const smtpPort = Number(get("SMTP_PORT") ?? 587);
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) problems.push("SMTP_PORT must be an integer from 1 to 65535");
    if (get("SMTP_SECURE") && !["true", "false"].includes(get("SMTP_SECURE")!)) problems.push("SMTP_SECURE must be true or false");
    mail = {
      transport: "smtp",
      from,
      smtp: {
        host: get("SMTP_HOST")!,
        port: smtpPort,
        secure: (get("SMTP_SECURE") ?? (smtpPort === 465 ? "true" : "false")) === "true",
        user: get("SMTP_USER"),
        pass: get("SMTP_PASS"),
      },
    };
  } else {
    mail = { transport: "disabled", from };
  }

  const pattern = (key: string, fallback: string) => {
    try {
      return new RegExp(get(key) ?? fallback);
    } catch {
      problems.push(`${key} is not a valid regular expression`);
      return new RegExp(fallback);
    }
  };
  const repoConfig = (key: string, fullName: string, token: string): RepoConfig => {
    const [owner, name, extra] = fullName.split("/");
    if (!owner || !name || extra !== undefined) problems.push(`${key} must look like owner/name`);
    return {
      apiUrl: trimSlash(get("GITHUB_API_URL") ?? "https://api.github.com"),
      token,
      owner: owner ?? "",
      name: name ?? "",
      label: get("GITHUB_ISSUE_LABEL") ?? "feature",
      releaseTag: pattern("GITHUB_RELEASE_TAG_PATTERN", "^v\\d+\\.\\d+\\.\\d+$"),
      nightlyTag: pattern("GITHUB_NIGHTLY_TAG_PATTERN", "^(nightly.*|v\\d+\\.\\d+\\.\\d+-.+)$"),
      timeoutMs: Number(get("GITHUB_TIMEOUT_MS") ?? 15000),
      syncIntervalMs: Number(get("GITHUB_SYNC_INTERVAL_SECONDS") ?? 300) * 1000,
    };
  };

  const repoName = get("GITHUB_REPO");
  const repoToken = get("GITHUB_TOKEN");
  const repo = repoName && repoToken ? repoConfig("GITHUB_REPO", repoName, repoToken) : null;

  // The changelog only reads public data, so it works without a token (at GitHub's lower anonymous rate limit).
  const changelogName = get("CHANGELOG_REPO") ?? repoName;
  const changelog: ChangelogConfig | null = changelogName
    ? {
        repo: repoConfig(get("CHANGELOG_REPO") ? "CHANGELOG_REPO" : "GITHUB_REPO", changelogName, repoToken ?? ""),
        mcpTag: pattern("CHANGELOG_MCP_TAG_PATTERN", "^mcp-v\\d+\\.\\d+\\.\\d+$"),
        mcpPath: get("CHANGELOG_MCP_PATH") ?? "packages/mcp",
        syncIntervalMs: Number(get("CHANGELOG_SYNC_INTERVAL_SECONDS") ?? 1800) * 1000,
      }
    : null;

  const labelContext = get("AUTO_LABEL_CONTEXT") ?? "Kaneo is an open-source project management app. This board collects feature requests for Kaneo and its MCP server. Classify the requested change and the demonstrated user problem.";
  const openrouterKey = get("OPENROUTER_API_KEY");
  const typesafeKey = get("TYPESAFE_API_KEY");
  const labeler: LabelerConfig | null = get("AUTO_LABEL_ENABLED") === "false" ? null
    : openrouterKey ? {
      name: "OpenRouter", url: "https://openrouter.ai/api/alpha/decisions", key: openrouterKey,
      model: get("JEV_MODEL") ?? "typesafe/jev-1.13", context: labelContext,
    } : typesafeKey ? {
      name: "TypeSafe", url: "https://api.typesafe.ai/v1/systemone", key: typesafeKey,
      model: get("JEV_MODEL") ?? "jev-latest", context: labelContext,
    } : null;

  const databasePath = get("DATABASE_PATH") ?? "./data/tracker.db";
  const backupEnabled = get("BACKUP_ENABLED") ?? (isProd ? "true" : "false");
  if (!["true", "false"].includes(backupEnabled)) problems.push("BACKUP_ENABLED must be true or false");
  const backupHours = Number(get("BACKUP_INTERVAL_HOURS") ?? 24);
  const backupKeep = Number(get("BACKUP_KEEP") ?? 7);
  if (!Number.isFinite(backupHours) || backupHours <= 0 || backupHours > 24 * 24) problems.push("BACKUP_INTERVAL_HOURS must be greater than 0 and at most 576");
  if (!Number.isInteger(backupKeep) || backupKeep < 1) problems.push("BACKUP_KEEP must be a positive integer");
  if (backupEnabled === "true" && databasePath === ":memory:") problems.push("Automatic backups require a file-backed database");

  if (problems.length) {
    throw new Error(`Invalid configuration:\n- ${problems.join("\n- ")}`);
  }

  return {
    env,
    port,
    appUrl,
    databasePath,
    authSecret,
    github,
    maintainerGithubIds,
    captcha,
    mail,
    repo,
    changelog,
    labeler,
    trustProxy: get("TRUST_PROXY") === "true",
    backups: backupEnabled === "true" ? {
      directory: get("BACKUP_DIR") ?? join(dirname(databasePath), "backups"),
      intervalMs: backupHours * 60 * 60_000,
      keep: backupKeep,
    } : null,
  };
}

export function isDevSecret(config: Config) {
  return config.authSecret === DEV_SECRET;
}
