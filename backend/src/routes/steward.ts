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

/**
 * A pane, as herdr writes it (`%6`).
 *
 * It names which history inside a workspace is meant. A workspace running one
 * agent names none and keeps the workspace's own, which is what every
 * workspace did before this; one running several has a history per pane,
 * because two agents in one workspace are two pieces of work and a single
 * history of both reads as one conversation that keeps changing the subject.
 *
 * A query parameter, never a path segment: `%` in a path is an escape, and a
 * pane id round-tripping through one is a bug nobody should have to think
 * about twice.
 */
const PaneId = z.string().regex(/^%\d{1,6}$/);

/** The pane named on the request, or nothing. Rejects a malformed one rather
 *  than quietly writing the workspace's own history instead. */
function paneOf(raw: string | undefined): { ok: true; paneId?: string } | { ok: false } {
  if (raw === undefined || raw === '') return { ok: true };
  const parsed = PaneId.safeParse(raw);
  return parsed.success ? { ok: true, paneId: parsed.data } : { ok: false };
}

/**
 * The ceiling on one entry, which is not the page budget.
 *
 * `fitToPage` holds `text` to the glasses' one page by *moving* the overrun
 * into `detail`, so the message still lands - and that is the right answer for
 * length: refusing it would trade "too long" for "nothing arrived", and silence
 * is this system's worst failure. These are the other thing: a stop on a writer
 * that has run away.
 *
 * A guard that cannot fire is not a guard. `DETAIL_MAX` was 20,000, which is
 * nine times anything ever written - measured across 391 stored entries, the
 * largest detail was 2,198 - so it was a disk limit wearing a guard's name.
 * 4,000 sits about twice real use: a long answer with a diff in it still goes
 * through, and a report pasted into a chat message does not.
 *
 * **It does not fix an ordinary over-long message, and is not meant to.** Every
 * detail measured was under 2,200, and a `detail` is behind a tap anyway, so
 * its length costs a reader nothing until they ask for it. This is only the
 * case where the writer has stopped making sense.
 */
const TEXT_MAX = 4000;
const DETAIL_MAX = 4000;

/**
 * A refusal the caller can act on.
 *
 * Zod's own issue list gives the number and no remedy, and the caller here is
 * an agent reading stdout: it retries against whatever the message suggests, so
 * a message that suggests nothing buys a retry of the same thing. Named the way
 * `stt-prompt` names its own refusals, which is the pattern this repository
 * already settled on - say what was refused, how far over it was, and what to
 * do instead.
 */
function tooBig(issues: { code: string; path: PropertyKey[]; maximum?: unknown }[], body: unknown): string | null {
  const over = issues.find(
    (i) => i.code === 'too_big' && (i.path[0] === 'text' || i.path[0] === 'detail'),
  );
  if (!over) return null;
  const field = String(over.path[0]);
  const sent = (body as Record<string, string> | null)?.[field]?.length ?? 0;
  const limit = Number(over.maximum);
  return field === 'detail'
    ? `detail is ${sent} characters against a ceiling of ${limit}. Nothing was written. ` +
        'That ceiling stops a runaway, so being near it means this is a report: ' +
        'put it in `steward report` or in a file you point at.'
    : `text is ${sent} characters against a ceiling of ${limit}. Nothing was written. ` +
        'One page reaches the glasses and the rest moves into detail on its own, so a long ' +
        'text buys no room - say the one thing the decision turns on.';
}

const RefsSchema = z.object({
  file: z.string().max(1000).optional(),
  line: z.number().int().min(0).max(10_000_000).optional(),
  url: z.string().max(2000).optional(),
});

const SourceSchema = z.object({
  agentSessionId: z.string().min(1).max(200),
  messageIds: z.array(z.string().min(1).max(200)).max(200).optional(),
});

const ImagesSchema = z.array(z.string().min(1).max(1000)).max(10);

const TurnSchema = z.object({
  id: z.string().min(1).max(200),
  at: z.number().optional(),
  role: z.enum(['agent', 'user', 'steward']),
  text: z.string().max(TEXT_MAX),
  detail: z.string().max(DETAIL_MAX).optional(),
  images: ImagesSchema.optional(),
  refs: RefsSchema.optional(),
  source: SourceSchema.optional(),
});

const AskAnswerSchema = z.discriminatedUnion('kind', [
  // No minimum. A multi-select's answer can genuinely be the empty set - which
  // is why it has a Send row at all, a tap being a toggle there rather than a
  // decision - and refusing it here made "none of these" the one answer the
  // glasses could not give. `single` is still held to exactly one, below.
  z.object({ kind: z.literal('choice'), indices: z.array(z.number().int().min(0).max(64)).max(64) }),
  z.object({ kind: z.literal('text'), text: z.string().max(TEXT_MAX) }),
  z.object({ kind: z.literal('dismissed') }),
]);

const ThreadPostSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('notify'),
    text: z.string().min(1).max(TEXT_MAX),
    detail: z.string().max(DETAIL_MAX).optional(),
    images: ImagesSchema.optional(),
    refs: RefsSchema.optional(),
    source: SourceSchema.optional(),
    sessionId: SessionId.optional(),
    paneId: PaneId.optional(),
  }),
  z.object({
    kind: z.literal('ask'),
    text: z.string().min(1).max(TEXT_MAX),
    detail: z.string().max(DETAIL_MAX).optional(),
    refs: RefsSchema.optional(),
    source: SourceSchema.optional(),
    sessionId: SessionId.optional(),
    paneId: PaneId.optional(),
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
    // A report crosses sessions by definition, so it carries none.
  }),
]);

/** Without an `askId` this is an unprompted instruction, which is equally
 *  allowed - the thread is a conversation, not a form. */
const ReplySchema = z.object({
  askId: z.string().min(1).max(200).optional(),
  answer: AskAnswerSchema.optional(),
  text: z.string().max(TEXT_MAX).optional(),
  images: ImagesSchema.optional(),
  /** Set when it was written from a session's own screen. */
  sessionId: SessionId.optional(),
  /** And which pane of it, when that workspace runs more than one agent. A
   *  person's own words belong in the history they typed them into. */
  paneId: PaneId.optional(),
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
  if (!parsed.success) {
    const over = tooBig(parsed.error.issues, body);
    if (over) return c.json({ error: over }, 400);
    return c.json({ error: 'invalid thread item', detail: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const fitted = fitToPage(input.text, input.detail);
  const base = {
    role: 'steward' as const,
    text: fitted.text,
    detail: fitted.detail,
    images: input.kind === 'notify' ? input.images : undefined,
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
      sessionId: input.sessionId,
      paneId: input.paneId,
      kind: 'ask',
      ask: { id, mode: input.mode, choices: input.choices, step: input.step },
    });
  } else if (input.kind === 'report') {
    item = await appendThreadItem({ ...base, kind: 'report', rows: input.rows });
  } else {
    item = await appendThreadItem({
      ...base,
      source: input.source,
      sessionId: input.sessionId,
      paneId: input.paneId,
      kind: 'notify',
    });
  }

  broadcastSteward({ type: 'steward-thread', item });
  await mirrorToSession(item);
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
  const { askId, answer, text, images, sessionId, paneId } = parsed.data;

  if (askId && !answer) return c.json({ error: 'answer is required when askId is given' }, 400);
  // An answer with nothing to answer is a caller bug, and accepting it would
  // record the reply while silently dropping the choice it carried.
  if (!askId && answer) return c.json({ error: 'askId is required when an answer is given' }, 400);
  if (!askId && !text && !images?.length) {
    return c.json({ error: 'text is required when there is no askId' }, 400);
  }

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
      if (mode === 'single' && answer.indices.length !== 1) {
        return c.json({ error: 'this question takes one answer' }, 400);
      }
      if (mode === 'freeText') {
        return c.json({ error: 'this question takes text, not a choice' }, 400);
      }
    }

    updatedAsk = await answerAsk(askId, answer);
    if (!updatedAsk) return c.json({ error: 'no such ask' }, 404);
    broadcastSteward({ type: 'steward-thread', item: updatedAsk });
    // The question joins the history now that it has an answer, so the reply
    // below is not a word on its own.
    await mirrorToSession(updatedAsk);
  }

  // Its own entry even when it answered a question: the ask holds the
  // machine-readable answer, the thread has to read back as a conversation.
  const replyText = text ?? answerAsText(answer, updatedAsk);
  // A reply written from a session's screen belongs to that session even when
  // it answers an ask raised elsewhere - it is where the person was looking.
  const about = sessionId ?? (updatedAsk?.kind === 'ask' ? updatedAsk.sessionId : undefined);
  // The pane goes with the session it came from, so what a person says on a
  // pane's screen is in that pane's history rather than in a workspace-level
  // one nothing reads.
  const onPane = sessionId ? paneId : (updatedAsk?.kind === 'ask' ? updatedAsk.paneId : undefined);
  const item = await appendThreadItem({
    kind: 'reply',
    askId,
    role: 'user',
    text: replyText,
    images,
    sessionId: about,
    paneId: onPane,
  });
  broadcastSteward({ type: 'steward-thread', item });
  await mirrorToSession(item);

  // No pane moves when a person answers, so the status watcher cannot see this.
  // The wake-up carries the answer rather than announcing that one exists:
  // waking and delivering are the same act, so there is nothing to poll.
  const asked = updatedAsk?.kind === 'ask' ? updatedAsk.text : '';
  const said = answerWake({ askId, asked, replyText });
  // The paths, in the wake-up itself. They are on the entry either way, but a
  // wake-up that only says what was typed is all the observer reads - so an
  // attached screenshot reached nobody, and the relay to the agent was a
  // paraphrase of a picture it had never seen.
  const withImages = images?.length
    ? `${said}\nThey attached: ${images.join(', ')}. Pass the path itself on - an agent can open the file, and your description of an image you cannot see is not the report.`
    : said;
  const target = about && onPane ? `${about}:${onPane}` : about;
  wakeObserverWith(
    about
      ? `${withImages}\nThey were reading session ${target}, so this is about that session unless they say otherwise. ` +
          `Answer with \`steward notify --session ${target}\` so it reaches the screen they are on.`
      : withImages,
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
  const pane = paneOf(c.req.query('pane'));
  if (!pane.ok) return c.json({ error: 'invalid pane id' }, 400);
  return c.json({ turns: await getSessionTurns(id.data, pane.paneId), paneId: pane.paneId });
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
  const pane = paneOf(c.req.query('pane'));
  if (!pane.ok) return c.json({ error: 'invalid pane id' }, 400);

  const existing = await getSessionTurns(id.data, pane.paneId);
  // Already written: nothing to ask for, and asking anyway would wake the
  // observer every time somebody opened a session.
  if (existing.length > 0) return c.json({ turns: existing, asked: false });

  const target = pane.paneId ? `${id.data}:${pane.paneId}` : id.data;
  wakeObserverWith(
    `The owner opened session ${target} and it has no history written yet. ` +
      `Read it and write its turns with \`steward turns ${target}\`, newest work first. ` +
      (pane.paneId
        ? 'That workspace runs more than one agent, so its history is per pane: write only what ' +
          'this pane is doing, and address the others by their own pane ids. '
        : '') +
      'Answer nothing in the thread for this - the session screen is where it goes.',
  );
  return c.json({ turns: [], asked: true });
});

/**
 * What the owner said to a pane without going through the steward.
 *
 * The glasses have a direct-talk mode: one step down inside a session, where
 * speech reaches the agent as a prompt and the steward is not in the loop. It
 * still has to be in the record. Unwritten, the steward sees a pane change
 * state for a reason it cannot account for, and its next summary of that
 * session is written around a gap - which is the shape of every "the steward
 * is confidently wrong about this session" report.
 *
 * Not `/thread/reply`, though the store work is the same. That one wakes the
 * observer with "the owner said X" and the observer answers it; this one has
 * already been answered by the agent, and an observer replying to it would be
 * a second voice in a conversation it is not part of.
 */
steward.post('/sessions/:id/spoke', async (c) => {
  const id = SessionId.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'invalid session id' }, 400);
  const pane = paneOf(c.req.query('pane'));
  if (!pane.ok) return c.json({ error: 'invalid pane id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ text: z.string().min(1).max(TEXT_MAX) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'text is required' }, 400);

  const item = await appendThreadItem({
    kind: 'reply',
    role: 'user',
    text: parsed.data.text,
    sessionId: id.data,
    paneId: pane.paneId,
  });
  broadcastSteward({ type: 'steward-thread', item });
  await mirrorToSession(item);

  wakeObserverWith(
    `The owner spoke straight to session ${pane.paneId ? `${id.data}:${pane.paneId}` : id.data}, ` +
      `bypassing you: "${parsed.data.text}"\n` +
      'It went to the agent in that pane and the agent is answering it. Do not answer it yourself, ' +
      'and do not relay it onward. Take it as context for what that pane does next, so the state ' +
      'change you are about to see is one you can explain.',
  );

  return c.json({ item });
});

steward.post('/sessions/:id/turns', async (c) => {
  const id = SessionId.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'invalid session id' }, 400);
  const pane = paneOf(c.req.query('pane'));
  if (!pane.ok) return c.json({ error: 'invalid pane id' }, 400);
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
  const stored = await appendSessionTurns(id.data, turns, pane.paneId);
  broadcastSteward({ type: 'steward-turns', sessionId: id.data, paneId: pane.paneId, turns: stored });
  return c.json({
    turns: stored,
    paneId: pane.paneId,
    ...(spilled ? { fitted: `${spilled} turn(s) ran past one page; the rest moved into detail` } : {}),
  });
});

/**
 * Questions still waiting, newest last.
 *
 * Its own endpoint rather than a filter over `GET /`: the screen that needs it
 * most is a session's chat, which has no reason to hold the whole thread, and
 * a question is the one thing there that a person has to act on.
 */
steward.get('/asks', async (c) => {
  const session = c.req.query('session');
  if (session !== undefined && !SessionId.safeParse(session).success) {
    return c.json({ error: 'invalid session id' }, 400);
  }
  const asks = (await getThread()).filter(
    (i) => i.kind === 'ask' && !i.ask.answer && (session === undefined || i.sessionId === session),
  );
  return c.json({ asks });
});

steward.get('/screen', (c) => c.json({ screen: getLastGlassesScreen() }));

/** Whether the steward is thinking. Polled by a screen that has just spoken. */
steward.get('/observer', async (c) => c.json(await observerStatus()));

/**
 * A thread entry about one session also belongs in that session's history.
 *
 * Written here rather than asked of the steward: an answer that appeared only
 * in the thread left the screen the question was asked from showing nothing,
 * and "call two commands every time" is a rule that holds until the one turn
 * it does not. Same id both places, so the upsert makes this idempotent.
 */
async function mirrorToSession(item: StewardThreadItem): Promise<void> {
  if (!item.sessionId) return;
  // A question still waiting is above the composer, not in the history: a copy
  // there would be a question with no way to answer it. Once it has an answer
  // the pair is exactly what the history is for - and answering from the
  // session's own screen used to leave nothing behind at all.
  if (item.kind === 'ask' && !item.ask.answer) return;
  const turn: StewardTurn = {
    id: item.id,
    at: item.at,
    role: item.role,
    text: item.text,
    detail: item.detail,
    images: item.images,
    refs: item.refs,
    source: item.source,
  };
  const turns = await appendSessionTurns(item.sessionId, [turn], item.paneId);
  broadcastSteward({
    type: 'steward-turns',
    sessionId: item.sessionId,
    paneId: item.paneId,
    turns,
  });
}

/**
 * How the observer is told an answer arrived.
 *
 * **Named by what it asked, not only by its id.** The id is how the two ends
 * agree which question this was; it is not a thing to say to anybody. An
 * observer handed nothing else uses the only handle it has, and `068d255a`
 * appears on no screen the owner has ever seen and links to nothing - reported
 * on 2026-08-20 as "what is this, it appeared out of nowhere and I am
 * confused". So the words come first and the id is labelled as bookkeeping.
 */
export function answerWake({
  askId,
  asked,
  replyText,
}: {
  askId?: string;
  asked?: string;
  replyText: string;
}): string {
  if (!askId) return `The owner said: ${replyText}`;
  const name = asked ? `"${asked}"` : 'a question';
  return `The owner answered ${name} (ask ${askId}, for your bookkeeping - never for them): ${replyText}`;
}

/** What a person's answer says, in the words the thread is read in. */
function answerAsText(
  answer: { kind: 'choice'; indices: number[] } | { kind: 'text'; text: string } | { kind: 'dismissed' } | undefined,
  ask: StewardThreadItem | null,
): string {
  if (!answer) return '';
  if (answer.kind === 'text') return answer.text;
  if (answer.kind === 'dismissed') return 'dismissed';
  const choices = ask?.kind === 'ask' ? ask.ask.choices : [];
  // Picking nothing from a multi-select is an answer, and an empty string here
  // would reach the thread as a reply that says nothing at all.
  if (answer.indices.length === 0) return 'none of them';
  return answer.indices.map((i) => choices[i] ?? `#${i}`).join(', ');
}

export { steward };
