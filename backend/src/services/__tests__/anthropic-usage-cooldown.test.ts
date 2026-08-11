import { afterEach, describe, expect, test } from 'bun:test';
import { AnthropicUsageService } from '../anthropic-usage';

/**
 * The dashboard polls every 30s, per open client, and `/api/oauth/usage` is
 * rate limited per ACCOUNT — hrdle's cache is the only thing standing between
 * that poll rate and a 429 that then blinds every client for up to an hour.
 *
 * The cache used to require a stored success to engage, and only a 429 set a
 * backoff. So any other failure — a 500, a token 401ing mid-refresh, a network
 * blip — removed all rate control at once: no result to serve, no cooldown to
 * wait on, so every poll became a live request until Anthropic 429'd us.
 *
 * The invariant these lock down: at most ONE upstream request per TTL, however
 * the previous attempt ended.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Service with a stubbed token and a counting fetch. */
function serviceWith(respond: () => Promise<Response> | Response) {
  const svc = new AnthropicUsageService();
  // biome-ignore lint/suspicious/noExplicitAny: test seam into private method.
  (svc as any).getAccessToken = async () => 'test-token';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return await respond();
  }) as unknown as typeof fetch;
  return { svc, calls: () => calls };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const USAGE = {
  five_hour: { utilization: 7, resets_at: '2026-07-16T01:59:59Z' },
  seven_day: { utilization: 68, resets_at: '2026-07-18T05:59:59Z' },
};

describe('AnthropicUsageService request cooldown', () => {
  test('a successful fetch is cached for the TTL', async () => {
    const { svc, calls } = serviceWith(() => ok(USAGE));
    await svc.getUsageLimits();
    await svc.getUsageLimits();
    await svc.getUsageLimits();
    expect(calls()).toBe(1);
  });

  // Each of these used to leave the service with no cached result AND no
  // backoff, so every subsequent poll hit Anthropic again.
  test.each([
    ['500 server error', () => new Response('boom', { status: 500 })],
    ['401 unauthorized (token mid-refresh)', () => new Response('nope', { status: 401 })],
    ['403 forbidden', () => new Response('nope', { status: 403 })],
  ])('does not retry within the TTL after %s', async (_label, respond) => {
    const { svc, calls } = serviceWith(respond);
    expect(await svc.getUsageLimits()).toBeNull();
    expect(await svc.getUsageLimits()).toBeNull();
    expect(await svc.getUsageLimits()).toBeNull();
    expect(calls()).toBe(1);
  });

  test('does not retry within the TTL after a network error', async () => {
    const { svc, calls } = serviceWith(() => {
      throw new Error('ECONNRESET');
    });
    expect(await svc.getUsageLimits()).toBeNull();
    expect(await svc.getUsageLimits()).toBeNull();
    expect(calls()).toBe(1);
  });

  test('a 429 still backs off far beyond the TTL', async () => {
    const { svc, calls } = serviceWith(
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '600' } }),
    );
    await svc.getUsageLimits();
    expect(calls()).toBe(1);

    const status = svc.getStatus();
    expect(status.errorReason).toBe('rate-limited');
    // Honoured Retry-After (600s) is well past the 60s TTL floor.
    const until = new Date(status.rateLimitedUntil as string).getTime();
    expect(until - Date.now()).toBeGreaterThan(9 * 60_000);

    // Expire the TTL floor only; the 429 window must still hold the request.
    // biome-ignore lint/suspicious/noExplicitAny: reaching into private state.
    (svc as any).lastFetchAt = Date.now() - 61_000;
    await svc.getUsageLimits();
    expect(calls()).toBe(1);
  });

  test('retries once the cooldown expires', async () => {
    const { svc, calls } = serviceWith(() => new Response('boom', { status: 500 }));
    await svc.getUsageLimits();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into private state.
    (svc as any).lastFetchAt = Date.now() - 61_000;
    await svc.getUsageLimits();
    expect(calls()).toBe(2);
  });

  test('concurrent callers share one request', async () => {
    const { svc, calls } = serviceWith(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return ok(USAGE);
    });
    await Promise.all([svc.getUsageLimits(), svc.getUsageLimits(), svc.getUsageLimits()]);
    expect(calls()).toBe(1);
  });

  test('keeps serving the last good result while failing', async () => {
    const svc = new AnthropicUsageService();
    // biome-ignore lint/suspicious/noExplicitAny: test seam into private method.
    (svc as any).getAccessToken = async () => 'test-token';
    globalThis.fetch = (async () => ok(USAGE)) as unknown as typeof fetch;
    const first = await svc.getUsageLimits();
    expect(first?.sevenDay.utilization).toBe(68);

    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    // biome-ignore lint/suspicious/noExplicitAny: reaching into private state.
    (svc as any).lastFetchAt = Date.now() - 61_000;
    const stale = await svc.getUsageLimits();
    expect(stale?.sevenDay.utilization).toBe(68);
    expect(svc.getStatus().isStale).toBe(true);
  });
});
