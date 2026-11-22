import { describe, test, expect } from 'bun:test';
import { CreateSessionSchema } from '../../../../shared/types';

// The name becomes the herdr workspace label, which is free text (the session
// id is herdr's workspace_id). It takes what a rename takes.
describe('CreateSessionSchema.name', () => {
  test('accepts the labels people and agents actually write', () => {
    for (const name of [
      'linux',
      'hrdle-work-1',
      'my.session',
      '#592 調査 — 作業中',
      'Groq音声認識の改善',
      'has space',
      'weird||~~||name',
    ]) {
      expect(CreateSessionSchema.safeParse({ name }).success).toBe(true);
    }
  });

  test('trims surrounding whitespace', () => {
    const r = CreateSessionSchema.safeParse({ name: '  dev  ' });
    expect(r.success && r.data.name).toBe('dev');
  });

  test('rejects control characters', () => {
    for (const name of ['has\nnewline', 'has\ttab', 'esc\x1b[2J', 'del\x7f']) {
      expect(CreateSessionSchema.safeParse({ name }).success).toBe(false);
    }
  });

  test('rejects an empty or blank name', () => {
    for (const name of ['', '   ']) {
      expect(CreateSessionSchema.safeParse({ name }).success).toBe(false);
    }
  });

  test('still accepts an absent name (optional)', () => {
    expect(CreateSessionSchema.safeParse({}).success).toBe(true);
  });

  test('caps the length at the rename limit', () => {
    expect(CreateSessionSchema.safeParse({ name: 'a'.repeat(100) }).success).toBe(true);
    expect(CreateSessionSchema.safeParse({ name: 'a'.repeat(101) }).success).toBe(false);
  });
});
