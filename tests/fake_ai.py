"""A fake OpenAI-compatible server, so a whole interview can run offline and for free.

    python tests/fake_ai.py            # listens on http://127.0.0.1:8799/v1

Then in the site connect "Other server" with that address and any key, or set
HOUSE_AI_URL, HOUSE_TTS_URL and HOUSE_STT_URL to it to try the built-in AI.
The replies are canned, but they follow the same JSON the real prompts ask for, so every
screen can be exercised: question planning, follow-ups, feedback, the report, voice and
transcription. It is for development and demos, never for production.
"""

import io
import json
import math
import re
import struct
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def tone(seconds: float = 0.6, hz: int = 330, rate: int = 24000) -> bytes:
    """A short beep standing in for speech."""
    frames = b"".join(struct.pack("<h", int(6000 * math.sin(2 * math.pi * hz * i / rate))) for i in range(int(seconds * rate)))
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(frames)
    return out.getvalue()


BEEP = tone()
CV_PROFILE = {
    "name": "Rahim Uddin", "headline": "Frontend developer, two years", "level": "junior",
    "skills": ["React", "TypeScript", "REST APIs", "Figma", "Git"],
    "highlights": ["Rebuilt the checkout page in React", "Cut page load by 40%"],
}


def say(text: str, intent: str) -> str:
    return json.dumps({"say": text, "intent": intent})


def interviewer(last: str) -> str:
    """The interviewer's next line, following the director's note in the last message."""
    wanted_next = re.search(r'ask the next question in your own words: "([^"]+)"', last)
    first = re.search(r'first question in your own words: "([^"]+)"', last)
    if first:
        return say(f"Hi, I'm your interviewer. Thanks for joining. {first.group(1)}", "next")
    if "replied to your last question" in last:
        return say("Good question. The team is small and ships weekly. Thanks for your time today.", "wrap_up")
    answer = last.split("---")[0]
    vague = not re.search(r"\d", answer)
    if "ask ONE short follow-up" in last and vague:
        return say("What exactly did you change, and how do you know it worked?", "follow_up")
    if wanted_next:
        return say(f"Thanks. {wanted_next.group(1)}", "next")
    return say("Thanks. That's all my questions. Do you have any questions for me?", "wrap_up")


def reply_for(messages: list[dict]) -> str:
    """Pick a canned reply by recognising which prompt this is."""
    last = messages[-1]["content"]
    if "single word OK" in last:
        return "OK"
    if "career coach reading a candidate's CV" in last:
        return json.dumps({
            "profile": CV_PROFILE,
            "roles": [{"title": "Frontend Developer", "level": "junior", "why": "Two years of React"},
                      {"title": "Frontend Developer Intern", "level": "intern", "why": "A safe first step"}],
            "topics": [{"label": "Checkout rebuild", "kind": "project", "detail": "React and TypeScript"},
                       {"label": "40% faster page load", "kind": "achievement", "detail": "How it was measured"},
                       {"label": "No testing mentioned", "kind": "gap", "detail": "A likely probe"}]})
    if "You are a recruiter screening an application" in last:
        return json.dumps({"score": 64, "verdict": "Good React work, but the CV never mentions testing.",
                           "strengths": ["React", "TypeScript"], "gaps": ["Automated testing"],
                           "keywords": ["Jest", "CI"], "fixes": ["Add a line about testing"]})
    if "You are preparing a mock interview" in last:
        return json.dumps({"questions": [
            {"q": "Walk me through your background and what you've worked on recently.", "competency": "intro", "source": "role", "why": "Warm-up"},
            {"q": "You rebuilt the checkout page in React. What made the old one hard to change?", "competency": "depth", "source": "cv", "why": "Tests a CV claim"},
            {"q": "Your CV says page load dropped by 40%. How did you measure that?", "competency": "evidence", "source": "cv", "why": "Checks the evidence"}]})
    if "bank of interview stories" in last:
        return json.dumps({"title": "Payment timeout fix", "situation": "Our payment page failed for some users.",
                           "task": "I owned the checkout page.", "action": "I traced it to a timeout and fixed it that night.",
                           "result": "Failures dropped to [number].", "tags": ["ownership", "failure"]})
    if "Evaluate one answer" in last:
        # The prompt lists the rubric as "id": 1-5, so score whatever this interview type asks for.
        return "Here is the feedback:\n```json\n" + json.dumps({
            "scores": {rubric_id: 3 for rubric_id in re.findall(r'"(\w+)": 1-5', last)},
            "worked": ["You said clearly what you did yourself."],
            "improve": ["Give a number for the result.", "Say what happened afterwards."],
            "fix_next": "End with the measurable result.",
            "quotes": [{"text": "I fixed the timeout", "type": "strong", "note": "Clear ownership"},
                       {"text": "kind of worked", "type": "weak", "note": "Vague result"}],
            "rewrite": "I traced the failures to a timeout we had set too low, fixed it that night, and cut them from [number] to almost zero.",
            "parts": {"Situation": True, "Task": False, "Action": True, "Result": False}}) + "\n```"
    if "top of a mock-interview report" in last:
        return json.dumps({"headline": "Clear about your own role, but your results need numbers.",
                           "best_moment": {"quote": "I fixed the timeout", "why": "Direct and specific"},
                           "fix_next": "Close every story with a measurable result.",
                           "strengths": ["Ownership"], "focus": ["Numbers"]})
    if "is stuck on this interview question" in last:
        return json.dumps({"hint": "Start with the situation in one sentence, then say what you did."})
    return interviewer(last)


class Handler(BaseHTTPRequestHandler):
    def send_body(self, body: bytes, kind: str = "application/json") -> None:
        self.send_response(200)
        self.send_header("Content-Type", kind)
        # Browsers call this server directly, so it has to allow it.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        for name, value in (("Origin", "*"), ("Headers", "*"), ("Methods", "GET, POST, OPTIONS")):
            self.send_header(f"Access-Control-Allow-{name}", value)
        self.end_headers()

    def do_GET(self) -> None:
        models = [{"id": "fake-fast"}, {"id": "fake-strong"}, {"id": "text-embedding-fake"}]
        self.send_body(json.dumps({"data": models}).encode())

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path.endswith("/audio/speech"):
            return self.send_body(BEEP, "audio/wav")
        if self.path.endswith("/audio/transcriptions"):
            return self.send_body(json.dumps({"text": "I fixed the timeout myself and added an alert."}).encode())
        messages = json.loads(body)["messages"]
        reply = {"choices": [{"message": {"role": "assistant", "content": reply_for(messages)}}]}
        self.send_body(json.dumps(reply).encode())

    def log_message(self, format: str, *args) -> None:  # silence the per-request log lines
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    print(f"Fake AI on http://127.0.0.1:{port}/v1  (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
