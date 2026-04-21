/**
 * P7.C — MCP tool handlers for the persistent omniclaude pane.
 *
 * These expose the dashboard snapshot/action surface + decision log +
 * chat read/write to omniclaude, so it can reason over the full
 * orchestrator state from within its Claude Code session.
 */

import { z } from 'zod';
import { backendClient } from '../client.js';
import { callBackend, errorResult, jsonResult, type ToolHandler } from '../handler-types.js';

// snapshot_dashboard — read-only.
const snapshotShape = {} as const;
const snapshotHandler: ToolHandler<Record<string, never>> = {
  name: 'snapshot_dashboard',
  description:
    'Capture the current a11y tree of the theorchestra dashboard via agent-browser. Returns semantic refs (e1..eN) with names + roles you can pass to act_on_ref.',
  inputSchema: snapshotShape,
  run: async () => {
    const r = await callBackend('snapshot_dashboard', () => backendClient.snapshotDashboard());
    if (!r.ok) return r.result;
    return jsonResult(r.value);
  },
};

// act_on_ref
const actShape = {
  ref: z.string().regex(/^e\d+$/).describe('Ref returned by snapshot_dashboard (e.g. "e36").'),
  verb: z
    .enum(['click', 'hover', 'focus', 'dblclick'])
    .describe('UI verb to apply to the ref.'),
} as const;
interface ActInput {
  ref: string;
  verb: 'click' | 'hover' | 'focus' | 'dblclick';
}
const actHandler: ToolHandler<ActInput> = {
  name: 'act_on_ref',
  description:
    "Drive the theorchestra dashboard: click/hover/focus/dblclick a semantic ref returned by a prior snapshot_dashboard. Per-(verb, ref) 10s cooldown prevents UI thrash.",
  inputSchema: actShape,
  run: async (input) => {
    const r = await callBackend('act_on_ref', () => backendClient.actOnRef(input.ref, input.verb));
    if (!r.ok) return r.result;
    return jsonResult(r.value);
  },
};

// get_recent_decisions
const recentShape = {
  limit: z.number().int().min(1).max(200).optional().describe('Max records, default 20.'),
} as const;
interface RecentInput {
  limit?: number;
}
const recentHandler: ToolHandler<RecentInput> = {
  name: 'get_recent_decisions',
  description:
    'Return the orchestrator decision log tail. Each record has action, classification (verdict + reason), executed, and any attestation / metadata from agent-browser actions.',
  inputSchema: recentShape,
  run: async (input) => {
    const limit = input.limit ?? 20;
    const r = await callBackend('get_recent_decisions', () => backendClient.getRecentDecisions(limit));
    if (!r.ok) return r.result;
    return jsonResult(r.value);
  },
};

// get_chat_messages
const chatShape = {
  limit: z.number().int().min(1).max(500).optional().describe('Max messages, default 50.'),
} as const;
interface ChatInput {
  limit?: number;
}
const chatHandler: ToolHandler<ChatInput> = {
  name: 'get_chat_messages',
  description:
    'Return the user↔orchestrator chat tail. Use to see the user\'s replies to prior asks or their free-form messages.',
  inputSchema: chatShape,
  run: async (input) => {
    const limit = input.limit ?? 50;
    const r = await callBackend('get_chat_messages', () => backendClient.getChatMessages(limit));
    if (!r.ok) return r.result;
    return jsonResult(r.value);
  },
};

// ask_user
const askShape = {
  topic: z
    .string()
    .min(1)
    .max(100)
    .describe('Short category (merge, design, permission, critical, generic).'),
  text: z.string().min(1).max(4000).describe('The question/detail to surface to the user.'),
  session_id: z.string().optional().nullable().describe('Related pane, if any.'),
} as const;
interface AskInput {
  topic: string;
  text: string;
  session_id?: string | null;
}
const askHandler: ToolHandler<AskInput> = {
  name: 'ask_user',
  description:
    'Escalate a decision to the user via the dashboard chat. The ask lands in OmniClaude panel with an optional snapshot badge. Use for genuine ambiguity you cannot resolve from context.',
  inputSchema: askShape,
  run: async (input) => {
    const r = await callBackend('ask_user', () =>
      backendClient.askUser(input.topic, input.text, input.session_id ?? null),
    );
    if (!r.ok) return r.result;
    return jsonResult(r.value);
  },
};

export const omniclaudeHandlers: ToolHandler<unknown>[] = [
  snapshotHandler as ToolHandler<unknown>,
  actHandler as ToolHandler<unknown>,
  recentHandler as ToolHandler<unknown>,
  chatHandler as ToolHandler<unknown>,
  askHandler as ToolHandler<unknown>,
];

// Unused-guard for the strict no-unused-imports check; errorResult is
// re-exported for symmetry with other handler modules that use it.
void errorResult;
