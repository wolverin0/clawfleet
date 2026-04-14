# Feature: Voice prompts (Whisper transcription)

Send a Telegram voice message in a project topic → theorchestra transcribes it via OpenAI Whisper (or a compatible endpoint) → the transcript is dispatched to that project's pane as if you typed it.

## Why agent-centric

The handler is pure: download audio → transcribe → return text. Nothing in theorchestra auto-dispatches. OmniClaude receives the transcript and decides: is this a prompt? An `/approve` command? A question for it (not for the pane)? That decision stays with the coordinator.

## Setup

```bash
# required — OpenAI Whisper key, or any bearer token for a compatible endpoint
export WHISPER_API_KEY=sk-…

# optional
export WHISPER_ENDPOINT=https://api.openai.com/v1/audio/transcriptions   # default
export WHISPER_MODEL=whisper-1                                            # default
export WHISPER_LANGUAGE=es                                                # ISO-639-1; default auto-detect
```

`voice-handler.isEnabled()` returns `false` when `WHISPER_API_KEY` is unset — callers can always-call without guarding.

## Module API

```js
const voice = require('./src/voice-handler.cjs');

// 1. Download the audio from Telegram
const localPath = await voice.downloadTelegramVoice(fileId, botToken);

// 2. Transcribe
const text = await voice.transcribe(localPath, {
  language: 'es',           // optional override
  model: 'whisper-1',       // optional override
  endpoint: 'https://…',    // optional override (e.g. self-hosted Whisper)
});
// → "por favor arreglá el test de auth"
```

Zero new runtime deps: pure Node `https` + manual `multipart/form-data` builder.

## CLI

```bash
node src/voice-handler.cjs /tmp/voice.ogg
# → prints transcript to stdout, or exits 2 on error.
```

Useful for ad-hoc transcription outside the orchestrator flow.

## OmniClaude integration

Add a handler in `omniclaude/CLAUDE.md` under Telegram Interaction for inbound voice messages. The channel plugin forwards `msg.voice` and `msg.audio` objects with `file_id`:

```
| inbound msg has `voice` or `audio` |
|  1. Skip if project topic ≠ a project pane (voice in DM = voice for OmniClaude) |
|  2. voice.downloadTelegramVoice(msg.voice.file_id, TELEGRAM_BOT_TOKEN) → path |
|  3. voice.transcribe(path, { language: 'es' })  → text |
|  4. Reply in topic with `🎙️ <text>` so user sees what was understood |
|  5. send_prompt(paneId, text) + send_key(paneId, 'enter') |
```

For voice-in-DM (user talking to OmniClaude directly), transcribe and treat the text as a DM command just like any text DM.

## Self-hosted Whisper

Set `WHISPER_ENDPOINT` to any OpenAI-compatible transcription endpoint. Examples:

- **Groq** (fast free tier): `https://api.groq.com/openai/v1/audio/transcriptions`
- **faster-whisper-server** (local): `http://localhost:8000/v1/audio/transcriptions`
- **OpenAI** (default): `https://api.openai.com/v1/audio/transcriptions`

The module does NOT validate the endpoint is OpenAI-compatible — if the endpoint returns a different shape, `transcribe` rejects with a parse error.

## Rate limiting & cost

Whisper is charged per minute of audio. For a typical voice command (5-15s) the cost per message is negligible (< USD 0.01). If abuse is a concern in a shared group, add a per-chat rate limit in OmniClaude's handler (e.g. 10 voice messages/hour).

## Cache / privacy

Downloaded audio files live in `os.tmpdir()/theorchestra-voice/`. They are NOT auto-cleaned — clean them with a cron / scheduled task if voice volume is high:

```bash
find $TMPDIR/theorchestra-voice -type f -mtime +1 -delete
```

The transcript never persists unless OmniClaude chooses to write it somewhere (MemoryMaster claim, Telegram echo, log). Audio upload goes to the Whisper endpoint — be aware of the endpoint's retention policy.

## Failure modes

| Error | Likely cause | Fix |
|---|---|---|
| `WHISPER_API_KEY not set` | env var missing | `export WHISPER_API_KEY=…` |
| `Telegram getFile failed: Bad Request` | wrong `fileId` or bot token | verify the update payload shape |
| `Whisper parse error (401)` | expired or invalid key | rotate the key |
| `Whisper parse error (413)` | file > 25 MB (OpenAI limit) | reject upstream or compress/transcode first |
| `transcribe request timeout (60s)` | endpoint unreachable or slow | check endpoint status; retry |
