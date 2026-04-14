/**
 * Formats Telegram alert messages for permission prompts detected in panes.
 *
 * Usage from OmniClaude when a `session_permission` event fires:
 *   const { formatPermissionAlert, parsePermissionCommand } = require('.../permission-alerts.cjs');
 *   const text = formatPermissionAlert({
 *     paneId: 6, projectName: 'app', promptPreview: 'Allow Edit on src/...?'
 *   });
 *   await mcp__plugin_telegram_telegram__reply({ chat_id: GROUP_ID, message_thread_id: topic, text });
 *
 * When the user replies in the topic with `/approve`, `/reject`, or `/always`,
 * call parsePermissionCommand(msg.text) to get the canonical send_key payload.
 */

const APPROVE_KEY = '1'; // "Yes" (once)
const ALWAYS_KEY  = '2'; // "Always"
const REJECT_KEY  = '3'; // "No"

/**
 * Build the Telegram alert body. Pure string formatting — no side effects.
 *
 * @param {{ paneId:number, projectName?:string, promptPreview?:string }} opts
 * @returns {string} Telegram-ready HTML message body (≤ 400 chars)
 */
function formatPermissionAlert({ paneId, projectName, promptPreview }) {
  const proj = projectName || `pane-${paneId}`;
  const preview = (promptPreview || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])).slice(0, 240);
  return [
    `🔐 <b>PERMISSION PROMPT</b> — <code>[${proj}]</code> pane-${paneId}`,
    preview ? `\n<i>${preview}</i>` : '',
    '\n\nReply in this topic:',
    '• <code>/approve</code>  — allow once',
    '• <code>/always</code>   — allow always',
    '• <code>/reject</code>   — deny',
  ].join('');
}

/**
 * Parse a user's topic reply and map it to a send_key payload.
 *
 * @param {string} text  raw message text
 * @returns {null | { command:'approve'|'always'|'reject', key:string }}
 */
function parsePermissionCommand(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().toLowerCase().match(/^\/(approve|always|reject|yes|no|si)\b/);
  if (!m) return null;
  const verb = m[1];
  if (verb === 'approve' || verb === 'yes' || verb === 'si') return { command: 'approve', key: APPROVE_KEY };
  if (verb === 'always') return { command: 'always', key: ALWAYS_KEY };
  if (verb === 'reject' || verb === 'no') return { command: 'reject', key: REJECT_KEY };
  return null;
}

module.exports = {
  formatPermissionAlert,
  parsePermissionCommand,
  KEYS: { APPROVE: APPROVE_KEY, ALWAYS: ALWAYS_KEY, REJECT: REJECT_KEY },
};
