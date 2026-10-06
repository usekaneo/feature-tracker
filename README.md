# Kaneo Feature Track

Feature requests, votes, and discussion for [Kaneo](https://kaneo.app). Accepted requests become GitHub issues; linked PRs and releases update their status.

Built with Bun, Hono, SQLite, and htmx.

## Development

Requires Bun 1.3.12 or newer.

```sh
bun install
cp .env.example .env
bun run db:migrate
bun run db:seed  # optional
bun run dev     # http://localhost:3000
```

Seed accounts: `maintainer@example.com` and `ada@example.com`, password `password123`. Development emails appear at `/dev/mail`.

## Deployment

Configure [`.env.example`](.env.example):

- Set `APP_URL`, `BETTER_AUTH_SECRET` (`openssl rand -hex 32`), and SMTP settings including `MAIL_FROM`.
- Leave `MAIL_TRANSPORT` empty or set it to `smtp`. Startup checks the SMTP connection.
- Set `TRUST_PROXY=true` only behind a proxy that overwrites `X-Forwarded-For`.

```sh
docker build -t kaneo-feature-track .
docker run -d -p 3000:3000 -v feature-track-data:/data --env-file .env kaneo-feature-track
```

Docker runs migrations on startup and stores the database in `/data`. Without Docker:

```sh
bun install --frozen-lockfile
bun run build
NODE_ENV=production bun dist/scripts/migrate.js
bun run start
```

Optional integrations:

- **GitHub sign-in:** set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Callback: `<APP_URL>/api/auth/callback/github`.
- **GitHub issues:** set `GITHUB_REPO` and `GITHUB_TOKEN` with Issues read/write, Contents read, and Pull requests read.
- **Auto-labeling:** set `OPENROUTER_API_KEY` or `TYPESAFE_API_KEY`. The provider receives request titles and descriptions.

## Administration

Grant a maintainer role after the account has verified its email:

```sh
bun run maintainer grant person@example.com
# Docker: docker exec <container> bun dist/scripts/maintainer.js grant person@example.com
```

Use `revoke` to remove the role. Maintainers manage labels and moderation in the account menu.

Production backs up at startup and daily, keeping seven snapshots beside the database (`/data/backups` in Docker). See `.env.example` for overrides. Copy snapshots off-host too.

For a manual backup, run `bun run db:backup ./backups/tracker.db`. To restore, stop the server, replace the database with a backup, and remove its `-wal` and `-shm` files before restarting.

## Checks

```sh
bun run typecheck && bun test && bun audit && bun run build
bun run smoke:docker
```
