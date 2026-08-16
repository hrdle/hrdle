import { describe, expect, it } from 'bun:test';
import { stewardInvocation } from '../steward-prompt';

/**
 * What the observer is told to type.
 *
 * A bare binary name does not work from a pane whose PATH lacks
 * `~/.local/bin`, so the prompt carries an absolute path - and the path has to
 * come from `execPath`. Measured on Bun 1.3: a compiled binary reports
 * `argv[0]` as the literal string "bun", so the earlier version wrote
 * `bun steward-do watch` into a released build and the observer spent its turn
 * looking for a command that does not exist.
 */
describe('the command the observer is given', () => {
  it('is a path that exists, never a bare name', () => {
    const invocation = stewardInvocation();
    expect(invocation.startsWith('/')).toBe(true);
    // The failure this test exists for: the whole invocation being the word.
    expect(invocation).not.toBe('bun');
  });

  it('names the script when running from a checkout', () => {
    // The suite itself runs under `bun run`, which is the checkout case.
    expect(stewardInvocation()).toContain(' run ');
    expect(stewardInvocation().endsWith('.ts')).toBe(true);
  });
});
