# Contributing

Thanks for taking a look. The project is deliberately small: one Python process, SQLite, plain browser modules and no build step. Changes that keep it that way are the easiest to merge.

## Run it locally

```bash
python run.py          # first run creates .venv, installs packages and writes .env
python run.py check    # lint (ruff) and tests (pytest)
```

Python 3.12 or newer. Without Google credentials the sign-in page offers an email-only login for local testing.

## Before opening a pull request

- `python run.py check` passes.
- The change works in a real browser if it touches `static/` or `templates/`. For the interview room, a fake AI that speaks the OpenAI chat format is enough to try a whole interview.
- New behaviour has a test in `tests/test_app.py`.
- Site text is English, in plain sentences. No marketing filler.

## Where things live

| Want to change | Look in |
|---|---|
| What an interview type asks and how it is scored | `app/packs.json` (also editable in the admin panel) |
| The instructions sent to the AI | `app/packs.json` → `prompts` |
| When to follow up, move on, give feedback | `static/room.js` |
| The setup wizard | `static/setup.js` |
| Payments | `app/billing.py` |
| Review drills, readiness score, plan, stories | `app/practice.py` |
| The built-in GPU AI | `app/house.py` |

## Adding an interview type

It's data, not code. Copy an entry in `packs.json`, change the interviewer, opener, question bank and rubric, and it appears in the setup wizard and the question library after a restart. `docs/deploy.md` explains how existing sites pick up new types.
