/**
 * Minimal fire-and-forget Telegram push notifier.
 *
 * Phase 8 scope: when the orchestrator `ask()`s the user, we ping them on
 * Telegram so they don't have to keep the dashboard open. Everything is
 * best-effort — Telegram is a notification channel, not part of the chat
 * source of truth (that stays in ChatStore, reachable via /api/chat/*).
 *
 * No SDK — we post JSON to api.telegram.org via the global fetch (Node 22).
 * No retries, no queue, no rate-limit tracking. Errors go to stderr so they
 * appear in the theorchestra log but never block the orchestrator loop.
 */

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  /** Optional forum topic thread_id for project routing. */
  messageThreadId?: number;
}

export class TelegramPusher {
  constructor(private readonly config: TelegramConfig | null) {}

  /** True if Telegram is configured and notifications will actually be sent. */
  get enabled(): boolean {
    return this.config !== null;
  }

  /**
   * Send a one-line notification. Fire-and-forget: we never block the
   * orchestrator on Telegram. All errors go to stderr.
   */
  notify(title: string, body: string): void {
    const cfg = this.config;
    if (!cfg) return;

    const text = formatMessage(title, body);
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    const payload: Record<string, unknown> = {
      chat_id: cfg.chatId,
      text,
      parse_mode: 'HTML',
    };
    if (typeof cfg.messageThreadId === 'number') {
      payload.message_thread_id = cfg.messageThreadId;
    }

    // Fire-and-forget. The orchestrator's `ask()` must remain synchronous in
    // feel; we return void and swallow the promise.
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then((res) => {
        if (!res.ok) {
          return res.text().then((body) => {
            process.stderr.write(
              `[telegram-push] ${res.status} ${res.statusText}: ${truncate(body, 200)}\n`,
            );
          });
        }
        return undefined;
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[telegram-push] fetch failed: ${msg}\n`);
      });
  }
}

function formatMessage(title: string, body: string): string {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  if (safeTitle.length === 0) return safeBody;
  return `<b>${safeTitle}</b>\n${safeBody}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * Build a TelegramConfig from process.env. Returns null if either the token
 * or chat id is missing — callers treat null as "Telegram disabled" and the
 * pusher becomes a no-op.
 */
export function configFromEnv(): TelegramConfig | null {
  const botToken = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID ?? '').trim();
  if (botToken.length === 0 || chatId.length === 0) return null;

  const raw = (process.env.TELEGRAM_MESSAGE_THREAD_ID ?? '').trim();
  let messageThreadId: number | undefined;
  if (raw.length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) messageThreadId = parsed;
  }

  return { botToken, chatId, messageThreadId };
}
