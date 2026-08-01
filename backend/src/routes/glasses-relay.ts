/**
 * `POST /api/glasses/relay` + `POST /api/glasses/relay/:id/dismiss` (#504).
 *
 * Intentionally UNAUTHENTICATED (local trust, same pattern as /api/notify):
 * local agents post self-notes via `cchub glasses` from inside panes where no
 * token exists. Defenses mirror notify: strict sessionId/id formats, bounded
 * store, per-session rate limit (the latter two enforced in the service).
 * index.ts keeps these paths outside the `/api/glasses/*` auth glob.
 */

import { Hono } from 'hono';
import { dismissRelayItem, postAgentRelay } from '../services/glasses-relay';

// Same alphabet as SessionIdSchema / the notify flood guard (#254).
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ITEM_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
// Base36 like herdr's own pane token, not digits (`%A` is the tenth pane).
const PANE_ID_RE = /^%[0-9A-Za-z]+$/;
const MAX_TEXT_LEN = 4000; // pre-clamp; the service trims to one G2 page
const MAX_CHOICES = 9;
const MAX_CHOICE_LEN = 200;

const glassesRelay = new Hono();

glassesRelay.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { sessionId, kind, text, choices, paneId } = body;

  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    return c.json({ error: 'sessionId is required and must match [A-Za-z0-9._-]' }, 400);
  }
  if (kind !== 'waiting' && kind !== 'info') {
    return c.json({ error: 'kind must be "waiting" or "info"' }, 400);
  }
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_TEXT_LEN) {
    return c.json({ error: `text is required (1..${MAX_TEXT_LEN} chars)` }, 400);
  }
  if (paneId !== undefined && (typeof paneId !== 'string' || !PANE_ID_RE.test(paneId))) {
    return c.json({ error: 'paneId must look like "%N"' }, 400);
  }
  let choiceList: string[] | undefined;
  if (choices !== undefined) {
    if (
      !Array.isArray(choices) ||
      choices.length > MAX_CHOICES ||
      choices.some((x) => typeof x !== 'string' || x.trim().length === 0 || x.length > MAX_CHOICE_LEN)
    ) {
      return c.json({ error: `choices must be up to ${MAX_CHOICES} non-empty strings` }, 400);
    }
    choiceList = choices as string[];
  }

  const result = postAgentRelay({
    sessionId,
    kind,
    text,
    paneId: paneId as string | undefined,
    choices: choiceList,
  });
  if (result.error) {
    return c.json({ error: result.error, item: result.item }, result.status as 409 | 429);
  }
  return c.json({ ok: true, item: result.item });
});

glassesRelay.post('/:id/dismiss', (c) => {
  const id = c.req.param('id');
  if (!ITEM_ID_RE.test(id)) {
    return c.json({ error: 'Invalid item id' }, 400);
  }
  const item = dismissRelayItem(id);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }
  return c.json({ ok: true, item });
});

export { glassesRelay };
