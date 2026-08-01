import { describe, expect, test } from 'bun:test';
import { PaneIdSchema } from '../../../../shared/types';
import { toTmuxPaneId } from '../herdr-client';
import { HerdrControlSession } from '../herdr-control';

/**
 * `ensurePaneReachable` resolves a pane by its tmux-convention id against
 * herdr's own ids, so the mapping is the part worth pinning: get it wrong and
 * a reply to a pane in another tab silently keeps 404ing.
 */
describe('pane id mapping for cross-tab delivery', () => {
  test('herdr ids map to the ids the API and the glasses speak', () => {
    expect(toTmuxPaneId('w4H:p4')).toBe('%4');
    expect(toTmuxPaneId('w2H:p6')).toBe('%6');
  });

  test('an id that is already tmux-shaped is left alone', () => {
    // The lookup falls back to the raw id, so this must not become something
    // else on the way through.
    expect(toTmuxPaneId('%4') ?? '%4').toBe('%4');
  });

  test('a pane past the ninth maps too', () => {
    // herdr counts panes in base36, so the tenth pane of a workspace is `pA`.
    // Matching digits only mapped every one of them to null: a split created a
    // pane herdr showed and this app could not address at all.
    expect(toTmuxPaneId('w2H:pA')).toBe('%A');
    expect(toTmuxPaneId('w2H:pG')).toBe('%G');
    expect(toTmuxPaneId('w2H:p10')).toBe('%10');
  });

  test('a herdr id without a pane part still maps to null', () => {
    expect(toTmuxPaneId('w2H:t6')).toBeNull();
    expect(toTmuxPaneId('w2H')).toBeNull();
  });
});

describe('pane ids accepted at the wire boundary', () => {
  test('PaneIdSchema accepts every shape toTmuxPaneId can produce', () => {
    expect(PaneIdSchema.safeParse('%1').success).toBe(true);
    expect(PaneIdSchema.safeParse('%A').success).toBe(true);
    expect(PaneIdSchema.safeParse('%10').success).toBe(true);
  });

  test('and still rejects anything that could reach herdr as something else', () => {
    expect(PaneIdSchema.safeParse('%1:p2').success).toBe(false);
    expect(PaneIdSchema.safeParse('%').success).toBe(false);
    expect(PaneIdSchema.safeParse('1').success).toBe(false);
    expect(PaneIdSchema.safeParse('%../x').success).toBe(false);
  });
});

/**
 * Focusing a pane is how the workspace list opens one, and the list spans every
 * tab while the split tree holds only the live one. Without the tab check the
 * focus resolves to nothing and the terminal stays where it was — the user taps
 * one pane and gets another, silently.
 */
describe('focusing a pane reaches across tabs', () => {
  test('selectPane asks for the pane to be brought into view first', async () => {
    const session = new HerdrControlSession('focus-across-tabs');
    const asked: string[] = [];
    session.ensurePaneReachable = async (paneId: string) => {
      asked.push(paneId);
      return false;
    };

    // No workspace is attached, so the focus RPC never leaves the process:
    // what is under test is that the tab check happens at all.
    await session.selectPane('%3');

    expect(asked).toEqual(['%3']);
    session.destroy();
  });
});
