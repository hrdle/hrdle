import { describe, expect, test } from 'bun:test';
import { PanePromptSchema } from '../../src/routes/sessions';

describe('PanePromptSchema', () => {
  test('text alone, images alone, or both', () => {
    expect(PanePromptSchema.safeParse({ text: 'hi' }).success).toBe(true);
    expect(PanePromptSchema.safeParse({ images: ['/tmp/a.png'] }).success).toBe(true);
    expect(PanePromptSchema.safeParse({ text: 'what is this', images: ['/tmp/a.png'] }).success).toBe(true);
  });

  test('nothing to send is refused', () => {
    expect(PanePromptSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(PanePromptSchema.safeParse({}).success).toBe(false);
  });

  test('an image path cannot carry what a terminal would act on', () => {
    expect(PanePromptSchema.safeParse({ images: ['/tmp/a.png\n'] }).success).toBe(false);
    expect(PanePromptSchema.safeParse({ images: ['/tmp/a\u001b[201~rm.png'] }).success).toBe(false);
    expect(PanePromptSchema.safeParse({ images: ['relative.png'] }).success).toBe(false);
  });
});
