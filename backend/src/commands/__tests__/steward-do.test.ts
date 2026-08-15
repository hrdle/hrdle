import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../../cli';
import { ACTIONS } from '../steward-do';

/**
 * The allowlist is the boundary itself, so it is pinned rather than described.
 * Adding a verb here is a decision about what the steward is allowed to be, and
 * this test is where that decision has to be made deliberately.
 */
describe('what the steward may send to a pane', () => {
  test('three verbs, and no more', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(['clear', 'say', 'stop']);
  });

  test('none of the forbidden ones exist', () => {
    // Answering a permission prompt is the owner's call; Ctrl+C and Ctrl+D kill
    // the agent rather than interrupting it.
    for (const forbidden of ['approve', 'answer', 'kill', 'interrupt', 'exit', 'eof', 'run']) {
      expect(ACTIONS).not.toHaveProperty(forbidden);
    }
  });

  test('stop sends Escape, which is recoverable', () => {
    expect(ACTIONS.stop.keys).toBe('Escape');
  });
});

describe('hrdle steward-do argument capture', () => {
  test('the verb and its words survive, including words that are command names', () => {
    const options = parseArgs(['steward-do', 'say', 'probe', 'status update please']);
    expect(options.command).toBe('steward-do');
    expect(options.stewardDoVerb).toBe('say');
    expect(options.stewardDoArgs).toEqual(['probe', 'status update please']);
  });

  test('it does not collide with the delivery command', () => {
    expect(parseArgs(['steward', 'notify', 'hi']).command).toBe('steward');
    expect(parseArgs(['steward-do', 'watch']).command).toBe('steward-do');
  });
});
