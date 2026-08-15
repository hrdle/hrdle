import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../../cli';

/**
 * A steward verb and its text are arbitrary words, and the parser is a switch
 * over words. `steward notify "..."` was being re-read as the `notify` command
 * and silently ran the hook reader instead; any message containing `update` or
 * `status` would have done the same.
 */
describe('hrdle steward argument capture', () => {
  test('a verb that is also a command name stays a verb', () => {
    const options = parseArgs(['steward', 'notify', 'build finished']);
    expect(options.command).toBe('steward');
    expect(options.stewardVerb).toBe('notify');
    expect(options.stewardArgs).toEqual(['build finished']);
  });

  test('text containing a command name is text', () => {
    const options = parseArgs(['steward', 'notify', 'status update: tests pass']);
    expect(options.command).toBe('steward');
    expect(options.stewardArgs).toEqual(['status update: tests pass']);
  });

  test('flags still reach the parser, and words after them are kept', () => {
    const options = parseArgs(['steward', 'ask', '--choices', 'yes,no', 'deploy?', '--step', '2/3']);
    expect(options.stewardVerb).toBe('ask');
    expect(options.stewardArgs).toEqual(['deploy?']);
    expect(options.choices).toEqual(['yes', 'no']);
    expect(options.stewardStep).toEqual({ index: 2, total: 3 });
  });

  test('two positional words keep their order', () => {
    const options = parseArgs(['steward', 'line', 'w1', 'waiting for review']);
    expect(options.stewardArgs).toEqual(['w1', 'waiting for review']);
  });

  test('the port is still a global flag', () => {
    const options = parseArgs(['steward', 'screen', '-p', '3457']);
    expect(options.stewardVerb).toBe('screen');
    expect(options.port).toBe(3457);
  });

  test('--choices is shared with glasses and neither loses it', () => {
    expect(parseArgs(['glasses', 'hi', '--choices', 'a,b']).choices).toEqual(['a', 'b']);
    expect(parseArgs(['steward', 'ask', 'hi', '--choices', 'a,b']).choices).toEqual(['a', 'b']);
  });
});
