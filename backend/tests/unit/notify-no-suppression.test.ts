// A hook event notifies everywhere, whatever the glasses are doing.
//
// `deliveredToGlasses` used to silence the browser notification and, briefly,
// the push as well. The reasoning was that the wearer had already been told.
// The flag cannot establish that: it is set when a relay item was created, and
// all that proves is that the glasses app held a socket at the time.
//
// On 2026-07-31 the G2 went back to its home screen while the app kept running,
// kept drawing and kept its subscription — the panel showed nothing and the
// flag stayed up. The same day, an app left running with the glasses off the
// face silenced the phone for its whole life. Neither field that would settle
// it is usable: `isWearing` reads `false` even on a wearer's face because the
// protobuf omits zero values, and `connectType` has read `none` on every event
// recorded, including while the app was drawing.
//
// So the rule is the one `glasses-relay.ts` already states for the relay
// itself: losing a notification is the worse failure of the two.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf-8');

/** Lines that are code rather than prose, so a comment explaining the old
 *  behaviour is not mistaken for the old behaviour. */
function codeLines(source: string): string[] {
  return source
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
}

describe('nothing gates a notification on the glasses flag', () => {
  const files = [
    'backend/src/routes/notify.ts',
    'frontend/src/components/DesktopLayout.tsx',
    'frontend/src/hooks/usePeerSessionsWatcher.ts',
  ];

  // Only the shapes that suppress. Putting the flag *into* the outgoing message
  // is what it is for, so `...(deliveredToGlasses ? { … } : {})` is not an
  // offender — a rule that flagged it would have to be turned off to pass, and
  // a rule nobody can leave on guards nothing.
  const SUPPRESSION = /if\s*\(\s*!?\s*(msg\.)?deliveredToGlasses|!\s*(msg\.)?deliveredToGlasses/;

  for (const file of files) {
    test(`${file} does not branch on it`, () => {
      const offenders = codeLines(read(file)).filter((l) => SUPPRESSION.test(l));
      expect(offenders).toEqual([]);
    });
  }

  test('the push is sent unconditionally', () => {
    // The regression that matters most: a push suppressed by this flag is a
    // notification that reaches nothing at all, because the socket it would
    // otherwise have gone over is the one that does not survive a locked phone.
    const source = read('backend/src/routes/notify.ts');
    const sendIndex = source.indexOf('void sendPush(');
    expect(sendIndex).toBeGreaterThan(-1);
    // Nothing between the start of the notification block and the send may test
    // the flag.
    const block = source.slice(source.indexOf('let deliveredToGlasses'), sendIndex);
    expect(block).not.toMatch(/if\s*\(\s*!?\s*deliveredToGlasses/);
  });

  test('the flag is still computed and still sent to clients', () => {
    // Dropping it would lose a true thing that is worth seeing, and this is
    // where suppression goes back when the glasses can report being worn.
    const source = read('backend/src/routes/notify.ts');
    expect(source).toContain('deliveredToGlasses = postHookRelay(');
    expect(source).toContain('deliveredToGlasses: true');
  });
});
