# Kaneo Feature Track

A small feature-request tracker for [Kaneo](https://kaneo.app). Visitors propose and discuss features and vote on them. When a maintainer accepts a request, the tracker opens a GitHub issue labelled `feature`. The request then shows **Merged** once a linked pull request is merged, **In nightly** when a nightly build contains it, and **Released** once a final release does.

Bun, Hono (server-rendered JSX + htmx), SQLite, Drizzle and Better Auth, in a single process.

## Run locally

Requires Bun 1.3.12 or newer.

```sh
bun install
cp .env.example .env        # defaults work for local development
bun run db:migrate
bun run db:seed             # optional sample data
bun run dev                 # http://localhost:3000
```

Seed accounts: `maintainer@example.com` (maintainer) and `ada@example.com`, both with password `password123`.

In development, emails are printed to the console and listed at `/dev/mail`. To use a local SMTP catcher such as Mailpit instead, set `MAIL_TRANSPORT=smtp`, `SMTP_HOST=localhost` and `SMTP_PORT=1025`.

Checks: `bun test`, `bun run typecheck`, `bun run build`.

## Production

```sh
bun install --frozen-lockfile
bun run build
NODE_ENV=production bun dist/scripts/migrate.js
bun run start
```

`bun run start` sets `NODE_ENV=production`. When invoking the bundle directly, set `NODE_ENV=production` yourself.
Use `MAIL_TRANSPORT=smtp` (or leave it empty), set `MAIL_FROM` and `SMTP_HOST`, and configure the port and TLS settings for your provider.
Production refuses missing email configuration and checks SMTP connectivity and authentication before opening the HTTP port.
The connection check cannot confirm inbox delivery: send a verification email and a password-reset email to a real test account before launch.

Or with Docker (the database lives in the `/data` volume; migrations run on start):

```sh
docker build -t kaneo-feature-track .
docker run -d -p 3000:3000 -v feature-track-data:/data --env-file .env kaneo-feature-track
```

### Configuration

See `.env.example`. Required in production:

- `APP_URL`: public URL, for example `https://feedback.example.com`
- `BETTER_AUTH_SECRET`: at least 32 characters (`openssl rand -hex 32`)
- `SMTP_HOST`, `MAIL_FROM`: needed for email verification, password resets and notification emails
- `SMTP_PORT` (default 587), `SMTP_SECURE` (inferred true for port 465, false otherwise): match your email provider
- `SMTP_USER`, `SMTP_PASS`: set both for authenticated SMTP, or leave both empty for a trusted unauthenticated relay

Optional:

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: GitHub OAuth app with callback URL `<APP_URL>/api/auth/callback/github`
- `GITHUB_REPO`, `GITHUB_TOKEN`: repository for issues, and a fine-grained token for it with **Issues: read and write**, **Contents: read** and **Pull requests: read**. Until both are set, accepted requests show a pending issue.
- `GITHUB_ISSUE_LABEL` (default `feature`), `GITHUB_RELEASE_TAG_PATTERN`, `GITHUB_NIGHTLY_TAG_PATTERN`, `GITHUB_SYNC_INTERVAL_SECONDS` (default 300): see `.env.example`. A pull request counts when it closes the issue (for example "Closes #123") and is merged into the default branch.
- `CHANGELOG_REPO`: repository for the `/changelog` page (defaults to `GITHUB_REPO`; no token needed for public repositories). Kaneo releases use their GitHub release notes. MCP releases (`mcp-vX.Y.Z` tags) get notes built from the commits under `CHANGELOG_MCP_PATH`.
- `TRUST_PROXY=true`: only behind a reverse proxy that sets `X-Forwarded-For`

### Maintainers

No account becomes a maintainer automatically. After the person has signed up and verified their email, run on the server:

```sh
bun run maintainer grant person@example.com     # Docker: docker exec <container> bun dist/scripts/maintainer.js grant …
bun run maintainer revoke person@example.com
bun run maintainer list
```

### Automatic labels

Set `OPENROUTER_API_KEY` or `TYPESAFE_API_KEY`, run `bun run db:migrate`, then restart the app. OpenRouter takes precedence when both keys are set. Set `AUTO_LABEL_ENABLED=false` to pause labeling; pending work resumes when enabled again. `JEV_MODEL` and `AUTO_LABEL_CONTEXT` are optional overrides.

New requests and title/description edits are labeled in the background using the Jev rubric ported from usetriaged:

- Priority: impact (50%), urgency (35%), readiness (15%), mapped to `priority: critical` (80+), `priority: high` (60+), `priority: medium` (35+), or `priority: low`.
- Category: `bug`, `feature`, `docs`, `maintenance`, or `question`, when category confidence is at least 70%.
- Area: the single best matching existing custom label, when confidence is at least 70%. Create area labels such as API, Board, Integrations, Mobile, or Notifications on the maintainer Labels page. At most 100 custom labels, in creation order, are considered.
- `needs-review` marks low-confidence assessments, empty descriptions, and truncated descriptions. Maintainers can see the score and review reasons under **Manage → Auto-labeler**.

The provider receives the title, the first 12,000 description characters, project context and area label names. Links, attachments, comments, user details and vote counts are excluded. Classification uses the [Jev Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request), with the model pinned to `typesafe/jev-1.13` on OpenRouter by default. Provider calls use the configured account's allowance.

Saving labels manually preserves the maintainer's entire label selection through future edits. **Re-run auto-labeler** explicitly resumes automation, replacing only labels previously added by the auto-labeler. Unrelated labels survive. This labels requests in the tracker; GitHub issue creation continues to use `GITHUB_ISSUE_LABEL`.

Work is persisted with each content change. Temporary failures retry up to five times; other errors appear in the maintainer panel for a manual retry. Hidden requests are skipped. To queue existing requests without replacing previous assessments or maintainer choices:

```sh
bun run labels:backfill
# Docker: docker exec <container> bun dist/scripts/label-backfill.js
```

The running app processes the queue. Backfill queues work without calling the provider itself.

### Notifications

People follow a request when they submit it, vote on it or comment on it, and can follow or unfollow it from the request page. Followers see status changes (including the ones GitHub drives) and new comments under the bell in the header, at `/notifications`. Each person picks which ones also arrive by email: status changes are on by default, comments off. Every email has a signed link that unfollows the request without signing in. Queued emails are retried for two days and then dropped, and notifications are deleted after 180 days.

### Moderation

Signed-in users can report a request or comment. Maintainers review reports at `/moderation` (linked from the account menu, with the open count). There they can hide the content or dismiss the reports, and suspend accounts. Suspended accounts can still sign in and read, but can't post, edit, vote or report. When you suspend an account you can also hide everything it posted. Hiding, locking and suspensions are recorded in the moderation log shown on the same page.

### Migrations

Migrations live in `drizzle/` and are applied with `bun run db:migrate` (the Docker image runs them on start). After changing `src/db/schema.ts`, generate a new one with `bun run db:generate`.

### Backups

The database is a single SQLite file in WAL mode. Don't copy the file while the server runs. Instead, take a consistent online backup:

```sh
bun run db:backup ./backups/tracker.db          # Docker: docker exec <container> bun dist/scripts/backup.js /data/backup.db
```

To restore, stop the server and replace the database file with the backup. Remove any `-wal` and `-shm` files next to it before you start the server again.

Production automatically takes a backup at startup and every 24 hours in a separate process, verifies its SQLite integrity, and keeps the newest seven automatic snapshots.
They are stored in `backups/` next to the database (`/data/backups` in Docker, inside the persistent data volume).
Set `BACKUP_DIR`, `BACKUP_INTERVAL_HOURS`, and `BACKUP_KEEP` to override these defaults, or `BACKUP_ENABLED=false` when an external backup service handles them.
Rotation runs only after a successful backup, preserves manual backups, and logs failures without deleting existing snapshots. Backup files have owner-only permissions.
Interrupted copies stay in hidden `.tracker-backup-*` staging directories and are never offered as completed backups; these directories can be removed after the backup process has stopped.
Copy completed snapshots to off-host storage too, and test a restore periodically; local snapshots do not protect against losing the server or volume.

## Release checks

CI runs the frozen install, dependency audit, type-check, tests, production build, and Docker smoke check on every push and pull request.
Run the same checks locally before tagging a release:

```sh
bun install --frozen-lockfile
bun audit
bun run typecheck
bun test
bun run build
bun run smoke:docker
```

The Docker check uses an isolated SMTP sink and verifies real SMTP delivery, automatic backup rotation, static assets, and that `/dev/mail` is unavailable.
The asset build uses Tailwind's compiler and scanner directly, with Bun's filesystem watcher during development; this removes the vulnerable `braces` dependency from the former CLI watcher.
The `esbuild` override keeps Drizzle's legacy loader on a patched version. Recheck it when upgrading Drizzle Kit.

Before deploying, configure HTTPS and the reverse proxy, verify email delivery to a real inbox, grant the first maintainer role, and (when enabled) test GitHub sign-in and issue creation using the intended repository/token.
Queued issue creation pauses when a request is hidden, reopened or declined, and resumes when visible and accepted again. An issue creation request already sent to GitHub may still complete; hiding content does not delete an existing GitHub issue.
