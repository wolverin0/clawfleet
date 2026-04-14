# Feature: Photo / document forwarding

Attach an image, doc, video, or voice clip to a Telegram project topic → theorchestra downloads it to a local cache dir → OmniClaude includes the local path in the prompt it sends to the pane → Claude Code's `Read` tool (or Codex equivalent) opens the file directly.

## Why this shape

Telegram Bot API serves files through temporary URLs. The pane can't reach those URLs — it only sees whatever text OmniClaude types into it. So we download once, put the file at a stable local path, and point the pane at the path. That's it — no image processing, no base64, no upload to a third service.

## Module API

```js
const media = require('./src/media-handler.cjs');

// Handling an inbound Telegram message with attachments:
const { paths, caption, kinds } = await media.downloadMessageMedia(msg, BOT_TOKEN);
// paths: ['/tmp/theorchestra-media/ABC_123.jpg', '/tmp/theorchestra-media/DEF_456.pdf']
// caption: 'look at this, the bug is in the footer'
// kinds: { photo: {...}, document: {...} }

// Build the text to send into the pane:
const preamble = media.formatPromptPreamble({ paths, caption });
// → '[attachment: /tmp/.../ABC.jpg]\n[attachment: /tmp/.../DEF.pdf]\n\nlook at this…'

// Then: send_prompt(paneId, preamble) + send_key(paneId, 'enter')
```

`downloadTelegramFile(fileId, botToken)` is the low-level single-file helper. `pickLargestPhoto(msg.photo)` picks the biggest variant from Telegram's photo size array.

Zero-dep: pure Node `https` + `fs`.

## Supported message types

| Telegram field | Handling |
|---|---|
| `msg.photo` (array) | picks the largest variant by width × height |
| `msg.document` | downloads as-is, keeps file extension |
| `msg.video` | downloads as-is |
| `msg.audio` | downloads as-is (if you want transcription, use `voice-handler.cjs` instead) |
| `msg.voice` | downloads as-is (same note — voice-handler for transcription) |
| `msg.sticker`, `msg.contact`, `msg.location`, etc. | ignored — out of scope for forwarding |

Caption (if present) is preserved and appended after the `[attachment: …]` lines.

## OmniClaude integration

Add to `omniclaude/CLAUDE.md` under Telegram Interaction:

```
| inbound msg has `photo`/`document`/`video` attachments |
|   const m = await media.downloadMessageMedia(msg, TELEGRAM_BOT_TOKEN)
|   const text = media.formatPromptPreamble({ paths: m.paths, caption: m.caption })
|   send_prompt(paneId, text) + send_key(paneId, 'enter')
|   reply in topic: `📎 forwarded ${m.paths.length} attachment(s) to <project>`
```

For images in DM (not in a project topic), use your discretion — you probably want to describe the image yourself rather than forward the path.

## Claude / Codex usage after forward

Once the preamble is in the pane's prompt:

```
[attachment: /tmp/theorchestra-media/AgACAgIAAxkBAAIF...jpg]

look at this, the bug is in the footer
```

Claude Code reads the image via its `Read` tool on the path. Codex reads files similarly with its file-read capability. No theorchestra-side work needed — the Claude/Codex session handles it from here.

## Cache location & cleanup

Files live in `os.tmpdir()/theorchestra-media/`. Naming: `<file_id>.<ext>` — stable and idempotent, so re-sending the same photo doesn't re-download. NOT auto-cleaned; drop a cron/scheduled task:

```bash
find $TMPDIR/theorchestra-media -type f -mtime +3 -delete
```

## Security

- **Trust boundary**: anything a user can type in your Telegram group becomes a file on the orchestrator host's tmpdir. Assume the group contains trusted users, or add a whitelist in OmniClaude's handler (refuse attachments from non-admin users).
- **No execution**: downloaded files are written with the default permissions; nothing is auto-executed. Claude/Codex will `Read` the file (read-only) unless they're explicitly instructed otherwise.
- **Size limits**: Telegram's max file size via Bot API is 20 MB (photos & docs) / 50 MB for some types. `downloadTelegramFile` doesn't enforce its own cap — add one in OmniClaude's handler if bandwidth is a concern.

## Failure modes

| Error | Cause | Fix |
|---|---|---|
| `Telegram getFile failed: Bad Request` | wrong file_id or bot token | verify the inbound update shape |
| `HTTP 404 for https://api.telegram.org/file/...` | file expired (Telegram purges old files) | ask the user to re-send |
| `fetchToFile timeout` | large file + slow link | raise the timeout or handle async |
| `ENOSPC` writing to cache | tmpdir full | move `cacheDir` via the opts param or clean the cache |
