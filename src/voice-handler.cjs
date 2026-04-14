#!/usr/bin/env node
/**
 * Voice transcription helper — OpenAI Whisper (or any compatible endpoint).
 *
 * Purpose: OmniClaude receives a voice message via the Telegram channel
 * plugin, calls `downloadTelegramVoice(fileId, token)` to fetch the audio,
 * then `transcribe(path)` to get text back. It then `send_prompt`s the
 * transcript to the project's pane — same flow as any text message.
 *
 * Zero-dep: raw Node `https`, manual multipart/form-data builder. No
 * OpenAI SDK, no `form-data` package.
 *
 * Config via env:
 *   WHISPER_API_KEY    — OpenAI-compatible bearer token (required to enable)
 *   WHISPER_ENDPOINT   — default 'https://api.openai.com/v1/audio/transcriptions'
 *   WHISPER_MODEL      — default 'whisper-1'
 *   WHISPER_LANGUAGE   — ISO-639-1 code (e.g. 'es', 'en'). Default: auto-detect.
 *
 * Exports:
 *   isEnabled() -> boolean
 *   downloadTelegramVoice(fileId, botToken, { cacheDir? }) -> Promise<string>   // local path
 *   transcribe(filePath, { language?, model?, endpoint? }) -> Promise<string>   // the text
 *
 * CLI:
 *   node src/voice-handler.cjs <file.ogg>    — print transcript or exit 2
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const DEFAULT_ENDPOINT = process.env.WHISPER_ENDPOINT || 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MODEL    = process.env.WHISPER_MODEL    || 'whisper-1';
const DEFAULT_LANGUAGE = process.env.WHISPER_LANGUAGE || null;
const CACHE_DIR        = path.join(os.tmpdir(), 'clawfleet-voice');

function isEnabled() {
  return !!process.env.WHISPER_API_KEY;
}

function log(msg) {
  process.stderr.write(`[voice-handler] ${new Date().toISOString()} ${msg}\n`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Download https URL to dest, following one 301/302 redirect. */
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

/**
 * Download a Telegram voice/audio file to local cacheDir and return its path.
 * fileId is msg.voice.file_id (or msg.audio.file_id).
 */
async function downloadTelegramVoice(fileId, botToken, { cacheDir = CACHE_DIR } = {}) {
  if (!fileId)   throw new Error('downloadTelegramVoice: fileId required');
  if (!botToken) throw new Error('downloadTelegramVoice: botToken required');
  ensureDir(cacheDir);

  // Step 1: getFile → file_path
  const api = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const metaJson = await new Promise((resolve, reject) => {
    https.get(api, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
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

  // Step 2: download the audio
  const ext = path.extname(meta.result.file_path) || '.oga';
  const localName = `${fileId.replace(/[^a-zA-Z0-9_-]/g, '_')}${ext}`;
  const localPath = path.join(cacheDir, localName);
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${meta.result.file_path}`;
  await fetchToFile(downloadUrl, localPath);
  return localPath;
}

/**
 * POST the file to the Whisper endpoint as multipart/form-data and return the transcript.
 */
async function transcribe(filePath, { language, model, endpoint } = {}) {
  const key = process.env.WHISPER_API_KEY;
  if (!key) throw new Error('WHISPER_API_KEY not set');
  if (!fs.existsSync(filePath)) throw new Error(`transcribe: file not found: ${filePath}`);

  const url = new URL(endpoint || DEFAULT_ENDPOINT);
  const boundary = '----clawfleetvoice' + Math.random().toString(16).slice(2);
  const fileName = path.basename(filePath);
  const fileBuf = fs.readFileSync(filePath);
  const useModel = model || DEFAULT_MODEL;
  const useLang  = language !== undefined ? language : DEFAULT_LANGUAGE;

  const parts = [];
  const append = (s) => parts.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));

  append(`--${boundary}\r\n`);
  append(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`);
  append('Content-Type: application/octet-stream\r\n\r\n');
  append(fileBuf);
  append('\r\n');

  append(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${useModel}\r\n`);
  if (useLang) {
    append(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${useLang}\r\n`);
  }
  append(`--${boundary}--\r\n`);

  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          if (typeof parsed.text !== 'string') return reject(new Error(`Whisper response missing text: ${data.slice(0, 200)}`));
          resolve(parsed.text);
        } catch (e) {
          reject(new Error(`Whisper parse error (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('Whisper request timeout (60s)')); });
    req.write(body);
    req.end();
  });
}

module.exports = { isEnabled, downloadTelegramVoice, transcribe };

// ── CLI ──
if (require.main === module) {
  const file = process.argv[2];
  if (!file) { process.stderr.write('usage: node src/voice-handler.cjs <audio-file>\n'); process.exit(1); }
  if (!isEnabled()) { process.stderr.write('WHISPER_API_KEY not set\n'); process.exit(1); }
  transcribe(file).then(text => {
    process.stdout.write(text + '\n');
    process.exit(0);
  }, err => {
    process.stderr.write(`transcribe failed: ${err.message}\n`);
    process.exit(2);
  });
}
