import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    # Real environment variables win over the file, so tests and systemd can override it.
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


@dataclass(frozen=True)
class Config:
    app_name: str
    base_url: str
    secret_key: str
    google_client_id: str
    google_client_secret: str
    admin_emails: frozenset[str]
    telegram_token: str
    telegram_chat_id: str
    telegram_webhook_secret: str
    db_path: Path
    tz: str

    @property
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def telegram_enabled(self) -> bool:
        return bool(self.telegram_token and self.telegram_chat_id)

    @property
    def secure_cookies(self) -> bool:
        return self.base_url.startswith("https://")

    @property
    def dev_login(self) -> bool:
        # Email-only sign-in for local development when Google isn't configured yet.
        host = urlparse(self.base_url).hostname
        return not self.google_enabled and host in {"127.0.0.1", "localhost"}


def load() -> Config:
    _load_dotenv(ROOT / ".env")
    env = os.environ.get
    db_path = Path(env("DB_PATH", "data/app.db"))
    if not db_path.is_absolute():
        db_path = ROOT / db_path
    admins = {e.strip().lower() for e in env("ADMIN_EMAILS", "").split(",") if e.strip()}
    return Config(
        app_name=env("APP_NAME", "Mohora"),
        base_url=env("BASE_URL", "http://127.0.0.1:8000").rstrip("/"),
        secret_key=env("SECRET_KEY", "dev-only-secret"),
        google_client_id=env("GOOGLE_CLIENT_ID", ""),
        google_client_secret=env("GOOGLE_CLIENT_SECRET", ""),
        admin_emails=frozenset(admins),
        telegram_token=env("TELEGRAM_BOT_TOKEN", ""),
        telegram_chat_id=env("TELEGRAM_ADMIN_CHAT_ID", ""),
        telegram_webhook_secret=env("TELEGRAM_WEBHOOK_SECRET", ""),
        db_path=db_path,
        tz=env("TZ", "Asia/Dhaka"),
    )


config = load()
