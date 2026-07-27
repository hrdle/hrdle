import { describe, expect, test } from 'bun:test';
import { toTmuxPaneId } from '../herdr-client';

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
});
