/**
 * Orchestrator Action Executor.
 *
 * Routes actions through a risk classifier:
 * - Safe actions auto-execute
 * - Risky actions become escalations (written to vault, surfaced in UI)
 *
 * Includes cooldown tracking, loop detection, and a global pause switch.
 */
const http = require('http');
const wez = require('./wezterm.cjs');
const vault = require('./vault-writer.cjs');

// ─── Config ──────────────────────────────────────────────────────────────────

const COOLDOWN_MS = 90 * 1000; // max 1 auto-continue per session per 90s
const LOOP_WINDOW_MS = 5 * 60 * 1000; // 5 min window
const LOOP_THRESHOLD = 3; // same action on same session 3 times → loop

const DESTRUCTIVE_RX = /\b(rm\s+-rf|rmdir|drop\s+(table|database)|delete\s+from|truncate|force[\s-]push|push\s+-f|migrate|deploy|prod(uction)?\b|wipe|purge|remove)\b/i;

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m',
};
function log(level, msg) {
  const color = level === 'error' ? c.red : level === 'warn' ? c.yellow : c.cyan;
  console.log(`${color}[executor]${c.reset} ${msg}`);
}

// ─── In-memory state ─────────────────────────────────────────────────────────

// Cooldown: session name → last action timestamp
const cooldowns = new Map();
// Loop detection: session name → [timestamps of recent actions]
const loopHistory = new Map();

// ─── Classifier ──────────────────────────────────────────────────────────────

/**
 * Classify an action as "safe" (auto-execute) or "risky" (escalate).
 * Returns { safe: boolean, reason: string }.
 */
function classifyAction(action, config) {
  config = config || { trusted_projects: [], never_auto_projects: [], allowed_tools: [], blocked_tools: [] };
  const session = action.session || '';
  const projectIsTrusted = config.trusted_projects.includes(session);
  const projectIsNeverAuto = config.never_auto_projects.includes(session);

  // Never-auto projects always escalate
  if (projectIsNeverAuto) {
    return { safe: false, reason: `project "${session}" is in never_auto_projects` };
  }

  // Self-action check (worker / wezbridge)
  if (/^wezbridge$|orchestrator-worker/i.test(session)) {
    return { safe: false, reason: 'cannot act on the orchestrator itself' };
  }

  switch (action.type) {
    case 'wait':
      return { safe: true, reason: 'wait is always safe' };

    case 'mission_progress':
      return { safe: true, reason: 'progress note is always safe' };

    case 'send_key': {
      if (!action.key) {
        return { safe: false, reason: 'send_key requires a key' };
      }
      const key = String(action.key).trim();
      // Navigation-only keys: always safe
      if (/^(esc|escape|tab|up|down|left|right)$/i.test(key)) {
        return { safe: true, reason: 'navigation key is always safe' };
      }
      // ctrl+c / ^c: escalate — it kills running work
      if (/^(ctrl\+c|\^c)$/i.test(key)) {
        return { safe: false, reason: 'ctrl+c interrupts — requires approval' };
      }
      // Numeric + Enter: selection keys. Check the option_text for destructive keywords.
      const optionText = (action.option_text || '').toLowerCase();
      if (DESTRUCTIVE_RX.test(optionText)) {
        return { safe: false, reason: `menu option "${action.option_text}" contains destructive keywords` };
      }
      // Menu options are short natural text — use broader destructive regex here
      if (/\b(delete|remove|wipe|reset|format|overwrite|drop|truncate|destroy)\b/i.test(optionText)) {
        return { safe: false, reason: `menu option "${action.option_text}" contains destructive keyword` };
      }
      // Also block "cancel" selections — they usually lose work
      if (/\b(cancel|abort|discard|reject)\b/i.test(optionText)) {
        return { safe: false, reason: `menu option "${action.option_text}" cancels/discards work` };
      }
      // Low confidence → escalate
      if (typeof action.confidence === 'number' && action.confidence < 0.7) {
        return { safe: false, reason: `low confidence (${action.confidence}) on menu selection` };
      }
      // If the worker didn't tell us what it's selecting, that's suspicious
      if (!action.option_text && /^\d+$/.test(key)) {
        return { safe: false, reason: 'numeric send_key without option_text — worker must identify what it selects' };
      }
      return { safe: true, reason: 'safe menu navigation' };
    }

    case 'continue': {
      if (!action.prompt || !action.prompt.trim()) {
        return { safe: false, reason: 'continue requires a non-empty prompt' };
      }
      // Destructive keyword scan
      if (DESTRUCTIVE_RX.test(action.prompt)) {
        return { safe: false, reason: 'prompt contains destructive keywords' };
      }
      // Low confidence → escalate (unless project is trusted)
      if (typeof action.confidence === 'number' && action.confidence < 0.6 && !projectIsTrusted) {
        return { safe: false, reason: `low confidence (${action.confidence})` };
      }
      return { safe: true, reason: projectIsTrusted ? 'trusted project' : 'safe continue' };
    }

    case 'spawn':
      // Spawning a new pane is always risky by default — costs tokens, has side effects
      return { safe: false, reason: 'spawn opens a new Claude session — requires user approval' };

    case 'mission_complete':
      // Option B: completion always escalates so the user confirms
      return { safe: false, reason: 'mission completion requires user confirmation (Option B)' };

    case 'mission_blocked':
      return { safe: false, reason: 'mission blocked — requires user attention' };

    case 'review':
      return { safe: false, reason: 'review spawns a new agent — requires user approval' };

    case 'escalate':
      return { safe: false, reason: 'explicit escalation from worker' };

    case 'kill':
      return { safe: false, reason: 'kill is destructive — requires approval' };

    case 'fire_routine':
      // Firing a Claude Routine spawns a remote session on Anthropic's infra
      // and consumes tokens/quota — always escalate in v1 so the user approves.
      if (!action.routine_id || !String(action.routine_id).trim()) {
        return { safe: false, reason: 'fire_routine requires routine_id' };
      }
      return { safe: false, reason: 'fire_routine triggers a remote Claude session — requires user approval' };

    case 'spawn_team':
      // PRD-driven team bootstrap — always escalates (spawns multiple agents + consumes tokens)
      if (!action.prd || !String(action.prd).trim()) {
        return { safe: false, reason: 'spawn_team requires prd name' };
      }
      return { safe: false, reason: 'spawn_team bootstraps a multi-agent team — requires user approval' };

    default:
      return { safe: false, reason: `unknown action type: ${action.type}` };
  }
}

// ─── Cooldown + loop detection ───────────────────────────────────────────────

function inCooldown(session) {
  const last = cooldowns.get(session);
  return last != null && (Date.now() - last) < COOLDOWN_MS;
}

function recordCooldown(session) {
  cooldowns.set(session, Date.now());
}

function isLoop(session, actionType) {
  // Wait, mission_progress are idempotent "no-op-ish" actions that
  // naturally repeat while a session is actively working. They must not
  // trip the loop detector — that's what the "don't interrupt" pattern looks like.
  if (actionType === 'wait' || actionType === 'mission_progress') return false;
  const key = `${session}:${actionType}`;
  const now = Date.now();
  const history = loopHistory.get(key) || [];
  const recent = history.filter(ts => now - ts < LOOP_WINDOW_MS);
  recent.push(now);
  loopHistory.set(key, recent);
  return recent.length >= LOOP_THRESHOLD;
}

// ─── Executors ───────────────────────────────────────────────────────────────

function execContinue(action) {
  if (action.pane_id == null) {
    throw new Error('continue requires pane_id');
  }
  wez.sendText(action.pane_id, action.prompt);
  recordCooldown(action.session);
  log('info', `continue → pane ${action.pane_id} (${action.session}): ${action.prompt.slice(0, 60)}...`);
}

function execWait(action) {
  log('info', `wait → ${action.session}: ${action.reason}`);
}

/**
 * Spawn a new WezTerm pane in the project directory, launch claude, send the initial prompt.
 * Returns the new pane id. If a mission_id is provided, the new pane is linked to it.
 */
async function execSpawn(action) {
  if (!action.project_path) {
    throw new Error('spawn requires project_path');
  }
  const cwd = action.project_path.replace(/\\/g, '/');
  log('info', `spawn → ${action.session} (${cwd})`);

  const newPaneId = wez.spawnPane({ cwd });
  log('info', `spawn → new pane #${newPaneId}, waiting for shell`);

  // Wait for shell prompt, then launch claude
  await sleep(2000);
  wez.sendText(newPaneId, 'claude --dangerously-skip-permissions');

  // Wait for Claude to boot
  await sleep(15000);

  // Send the initial prompt if provided
  if (action.prompt && action.prompt.trim()) {
    wez.sendText(newPaneId, action.prompt);
    log('info', `spawn → sent initial prompt to pane #${newPaneId}`);
  }

  // If linked to a mission, update the mission with the new pane_id and mark running
  if (action.mission_id) {
    try {
      vault.updateMission(action.mission_id, {
        pane_id: newPaneId,
        status: 'running',
      });
      vault.appendMissionProgress(action.mission_id, `Spawned pane #${newPaneId} and sent initial prompt`);
      log('info', `spawn → mission ${action.mission_id} linked to pane #${newPaneId}`);
    } catch (err) {
      log('warn', `failed to update mission ${action.mission_id}: ${err.message}`);
    }
  }

  recordCooldown(action.session);
  return newPaneId;
}

/**
 * Mark a mission as completed (only via user-approved escalation per Option B).
 */
function execMissionComplete(action) {
  if (!action.mission_id) {
    throw new Error('mission_complete requires mission_id');
  }
  vault.updateMission(action.mission_id, { status: 'completed' });
  vault.appendMissionProgress(action.mission_id, `Marked complete: ${action.reason || 'user approved'}`);
  log('info', `mission_complete → ${action.mission_id} (${action.session})`);
}

/**
 * Append a progress note to a mission.
 */
function execMissionProgress(action) {
  if (!action.mission_id) {
    log('warn', 'mission_progress missing mission_id, ignoring');
    return;
  }
  const note = action.progress_note || action.reason || '(no note)';
  vault.appendMissionProgress(action.mission_id, note);
  log('info', `mission_progress → ${action.mission_id}: ${note.slice(0, 60)}`);
}

/**
 * Send a single key to a pane. Used for navigating interactive Claude Code menus
 * (Enter-to-select pickers). The key can be a digit (1-9), Enter, Esc, Tab, arrows.
 */
function execSendKey(action) {
  if (action.pane_id == null) {
    throw new Error('send_key requires pane_id');
  }
  if (!action.key) {
    throw new Error('send_key requires key');
  }
  const key = String(action.key).trim().toLowerCase();
  // Map common key names to terminal sequences
  // Note: digits and enter are sent as-is; escape is \x1b; arrows are escape sequences
  let rawKey;
  switch (key) {
    case 'esc':
    case 'escape':
      rawKey = '\x1b';
      break;
    case 'tab':
      rawKey = '\t';
      break;
    case 'enter':
    case 'return':
      rawKey = '\r';
      break;
    case 'up':
      rawKey = '\x1b[A';
      break;
    case 'down':
      rawKey = '\x1b[B';
      break;
    case 'right':
      rawKey = '\x1b[C';
      break;
    case 'left':
      rawKey = '\x1b[D';
      break;
    case 'ctrl+c':
    case '^c':
      rawKey = '\x03';
      break;
    default:
      // For single digits and plain text, send as-is. Numeric menu selections
      // in Claude Code are confirmed immediately on key press (no Enter needed).
      rawKey = action.key;
  }
  // For navigation keys use sendTextNoEnter (no extra \r appended).
  // For numeric menu picks, the menu auto-selects on the digit keypress.
  wez.sendTextNoEnter(action.pane_id, rawKey);
  log('info', `send_key → pane ${action.pane_id} key="${action.key}" option="${(action.option_text || '').slice(0, 60)}"`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function execEscalate(action, { emitEvent } = {}) {
  const id = 'esc-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6);
  const escalation = vault.addEscalation(id, {
    session: action.session,
    paneId: action.pane_id,
    reason: action.reason,
    context: action.prompt || '',
    proposedAction: action,
    options: ['approve', 'reject', 'custom'],
    priority: action.priority || 'normal',
  });
  if (emitEvent) {
    emitEvent({
      type: 'escalation_needed',
      id,
      session: action.session,
      pane_id: action.pane_id,
      reason: action.reason,
      priority: action.priority || 'normal',
      proposed_action: action,
      timestamp: new Date().toISOString(),
    });
  }
  log('warn', `escalate → ${action.session}: ${action.reason} (id=${id})`);
  return id;
}

// ─── Fire a Claude Routine via the local /api/routines/fire endpoint ────────

function execFireRoutine(action) {
  return new Promise((resolve, reject) => {
    if (!action.routine_id) return reject(new Error('fire_routine requires routine_id'));
    const port = parseInt(process.env.DASHBOARD_PORT || '4200', 10);
    const body = JSON.stringify({
      routine_id: action.routine_id,
      ...(action.text ? { text: String(action.text) } : {}),
      ...(action.token_env_var ? { token_env_var: String(action.token_env_var) } : {}),
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/routines/fire',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 20 * 1000,
    }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log('info', `fire_routine → ${action.routine_id} ok (status ${res.statusCode})`);
          resolve(parsed || { ok: true });
        } else {
          log('error', `fire_routine → ${action.routine_id} failed ${res.statusCode}: ${buf.slice(0, 200)}`);
          reject(new Error(`routines fire failed: ${res.statusCode}`));
        }
      });
    });
    req.on('error', err => reject(err));
    req.on('timeout', () => { req.destroy(new Error('routines fire timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── Spawn a team via the local /api/agency/bootstrap endpoint ──────────────

function execSpawnTeam(action) {
  return new Promise((resolve, reject) => {
    if (!action.prd) return reject(new Error('spawn_team requires prd'));
    const port = parseInt(process.env.DASHBOARD_PORT || '4200', 10);
    const body = JSON.stringify({
      prd: String(action.prd),
      ...(action.cwd ? { cwd: String(action.cwd) } : {}),
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/agency/bootstrap',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 120 * 1000,
    }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log('info', `spawn_team → ${action.prd} ok (status ${res.statusCode})`);
          resolve(parsed || { ok: true });
        } else {
          log('error', `spawn_team → ${action.prd} failed ${res.statusCode}: ${buf.slice(0, 200)}`);
          reject(new Error(`agency bootstrap failed: ${res.statusCode}`));
        }
      });
    });
    req.on('error', err => reject(err));
    req.on('timeout', () => { req.destroy(new Error('agency bootstrap timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────

/**
 * Dispatch a single action through the classifier + executor.
 * Returns the outcome string logged by the daemon.
 * @param {object} action - Normalized action from the worker
 * @param {object} context - { tick_id, emitEvent }
 */
async function dispatch(action, context = {}) {
  // Load fresh config every dispatch (allows live config edits)
  let config = {};
  try { config = vault.parseOrchestratorConfig(); } catch { /* ignore */ }

  // Loop detection first — a loop short-circuits everything and escalates
  if (isLoop(action.session, action.type)) {
    log('error', `LOOP detected for ${action.session}:${action.type} — escalating`);
    execEscalate({
      ...action,
      reason: `Possible loop detected: ${action.type} on ${action.session} fired ${LOOP_THRESHOLD}+ times in ${LOOP_WINDOW_MS / 1000}s. ` + action.reason,
      priority: 'high',
    }, context);
    return 'loop_escalated';
  }

  const classification = classifyAction(action, config);

  // Safe actions: cooldown + execute
  if (classification.safe) {
    if (action.type === 'continue' && inCooldown(action.session)) {
      log('info', `cooldown active for ${action.session}, skipping ${action.type}`);
      return 'cooldown_skipped';
    }
    try {
      switch (action.type) {
        case 'wait': execWait(action); return 'executed';
        case 'continue': execContinue(action); return 'executed';
        case 'mission_progress': execMissionProgress(action); return 'executed';
        case 'send_key': execSendKey(action); return 'executed';
        default:
          log('warn', `no executor for safe action type: ${action.type}`);
          return 'unknown_type';
      }
    } catch (err) {
      log('error', `execution failed: ${err.message}`);
      return 'failed';
    }
  }

  // Risky actions: escalate
  log('info', `risky (${classification.reason}) → escalating`);
  execEscalate({ ...action, reason: classification.reason + '. ' + action.reason }, context);
  return 'escalated';
}

// ─── Apply a resolved escalation (called from dashboard when user resolves) ─

/**
 * When the user resolves an escalation in the UI, this is called to apply the chosen action.
 * @param {object} escalation - The escalation metadata
 * @param {object} resolution - { action: 'approve' | 'reject' | 'custom', payload: {...} }
 */
async function applyResolution(escalation, resolution) {
  const proposed = escalation.proposedAction || null;
  if (!proposed) {
    log('warn', 'escalation has no proposed action, nothing to apply');
    return 'no_action';
  }

  if (resolution.action === 'reject') {
    log('info', `escalation ${escalation.id} rejected by user`);
    return 'rejected';
  }

  if (resolution.action === 'approve') {
    // Execute the proposed action directly, bypassing the classifier
    try {
      switch (proposed.type) {
        case 'continue': execContinue(proposed); return 'approved_executed';
        case 'wait': execWait(proposed); return 'approved_executed';
        case 'kill':
          if (proposed.pane_id != null) wez.killPane(proposed.pane_id);
          return 'approved_executed';
        case 'spawn': {
          // Async — fire and let the caller move on. We don't await here so the
          // resolve endpoint returns quickly to the user. The pane is tracked via vault.
          execSpawn(proposed).catch(err => log('error', `approved spawn failed: ${err.message}`));
          return 'approved_executed';
        }
        case 'send_key':
          execSendKey(proposed); return 'approved_executed';
        case 'review': {
          // Review = spawn a fresh Claude session in the project dir with an audit prompt.
          // Reuses execSpawn under the hood.
          if (!proposed.project_path) {
            log('warn', 'review approval missing project_path — cannot spawn');
            return 'approved_noop';
          }
          const reviewAction = {
            ...proposed,
            type: 'spawn',
            prompt: proposed.prompt || 'Review the recent work in this project. Run tests, check for regressions, summarize findings.',
          };
          execSpawn(reviewAction).catch(err => log('error', `approved review spawn failed: ${err.message}`));
          return 'approved_executed';
        }
        case 'fire_routine': {
          execFireRoutine(proposed)
            .catch(err => log('error', `approved fire_routine failed: ${err.message}`));
          return 'approved_executed';
        }
        case 'spawn_team': {
          // POST to /api/agency/bootstrap via local http request
          execSpawnTeam(proposed)
            .catch(err => log('error', `approved spawn_team failed: ${err.message}`));
          return 'approved_executed';
        }
        case 'mission_complete':
          execMissionComplete(proposed);
          return 'approved_executed';
        case 'mission_blocked':
          if (proposed.mission_id) {
            vault.updateMission(proposed.mission_id, { status: 'blocked' });
            vault.appendMissionProgress(proposed.mission_id, `Marked blocked: ${proposed.reason || ''}`);
          }
          return 'approved_executed';
        default:
          log('warn', `no executor for approved action type: ${proposed.type}`);
          return 'approved_unknown';
      }
    } catch (err) {
      log('error', `approval execution failed: ${err.message}`);
      return 'approved_failed';
    }
  }

  if (resolution.action === 'custom') {
    // User provided a custom prompt/payload
    if (proposed.pane_id != null && resolution.payload && resolution.payload.prompt) {
      try {
        wez.sendText(proposed.pane_id, resolution.payload.prompt);
        return 'custom_executed';
      } catch (err) {
        log('error', `custom execution failed: ${err.message}`);
        return 'custom_failed';
      }
    }
    return 'custom_noop';
  }

  return 'unknown_resolution';
}

module.exports = {
  dispatch,
  applyResolution,
  classifyAction,
  // Individual executors (used by dashboard for direct mission auto-spawn)
  execSpawn,
  execContinue,
  execSendKey,
  execFireRoutine,
  execSpawnTeam,
  // Exposed for tests
  _internals: { cooldowns, loopHistory, inCooldown, isLoop },
};
