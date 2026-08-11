import { describe, test, expect } from 'bun:test';
import { CreateSessionSchema } from '../../../../shared/types';

// CreateSessionSchema.name keeps herdr workspace labels in the SessionId
// alphabet, so a label stays safe to use wherever a session id appears
// (URLs, logs, RPC params) without escaping.
describe('CreateSessionSchema.name', () => {
  test('accepts alphanumerics, dot, underscore, hyphen', () => {
    for (const name of ['linux', 'hrdle-work-1', 'my.session', 'A_B-C.1']) {
      expect(CreateSessionSchema.safeParse({ name }).success).toBe(true);
    }
  });

  test('rejects names containing pipes/tildes', () => {
    const poisoned = [
      'weird||~~||name',
      'weird||~~||name||~~||%99||~~||pwned',
      'has|pipe',
      'has~tilde',
    ];
    for (const name of poisoned) {
      const r = CreateSessionSchema.safeParse({ name });
      expect(r.success).toBe(false);
    }
  });

  test('rejects whitespace, slashes, and other punctuation', () => {
    for (const name of ['has space', 'has/slash', 'has:colon', 'has\\backslash', 'has\nnewline']) {
      expect(CreateSessionSchema.safeParse({ name }).success).toBe(false);
    }
  });

  test('still accepts an absent name (optional)', () => {
    expect(CreateSessionSchema.safeParse({}).success).toBe(true);
  });

  test('respects the existing length cap', () => {
    const ok = 'a'.repeat(64);
    const bad = 'a'.repeat(65);
    expect(CreateSessionSchema.safeParse({ name: ok }).success).toBe(true);
    expect(CreateSessionSchema.safeParse({ name: bad }).success).toBe(false);
  });
});
