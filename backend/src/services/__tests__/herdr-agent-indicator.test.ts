import { describe, expect, it } from 'bun:test';
import { herdrStatusToIndicator } from '../../routes/sessions';
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
