import { describe, expect, test } from 'bun:test';
import { readOwnerInput } from '../steward-runtime';

/**
 * What a person sends to a pane themselves.
 *
 * The steward hears about a pane through `pane.agent_status_changed`, which
 * says that something moved and never what was said - fine for an agent working
 * on its own, and wrong for the one case a person cares about. Their next
 * reading of the pane is three seconds later, by which time the agent has
 * redrawn, so they report the answer to a question they never saw.
 *
 * Two shapes, worth different amounts. A bracketed paste is a whole message and
 * goes through verbatim; a bare Enter is only a moment, because reconstructing
 * what was typed from the key stream would mean re-implementing the TUI's own
 * line editing, and a transcript that is wrong sometimes is worse than none -
 * the steward relays it.
 */
const paste = (text: string) => Buffer.from(`\x1b[200~${text}\x1b[201~`, 'utf8');

describe('what the owner sent to a pane', () => {
  test('a bracketed paste is the message, exactly', () => {
    expect(readOwnerInput(paste('リリースお願いします'))).toEqual({
      kind: 'sent',
      text: 'リリースお願いします',
    });
  });

  // `hrdle send --submit` and the input bar both append the Enter after the
  // paste, so the two arrive together.
  test('the Enter after it does not become part of what was said', () => {
    const withSubmit = Buffer.concat([paste('go ahead'), Buffer.from('\r')]);
    expect(readOwnerInput(withSubmit)).toEqual({ kind: 'sent', text: 'go ahead' });
  });

  test('an unterminated paste is still the message', () => {
    expect(readOwnerInput(Buffer.from('\x1b[200~half a thought', 'utf8'))).toEqual({
      kind: 'sent',
      text: 'half a thought',
    });
  });

  // A log pasted into a pane is a paste like any other, and it is not the
  // wake-up.
  test('a long paste is cut rather than becoming the wake-up', () => {
    const out = readOwnerInput(paste('x'.repeat(5000)));
    expect(out?.kind).toBe('sent');
    expect(out?.kind === 'sent' && out.text.length).toBe(2000);
  });

  test('an empty paste says nothing', () => {
    expect(readOwnerInput(paste('   '))).toBeNull();
  });
});

describe('what the owner typed into a pane', () => {
  test('a submit is a moment, carrying no text', () => {
    expect(readOwnerInput(Buffer.from('\r'))).toEqual({ kind: 'typed' });
    expect(readOwnerInput(Buffer.from('\n'))).toEqual({ kind: 'typed' });
  });

  // Every keystroke arrives on its own. Reporting them would be reporting
  // nothing, several times a second.
  test('a keystroke on its own is not', () => {
    for (const key of ['a', 'あ', '\x1b[A', '\x7f', '\x1b[200~']) {
      expect(readOwnerInput(Buffer.from(key, 'utf8'))).toBeNull();
    }
  });

  // Mouse reporting and other escape traffic run through the same path.
  test('escape traffic that is not a submit is not', () => {
    expect(readOwnerInput(Buffer.from('\x1b[<0;40;12M', 'utf8'))).toBeNull();
  });
});
