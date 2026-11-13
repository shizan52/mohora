# Running on a GPU server

By default Mohora costs you almost nothing to run, because every visitor brings their own AI key and the browser talks to the provider directly. A GPU lets you offer something better: a **built-in AI** that works with no key at all, a **natural voice** for the interviewer and **accurate speech recognition** in any browser, including Bangla.

Everything here is optional and additive. Without it the site works exactly as before.

## What you get

| Piece | What it does for visitors | Runs as |
|---|---|---|
| Built-in AI | "Built-in AI" appears in the connection list and is picked automatically when someone has no key. It plays the interviewer and writes the feedback. | [Ollama](https://ollama.com) (any OpenAI-compatible server works) |
| Natural voice | The interviewer sounds like a person, in every browser. English. | [Kokoro](https://github.com/remsky/Kokoro-FastAPI) |
| Speech recognition | Answers are transcribed by Whisper large-v3, which handles Bangla far better than the browser's built-in recognition and also works in Firefox and Safari. | [Speaches](https://github.com/speaches-ai/speaches) (faster-whisper) |

Visitors who connect their own AI still do, and their usage is unlimited and free to you. The built-in AI has a daily allowance per person (see [Capacity](#capacity)) so nobody can take the whole GPU.

## What you need

- An **NVIDIA GPU** with a current driver. `nvidia-smi` should list the card.
- Docker Engine and the **NVIDIA Container Toolkit** so containers can use the GPU.
- The site already running from [docs/deploy.md](deploy.md).

Install the toolkit on Ubuntu or Debian (see [NVIDIA's guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) for other systems):

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker run --rm --gpus all ubuntu nvidia-smi      # should print your GPU
```

## Pick a model for your card

The model decides how good the interviewer and the feedback are. These are rough guides; quantised models in Ollama need less memory than the full ones.

| GPU memory | A good starting model | Notes |
|---|---|---|
| 8 to 12 GB | `qwen2.5:7b` or `llama3.1:8b` | Fine for English. Bangla is weaker. |
| 16 to 24 GB | `qwen2.5:14b` (the default here) | A good balance. |
| 24 to 48 GB | `qwen2.5:32b` | Noticeably better feedback. |
| 48 GB and up | a 70B-class model | Pick one that supports JSON output well. |

Add a few GB for the voice (Kokoro is small) and Whisper large-v3 (a few GB). You can use a stronger `HOUSE_COACH_MODEL` than the interviewer model, since feedback quality matters most.

Test your chosen model in Bangla yourself before promising it to Bangla speakers: quality varies a lot between models.

## Turn it on

1. Add these lines to `.env` (they are in `.env.example`, commented out):

   ```ini
   HOUSE_AI_URL=http://llm:11434/v1
   HOUSE_AI_MODEL=qwen2.5:14b
   HOUSE_COACH_MODEL=qwen2.5:14b
   HOUSE_TTS_URL=http://voice:8880/v1
   HOUSE_STT_URL=http://ears:8000/v1
   ```

   Leave out the voice or the speech line if you don't want that piece.

2. Start the GPU services next to the site:

   ```bash
   docker compose --profile gpu up -d --build
   docker compose logs -f llm-pull      # downloads the models, then exits
   ```

   The first start downloads several GB: the language model, the voice and Whisper. Later starts are quick because they live in Docker volumes.

3. Check each piece answers:

   ```bash
   docker compose exec app python -c "
   import httpx
   print(httpx.post('http://llm:11434/v1/chat/completions', json={'model':'qwen2.5:14b','messages':[{'role':'user','content':'Say hi'}]}, timeout=120).json()['choices'][0]['message']['content'])"
   docker compose ps          # llm, voice and ears should be running
   ```

4. Open the site in a private window. In **New interview** the AI box should say *Your interviewer runs on the built-in AI* even though no key was entered. Run a short interview to hear the voice.

## Capacity

An interview of five questions is roughly 12 AI calls and about 22,000 tokens. The knobs:

| Setting | Where | Effect |
|---|---|---|
| `HOUSE_DAILY_LIMIT` | `.env` | AI calls per signed-in person per day (default 150, about 12 interviews). Pro members get ten times as many. People without an account get a third. |
| `OLLAMA_NUM_PARALLEL` | `.env` | How many requests the model serves at once (default 4). More needs more GPU memory. |
| `HOUSE_COACH_MODEL` | `.env` | A separate, usually stronger, model for feedback. |

Watch `nvidia-smi` and the response times after your first busy day, then adjust. If the GPU is busy, people see a clear message and can still connect their own AI.

## Using a GPU machine separate from the site

The site doesn't need to be on the GPU box. Run Ollama (or vLLM, or any OpenAI-compatible server), Kokoro-FastAPI and Speaches on the GPU machine, then point the site at it:

```ini
HOUSE_AI_URL=https://gpu.example.com/v1
HOUSE_AI_KEY=<a key your proxy checks>
```

Put the GPU machine behind a reverse proxy that requires that key, or reach it over a private network such as WireGuard or Tailscale. **Never expose an unauthenticated model server to the internet.** In the bundled compose file the GPU services publish no ports at all; only the site can reach them.

For [vLLM](https://docs.vllm.ai/) run `vllm serve <model> --port 8001` and set `HOUSE_AI_URL=http://<host>:8001/v1` and `HOUSE_AI_MODEL` to the same model name.

## Languages

- **Voice** (`HOUSE_TTS_LANGS`): Kokoro speaks English. For Bangla interviews the browser's own voice is used, so Edge with its neural voices sounds best. If you add a Bangla-capable voice server later, list `en,bn` here and the site will use it for both.
- **Speech recognition**: Whisper large-v3 supports Bangla and English. In **Settings → Voice**, visitors can choose live captions from the browser or the server's more accurate transcription. By default English uses live captions and Bangla uses the server.

## What is verified and what isn't

The site side (relay, daily allowance, the browser using the server's voice and transcription, falling back when they fail) is covered by automated tests and was exercised end to end against stand-in servers. The compose file's GPU services follow each project's documented container image and settings, but were written without a GPU at hand, so on first run you may need to adjust:

- image tags (this file uses `latest`; pin the versions you tested),
- Speaches' model preloading setting (`PRELOAD_MODELS`), which has changed between releases; if the first transcription fails, download the model with Speaches' model endpoint and check its README,
- the Kokoro voice names, if your build lists different ones (`HOUSE_TTS_VOICE_FEMALE`, `HOUSE_TTS_VOICE_MALE`).

If you hit something, an issue with `docker compose logs <service>` helps the next person.
