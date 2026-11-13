"""The site's own AI, for servers with a GPU.

When HOUSE_AI_URL points at an OpenAI-compatible server (Ollama, vLLM, llama.cpp), people can
practise with no key at all. Optional speech servers give a natural voice (HOUSE_TTS_URL, for
example Kokoro) and accurate transcription in any browser (HOUSE_STT_URL, for example Whisper).
Requests are relayed and never stored. A daily allowance per person keeps one user from
taking the whole GPU.
"""

import logging
from datetime import date
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .auth import current_user
from .config import config
from .db import User, cached_flags
from .web import check_csrf

router = APIRouter(prefix="/api/house", dependencies=[Depends(check_csrf)])
log = logging.getLogger("mohora.house")

GUEST_SHARE = 3  # visitors without an account get a third of the daily allowance
PRO_TIMES = 10
MAX_PROMPT_CHARS = 60_000
MAX_AUDIO_BYTES = 1_900_000

# Per process, so with several workers the real allowance is a little higher. Good enough
# to stop one person from draining the GPU; not an accounting system.
_used: dict[str, tuple[date, int]] = {}


def caller(request: Request, user: User | None) -> tuple[str, int]:
    if user is None:
        if not cached_flags().get("guest_mode"):
            raise HTTPException(401, "Sign in to use the built-in AI.")
        host = request.client.host if request.client else "unknown"
        return f"ip:{host}", config.house_daily_limit // GUEST_SHARE
    return f"user:{user.id}", config.house_daily_limit * (PRO_TIMES if user.has_pass else 1)


def spend(key: str, allowance: int, cost: int = 1) -> None:
    today = date.today()
    day, used = _used.get(key, (today, 0))
    if day != today:
        used = 0
    if used + cost > allowance:
        raise HTTPException(429, "You've used today's allowance of the built-in AI. It resets tomorrow. "
                                 "Pro raises it, and your own AI key has no limit.")
    _used[key] = (today, used + cost)


async def upstream(url: str, **kwargs: Any) -> httpx.Response:
    headers = {"Authorization": f"Bearer {config.house_ai_key}"} if config.house_ai_key else {}
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            return await client.post(url, headers=headers, **kwargs)
    except httpx.HTTPError as exc:
        log.warning("House AI request failed (%s)", type(exc).__name__)
        raise HTTPException(502, "The built-in AI isn't answering right now. Try again in a moment.") from None


class ChatIn(BaseModel):
    messages: list[dict[str, Any]] = Field(min_length=1, max_length=60)
    purpose: Literal["interviewer", "coach"] = "interviewer"
    json_mode: bool = False
    max_tokens: int = Field(700, ge=1, le=2000)
    temperature: float = Field(0.7, ge=0, le=1.5)


@router.post("/chat")
async def chat(body: ChatIn, request: Request, user: User | None = Depends(current_user)):
    if not config.house_enabled:
        raise HTTPException(404)
    messages = [{"role": str(m.get("role", "user")), "content": str(m.get("content", ""))} for m in body.messages]
    if sum(len(m["content"]) for m in messages) > MAX_PROMPT_CHARS:
        raise HTTPException(413, "That request is too long for the built-in AI.")
    spend(*caller(request, user))
    payload: dict[str, Any] = {
        "model": config.house_coach_model if body.purpose == "coach" else config.house_ai_model,
        "messages": messages, "max_tokens": body.max_tokens, "temperature": body.temperature,
    }
    if body.json_mode:
        payload["response_format"] = {"type": "json_object"}
    resp = await upstream(f"{config.house_ai_url}/chat/completions", json=payload)
    try:
        return JSONResponse(resp.json(), status_code=resp.status_code)
    except ValueError:
        raise HTTPException(502, "The built-in AI sent back something unreadable.") from None


class SpeechIn(BaseModel):
    text: str = Field(min_length=1, max_length=600)
    gender: Literal["female", "male"] = "female"


@router.post("/speech")
async def speech(body: SpeechIn, request: Request, user: User | None = Depends(current_user)):
    if not config.house_tts_url:
        raise HTTPException(404)
    key, allowance = caller(request, user)
    # A reply is spoken sentence by sentence, so speech gets a larger allowance than chat.
    spend(f"speech:{key}", allowance * 8)
    voice = config.house_tts_voice_male if body.gender == "male" else config.house_tts_voice_female
    payload = {"model": config.house_tts_model, "input": body.text, "voice": voice, "response_format": "mp3"}
    resp = await upstream(f"{config.house_tts_url}/audio/speech", json=payload)
    if resp.status_code != 200:
        raise HTTPException(502, "The voice server couldn't speak that.")
    return Response(resp.content, media_type=resp.headers.get("content-type", "audio/mpeg"))


@router.post("/transcribe")
async def transcribe(
    request: Request,
    audio: UploadFile = File(...),
    lang: str = Form("en"),
    user: User | None = Depends(current_user),
):
    if not config.house_stt_url:
        raise HTTPException(404)
    key, allowance = caller(request, user)
    spend(f"listen:{key}", allowance)
    data = await audio.read()
    if not data or len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "That recording is empty or too long. Keep answers under about five minutes.")
    form = {"model": config.house_stt_model, "language": "en" if lang == "en" else "bn", "response_format": "json"}
    files = {"file": (audio.filename or "answer.webm", data, audio.content_type or "audio/webm")}
    resp = await upstream(f"{config.house_stt_url}/audio/transcriptions", data=form, files=files)
    try:
        text = str(resp.json().get("text", "")).strip()
    except ValueError:
        text = ""
    if resp.status_code != 200:
        raise HTTPException(502, "The transcription server couldn't read that recording.")
    return {"text": text}
