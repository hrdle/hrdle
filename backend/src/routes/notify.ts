import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Hono } from 'hono';
import { broadcastToMuxClients } from './terminal-mux';
import type { IndicatorState } from '../../../shared/types';
import { getHookStatus } from '../services/hook-status';
import {
  glassesRelaySubscriberCount,
  postHookRelay,
  resolveHookTarget,
} from '../services/glasses-relay';
import { resolveNotifyCommand } from '../services/notify-command';

// Read only the trailing slice of a transcript instead of the whole file.
// Active Claude sessions produce multi-MB .jsonl transcripts; the previous
// "readFile + split('\\n')" path showed up at ~16% of CPU in profiling
// because every hook event re-parsed the entire history.
// 256 KB is enough to comfortably contain 50 trailing JSONL entries even
// for entries with large tool_result blocks.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

async function readTrailingLines(path: string, lineCount: number): Promise<string[]> {
  const file = Bun.file(path);
  const size = file.size;
  if (size === 0) return [];
  const offset = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
  const slice = offset === 0 ? file : file.slice(offset);
  const content = await slice.text();
  const lines = content.split('\n');
  // The first line may be a partial JSONL record when we sliced mid-file;
  // drop it so JSON.parse below doesn't fail on a truncated entry.
  if (offset > 0) lines.shift();
  return lines.slice(-lineCount);
}

// /api/notify is unauthenticated (local hooks call into it), so the
// transcript_path in the request body cannot be trusted: generateSmartMessage
// reads the file and broadcasts text fragments of it to every connected
// client. Only real transcript locations (the agent CLIs' state dirs) may be
// read. Symlinks are resolved before the prefix check. #347
export async function isAllowedTranscriptPath(path: string): Promise<boolean> {
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    return false;
  }
  for (const dir of ['.claude', '.codex', '.grok', '.kimi-code']) {
    const root = await realpath(`${homedir()}/${dir}`).catch(() => null);
    if (root && resolved.startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * Grok Build sends hook JSON with camelCase keys and snake_case event names
 * (`{"hookEventName":"stop","sessionId":...,"transcriptPath":...}`) — even for
 * hooks it loaded from Claude's settings.json via its compat layer. Map that
 * shape onto the Claude field names the rest of this route understands.
 * Bodies already in Claude shape pass through untouched.
 */
const GROK_EVENT_NAMES: Record<string, string> = {
  stop: 'Stop',
  notification: 'Notification',
  subagent_stop: 'SubagentStop',
  post_tool_use: 'PostToolUse',
  pre_tool_use: 'PreToolUse',
  user_prompt_submit: 'UserPromptSubmit',
  session_start: 'SessionStart',
  session_end: 'SessionEnd',
};

export function normalizeHookBody(body: Record<string, unknown>): Record<string, unknown> {
  if (body.hook_event_name || typeof body.hookEventName !== 'string') return body;
  const { hookEventName, sessionId, transcriptPath, toolName, ...rest } = body;
  const normalized: Record<string, unknown> = {
    ...rest,
    hook_event_name: GROK_EVENT_NAMES[hookEventName as string] ?? hookEventName,
  };
  if (typeof sessionId === 'string') normalized.session_id = sessionId;
  if (typeof transcriptPath === 'string') normalized.transcript_path = transcriptPath;
  if (typeof toolName === 'string') normalized.tool_name = toolName;
  return normalized;
}

/**
 * Grok の transcript (updates.jsonl, JSON-RPC session/update ストリーム) から
 * 通知メッセージを生成する。最後の user_message_chunk 以降の
 * agent_message_chunk を連結して最後の応答本文とみなす。
 */
function generateGrokSmartMessage(entries: Array<Record<string, unknown>>): string | undefined {
  const tools: string[] = [];
  let responseText = '';
  for (const entry of entries) {
    const update = (entry.params as { update?: Record<string, unknown> } | undefined)?.update;
    if (!update) continue;
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        responseText = '';
        break;
      case 'agent_message_chunk': {
        const text = (update.content as { text?: string } | undefined)?.text;
        if (typeof text === 'string') responseText += text;
        break;
      }
      case 'tool_call': {
        const name = typeof update.title === 'string' ? update.title : undefined;
        if (name && !tools.includes(name)) tools.push(name);
        // Chunks before a tool call are intermediate narration; the summary
        // should quote the FINAL message of the turn (same as the Claude path).
        responseText = '';
        break;
      }
    }
  }

  let action: string;
  const hasTool = (pattern: RegExp) => tools.some((t) => pattern.test(t));
  if (hasTool(/edit|write|create_file|apply_patch/i)) action = 'ファイル編集完了';
  else if (hasTool(/terminal|bash|command/i)) action = 'コマンド実行完了';
  else if (hasTool(/read|search|grep|glob/i)) action = '調査完了';
  else action = '完了';

  let inCodeBlock = false;
  for (const line of responseText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;
    if (trimmed && trimmed.length > 5) {
      const summary = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
      return `${action}: ${summary}`;
    }
  }
  return action;
}

/** transcriptファイルからコンテキストに応じた通知メッセージを生成する */
async function generateSmartMessage(transcriptPath: string, _event: string): Promise<string | undefined> {
  try {
    const recentLines = await readTrailingLines(transcriptPath, 50);
    const entries = [];
    for (const line of recentLines) {
      if (!line) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }

    // Grok transcript は Claude の .jsonl と行形式が違うので専用パスへ
    if (entries.some((e) => e?.method === 'session/update')) {
      return generateGrokSmartMessage(entries);
    }

    // 使用されたツールを収集
    const tools: string[] = [];
    for (const entry of entries) {
      if (entry.type === 'assistant') {
        for (const block of entry.message?.content || []) {
          if (block.type === 'tool_use' && block.name && !tools.includes(block.name)) {
            tools.push(block.name);
          }
        }
      }
    }

    // アクション種別を判定
    let action: string;
    if (tools.includes('Edit') || tools.includes('Write')) action = 'ファイル編集完了';
    else if (tools.includes('Bash')) action = 'コマンド実行完了';
    else if (tools.includes('Grep') || tools.includes('Glob') || tools.includes('Read')) action = '調査完了';
    else action = '完了';

    // 最後のアシスタントメッセージのテキストを取得
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type !== 'assistant') continue;
      for (const block of entries[i].message?.content || []) {
        if (block.type !== 'text') continue;
        // コードブロックを除いた最初の有意な行
        let inCodeBlock = false;
        for (const line of (block.text || '').split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
          if (inCodeBlock) continue;
          if (trimmed && trimmed.length > 5) {
            const summary = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
            return `${action}: ${summary}`;
          }
        }
      }
    }

    return action;
  } catch {
    return undefined;
  }
}

const notify = new Hono();

// hookイベントによるindicatorStateの一時オーバーライド
// ccSessionId → { state, expiresAt }
const stateOverrides = new Map<string, { state: IndicatorState; expiresAt: number; toolName?: string }>();
// TTLは安全弁。StopやPostToolUse/PreToolUseで明示的に上書きされる。
const OVERRIDE_TTL = 24 * 60 * 60_000; // 24時間
// `/api/notify` is intentionally unauthenticated (local hooks call into it),
// so a network attacker can flood the endpoint with arbitrary session_ids to
// blow up `stateOverrides`. Validate the id format and bound the Map size so a
// flood costs O(MAX) memory rather than O(requests). #254
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_OVERRIDE_ENTRIES = 500;

function evictStateOverrides(): void {
  const now = Date.now();
  for (const [key, entry] of stateOverrides) {
    if (entry.expiresAt <= now) stateOverrides.delete(key);
  }
  while (stateOverrides.size > MAX_OVERRIDE_ENTRIES) {
    const oldest = stateOverrides.keys().next().value;
    if (oldest === undefined) break;
    stateOverrides.delete(oldest);
  }
}

/**
 * What the glasses say about an event, when the transcript gave us nothing
 * better. Mirrors the browser notification's own fallback bodies so the two
 * channels describe the same event in the same words.
 */
const HOOK_RELAY_TEXT: Record<string, string> = {
  Stop: '応答が完了しました',
  Notification: 'ユーザー入力を待っています',
  SubagentStop: 'サブエージェントが完了しました',
  TaskCompleted: 'タスクが完了しました',
  PostToolUse: 'ユーザー入力を待っています',
};

function hookEventToState(event: string, toolName?: string): IndicatorState | null {
  switch (event) {
    case 'Stop':
    case 'Notification':
    case 'SubagentStop':
      return 'completed';
    case 'PostToolUse':
      if (toolName === 'AskUserQuestion') return 'waiting_input';
      return null;
    case 'PreToolUse':
      if (toolName === 'AskUserQuestion') return 'waiting_input';
      return 'processing';
    case 'UserPromptSubmit':
      return 'processing';
    default:
      return null;
  }
}

/** セッションリスト取得時にオーバーライドを適用する */
export function getIndicatorOverride(ccSessionId: string): { state: IndicatorState; toolName?: string } | null {
  const override = stateOverrides.get(ccSessionId);
  if (!override) return null;
  if (Date.now() > override.expiresAt) {
    stateOverrides.delete(ccSessionId);
    return null;
  }
  return { state: override.state, toolName: override.toolName };
}

/**
 * Claude Code / Codex hook イベントを受信して WebSocket 経由で全クライアントにブロードキャストする。
 * Stop, Notification 等の hook から curl で呼ばれる想定。
 *
 * リクエストボディ: hook の stdin JSON をそのまま渡す
 * {
 *   "hook_event_name": "Stop" | "Notification" | ...,
 *   "session_id": "...",
 *   "cwd": "/path/to/project",
 *   ...その他のhook固有フィールド
 * }
 */
notify.post('/', async (c) => {
  try {
    const body = normalizeHookBody(await c.req.json());
    const event = String(body.hook_event_name || body.event || 'unknown');
    const cwd = body.cwd as string | undefined;
    const sessionId = body.session_id as string | undefined;

    // hook固有の情報を data に格納
    const { hook_event_name, cwd: _cwd, session_id: _sid, transcript_path: _tp, ...rest } = body;
    const transcriptPath = body.transcript_path as string | undefined;

    // indicatorStateオーバーライドを保存
    // session_id must look like a real agent session id (Claude/Codex UUIDs,
    // herdr workspace labels). Reject anything that doesn't and bound the Map so
    // an unauth flood costs O(MAX) memory, not O(requests). #254
    if (sessionId && SESSION_ID_RE.test(sessionId)) {
      const toolName = body.tool_name as string | undefined;
      const newState = hookEventToState(event, toolName);
      if (newState) {
        const ttl = OVERRIDE_TTL;
        evictStateOverrides();
        // Keep the tool name from either side of the tool call: PreToolUse is
        // optional now that herdr reports `blocked` on its own (#390), so
        // PostToolUse/AskUserQuestion has to be able to name the question.
        const carriesToolName = event === 'PreToolUse' || event === 'PostToolUse';
        stateOverrides.set(sessionId, { state: newState, expiresAt: Date.now() + ttl, toolName: carriesToolName ? toolName : undefined });
      }
    }

    // transcriptからスマートなメッセージを生成
    let message: string | undefined;
    if (transcriptPath && (await isAllowedTranscriptPath(transcriptPath))) {
      message = await generateSmartMessage(transcriptPath, event);
    }

    // Skip notification for status-only events (no browser notification needed)
    if (event !== 'UserPromptSubmit' && event !== 'PreToolUse') {
      // While the glasses are on they take the notification and the browser
      // stays quiet: the user is wearing the thing that already told them, and
      // a phone buzzing about the same event is noise. Anything that keeps the
      // relay item from landing — no glasses, an unresolvable session, the
      // per-session rate limit — leaves this false and the push goes out as it
      // always did. Losing a notification is the worse failure of the two.
      let deliveredToGlasses = false;
      if (glassesRelaySubscriberCount() > 0) {
        try {
          const target = await resolveHookTarget(sessionId, cwd);
          if (target) {
            deliveredToGlasses = postHookRelay({
              sessionId: target.sessionId,
              paneId: target.paneId,
              text: message || HOOK_RELAY_TEXT[event] || `Hook: ${event}`,
            });
          }
        } catch (err) {
          console.warn('[notify] glasses relay failed:', err);
        }
      }
      const hookMsg = {
        type: 'hook-event',
        event,
        cwd,
        sessionId,
        message,
        data: Object.keys(rest).length > 0 ? rest : undefined,
        ...(deliveredToGlasses ? { deliveredToGlasses: true } : {}),
      };
      broadcastToMuxClients(hookMsg);
    }

    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }
});

/** Check if cchub notify is configured in ~/.claude or ~/.codex hooks */
notify.get('/hook-status', async (c) => {
  try {
    const status = await getHookStatus();
    return c.json(status);
  } catch {
    // settings / config files don't exist or are invalid
    return c.json({
      configured: false,
      events: { stop: false, askUserQuestion: false },
      missing: ['stop', 'askUserQuestion'],
      command: resolveNotifyCommand(),
    });
  }
});

export { notify };
