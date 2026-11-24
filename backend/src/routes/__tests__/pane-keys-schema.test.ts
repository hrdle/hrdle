import { describe, expect, test } from 'bun:test';
import { PaneKeysSchema } from '../sessions';

describe('PaneKeysSchema', () => {
  test('accepts the keys the chat view presses', () => {
    expect(PaneKeysSchema.safeParse({ keys: ['esc'] }).success).toBe(true);
    expect(PaneKeysSchema.safeParse({ keys: ['shift+tab', 'shift+tab'] }).success).toBe(true);
  });

  test('refuses any other key, so the route cannot type text', () => {
    expect(PaneKeysSchema.safeParse({ keys: ['enter'] }).success).toBe(false);
    expect(PaneKeysSchema.safeParse({ keys: ['y'] }).success).toBe(false);
    expect(PaneKeysSchema.safeParse({ keys: [] }).success).toBe(false);
  });
});
