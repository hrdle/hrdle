import { t } from '../i18n';
import { VERSION } from '../cli';
import { userAgent } from '../../../shared/identity';
import { getClaudeAccessToken } from '../utils/claude-credentials';
import type { UsageLimitsErrorReason, UsageLimitsStatus, UsageScopedLimit } from '../../../shared/types';

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.floor((date - Date.now()) / 1000));
  return null;
}

interface UsageResponse {
  five_hour: {
    utilization: number;
    resets_at: string;
  };
  seven_day: {
    utilization: number;
    resets_at: string;
  };
  limits?: unknown;
}

interface RawLimitEntry {
  group?: unknown;
  percent?: unknown;
  severity?: unknown;
  resets_at?: unknown;
  is_active?: unknown;
  scope?: {
    model?: { display_name?: unknown } | null;
    surface?: unknown;
  } | null;
}

/**
 * Extract per-model limits from the `limits[]` array of the OAuth usage
 * response. Entries whose `scope` is null are the overall cycles, which
 * `five_hour` / `seven_day` already carry — only scoped entries add anything.
 *
 * Every field is validated because `limits[]` is newer than the flat fields
 * and hrdle must never break the existing chart over an unexpected shape: an
 * entry that doesn't parse (unknown `group`, missing `percent`) is dropped
 * rather than guessed at, and an absent/malformed array yields no overlays.
 */
export function parseScopedLimits(raw: unknown): UsageScopedLimit[] {
  const entries = (raw as { limits?: unknown } | null)?.limits;
  if (!Array.isArray(entries)) return [];

  const scoped: UsageScopedLimit[] = [];
  for (const entry of entries as RawLimitEntry[]) {
    if (!entry || typeof entry !== 'object') continue;

    const modelName = entry.scope?.model?.display_name;
    const surface = entry.scope?.surface;
    const name =
      typeof modelName === 'string' && modelName
        ? modelName
        : typeof surface === 'string' && surface
          ? surface
          : null;
    if (!name) continue;

    // Anything other than the two cycles hrdle charts would have no axis to
    // sit on, so drop it instead of misplacing it.
    const group = entry.group === 'session' || entry.group === 'weekly' ? entry.group : null;
    if (!group) continue;

    if (typeof entry.percent !== 'number' || !Number.isFinite(entry.percent)) continue;
    if (typeof entry.resets_at !== 'string' || !entry.resets_at) continue;

    scoped.push({
      key: `${group}:${name}`,
      name,
      group,
      utilization: entry.percent,
      resetsAt: entry.resets_at,
      isActive: entry.is_active === true,
      severity: typeof entry.severity === 'string' ? entry.severity : undefined,
    });
  }
  return scoped;
}

export interface UsageLimits {
  fiveHour: {
    utilization: number;
    resetsAt: string;
    timeRemaining: string;
    estimatedHitTime?: string; // When limit will be hit at current rate
    status: 'safe' | 'warning' | 'danger' | 'exceeded'; // Overall status
    statusMessage: string; // Human-readable message
  };
  sevenDay: {
    utilization: number;
    resetsAt: string;
    timeRemaining: string;
    estimatedHitTime?: string;
    status: 'safe' | 'warning' | 'danger' | 'exceeded';
    statusMessage: string;
  };
  scopedLimits?: UsageScopedLimit[];
}

export class AnthropicUsageService {
  private lastSuccessfulResult: UsageLimits | null = null;
  /**
   * When the last attempt STARTED, whatever came of it. This gates every
   * request, so the TTL is a hard floor between calls rather than a cache that
   * only exists once one has succeeded. Keying it on success instead left every
   * failure — a 500, a token mid-refresh 401ing, a network blip — with no
   * cooldown at all: the cache could not engage without a stored result, and
   * only a 429 set a backoff, so the dashboard's 30s poll (times every open
   * client) went straight through to Anthropic and earned the very 429 this
   * class exists to avoid. Also subsumes the no-credentials cooldown: a
   * missing token is just another attempt that yielded nothing.
   */
  private lastFetchAt = 0;
  private inflight: Promise<UsageLimits | null> | null = null;
  // Anthropic /api/oauth/usage has strict rate limits. Cache for 60s.
  private readonly CACHE_TTL_MS = 60_000;
  // On 429, back off for 5 minutes before retrying.
  private rateLimitedUntil = 0;
  private lastErrorReason: UsageLimitsErrorReason | undefined;

  private async getAccessToken(): Promise<string | null> {
    return getClaudeAccessToken();
  }

  getStatus(): UsageLimitsStatus {
    const now = Date.now();
    const status: UsageLimitsStatus = {};
    if (this.lastErrorReason) status.errorReason = this.lastErrorReason;
    if (this.rateLimitedUntil > now) {
      status.rateLimitedUntil = new Date(this.rateLimitedUntil).toISOString();
    }
    if (this.lastFetchAt > 0) {
      status.lastFetchAt = new Date(this.lastFetchAt).toISOString();
    }
    if (this.lastSuccessfulResult && (this.rateLimitedUntil > now || this.lastErrorReason)) {
      status.isStale = true;
    }
    return status;
  }

  async getUsageLimits(): Promise<UsageLimits | null> {
    const now = Date.now();

    // At most one attempt per TTL, no matter how the last one ended. On success
    // this serves the cached result; on failure it serves whatever we last had
    // (possibly null) rather than retrying at the caller's polling rate.
    if (now - this.lastFetchAt < this.CACHE_TTL_MS) {
      return this.lastSuccessfulResult;
    }

    // Respect rate-limit backoff window (longer than the TTL floor above)
    if (now < this.rateLimitedUntil) {
      return this.lastSuccessfulResult;
    }

    // Coalesce concurrent requests
    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.fetchUsageLimits();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async fetchUsageLimits(): Promise<UsageLimits | null> {
    // Stamp the attempt up front so every exit below — a missing token, a
    // non-429 status, a thrown network error — starts the cooldown. Stamping
    // it only where a request "counted" is what left the failure paths
    // unthrottled.
    this.lastFetchAt = Date.now();

    const token = await this.getAccessToken();
    if (!token) {
      this.lastErrorReason = 'no-credentials';
      return this.lastSuccessfulResult;
    }

    try {
      const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': userAgent(VERSION),
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 429) {
          // Honor Retry-After when present; clamp to [5min, 1h].
          const retryAfterSec = parseRetryAfter(response.headers.get('retry-after'));
          const backoffMs = retryAfterSec != null
            ? Math.min(Math.max(retryAfterSec * 1000, 5 * 60_000), 60 * 60_000)
            : 5 * 60_000;
          this.rateLimitedUntil = Date.now() + backoffMs;
          this.lastErrorReason = 'rate-limited';
        } else if (response.status === 401 || response.status === 403) {
          this.lastErrorReason = 'unauthorized';
        } else {
          this.lastErrorReason = 'fetch-failed';
        }
        console.error('Failed to fetch usage:', response.status);
        return this.lastSuccessfulResult;
      }

      const data: UsageResponse = await response.json();
      this.lastErrorReason = undefined;

      const fiveHourEstimate = this.estimateHitTime(data.five_hour.utilization, data.five_hour.resets_at, 5);
      const sevenDayEstimate = this.estimateHitTime(data.seven_day.utilization, data.seven_day.resets_at, 7 * 24);

      const result: UsageLimits = {
        fiveHour: {
          utilization: data.five_hour.utilization,
          resetsAt: data.five_hour.resets_at,
          timeRemaining: this.formatTimeRemaining(data.five_hour.resets_at),
          estimatedHitTime: fiveHourEstimate,
          ...this.calculateStatus(data.five_hour.utilization, fiveHourEstimate, this.formatTimeRemaining(data.five_hour.resets_at)),
        },
        sevenDay: {
          utilization: data.seven_day.utilization,
          resetsAt: data.seven_day.resets_at,
          timeRemaining: this.formatTimeRemaining(data.seven_day.resets_at),
          estimatedHitTime: sevenDayEstimate,
          ...this.calculateStatus(data.seven_day.utilization, sevenDayEstimate, this.formatTimeRemaining(data.seven_day.resets_at)),
        },
        scopedLimits: parseScopedLimits(data),
      };

      this.lastSuccessfulResult = result;
      return result;
    } catch (err) {
      console.error('Error fetching usage:', err);
      this.lastErrorReason = 'unknown';
      return this.lastSuccessfulResult;
    }
  }

  /**
   * Calculate status and message based on utilization and estimated hit time
   */
  private calculateStatus(
    utilization: number,
    estimatedHitTime: string | undefined,
    _timeRemaining: string
  ): { status: 'safe' | 'warning' | 'danger' | 'exceeded'; statusMessage: string } {
    if (utilization >= 100) {
      return { status: 'exceeded', statusMessage: t('usage.limitReached') };
    }

    if (estimatedHitTime) {
      // Will hit limit before reset
      return {
        status: 'danger',
        statusMessage: t('usage.willHitLimit', { time: estimatedHitTime }),
      };
    }

    // Won't hit limit before reset - frontend will generate its own message
    if (utilization >= 75) {
      return {
        status: 'warning',
        statusMessage: '',
      };
    }

    if (utilization >= 50) {
      return {
        status: 'safe',
        statusMessage: '',
      };
    }

    return {
      status: 'safe',
      statusMessage: '',
    };
  }

  private formatDuration(diffMs: number): string {
    if (diffMs <= 0) return 'soon';

    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) {
      return `${days}d ${hours}h${minutes}m`;
    }
    if (hours > 0) {
      return `${hours}h${minutes}m`;
    }
    return `${minutes}m`;
  }

  private formatTimeRemaining(resetsAt: string): string {
    try {
      const resetTime = new Date(resetsAt);
      const now = new Date();
      return this.formatDuration(resetTime.getTime() - now.getTime());
    } catch {
      return '?';
    }
  }

  /**
   * Estimate when the limit will be hit based on current usage rate
   * @param utilization Current usage percentage
   * @param resetsAt When the cycle resets
   * @param cycleTotalHours Total hours in the cycle (5 for 5h, 168 for 7d)
   */
  private estimateHitTime(utilization: number, resetsAt: string, cycleTotalHours: number): string | undefined {
    if (utilization <= 0 || utilization >= 100) {
      return undefined;
    }

    try {
      const resetTime = new Date(resetsAt);
      const now = new Date();

      // Calculate cycle start time
      const cycleStartTime = new Date(resetTime.getTime() - cycleTotalHours * 60 * 60 * 1000);

      // Time elapsed since cycle start
      const elapsedMs = now.getTime() - cycleStartTime.getTime();
      if (elapsedMs <= 0) return undefined;

      // Usage rate: utilization% per elapsed time
      const ratePerMs = utilization / elapsedMs;

      // Time needed to reach 100%
      const remainingUtilization = 100 - utilization;
      const msToHit = remainingUtilization / ratePerMs;

      // Estimated hit time
      const hitTime = new Date(now.getTime() + msToHit);

      // If hit time is after reset, limit won't be hit this cycle
      if (hitTime >= resetTime) {
        return undefined;
      }

      // If hit time is within the last 10% of remaining time, not really dangerous
      const remainingMs = resetTime.getTime() - now.getTime();
      if (remainingMs > 0 && (hitTime.getTime() - now.getTime()) > remainingMs * 0.9) {
        return undefined;
      }

      // Format the hit time
      return this.formatDuration(hitTime.getTime() - now.getTime());
    } catch {
      return undefined;
    }
  }
}
