#!/usr/bin/env node
/**
 * Media forwarding helper — Telegram photo / document → local path.
 *
 * Purpose: when a user attaches an image or document to a project topic,
 * the channel plugin forwards the message with `photo[]` / `document` /
 * `video` / `audio` / `voice` fields. OmniClaude calls this helper to
 * download the largest variant to disk, then embeds the local path in
 * the prompt it sends to the pane — Claude Code's Read tool handles
 * images natively; Codex can also read files referenced by path.
 *
 * Zero-dep: pure Node `https` + `fs`. No Telegram SDK.
 *
 * Exports:
 *   formatPromptPreamble({ paths, caption }) -> string   // text to prepend to user's prompt
 *   pickLargestPhoto(photoArray)             -> { file_id, width, height, file_size } | null
 *   downloadTelegramFile(fileId, botToken, { cacheDir? }) -> Promise<{ path, size, mime? }>
 *   downloadMessageMedia(msg, botToken, { cacheDir? })    -> Promise<{ paths, caption, kinds }>
 *
 * Re-uses the same two-step Telegram fetch pattern as voice-handler.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const CACHE_DIR = path.join(os.tmpdir(), 'theorchestra-media');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function fetchToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.resume();
        return fetchToFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('fetchToFile timeout')); });
  });
}

/** Pick the biggest variant from a Telegram photo[] array. */
function pickLargestPhoto(photos) {
  if (!Array.isArray(photos) || photos.length === 0) return null;
  return photos.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
}

/** Fetch a single Telegram file by file_id → { path, size, mime? }. */
async function downloadTelegramFile(fileId, botToken, { cacheDir = CACHE_DIR } = {}) {
  if (!fileId)   throw new Error('downloadTelegramFile: fileId required');
  if (!botToken) throw new Error('downloadTelegramFile: botToken required');
  ensureDir(cacheDir);

  const metaJson = await new Promise((resolve, reject) => {
    https.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`, (res) => {
      let buf = ''; res.on('data', c => { buf += c; });
      res.on('end', () => resolve(buf));
      res.on('error', reject);
    }).on('error', reject);
  });
  let meta;
  try { meta = JSON.parse(metaJson); }
  catch { throw new Error(`Telegram getFile: invalid JSON: ${metaJson.slice(0, 200)}`); }
  if (!meta.ok || !meta.result || !meta.result.file_path) {
    throw new Error(`Telegram getFile failed: ${meta.description || JSON.stringify(meta)}`);
  }

  const ext = path.extname(meta.result.file_path) || '';
  const safeId = fileId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const localPath = path.join(cacheDir, `${safeId}${ext}`);
  await fetchToFile(`https://api.telegram.org/file/bot${botToken}/${meta.result.file_path}`, localPath);
  const size = fs.statSync(localPath).size;
  return { path: localPath, size, ext };
}

/**
 * Extract all media attached to a Telegram message and download them.
 * Returns `{ paths: [string], caption: string, kinds: {photo?, document?, video?, audio?, voice?} }`.
 *
 * - photo[] → picks the largest variant
 * - document → single file
 * - video / audio / voice → single file each
 * - ignores sticker, contact, location, etc. (out of scope for forwarding)
 */
async function downloadMessageMedia(msg, botToken, opts = {}) {
  if (!msg || typeof msg !== 'object') throw new Error('downloadMessageMedia: msg required');
  const kinds = {};
  const paths = [];

  const photo = pickLargestPhoto(msg.photo);
  if (photo) {
    const dl = await downloadTelegramFile(photo.file_id, botToken, opts);
    paths.push(dl.path);
    kinds.photo = { ...dl, width: photo.width, height: photo.height };
  }
  for (const key of ['document', 'video', 'audio', 'voice']) {
    if (msg[key] && msg[key].file_id) {
      const dl = await downloadTelegramFile(msg[key].file_id, botToken, opts);
      paths.push(dl.path);
      kinds[key] = { ...dl, mime_type: msg[key].mime_type, file_name: msg[key].file_name || null };
    }
  }

  return {
    paths,
    caption: (msg.caption || '').trim(),
    kinds,
  };
}

/**
 * Build a preamble for the user's prompt that tells Claude / Codex where to find
 * the files. The coordinator prepends this to the caption (if any) and sends the
 * whole thing via send_prompt + send_key('enter').
 */
function formatPromptPreamble({ paths, caption }) {
  if (!paths || paths.length === 0) return caption || '';
  const lines = paths.map(p => `[attachment: ${p}]`);
  const preamble = lines.join('\n');
  return caption ? `${preamble}\n\n${caption}` : preamble;
}

module.exports = {
  pickLargestPhoto,
  downloadTelegramFile,
  downloadMessageMedia,
  formatPromptPreamble,
};

// ── CLI (debug util) ──
if (require.main === module) {
  const [, , fileId, token] = process.argv;
  if (!fileId || !token) {
    process.stderr.write('usage: node src/media-handler.cjs <file_id> <bot_token>\n');
    process.exit(1);
  }
  downloadTelegramFile(fileId, token).then(r => {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(0);
  }, err => {
    process.stderr.write(`download failed: ${err.message}\n`);
    process.exit(2);
  });
}
