import { describe, expect, test } from 'bun:test';
import { AnthropicUsageService } from '../anthropic-usage';

/**
 * with no credentials there is nothing to fetch, but the dashboard
 * polls getUsageLimits every few seconds. Without a cooldown each call
 * re-reads the credentials file. Verify the token lookup is not repeated
 * within the cache TTL window.
 */
describe('AnthropicUsageService no-credentials backoff', () => {
  test('does not re-read credentials on every poll', async () => {
    const svc = new AnthropicUsageService();
    let lookups = 0;
    // biome-ignore lint/suspicious/noExplicitAny: test seam into private method.
    (svc as any).getAccessToken = async () => {
      lookups++;
      return null;
    };

    expect(await svc.getUsageLimits()).toBeNull();
    expect(await svc.getUsageLimits()).toBeNull();
    expect(await svc.getUsageLimits()).toBeNull();

    expect(lookups).toBe(1);
    expect(svc.getStatus().errorReason).toBe('no-credentials');
  });
});
