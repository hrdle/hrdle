/**
 * `/api/steward/*` - what the steward writes and the screens read.
 *
 * Authenticated, unlike the relay's local-trust endpoint: this surface can
 * rewrite history and answer questions on someone's behalf. `hrdle steward`
 * signs its own token rather than being given a hole.
 *
 * Every route 404s with the gate off. `/enabled` is the exception, and it is
 * what the CLI asks after a 404 so it can tell "switched off" apart from a
 * server too old to have any of this.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getLastGlassesScreen, broadcastSteward } from './terminal-mux';
import { getStewardSettings, isStewardEnabled, setStewardSettings } from '../services/steward-config';
import { observerStatus, wakeObserverWith } from '../services/steward-runtime';
import {
  answerAsk,
  findAsk,
  appendSessionTurns,
  appendThreadItem,
  getLines,
  getSessionTurns,
  getThread,
  setLine,
} from '../services/steward-store';
import { fitToPage } from '../services/steward-text';
import type { StewardThreadItem, StewardTurn } from '../../../shared/types';

// Same alphabet as SessionIdSchema.
const SessionId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);

/** Not the page budget: `fitToPage` moves what overruns it into `detail`, so
 *  these only stop a runaway writer filling the disk. */
const TEXT_MAX = 4000;
const DETAIL_MAX = 20_000;

const RefsSchema = z.object({
  file: z.string().max(1000).optional(),
  line: z.number().int().min(0).max(10_000_000).optional(),
  url: z.string().max(2000).optional(),
});

const SourceSchema = z.object({
  agentSessionId: z.string().min(1).max(200),
  messageIds: z.array(z.string().min(1).max(200)).max(200).optional(),
});

const TurnSchema = z.object({
  id: z.string().min(1).max(200),
  at: z.number().optional(),
  role: z.enum(['agent', 'user', 'steward']),
  text: z.string().max(TEXT_MAX),
  detail: z.string().max(DETAIL_MAX).optional(),
  refs: RefsSchema.optional(),
  source: SourceSchema.optional(),
});

const AskAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), indices: z.array(z.number().int().min(0).max(64)).min(1).max(64) }),
  z.object({ kind: z.literal('text'), text: z.string().max(TEXT_MAX) }),
  z.object({ kind: z.literal('dismissed') }),
]);

const ThreadPostSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('notify'),
    text: z.string().min(1).max(TEXT_MAX),
    detail: z.string().max(DETAIL_MAX).optional(),
    refs: RefsSchema.optional(),
    source: SourceSchema.optional(),
  }),
  z.object({
    kind: z.literal('ask'),
    text: z.string().min(1).max(TEXT_MAX),
    detail: z.string().max(DETAIL_MAX).optional(),
    refs: RefsSchema.optional(),
    source: SourceSchema.optional(),
    mode: z.enum(['single', 'multi', 'freeText']).default('single'),
    // A free-text question legitimately offers nothing to pick from.
    choices: z.array(z.string().min(1).max(200)).max(9).default([]),
    step: z.object({ index: z.number().int().min(1).max(99), total: z.number().int().min(1).max(99) }).optional(),
  }),
  z.object({
    kind: z.literal('report'),
    text: z.string().min(1).max(TEXT_MAX),
    rows: z.array(z.string().max(TEXT_MAX)).max(100),
    detail: z.string().max(DETAIL_MAX).optional(),
    refs: RefsSchema.optional(),
  }),
]);

/** Without an `askId` this is an unprompted instruction, which is equally
 *  allowed - the thread is a conversation, not a form. */
const ReplySchema = z.object({
  askId: z.string().min(1).max(200).optional(),
  answer: AskAnswerSchema.optional(),
  text: z.string().max(TEXT_MAX).optional(),
});

const steward = new Hono();

/** Always answers, gate or no gate. See the file comment. */
steward.get('/enabled', async (c) => {
  const enabled = isStewardEnabled();
  if (!enabled) return c.json({ enabled: false });
  return c.json({ enabled: true, settings: await getStewardSettings() });
});

steward.use('*', async (c, next) => {
  if (!isStewardEnabled()) return c.json({ error: 'steward is not enabled' }, 404);
  return next();
});

steward.get('/', async (c) => {
  const [thread, lines] = await Promise.all([getThread(), getLines()]);
  return c.json({ thread, lines });
});

/**
 * Which model each half runs. Read through `/enabled`; written here.
 *
 * `appliesWhen` is in the response because a running observer keeps the model
 * it was started with - the supervisor only starts one when none is there - so
 * a settings screen would otherwise look broken.
 */
steward.put('/settings', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      observerModel: z.string().min(1).max(100).optional(),
      workerModel: z.string().min(1).max(100).optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid settings', detail: parsed.error.issues }, 400);
  return c.json({ settings: await setStewardSettings(parsed.data), appliesWhen: 'the observer next starts' });
});

steward.post('/thread', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ThreadPostSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid thread item', detail: parsed.error.issues }, 400);
  const input = parsed.data;

  const fitted = fitToPage(input.text, input.detail);
  const base = {
    role: 'steward' as const,
    text: fitted.text,
    detail: fitted.detail,
    refs: input.refs,
  };

  let item: StewardThreadItem;
  if (input.kind === 'ask') {
    // The ask's id IS the thread item's id: one question is one entry, and two
    // identifiers for it would only ever be a way for them to disagree.
    const id = crypto.randomUUID();
    item = await appendThreadItem({
      ...base,
      id,
      source: input.source,
      kind: 'ask',
      ask: { id, mode: input.mode, choices: input.choices, step: input.step },
    });
  } else if (input.kind === 'report') {
    item = await appendThreadItem({ ...base, kind: 'report', rows: input.rows });
  } else {
    item = await appendThreadItem({ ...base, source: input.source, kind: 'notify' });
  }

  broadcastSteward({ type: 'steward-thread', item });
  return c.json({
    item,
    askId: item.kind === 'ask' ? item.ask.id : undefined,
    ...(fitted.spilled ? { fitted: 'text was longer than one page; the rest moved into detail' } : {}),
  });
});

steward.post('/thread/reply', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ReplySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid reply', detail: parsed.error.issues }, 400);
  const { askId, answer, text } = parsed.data;

  if (askId && !answer) return c.json({ error: 'answer is required when askId is given' }, 400);
  // An answer with nothing to answer is a caller bug, and accepting it would
  // record the reply while silently dropping the choice it carried.
  if (!askId && answer) return c.json({ error: 'askId is required when an answer is given' }, 400);
  if (!askId && !text) return c.json({ error: 'text is required when there is no askId' }, 400);

  let updatedAsk: StewardThreadItem | null = null;
  if (askId && answer) {
    const target = await findAsk(askId);
    if (target?.kind !== 'ask') return c.json({ error: 'no such ask' }, 404);

    // Checked against the question itself, not just its own shape. The steward
    // reads `ask.answer` as the record of what was decided, so an index nobody
    // was offered becomes a decision nobody made.
    if (answer.kind === 'choice') {
      const { choices, mode } = target.ask;
      const outOfRange = answer.indices.filter((i) => i >= choices.length);
      if (outOfRange.length > 0) {
        return c.json({ error: `no such choice: ${outOfRange.join(', ')}` }, 400);
      }
      if (mode === 'single' && answer.indices.length > 1) {
        return c.json({ error: 'this question takes one answer' }, 400);
      }
      if (mode === 'freeText') {
        return c.json({ error: 'this question takes text, not a choice' }, 400);
      }
    }

    updatedAsk = await answerAsk(askId, answer);
    if (!updatedAsk) return c.json({ error: 'no such ask' }, 404);
    broadcastSteward({ type: 'steward-thread', item: updatedAsk });
  }

  // Its own entry even when it answered a question: the ask holds the
  // machine-readable answer, the thread has to read back as a conversation.
  const replyText = text ?? answerAsText(answer, updatedAsk);
  const item = await appendThreadItem({ kind: 'reply', askId, role: 'user', text: replyText });
  broadcastSteward({ type: 'steward-thread', item });

  // No pane moves when a person answers, so the status watcher cannot see this.
  // The wake-up carries the answer rather than announcing that one exists:
  // waking and delivering are the same act, so there is nothing to poll.
  wakeObserverWith(
    askId
      ? `The owner answered ask ${askId}: ${replyText}`
      : `The owner said: ${replyText}`,
  );

  return c.json({ item, ask: updatedAsk });
});

steward.put('/sessions/:id/line', async (c) => {
  const id = SessionId.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'invalid session id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ text: z.string().max(TEXT_MAX) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'text is required' }, 400);

  const line = await setLine(id.data, parsed.data.text);
  broadcastSteward({ type: 'steward-line', line });
  return c.json({ line });
});

steward.get('/sessions/:id/turns', async (c) => {
  const id = SessionId.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'invalid session id' }, 400);
  return c.json({ turns: await getSessionTurns(id.data) });
});

/**
 * Ask for a session the steward has not written yet.
 *
 * A screen opening a session it has no summary for must get one, not the raw
 * transcript: falling back means that session is never steward-backed, and
 * `update_session` writes differences, so the first write is all it takes to
 * catch up. Writing every session all the time is what this avoids - the
 * steward writes when a session is read, and when its state moves.
 */
steward.post('/sessions/:id/summarise', async (c) => {
  const id = SessionId.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'invalid session id' }, 400);

  const existing = await getSessionTurns(id.data);
  // Already written: nothing to ask for, and asking anyway would wake the
  // observer every time somebody opened a session.
  if (existing.length > 0) return c.json({ turns: existing, asked: false });

  wakeObserverWith(
    `The owner opened session ${id.data} and it has no history written yet. ` +
      'Read it and write its turns with `steward turns`, newest work first. ' +
      'Answer nothing in the thread for this - the session screen is where it goes.',
  );
  return c.json({ turns: [], asked: true });
});

steward.post('/sessions/:id/turns', async (c) => {
  const id = SessionId.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'invalid session id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ turns: z.array(TurnSchema).min(1).max(50) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid turns', detail: parsed.error.issues }, 400);

  const now = Date.now();
  let spilled = 0;
  const turns: StewardTurn[] = parsed.data.turns.map((t) => {
    const fitted = fitToPage(t.text, t.detail);
    if (fitted.spilled) spilled++;
    return { ...t, text: fitted.text, detail: fitted.detail, at: t.at ?? now };
  });
  const stored = await appendSessionTurns(id.data, turns);
  broadcastSteward({ type: 'steward-turns', sessionId: id.data, turns: stored });
  return c.json({
    turns: stored,
    ...(spilled ? { fitted: `${spilled} turn(s) ran past one page; the rest moved into detail` } : {}),
  });
});

steward.get('/screen', (c) => c.json({ screen: getLastGlassesScreen() }));

/** Whether the steward is thinking. Polled by a screen that has just spoken. */
steward.get('/observer', async (c) => c.json(await observerStatus()));

/** What a person's answer says, in the words the thread is read in. */
function answerAsText(
  answer: { kind: 'choice'; indices: number[] } | { kind: 'text'; text: string } | { kind: 'dismissed' } | undefined,
  ask: StewardThreadItem | null,
): string {
  if (!answer) return '';
  if (answer.kind === 'text') return answer.text;
  if (answer.kind === 'dismissed') return 'dismissed';
  const choices = ask?.kind === 'ask' ? ask.ask.choices : [];
  return answer.indices.map((i) => choices[i] ?? `#${i}`).join(', ');
}

export { steward };
