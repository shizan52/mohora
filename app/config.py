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
    house_ai_url: str
    house_ai_key: str
    house_ai_model: str
    house_coach_model: str
    house_daily_limit: int
    house_tts_url: str
    house_tts_model: str
    house_tts_voice_female: str
    house_tts_voice_male: str
    house_tts_langs: tuple[str, ...]
    house_stt_url: str
    house_stt_model: str

    @property
    def house_enabled(self) -> bool:
        return bool(self.house_ai_url and self.house_ai_model)

    @property
    def house(self) -> dict:
        """What the site's own AI offers, as the browser needs to know it."""
        return {
            "chat": self.house_enabled,
            "speech": list(self.house_tts_langs) if self.house_tts_url else [],
            "transcribe": bool(self.house_stt_url),
        }

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
        house_ai_url=env("HOUSE_AI_URL", "").rstrip("/"),
        house_ai_key=env("HOUSE_AI_KEY", ""),
        house_ai_model=env("HOUSE_AI_MODEL", ""),
        house_coach_model=env("HOUSE_COACH_MODEL", "") or env("HOUSE_AI_MODEL", ""),
        house_daily_limit=int(env("HOUSE_DAILY_LIMIT", "150")),
        house_tts_url=env("HOUSE_TTS_URL", "").rstrip("/"),
        house_tts_model=env("HOUSE_TTS_MODEL", "kokoro"),
        house_tts_voice_female=env("HOUSE_TTS_VOICE_FEMALE", "af_heart"),
        house_tts_voice_male=env("HOUSE_TTS_VOICE_MALE", "am_michael"),
        house_tts_langs=tuple(x.strip() for x in env("HOUSE_TTS_LANGS", "en").split(",") if x.strip()),
        house_stt_url=env("HOUSE_STT_URL", "").rstrip("/"),
        house_stt_model=env("HOUSE_STT_MODEL", "Systran/faster-whisper-large-v3"),
    )


config = load()
