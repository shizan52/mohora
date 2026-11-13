# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first, so rebuilding after a code change is fast.
COPY requirements.txt constraints.txt ./
RUN pip install -r requirements.txt -c constraints.txt

COPY app ./app
COPY templates ./templates
COPY static ./static
COPY run.py LICENSE ./

# The app runs as an ordinary user. Everything it writes goes to /data.
RUN useradd --system --uid 10001 --home-dir /app mohora \
    && mkdir -p /data/backups \
    && chown -R mohora /data
USER mohora

ENV DB_PATH=/data/app.db \
    BACKUP_DIR=/data/backups \
    PORT=8000 \
    WORKERS=2
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "run.py", "health"]

# --proxy-headers makes the visitor's real address (and https) visible behind Caddy or nginx.
# Keep port 8000 off the public internet: only the proxy should reach it.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers ${WORKERS} --proxy-headers --forwarded-allow-ips='*'"]
