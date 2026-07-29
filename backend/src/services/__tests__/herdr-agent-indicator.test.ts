import { describe, expect, it } from 'bun:test';
import { herdrStatusToIndicator, paneIndicatorState } from '../../routes/sessions';
import { parseHookJson, parseHookToml } from '../hook-status';
import { HOOK_COMMAND } from '../../../../shared/identity';

/**
 * #390: herdr's own agent detection drives the indicator, so the
 * status-transition hooks (PreToolUse / UserPromptSubmit) are gone. These lock
 * in the mapping and the "don't ask for hooks we no longer need" contract.
 */
describe('herdrStatusToIndicator', () => {
  it('maps herdr agent states to indicator states', () => {
    // Verified against Claude 2.x on herdr 0.7.3 (probe: idle -> working ->
    // blocked at an AskUserQuestion prompt -> done).
    expect(herdrStatusToIndicator('working')).toBe('processing');
    expect(herdrStatusToIndicator('blocked')).toBe('waiting_input');
    expect(herdrStatusToIndicator('idle')).toBe('completed');
    expect(herdrStatusToIndicator('done')).toBe('completed');
  });

  it('falls through on states it cannot interpret', () => {
    // `unknown` = no agent on the pane. A future herdr may add states; guessing
    // would show a confidently wrong indicator, so the caller must fall back.
    expect(herdrStatusToIndicator('unknown')).toBeNull();
    expect(herdrStatusToIndicator(undefined)).toBeNull();
    expect(herdrStatusToIndicator('thinking_very_hard')).toBeNull();
  });
});

describe('paneIndicatorState', () => {
  it('never lets a stale hook override outrank a live herdr status', () => {
    // Repro of the false permission-pending badge: PostToolUse/AskUserQuestion set a
    // waiting_input override (24h TTL), the user answered, and Claude kept
    // working — nothing fires to clear the override until Stop, but herdr
    // already reports `working`.
    expect(
      paneIndicatorState({
        paneAgent: 'claude',
        paneAgentStatus: 'working',
        sessionIndicator: 'processing',
        hookState: 'waiting_input',
      }),
    ).toBe('processing');
  });

  it('shows waiting_input when herdr itself reports blocked', () => {
    expect(
      paneIndicatorState({
        paneAgent: 'claude',
        paneAgentStatus: 'blocked',
        sessionIndicator: 'waiting_input',
        hookState: null,
      }),
    ).toBe('waiting_input');
  });

  it('does not remap a completed Claude pane to waiting_input', () => {
    // The tmux-era pane list showed idle-at-prompt as waiting_input; today
    // that state pulses yellow and derives the card's permission-pending badge, so a
    // finished turn must stay `completed` even while a stale override lives.
    expect(
      paneIndicatorState({
        paneAgent: 'claude',
        paneAgentStatus: 'done',
        sessionIndicator: 'completed',
        hookState: 'waiting_input',
      }),
    ).toBe('completed');
  });

  it('falls back to the session indicator when herdr has no status for a Claude pane', () => {
    expect(
      paneIndicatorState({
        paneAgent: 'claude',
        paneAgentStatus: undefined,
        sessionIndicator: 'processing',
        hookState: null,
      }),
    ).toBe('processing');
  });

  it('keeps hooks first for thread agents, then herdr, then idle', () => {
    // Mirrors the session-level rule: herdr's status accuracy for thread
    // agents is unverified (#390).
    expect(
      paneIndicatorState({
        paneAgent: 'codex',
        paneAgentStatus: 'working',
        sessionIndicator: 'processing',
        hookState: 'completed',
      }),
    ).toBe('completed');
    expect(
      paneIndicatorState({
        paneAgent: 'kimi',
        paneAgentStatus: 'idle',
        sessionIndicator: 'completed',
        hookState: null,
      }),
    ).toBe('completed');
    expect(
      paneIndicatorState({
        paneAgent: 'codex',
        paneAgentStatus: undefined,
        sessionIndicator: 'completed',
        hookState: null,
      }),
    ).toBe('idle');
  });

  it('reports idle for panes with no agent', () => {
    expect(
      paneIndicatorState({
        paneAgent: undefined,
        paneAgentStatus: 'working',
        sessionIndicator: 'processing',
        hookState: 'processing',
      }),
    ).toBe('idle');
  });
});

describe('hook status expectations', () => {
  it('only requires the hooks herdr cannot replace', () => {
    const settings = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ command: HOOK_COMMAND }] }],
        PostToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ command: HOOK_COMMAND }] }],
      },
    });
    const parsed = parseHookJson(settings);
    // No PreToolUse / UserPromptSubmit here — this must still be "complete".
    expect(parsed).toEqual({ stop: true, askUserQuestion: true });
  });

  it('does not credit an untracked TOML section to the hook parsed before it', () => {
    // Regression: dropping PreToolUse from the section regex left currentEvent
    // pointing at Stop, so PreToolUse's notify hook marked stop configured.
    const toml = `
[[hooks.PreToolUse]]
command = "${HOOK_COMMAND}"
`;
    expect(parseHookToml(toml)).toEqual({ stop: false, askUserQuestion: false });
  });

  it('still detects the hooks it does track in TOML', () => {
    const toml = `
[[hooks.Stop]]
command = "${HOOK_COMMAND}"

[[hooks.PostToolUse]]
matcher = "AskUserQuestion"
command = "${HOOK_COMMAND}"
`;
    expect(parseHookToml(toml)).toEqual({ stop: true, askUserQuestion: true });
  });
});
