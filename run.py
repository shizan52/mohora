"""One entry point for everything.

    python run.py              start the development server (sets things up the first time)
    python run.py setup        create .venv, install packages, write .env, create the database
    python run.py dev          development server with auto-reload, opens the browser
    python run.py prod         production server
    python run.py check        lint, tests and a configuration check
    python run.py tg-test      send a Telegram test message and show chat ids
    python run.py admin EMAIL  make an existing user an admin
    python run.py backup       copy the database into backups/
    python run.py health       exit 0 if a running server answers (used by Docker)
    python run.py deploy       print a systemd unit and Caddy config for BASE_URL

Uses only the standard library, so it works before anything is installed.
"""

import json
import os
import secrets
import sqlite3
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import venv
import webbrowser
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
VENV_PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
ENV_FILE = ROOT / ".env"
KEEP_BACKUPS = 14
# Settings that may come from the environment (containers) as well as from .env.
KNOWN_KEYS = (
    "APP_NAME", "BASE_URL", "SECRET_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ADMIN_EMAILS",
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_ADMIN_CHAT_ID", "TELEGRAM_WEBHOOK_SECRET", "DB_PATH", "BACKUP_DIR",
    "TZ", "PORT", "WORKERS",
)


def say(message: str) -> None:
    print(f"  {message}", flush=True)


def read_env() -> dict[str, str]:
    values = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip("'\"")
    return {**values, **{k: os.environ[k] for k in KNOWN_KEYS if k in os.environ}}


def in_venv() -> bool:
    return Path(sys.prefix).resolve() == VENV.resolve()


def in_venv_or_rerun() -> None:
    """Run the rest of this command with the project's own Python."""
    if in_venv():
        return
    if not VENV_PY.exists() or not ENV_FILE.exists():
        setup()
    sys.exit(subprocess.call([str(VENV_PY), str(ROOT / "run.py"), *sys.argv[1:]], cwd=ROOT))


def ask(question: str, default: str = "") -> str:
    if not sys.stdin.isatty():
        return default
    hint = f" [{default}]" if default else ""
    try:
        answer = input(f"  {question}{hint}: ").strip()
    except EOFError:
        # Run from a script or CI with no one to answer: take the defaults.
        return default
    return answer or default


def setup() -> None:
    print("\nSetting up")
    if sys.version_info < (3, 12):  # noqa: UP036 - run.py starts on whatever Python the user has
        sys.exit("  Python 3.12 or newer is needed. You have " + sys.version.split()[0])
    if not VENV_PY.exists():
        say("Creating .venv")
        venv.create(VENV, with_pip=True)
    say("Installing packages (the first time takes a minute)")
    subprocess.check_call([str(VENV_PY), "-m", "pip", "install", "-q", "--disable-pip-version-check",
                           "-r", str(ROOT / "requirements-dev.txt")], cwd=ROOT)

    if not ENV_FILE.exists():
        say("Writing .env. Press Enter to skip anything you don't have yet.")
        template = (ROOT / ".env.example").read_text(encoding="utf-8")
        answers = {
            "SECRET_KEY": secrets.token_urlsafe(32),
            "BASE_URL": ask("Site address", "http://127.0.0.1:8000"),
            "ADMIN_EMAILS": ask("Your email, for the admin panel"),
            "GOOGLE_CLIENT_ID": ask("Google OAuth client ID"),
            "GOOGLE_CLIENT_SECRET": ask("Google OAuth client secret"),
            "TELEGRAM_BOT_TOKEN": ask("Telegram bot token"),
            "TELEGRAM_ADMIN_CHAT_ID": ask("Telegram chat id (run `python run.py tg-test` to find it)"),
            "TELEGRAM_WEBHOOK_SECRET": secrets.token_urlsafe(16),
        }
        lines = []
        for line in template.splitlines():
            key = line.split("=", 1)[0]
            lines.append(f"{key}={answers[key]}" if key in answers and "=" in line else line)
        ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
        say("Saved .env")

    say("Preparing the database")
    subprocess.check_call([str(VENV_PY), "-c", "from app.db import init_db; init_db()"], cwd=ROOT)
    say("Done.\n")


def dev() -> None:
    in_venv_or_rerun()
    env = read_env()
    port = env.get("PORT", "8000")
    url = f"http://127.0.0.1:{port}"
    print(f"\n  {env.get('APP_NAME', 'Mohora')} is running at {url}  (Ctrl+C to stop)\n")
    if not env.get("GOOGLE_CLIENT_ID"):
        say("Google sign-in isn't configured, so /login uses a local email sign-in.")
    threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=int(port), reload=True,
                reload_dirs=[str(ROOT / "app"), str(ROOT / "templates")], log_level="info")


def prod() -> None:
    in_venv_or_rerun()
    env = read_env()
    if env.get("SECRET_KEY", "change-me") in ("", "change-me", "dev-only-secret"):
        sys.exit("  Set a real SECRET_KEY in .env before running in production.")
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=int(env.get("PORT", "8000")),
                workers=int(env.get("WORKERS", "2")), proxy_headers=True, forwarded_allow_ips="127.0.0.1")


def check() -> None:
    in_venv_or_rerun()
    print("\nChecking")
    failed = False
    for name, cmd in (("Lint", ["-m", "ruff", "check", "."]), ("Tests", ["-m", "pytest", "-q"])):
        say(f"{name}...")
        failed |= subprocess.call([sys.executable, *cmd], cwd=ROOT) != 0
    env = read_env()
    say("Configuration:")
    for label, ok in (
        ("SECRET_KEY set", env.get("SECRET_KEY") not in (None, "", "change-me")),
        ("Google sign-in", bool(env.get("GOOGLE_CLIENT_ID") and env.get("GOOGLE_CLIENT_SECRET"))),
        ("Telegram alerts", bool(env.get("TELEGRAM_BOT_TOKEN") and env.get("TELEGRAM_ADMIN_CHAT_ID"))),
        ("Admin email", bool(env.get("ADMIN_EMAILS"))),
    ):
        say(f"  {'yes' if ok else 'no '}  {label}")
    print()
    sys.exit(1 if failed else 0)


def telegram(method: str, token: str, **payload) -> dict:
    data = json.dumps(payload).encode() if payload else None
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read() or b"{}")


def tg_test() -> None:
    env = read_env()
    token = env.get("TELEGRAM_BOT_TOKEN")
    if not token:
        sys.exit("  Add TELEGRAM_BOT_TOKEN to .env first. Create a bot by messaging @BotFather on Telegram.")
    me = telegram("getMe", token)
    if not me.get("ok"):
        sys.exit(f"  Telegram rejected the token: {me.get('description')}")
    say(f"Bot: @{me['result']['username']}")
    chats = {}
    for update in telegram("getUpdates", token).get("result", []):
        chat = (update.get("message") or update.get("channel_post") or {}).get("chat")
        if chat:
            chats[chat["id"]] = chat.get("title") or chat.get("first_name") or ""
    if chats:
        say("Chats that messaged the bot recently:")
        for chat_id, name in chats.items():
            say(f"  {chat_id}  {name}")
    else:
        say(f"No messages yet. Send any message to @{me['result']['username']}, then run this again.")
    chat_id = env.get("TELEGRAM_ADMIN_CHAT_ID")
    if chat_id:
        sent = telegram("sendMessage", token, chat_id=chat_id, text="Test message: Telegram alerts are working.")
        say("Test message sent." if sent.get("ok") else f"Couldn't send to {chat_id}: {sent.get('description')}")
    else:
        say("Put one of the ids above into TELEGRAM_ADMIN_CHAT_ID in .env.")


def make_admin(email: str) -> None:
    db = database_path()
    with sqlite3.connect(db) as conn:
        changed = conn.execute("UPDATE users SET is_admin = 1 WHERE lower(email) = lower(?)", (email,)).rowcount
    say(f"{email} is now an admin." if changed else f"No user with {email}. Sign in once first, then run this again.")


def database_path() -> Path:
    path = Path(read_env().get("DB_PATH", "data/app.db"))
    path = path if path.is_absolute() else ROOT / path
    if not path.exists():
        sys.exit(f"  No database at {path}. Run `python run.py setup` first.")
    return path


def backup() -> None:
    source = database_path()
    folder = Path(read_env().get("BACKUP_DIR", "backups"))
    folder = folder if folder.is_absolute() else ROOT / folder
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"app-{datetime.now():%Y%m%d-%H%M%S}.db"
    src, dst = sqlite3.connect(source), sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        src.close()
        dst.close()
    for old in sorted(folder.glob("app-*.db"))[:-KEEP_BACKUPS]:
        old.unlink()
    say(f"Saved {target}")


def health() -> None:
    port = read_env().get("PORT", "8000")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=4) as resp:
            sys.exit(0 if resp.status == 200 else 1)
    except OSError:
        sys.exit(1)


def deploy() -> None:
    env = read_env()
    url = urllib.parse.urlparse(env.get("BASE_URL", ""))
    if url.scheme != "https" or not url.hostname:
        sys.exit("  Set BASE_URL in .env to your https:// address first, for example https://mohora.example.com")
    port = env.get("PORT", "8000")
    user = os.environ.get("USER", "www-data")
    print(f"""
# 1. Save as /etc/systemd/system/mohora.service, then:
#    sudo systemctl daemon-reload && sudo systemctl enable --now mohora
[Unit]
Description={env.get('APP_NAME', 'Mohora')}
After=network.target

[Service]
User={user}
WorkingDirectory={ROOT}
ExecStart={VENV_PY} {ROOT / 'run.py'} prod
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target

# 2. Add to /etc/caddy/Caddyfile, then: sudo systemctl reload caddy
#    Caddy gets and renews the HTTPS certificate on its own.
{url.hostname} {{
    encode zstd gzip
    reverse_proxy 127.0.0.1:{port}
}}

# 3. In Google Cloud Console, add this redirect URI to the OAuth client:
#    {url.scheme}://{url.hostname}/auth/callback

# 4. Daily backup, via `crontab -e`:
#    15 3 * * * cd {ROOT} && {VENV_PY} run.py backup
""")


COMMANDS = {"setup": setup, "dev": dev, "prod": prod, "check": check, "tg-test": tg_test,
            "backup": backup, "health": health, "deploy": deploy}


def main() -> None:
    args = sys.argv[1:]
    command = args[0] if args else "dev"
    if command == "admin":
        if len(args) < 2:
            sys.exit("  Usage: python run.py admin you@example.com")
        return make_admin(args[1])
    if command not in COMMANDS:
        sys.exit(__doc__)
    COMMANDS[command]()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
