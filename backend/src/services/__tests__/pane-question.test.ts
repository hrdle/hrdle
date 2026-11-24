import { describe, expect, test } from 'bun:test';
import {
  type AnswerStep,
  executeAnswer,
  type PaneQuestionRead,
  type PaneSnapshot,
  planAnswer,
  publicRead,
  readStructuredQuestion,
  splitKeystrokes,
} from '../pane-question';
import type { QuestionsRead } from '../agent-question';

const DOWN = '\x1b[B';

/** Claude Code's single-pick picker, as the reader tests capture it. */
const SINGLE = [
  '● 保存済みの認証情報はありません。パスワードの渡し方を選んでください。',
  '────────────────────────────────────────────────────────────────',
  ' ☐ 認証情報 ',
  '',
  'ルータ管理画面（admin）のパスワードをどう渡しますか？',
  '',
  ' 1. vaultに自分で保存（推奨）',
  '    自分で vault に書き込み、名前だけ伝えます。',
  ' 2. チャットで直接教える',
  '❯ 3. ルータ操作は中止',
  ' 4. Type something.',
  '',
  '────────────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

/** A multi-select as Claude Code 2.1.228 draws one, captured live. */
const MULTI = [
  '────────────────────────────────────────────────────────',
  '←  ☐ 機能選択  ✔ Submit  →',
  '',
  '有効にする機能をすべて選んでください',
  '',
  '❯ 1. [ ] 認証機能',
  '  メールとパスワードによるログインとセッション管理を実装します。',
  '  2. [✔] 通知',
  '  メールとアプリ内通知の両方に対応します。',
  '  3. [ ] ダークモード',
  '  4. [ ] 多言語対応',
  '  5. [ ] Type something',
  '     Submit',
  '────────────────────────────────────────────────────────',
  '  6. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

/** The same list once the walk to `Type something` has put the cursor on it. */
const MULTI_ON_FIELD = MULTI.replace('❯ 1. [ ] 認証機能', '  1. [ ] 認証機能').replace(
  '  5. [ ] Type something',
  '❯ 5. [ ] Type something',
);

const noRecord = { readAgentQuestions: async (): Promise<QuestionsRead> => ({ known: true }) };

function claude(text: string, agentStatus = 'blocked'): PaneSnapshot {
  return { agent: 'claude', agentSessionId: 's1', agentStatus, text };
}

async function read(snapshot: PaneSnapshot, deps = noRecord): Promise<PaneQuestionRead> {
  return readStructuredQuestion(snapshot, deps);
}

function question(r: PaneQuestionRead) {
  if (r.status !== 'question') throw new Error(`expected a question, got ${r.status}`);
  return r;
}

describe('reading the question', () => {
  test('a claude single-select is read off its frame, whole', async () => {
    const r = question(await read(claude(SINGLE)));
    expect(r.question.source).toBe('screen');
    expect(r.question.question).toBe('ルータ管理画面（admin）のパスワードをどう渡しますか？');
    expect(r.question.multiSelect).toBe(false);
    expect(r.question.options[0]).toMatchObject({
      index: 0,
      label: 'vaultに自分で保存（推奨）',
      description: '自分で vault に書き込み、名前だけ伝えます。',
    });
    expect(r.question.options.find((o) => o.label.startsWith('Type something'))?.freeText).toBe(true);
  });

  test('a multi-select reports each box as the pane has it, without the box in the label', async () => {
    const r = question(await read(claude(MULTI)));
    expect(r.question.multiSelect).toBe(true);
    expect(r.question.options.slice(0, 3).map((o) => [o.label, o.checked])).toEqual([
      ['認証機能', false],
      ['通知', true],
      ['ダークモード', false],
    ]);
  });

  test('ticking a box does not change the question id', async () => {
    const before = question(await read(claude(MULTI)));
    const after = question(await read(claude(MULTI.replace('1. [ ] 認証機能', '1. [✔] 認証機能'))));
    expect(after.question.questionId).toBe(before.question.questionId);
  });

  test('a different question has a different id', async () => {
    const a = question(await read(claude(MULTI)));
    const b = question(await read(claude(MULTI.replace('ダークモード', 'ライトモード'))));
    expect(b.question.questionId).not.toBe(a.question.questionId);
  });

  test('a claude pane with no picker is not a question, whatever herdr says', async () => {
    expect((await read(claude('Do you want to proceed?\n❯ 1. Yes\n  2. No'))).status).toBe('none');
    expect((await read(claude('● done.', 'done'))).status).toBe('not-blocked');
  });

  test('kimi is read from its record and numbered in call order', async () => {
    const deps = {
      readAgentQuestions: async (): Promise<QuestionsRead> => ({
        known: true,
        questions: [
          {
            question: 'Which one?',
            options: [{ label: 'A', description: 'first' }, { label: 'B' }],
            multiSelect: false,
            ambiguous: false,
          },
        ],
      }),
    };
    const r = question(
      await read({ agent: 'kimi', agentSessionId: 'k1', agentStatus: 'blocked', text: 'Which one?' }, deps),
    );
    expect(r.question.source).toBe('record');
    expect(r.question.options).toEqual([
      { index: 0, label: 'A', description: 'first' },
      { index: 1, label: 'B' },
    ]);
    expect(r.keys.keys).toEqual(['1', '2']);
  });

  test('a kimi call whose front tab the pane does not show is ambiguous', async () => {
    const q = (text: string) => ({ question: text, options: [{ label: 'x' }], multiSelect: false, ambiguous: true });
    const deps = {
      readAgentQuestions: async (): Promise<QuestionsRead> => ({ known: true, questions: [q('One?'), q('Two?')] }),
    };
    const r = await read({ agent: 'kimi', agentStatus: 'blocked', text: 'nothing here' }, deps);
    expect(r.status).toBe('ambiguous');
  });

  test('an agent without a structured reader is unsupported', async () => {
    const r = await read({ agent: 'codex', agentStatus: 'blocked', text: '1. Yes\n2. No' });
    expect(r).toEqual({ status: 'unsupported', agent: 'codex' });
  });

  test('the public read carries no keys', async () => {
    const r = publicRead(question(await read(claude(MULTI))));
    expect('keys' in r).toBe(false);
  });
});

describe('planning an answer', () => {
  test('a single-select is answered by its own key', async () => {
    const r = question(await read(claude(SINGLE)));
    const plan = planAnswer(r, { questionId: r.question.questionId, choices: [1] });
    expect(plan).toEqual({ ok: true, steps: [{ kind: 'keys', data: '2' }] });
  });

  test('a free-text row opens the field and the words go in as a prompt', async () => {
    const r = question(await read(claude(SINGLE)));
    const free = r.question.options.findIndex((o) => o.freeText);
    const plan = planAnswer(r, { questionId: r.question.questionId, choices: [free], text: 'ほかの方法で' });
    expect(plan).toEqual({
      ok: true,
      steps: [
        { kind: 'keys', data: String(free + 1) },
        { kind: 'prompt', data: 'ほかの方法で' },
      ],
    });
  });

  test('a stale question id is refused', async () => {
    const r = question(await read(claude(SINGLE)));
    const plan = planAnswer(r, { questionId: 'not-this-one', choices: [0] });
    expect(plan).toMatchObject({ ok: false, status: 409 });
  });

  test('nothing to answer is refused', () => {
    expect(planAnswer({ status: 'none' }, { questionId: 'x', choices: [0] })).toMatchObject({ ok: false, status: 409 });
  });

  test('bad choices and misplaced text are refused', async () => {
    const r = question(await read(claude(SINGLE)));
    const id = r.question.questionId;
    expect(planAnswer(r, { questionId: id, choices: [99] })).toMatchObject({ ok: false, status: 400 });
    expect(planAnswer(r, { questionId: id, choices: [0, 1] })).toMatchObject({ ok: false, status: 400 });
    expect(planAnswer(r, { questionId: id, choices: [0], text: 'why' })).toMatchObject({ ok: false, status: 400 });
    const free = r.question.options.findIndex((o) => o.freeText);
    expect(planAnswer(r, { questionId: id, choices: [free] })).toMatchObject({ ok: false, status: 400 });
  });

  test('a multi-select toggles only the boxes that differ, then submits', async () => {
    const r = question(await read(claude(MULTI)));
    // Wanted: 認証機能 and ダークモード. 通知 is ticked on the pane and is not wanted.
    const plan = planAnswer(r, { questionId: r.question.questionId, choices: [0, 2] });
    expect(plan).toEqual({
      ok: true,
      steps: [
        { kind: 'keys', data: '1' },
        { kind: 'keys', data: '2' },
        { kind: 'keys', data: '3' },
        { kind: 'send' },
      ],
    });
  });

  test('a field is walked to and typed into without an Enter', async () => {
    const r = question(await read(claude(MULTI)));
    const field = r.question.options.findIndex((o) => o.label === 'Type something');
    const plan = planAnswer(r, { questionId: r.question.questionId, choices: [1, field], text: '音声入力' });
    expect(plan).toEqual({
      ok: true,
      steps: [
        { kind: 'keys', data: DOWN.repeat(4) },
        { kind: 'type', data: '音声入力' },
        { kind: 'send' },
      ],
    });
  });

  test('an option without a box leaves the list and must be chosen alone', async () => {
    const r = question(await read(claude(MULTI)));
    const chat = r.question.options.findIndex((o) => o.label === 'Chat about this');
    expect(chat).toBeGreaterThanOrEqual(0);
    expect(planAnswer(r, { questionId: r.question.questionId, choices: [0, chat] })).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe('carrying the answer out', () => {
  test('keys go one per write, and the Submit walk is measured after the field', async () => {
    const written: string[] = [];
    const steps: AnswerStep[] = [
      { kind: 'keys', data: DOWN.repeat(4) },
      { kind: 'type', data: '音声入力' },
      { kind: 'send' },
    ];
    const result = await executeAnswer(steps, {
      write: async (d) => {
        written.push(d);
      },
      sleep: async () => {},
      reread: () => readStructuredQuestion(claude(MULTI_ON_FIELD), noRecord),
    });
    expect(result).toEqual({ ok: true });
    // Four single arrows, the words in one piece, then the walk from row 5 to
    // Submit - one row down - and Enter.
    expect(written).toEqual([DOWN, DOWN, DOWN, DOWN, '音声入力', DOWN, '\r']);
  });

  test('a prompt is a bracketed paste and a separate Enter', async () => {
    const written: string[] = [];
    await executeAnswer([{ kind: 'prompt', data: 'hello' }], {
      write: async (d) => {
        written.push(d);
      },
      sleep: async () => {},
      reread: async () => ({ status: 'none' }),
    });
    expect(written).toEqual(['\x1b[200~hello\x1b[201~', '\r']);
  });

  test('no Submit button after the field is a failure, not a guess', async () => {
    const result = await executeAnswer([{ kind: 'send' }], {
      write: async () => {},
      sleep: async () => {},
      reread: async () => ({ status: 'none' }),
    });
    expect(result.ok).toBe(false);
  });

  test('escape sequences stay whole when split', () => {
    expect(splitKeystrokes(`1${DOWN}\r`)).toEqual(['1', DOWN, '\r']);
  });
});

describe('a claude permission prompt', () => {
  const bash = (command: string, cursorRow = 1) =>
    [
      '─'.repeat(60),
      ' Bash command',
      ` ${command}`,
      ' Do you want to proceed?',
      `${cursorRow === 1 ? ' ❯' : '  '} 1. Yes`,
      `${cursorRow === 2 ? ' ❯' : '  '} 2. Yes, and switch to auto mode · auto mode handles these prompts for you`,
      `${cursorRow === 3 ? ' ❯' : '  '} 3. No`,
      '',
      ' Esc to cancel · Tab to amend',
    ].join('\n');

  test('is read as a permission, with No open to an instruction', async () => {
    const r = question(await read(claude(bash('touch a.txt'))));
    expect(r.question.kind).toBe('permission');
    expect(r.question.title).toBe('Bash command');
    expect(r.question.detail).toBe('touch a.txt');
    expect(r.question.options[2]).toEqual({ index: 2, label: 'No', freeText: true, textOptional: true });
  });

  test('two commands asking the same question have different ids', async () => {
    const a = question(await read(claude(bash('touch a.txt'))));
    const b = question(await read(claude(bash('rm -rf b'))));
    expect(a.question.questionId).not.toBe(b.question.questionId);
  });

  test('a row is answered by its digit, No included when nothing is written', async () => {
    const r = question(await read(claude(bash('touch a.txt'))));
    expect(planAnswer(r, { questionId: r.question.questionId, choices: [0] })).toEqual({
      ok: true,
      steps: [{ kind: 'keys', data: '1' }],
    });
    expect(planAnswer(r, { questionId: r.question.questionId, choices: [2] })).toEqual({
      ok: true,
      steps: [{ kind: 'keys', data: '3' }],
    });
  });

  test('No with words walks from the pane cursor, amends, and sends them', async () => {
    const r = question(await read(claude(bash('touch a.txt', 2))));
    expect(planAnswer(r, { questionId: r.question.questionId, choices: [2], text: 'use echo' })).toEqual({
      ok: true,
      steps: [
        { kind: 'keys', data: `${DOWN}\t` },
        { kind: 'prompt', data: 'use echo' },
      ],
    });
  });

  test('words on any other row are refused', async () => {
    const r = question(await read(claude(bash('touch a.txt'))));
    const plan = planAnswer(r, { questionId: r.question.questionId, choices: [0], text: 'why' });
    expect(plan.ok).toBe(false);
  });
});
