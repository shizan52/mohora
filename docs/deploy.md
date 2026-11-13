# Deploying Mohora

This guide takes you from an empty Linux server to a public site with HTTPS, Google sign-in, Telegram alerts and daily backups. Allow about half an hour, most of it waiting on DNS and Google's console.

Want a GPU-powered built-in AI (no API key needed for your visitors)? Do this guide first, then [docs/gpu.md](gpu.md).

## What you need

| | |
|---|---|
| A server | Any Linux box with 1 GB of RAM or more. Without the GPU profile, the site is light: one Python process and a SQLite file. |
| A domain | With an `A` record pointing at the server's IP. Caddy needs ports **80** and **443** reachable to get its certificate. |
| Docker | Docker Engine with the Compose plugin ([install guide](https://docs.docker.com/engine/install/)). |
| A Google account | To create the sign-in credentials (free). |
| Optional | A Telegram account for owner alerts; a USDT (TRC20) wallet address to take Pro payments. |

No Docker? Jump to [Without Docker](#without-docker).

## 1. Get the code and configure it

```bash
git clone https://github.com/shizan52/mohora.git
cd mohora
cp .env.example .env
```

Open `.env` and set at least these four:

```ini
BASE_URL=https://practice.example.com
DOMAIN=practice.example.com
SECRET_KEY=<a long random string>
ADMIN_EMAILS=you@gmail.com
```

Make the secret with `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`. The site refuses to start on an `https://` address while `SECRET_KEY` is still `change-me`.

## 2. Set up Google sign-in

1. Open the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick one).
2. **APIs & Services → OAuth consent screen**: choose *External*, fill in the app name and your support email. Add your domain under *Authorized domains*, and set the privacy policy and terms links to `https://<your-domain>/privacy` and `https://<your-domain>/terms` (both pages ship with the app).
3. **Credentials → Create credentials → OAuth client ID**, type *Web application*. Under *Authorized redirect URIs* add exactly `https://<your-domain>/auth/callback`.
4. Copy the client ID and secret into `.env`:

   ```ini
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```
5. Back on the consent screen, press **Publish app**. While it says *Testing*, only people you list by hand can sign in. The app asks only for `openid email profile`, which needs no Google review.

## 3. Start it

```bash
docker compose up -d --build
docker compose ps
```

Within a minute Caddy has a certificate and `https://<your-domain>` shows the site. `docker compose logs -f app caddy` shows what's happening. Sign in with the Google account listed in `ADMIN_EMAILS` and an **Admin** link appears in the header.

Already signed in once but not an admin? Run:

```bash
docker compose exec app python run.py admin you@gmail.com
```

## 4. Telegram alerts (optional)

You get a message for every new sign-up, every first finished interview, new feedback and payments to check, plus a daily summary at 9 pm in your `TZ`.

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot` and copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot.
3. Run `docker compose exec app python run.py tg-test`. It prints your chat id; put it in `TELEGRAM_ADMIN_CHAT_ID`.
4. `docker compose up -d --force-recreate app`, then run `tg-test` again. A test message should arrive.

## 5. Take payments (optional)

Open **Admin → Site settings → Payments** and paste your USDT address on TRON (TRC20). Set the price and the number of days. Payments on TRC20 are confirmed automatically from the blockchain; a BEP20 address is optional and those payments wait in **Admin → Payments** for you to approve by hand.

Send yourself a small test payment before announcing anything. The price is whatever you set (the form's smallest step is `0.1` USDT).

## Configuration reference

Everything is an environment variable, set in `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `APP_NAME` | `Mohora` | Name shown in the header, emails to you and the page title. |
| `BASE_URL` | `http://127.0.0.1:8000` | Public address. Must match what visitors type. `https://` turns on secure cookies. |
| `DOMAIN` | `localhost` | Docker only. The domain Caddy gets a certificate for. |
| `SECRET_KEY` | `change-me` | Signs cookies. Required on https. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Google sign-in. Empty on localhost gives an email-only dev login. |
| `ADMIN_EMAILS` | empty | Comma-separated emails that can open `/admin`. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID` | empty | Owner alerts. |
| `TZ` | `Asia/Dhaka` | Time zone for alerts, the daily summary and "today" on dashboards. |
| `PORT`, `WORKERS` | `8000`, `2` | Port and number of server processes. |
| `DB_PATH`, `BACKUP_DIR` | `data/app.db`, `backups` | Docker fixes these to the data volume. |
| `HOUSE_*` | empty | The built-in GPU AI. See [docs/gpu.md](gpu.md). |

Things you change while the site runs, with no restart, live in **Admin → Site settings**: the announcement banner, contact email, sign-ups on or off, maintenance mode, payment settings and the AI prompts. Interview types are edited as JSON in **Admin → Interview types**.

## Updating

```bash
cd mohora
git pull
docker compose up -d --build
```

The database upgrades itself on start. Two things to know about edits you made in the admin panel:

- **Interview types** you've edited keep your text. New fields that a release adds are filled in; brand-new types appear automatically.
- **Prompts** you've edited are never overwritten, so an improved prompt in a release won't reach you automatically. Compare the `prompts` section of `app/packs.json` with **Admin → Site settings** after updating.

## Backups

The `backup` service copies the database into the data volume every day and keeps the last 14. Copy them off the server now and then:

```bash
docker compose cp backup:/data/backups ./backups
```

To restore one:

```bash
docker compose stop app backup
docker compose run --rm --no-deps app sh -c \
  "rm -f /data/app.db-wal /data/app.db-shm && cp /data/backups/app-YYYYMMDD-HHMMSS.db /data/app.db"
docker compose start app backup
```

## Behind your own proxy or tunnel

Already running nginx, Traefik or a Cloudflare Tunnel? Start only the app and point your proxy at `127.0.0.1:8000`:

```bash
docker compose up -d --build app backup
```

Pass the visitor's address through (`X-Forwarded-For` and `X-Forwarded-Proto`); the container already trusts them. Keep port 8000 closed to the internet.

## Without Docker

Python 3.12 or newer.

```bash
git clone https://github.com/shizan52/mohora.git && cd mohora
python3 run.py setup        # creates .venv, installs packages, writes .env, creates the database
python3 run.py deploy       # prints a systemd unit and a Caddy config for your BASE_URL
```

Follow the four steps `deploy` prints. In short: save the unit as `/etc/systemd/system/mohora.service` and enable it, add the Caddy block, add the redirect URI in Google, and add the printed `cron` line for daily backups. `python3 run.py check` runs the lint and tests.

## How big can it get?

- One server process handles a lot, because the AI calls go from the visitor's browser (or your GPU box), not through the site.
- The database is SQLite in WAL mode: fine for thousands of people, and a single file to back up. If you ever outgrow it, that is the part to replace.
- Rate limits are counted per worker process, so with `WORKERS=2` the effective limit is a little higher than the number in the code. They exist to stop abuse, not to count precisely.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Caddy never gets a certificate | DNS doesn't point at this server yet, or ports 80/443 are blocked by a firewall or cloud security group. `docker compose logs caddy` says which. |
| Google says `redirect_uri_mismatch` | The URI in the Google console must be exactly `https://<your-domain>/auth/callback`, and `BASE_URL` must match your domain. |
| Signing in loops back to the sign-in page | `BASE_URL` says `http://` but you are using `https://` (or the reverse), so the cookie isn't sent. |
| `RuntimeError: Set SECRET_KEY` | You set an https `BASE_URL` but left `SECRET_KEY=change-me`. |
| The microphone is blocked | Browsers allow microphones and cameras on `https://` and `localhost` only. |
| Visitors without an account quickly see "Too many requests" | The proxy isn't passing `X-Forwarded-For`, so every visitor looks like one address. |
| Sign-up alerts don't arrive | Run `docker compose exec app python run.py tg-test`; it prints what Telegram answered. |
