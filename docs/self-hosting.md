# Self-hosting Slipstream for a team

On your own laptop, Slipstream runs with no setup at all (see the README's quick start), and `slipstream service install` keeps it running from the moment you log in. Run it on a server when a team wants shared snippets, shared conversations with comments, and one place everyone signs in to.

Each person's mailboxes stay private to them on the server. Teammates only see what someone deliberately shares.

## What a server needs

- One always-on container. Mail sync runs in the background, so a platform that sleeps idle apps won't work.
- A persistent disk mounted at `/data`. It holds the SQLite database and cached attachments.
- HTTPS. Every platform below handles it for you.
- About 512 MB of RAM for a small team.

## Recommended: Fly.io

Fly runs the Docker image as a single always-on machine with a volume. It's the cheapest fit for this shape. As of October 2026, about $4 a month buys a 512 MB machine with a 1 GB volume (shared-cpu-1x at $3.69, volumes at $0.15/GB-month).

```bash
fly launch --no-deploy --copy-config      # pick an app name; keeps fly.toml
fly volumes create slipstream_data --size 3
fly secrets set SLIPSTREAM_SECRET="$(openssl rand -base64 32)"
fly deploy
```

Open `https://<your-app>.fly.dev`. The first person to sign up creates the workspace and becomes its owner. Everyone after that joins through an invite link from Settings → Team.

Optional extras:

- **Backups.** Create a Tigris bucket (`fly storage create`), then add these secrets:
  ```bash
  fly secrets set LITESTREAM_REPLICA_URL="s3://<bucket>/slipstream?endpoint=fly.storage.tigris.dev&region=auto" \
    LITESTREAM_ACCESS_KEY_ID=… LITESTREAM_SECRET_ACCESS_KEY=…
  ```
- **Gmail and Outlook.** Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_ID` as secrets. See [connect-accounts.md](connect-accounts.md).
- **Custom domain.** Run `fly certs add mail.yourco.com`, then `fly secrets set SLIPSTREAM_PUBLIC_URL=https://mail.yourco.com`.

## Anywhere with Docker (fallback)

This works on any VPS: Hetzner, DigitalOcean, a home server, or Coolify.

```bash
git clone https://github.com/Tradelord223/slipstream && cd slipstream
cp .env.example .env        # set SLIPSTREAM_PUBLIC_URL and SLIPSTREAM_SECRET at minimum
docker compose up -d
```

Put it behind a reverse proxy that terminates HTTPS. With Caddy, that's one line: `mail.yourco.com { reverse_proxy localhost:8080 }`. On Coolify, add the repo as a Docker Compose resource and set the same variables.

## Render and Railway

- **Render.** `render.yaml` is a Blueprint. Click "New → Blueprint" and point it at your fork. A persistent disk requires a paid instance (Starter, $7/month in October 2026). Render generates `SLIPSTREAM_SECRET` for you.
- **Railway.** `railway.json` uses the Dockerfile. Add a volume mounted at `/data` and set `SLIPSTREAM_SECRET`. Railway's Hobby plan caps volumes at 5 GB.

Cloudflare Workers and Containers aren't a fit. Their disks are ephemeral and instances sleep, while Slipstream needs a real disk and always-on sync. Cloudflare R2 works well as a Litestream backup target.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `SLIPSTREAM_MODE` | `local` (`team` in Docker) | `team` turns on accounts, sessions and workspaces. |
| `SLIPSTREAM_PUBLIC_URL` | detected on Fly, Render and Railway | The origin people use. Needed for OAuth redirects and invite links. |
| `SLIPSTREAM_SECRET` | required in team mode | Encrypts stored mail credentials (AES-256-GCM). Keep it safe and never change it. |
| `SLIPSTREAM_DATA_DIR` | `~/.slipstream` (`/data` in Docker) | Holds the database, attachment cache and key file. |
| `PORT` | `4380` (`8080` in Docker) | HTTP port. |
| `SLIPSTREAM_OPEN_SIGNUP` | off | `1` lets anyone with the URL create an account. Otherwise it's invite-only after the first owner. |
| `SLIPSTREAM_ALLOWED_HOSTS` | public URL host | Extra hostnames to accept, comma-separated. |
| `SLIPSTREAM_SYNC_SECONDS` | `60` | How often to poll providers. |
| `SLIPSTREAM_UNDO_SEND_SECONDS` | `10` | How long Undo Send waits. |
| `SLIPSTREAM_SENDER_LOGOS` | on | `off` stops this server from ever fetching sender logos, whatever people choose in Settings. Logos are also off for each person until they turn them on. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Enables "Continue with Google". |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT` | none (tenant `common`) | Enables "Continue with Microsoft". Slipstream has no Microsoft app of its own yet, so this is needed for Outlook sign-in (see [Register Slipstream's Microsoft app](connect-accounts.md#register-slipstreams-microsoft-app)). |
| `SLIPSTREAM_DEMO` | off | `1` adds an invented demo mailbox on first start (local mode, for developers). With this set the demo mailbox stays beside your real accounts. Without it, a new install never creates one, and an older install that still has one loses it when a real account is connected. `slipstream --demo` does the same as setting this. |
| `SLIPSTREAM_SOURCE_URL` | this project's GitHub repo | Where the app's "Source code" link points. If you run a modified Slipstream for other people, point it at your modified source. |
| `ANTHROPIC_API_KEY` | none | A server-wide AI key. People can also add their own. |
| `LITESTREAM_REPLICA_URL` + `LITESTREAM_ACCESS_KEY_ID` / `LITESTREAM_SECRET_ACCESS_KEY` | none | Continuous backups of the database to S3-compatible storage. |

## Check your setup

`slipstream doctor` checks an install without changing anything and says what to fix, in plain words:
- **Basics:** the Node.js version, the data folder's permissions, free disk space, and that the database opens and isn't damaged.
- **Encryption key:** that the key still opens the saved sign-ins.
- **Running:** whether Slipstream is running, or another program has its port.
- **Accounts:** each mail account's sync, and changes or sends that didn't go through.
- **Team servers only:** that the public address is https, and that backups and `SLIPSTREAM_SECRET` are set.

```bash
slipstream doctor                                # on your own computer
fly ssh console -C "node /app/dist/cli.js doctor" # on Fly.io
docker compose exec slipstream node /app/dist/cli.js doctor
```

Add `--json` for scripts and agents. It exits with status 1 when something needs fixing.

## Backups and restore

- **What Litestream covers.** It streams every database change to your bucket. On a fresh volume, the container restores from the bucket before it starts.
- **Your secret.** Back up `SLIPSTREAM_SECRET` separately, for example in a password manager. Without it, a restored database can't decrypt the stored mail-account tokens. Everyone would have to reconnect their accounts, though their mail and settings stay intact.
- **What isn't backed up.** The attachment cache in `/data/blobs` is skipped. For Gmail, Outlook and IMAP accounts, attachments are fetched again on demand. Attachments in imported `.mbox` archives exist only on the volume, so keep the original files.

## Updating

Pull the new version and redeploy (`fly deploy` or `docker compose up -d --build`). Database migrations run automatically at startup and are append-only.
