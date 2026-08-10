import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openClaudeQuestion,
  openClaudeQuestions,
  openKimiQuestion,
  openKimiQuestions,
  readAgentQuestion,
  readAgentQuestions,
} from '../agent-question';
import { KimiSessionStore } from '../kimi';

/**
 * A question read from the agent's own record instead of off the screen.
 *
 * The screen reader guesses, and on 2026-08-08 it guessed wrong twice: it
 * offered a kimi question's tab bar as that question's answer, and then - on a
 * Claude pane that was not asking anything at all - a `Read` result that
 * happened to hold a line number and a line of code on one row, as
 * `1039 / const pane = state.selectedPaneId`.
 *
 * Both agents write the question down, in the same shape, in files hrdle
 * already reads.
 */

const SESSION = '20da1aaa-f092-4ea8-b13e-9c174a916abf';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The `AskUserQuestion` call as Claude records it, verbatim in shape. */
const CLAUDE_QUESTION = {
  question: '頭脳にする Android 端末はどれにしますか?',
  header: '頭脳の端末',
  multiSelect: false,
  options: [
    { label: 'Pixel 7a(到着待ちの端末)', description: 'カスタムROM用に買った端末を転用' },
    { label: '別の余っている端末', description: '手持ちの古い Android を使う' },
  ],
};

function claudeTranscript(sessionId: string, lines: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-home-'));
  dirs.push(root);
  const projects = join(root, 'projects');
  const project = join(projects, '-home-dev-thing');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  // The locator takes the *projects* directory, and only accepts a session id
  // shaped like the UUID Claude actually writes.
  return projects;
}

const askEntry = (id: string, questions: unknown[]) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] },
});

const resultEntry = (id: string) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Pixel 7a' }] },
});

describe('claude', () => {
  test('an unanswered AskUserQuestion comes back with its descriptions', async () => {
    const home = claudeTranscript(SESSION, [askEntry('toolu_1', [CLAUDE_QUESTION])]);
    const q = await openClaudeQuestion(SESSION, home);
    expect(q).toEqual({
      question: '頭脳にする Android 端末はどれにしますか?',
      options: [
        { label: 'Pixel 7a(到着待ちの端末)', description: 'カスタムROM用に買った端末を転用' },
        { label: '別の余っている端末', description: '手持ちの古い Android を使う' },
      ],
      multiSelect: false,
      ambiguous: false,
    });
  });

  test('an answered one is not a question any more', async () => {
    const home = claudeTranscript(SESSION, [askEntry('toolu_1', [CLAUDE_QUESTION]), resultEntry('toolu_1')]);
    expect(await openClaudeQuestion(SESSION, home)).toBeUndefined();
  });

  test('the newest unanswered call wins over an older answered one', async () => {
    const second = { ...CLAUDE_QUESTION, question: '接続方式はどうしますか?' };
    const home = claudeTranscript(SESSION, [
      askEntry('toolu_1', [CLAUDE_QUESTION]),
      resultEntry('toolu_1'),
      askEntry('toolu_2', [second]),
    ]);
    expect((await openClaudeQuestion(SESSION, home))?.question).toBe('接続方式はどうしますか?');
  });

  test('a call carrying several questions says so', async () => {
    // The pane draws a tab per question and answers whichever is in front,
    // and which one that is exists only on the screen.
    const home = claudeTranscript(SESSION, [askEntry('toolu_1', [CLAUDE_QUESTION, { ...CLAUDE_QUESTION, question: '2つめ' }])]);
    expect((await openClaudeQuestion(SESSION, home))?.ambiguous).toBe(true);
  });

  test('the plural read keeps every question of the call, in call order', async () => {
    const home = claudeTranscript(SESSION, [askEntry('toolu_1', [CLAUDE_QUESTION, { ...CLAUDE_QUESTION, question: '2つめ' }])]);
    const all = await openClaudeQuestions(SESSION, home);
    expect(all?.map((q) => q.question)).toEqual(['頭脳にする Android 端末はどれにしますか?', '2つめ']);
    expect(all?.every((q) => q.ambiguous)).toBe(true);
  });

  test('a pane that never asked has no question', async () => {
    const home = claudeTranscript(SESSION, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: '1039\tconst pane = state.selectedPaneId' }] } },
    ]);
    // The row that was offered to a wearer as a menu. Nothing here is one.
    expect(await openClaudeQuestion(SESSION, home)).toBeUndefined();
  });
});

/** A kimi sessions root with one session holding `wire`. */
function kimiSessions(sessionId: string, wire: unknown[]): KimiSessionStore {
  const root = mkdtempSync(join(tmpdir(), 'kimi-sessions-'));
  dirs.push(root);
  const dir = join(root, 'wd_thing_1111', sessionId);
  mkdirSync(join(dir, 'agents', 'main'), { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ cwd: '/home/dev/thing', updatedAt: 1786134737147 }));
  writeFileSync(join(dir, 'agents', 'main', 'wire.jsonl'), wire.map((l) => JSON.stringify(l)).join('\n'));
  return new KimiSessionStore(root);
}

const KIMI_QUESTION = {
  question: 'intro.lead(冒頭リード文)をどの案に差し替えますか?',
  header: 'intro.lead',
  options: [
    { label: '案A (Recommended)', description: '現行の動詞列の構成を活かしつつ「スマホやG2から」を明示' },
    { label: '案B', description: '最短。操作できることを先に言い切る' },
    { label: '案C', description: '「ふつうはPCの中」→「手元に持ってくる」の対比で始める' },
  ],
};

describe('kimi', () => {
  test('an unresolved question comes back with its descriptions', async () => {
    const store = kimiSessions('session_1', [
      { type: 'interaction.request', id: 'AskUserQuestion_17', kind: 'question', request: { questions: [KIMI_QUESTION] } },
    ]);
    const q = await openKimiQuestion('session_1', store);
    expect(q?.question).toBe('intro.lead(冒頭リード文)をどの案に差し替えますか?');
    expect(q?.options.map((o) => o.label)).toEqual(['案A (Recommended)', '案B', '案C']);
    // The words that were missing on the G2: three labels naming nothing.
    expect(q?.options[1].description).toBe('最短。操作できることを先に言い切る');
  });

  test('a resolved one is gone', async () => {
    const store = kimiSessions('session_1', [
      { type: 'interaction.request', id: 'AskUserQuestion_17', kind: 'question', request: { questions: [KIMI_QUESTION] } },
      { type: 'interaction.resolved', id: 'AskUserQuestion_17', response: {} },
    ]);
    expect(await openKimiQuestion('session_1', store)).toBeUndefined();
  });

  test('an approval prompt is not read as a question', async () => {
    // kimi's permission prompt is `kind: "approval"`. It is a real thing to
    // answer, but it is not in this shape and the screen still owns it.
    const store = kimiSessions('session_1', [
      { type: 'interaction.request', id: 'Bash_4', kind: 'approval', request: { toolName: 'Bash', action: 'Running: ls' } },
    ]);
    expect(await openKimiQuestion('session_1', store)).toBeUndefined();
  });

  test('the plural read keeps every question of the call', async () => {
    const store = kimiSessions('session_1', [
      { type: 'interaction.request', id: 'q', kind: 'question', request: { questions: [KIMI_QUESTION, { ...KIMI_QUESTION, question: '2つめ' }] } },
    ]);
    const all = await openKimiQuestions('session_1', store);
    expect(all?.map((q) => q.question)).toEqual(['intro.lead(冒頭リード文)をどの案に差し替えますか?', '2つめ']);
  });
});

describe('whether the agent can be asked at all', () => {
  test('an agent that keeps no readable record says so', async () => {
    // codex, grok and opencode write nothing of this shape. The screen is
    // still the only source for them, and a caller must not read the absence
    // of a question as "nothing is being asked".
    expect(await readAgentQuestion('codex', 'whatever')).toEqual({ known: false });
    expect(await readAgentQuestion('opencode', 'whatever')).toEqual({ known: false });
  });

  test('no session id is not an answer either', async () => {
    expect(await readAgentQuestion('claude', undefined)).toEqual({ known: false });
  });

  test('the plural read answers the same way', async () => {
    expect(await readAgentQuestions('codex', 'whatever')).toEqual({ known: false });
    expect(await readAgentQuestions('claude', undefined)).toEqual({ known: false });
  });
});
