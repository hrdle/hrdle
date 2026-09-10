import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('../../utils/claude-credentials', () => ({
  getClaudeAccessToken: async () => 'token',
}));

const { ageModelCatalogForTest, forgetKnownWindowsForTest, forgetModelCatalogForTest, getMaxInputTokens } = await import('../anthropic-models');

const realFetch = globalThis.fetch;

/** A stand-in for `fetch` that answers every request with one model listing. */
function listing(models: Record<string, number>): typeof fetch {
  const answer = async () =>
    new Response(JSON.stringify({ data: Object.entries(models).map(([id, max_input_tokens]) => ({ id, max_input_tokens })) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  return answer as unknown as typeof fetch;
}

/** A stand-in for `fetch` that fails after a moment, so callers can pile up on one refresh. */
function failingAfter(ms: number): typeof fetch {
  const answer = async () => {
    await new Promise((r) => setTimeout(r, ms));
    return new Response('', { status: 401 });
  };
  return answer as unknown as typeof fetch;
}

describe('the context window of a model', () => {
  beforeEach(() => {
    forgetModelCatalogForTest();
    forgetKnownWindowsForTest();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('is what the catalog says', async () => {
    globalThis.fetch = listing({ 'claude-fable-5': 1_000_000 });
    expect(await getMaxInputTokens('claude-fable-5')).toBe(1_000_000);
  });

  test('is the flat fallback for a model the catalog has never listed', async () => {
    globalThis.fetch = listing({ 'claude-opus-5': 1_000_000 });
    expect(await getMaxInputTokens('claude-fable-5')).toBe(200_000);
  });

  test('is the same for every caller of a refresh that fails', async () => {
    // The flicker's root: the caller that started a failed refresh got the
    // stale catalog, and the callers that joined it got the empty result.
    globalThis.fetch = listing({ 'claude-fable-5': 1_000_000 });
    expect(await getMaxInputTokens('claude-fable-5')).toBe(1_000_000);
    forgetKnownWindowsForTest();
    ageModelCatalogForTest();
    globalThis.fetch = failingAfter(20);
    const windows = await Promise.all(Array.from({ length: 5 }, () => getMaxInputTokens('claude-fable-5')));
    expect(windows).toEqual([1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000]);
  });

  test('is not forgotten when a later listing leaves the model out', async () => {
    // The flicker: 416,221 tokens read as 41.6% of 1M on one refresh and as
    // 100% of the 200k fallback on the next, because a listing without the
    // model replaced the cache and the fallback answered the miss.
    globalThis.fetch = listing({ 'claude-fable-5': 1_000_000 });
    expect(await getMaxInputTokens('claude-fable-5')).toBe(1_000_000);
    forgetModelCatalogForTest();
    globalThis.fetch = listing({ 'claude-opus-5': 1_000_000 });
    expect(await getMaxInputTokens('claude-fable-5')).toBe(1_000_000);
    // A model that was never in any listing is still the fallback.
    expect(await getMaxInputTokens('claude-haiku-9')).toBe(200_000);
  });
});
