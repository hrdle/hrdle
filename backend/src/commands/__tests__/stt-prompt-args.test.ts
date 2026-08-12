import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../../cli';

/**
 * The words are a positional argument and the flags are not ordered, so a
 * caller writes them in whichever order reads well. Dropping the words when a
 * flag came first turned a write into a silent no-op: the command printed the
 * current value and exited 0, which reads as "done" and is the opposite.
 */
describe('hrdle stt-prompt argument order', () => {
  test('words immediately after the command', () => {
    const options = parseArgs(['stt-prompt', '味噌、だし']);
    expect(options.command).toBe('stt-prompt');
    expect(options.sttPromptText).toBe('味噌、だし');
  });

  test('words after a flag that takes a value', () => {
    const options = parseArgs(['stt-prompt', '--session', 'w2H', '味噌、だし']);
    expect(options.session).toBe('w2H');
    expect(options.sttPromptText).toBe('味噌、だし');
  });

  test('words after a flag that takes none', () => {
    const options = parseArgs(['stt-prompt', '--replace', '味噌、だし']);
    expect(options.sttPromptReplace).toBe(true);
    expect(options.sttPromptText).toBe('味噌、だし');
  });

  test('no words at all still means show', () => {
    const options = parseArgs(['stt-prompt', '--session', 'w2H']);
    expect(options.sttPromptText).toBeUndefined();
  });

  test('a session id is not mistaken for the words', () => {
    const options = parseArgs(['stt-prompt', '味噌', '--session', 'w2H']);
    expect(options.sttPromptText).toBe('味噌');
    expect(options.session).toBe('w2H');
  });
});
