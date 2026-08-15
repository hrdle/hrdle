import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../../cli';
import { ACTIONS, resolveAgentIn } from '../steward-do';

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

/**
 * Rows shaped the way a real server answers.
 *
 * `name` is only present on agents started through `herdr agent start <name>` -
 * the observer, and anything a test starts that way. Measured on a live server:
 * 16 of 17 rows had none. Addressing by name therefore passed in dev and could
 * not reach a single session a person actually runs.
 */
const REAL_ROWS = [
  { agent: 'claude', pane_id: 'w4H:p1', workspace_id: 'w4H', agent_status: 'idle' },
  { agent: 'claude', pane_id: 'w4H:p2', workspace_id: 'w4H', agent_status: 'working' },
  { agent: 'codex', pane_id: 'w59:p1', workspace_id: 'w59', agent_status: 'idle' },
  { agent: 'claude', pane_id: 'wA:p1', workspace_id: 'wA', agent_status: 'blocked', name: 'observer' },
];

describe('addressing an agent pane', () => {
  test('a pane id resolves, with or without a name on the row', () => {
    const r = resolveAgentIn(REAL_ROWS, 'w4H:p2');
    expect(r.ok && r.agent.pane_id).toBe('w4H:p2');
  });

  test('a workspace holding one agent resolves to it', () => {
    const r = resolveAgentIn(REAL_ROWS, 'w59');
    expect(r.ok && r.agent.pane_id).toBe('w59:p1');
  });

  // Multi-agent workspaces are ordinary. Resolving to whichever listed first
  // would silently drive a different pane than the caller meant.
  test('a workspace holding several refuses, and says which', () => {
    const r = resolveAgentIn(REAL_ROWS, 'w4H');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason === 'ambiguous' && r.panes).toEqual(['w4H:p1', 'w4H:p2']);
  });

  test('a name still works where one exists', () => {
    const r = resolveAgentIn(REAL_ROWS, 'observer');
    expect(r.ok && r.agent.pane_id).toBe('wA:p1');
  });

  test('an unknown address resolves to nothing', () => {
    expect(resolveAgentIn(REAL_ROWS, 'w99:p1').ok).toBe(false);
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
