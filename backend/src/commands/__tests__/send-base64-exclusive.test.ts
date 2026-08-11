import { describe, expect, test } from 'bun:test';
import { runSend, type SendOptions } from '../send';
import { IDENTITY } from '../../../../shared/identity';

/**
 * --base64 must not be combined with --submit / --newline. Those flags
 * wrap the payload in VT escapes, which would corrupt a literal base64 string
 * before the server decodes it. runSend should reject the combination before
 * touching the network.
 */

function opts(over: Partial<SendOptions>): SendOptions {
  return {
    target: 'local:dev:%1',
    text: 'aGVsbG8=',
    stdin: false,
    newline: false,
    submit: false,
    base64: false,
    localPort: IDENTITY.devPort,
    wait: false,
    waitMs: 800,
    lines: 20,
    ...over,
  };
}

describe('runSend --base64 exclusivity', () => {
  test('rejects --base64 with --submit', async () => {
    await expect(runSend(opts({ base64: true, submit: true }))).rejects.toThrow(
      '--base64 cannot be combined with --submit / --newline',
    );
  });

  test('rejects --base64 with --newline', async () => {
    await expect(runSend(opts({ base64: true, newline: true }))).rejects.toThrow(
      '--base64 cannot be combined with --submit / --newline',
    );
  });
});
