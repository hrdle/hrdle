import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexUsageLimits, UsageCycleInfo } from '../../../shared/types';

interface RateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number; // unix epoch seconds
}

interface RateLimitsPayload {
  limit_id?: string;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  plan_type?: string;
  /** Explicit Codex verdict; null while requests are still allowed. */
  rate_limit_reached_type?: string | null;
}

interface TokenCountEvent {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    rate_limits?: RateLimitsPayload | null;
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatDuration(diffMs: number): string {
  if (diffMs <= 0) return 'soon';
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0) return `${days}d ${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function statusFromUtilization(utilization: number): UsageCycleInfo['status'] {
  if (utilization >= 100) return 'exceeded';
  if (utilization >= 75) return 'warning';
  return 'safe';
}

/**
 * Mirrors AnthropicUsageService.estimateHitTime. Returns a formatted hit time
 * (HH:MM for short windows, M/D for long windows) when current pace projects
 * to 100% before the cycle resets — otherwise undefined.
 *
 * `cycleHours` is the assumed cycle length used to derive cycle start
 * (resetTime − cycleHours). Codex uses rolling windows but the chart and
 * status share this approximation so the message and chart projection agree.
 */
function estimateHitTime(
  utilization: number,
  resetsAtMs: number,
  cycleHours: number,
  now: number,
): string | undefined {
  if (utilization <= 0 || utilization >= 100) return undefined;
  const cycleStartMs = resetsAtMs - cycleHours * 60 * 60 * 1000;
  const elapsedMs = now - cycleStartMs;
  if (elapsedMs <= 0) return undefined;
  const ratePerMs = utilization / elapsedMs;
  const remaining = 100 - utilization;
  const msToHit = remaining / ratePerMs;
  const hitMs = now + msToHit;
  if (hitMs >= resetsAtMs) return undefined;
  // Ignore predictions that fall in the last 10% of remaining time — those are
  // basically "won't hit before reset" with rounding noise.
  const remainingMs = resetsAtMs - now;
  if (remainingMs > 0 && msToHit > remainingMs * 0.9) return undefined;
  const hit = new Date(hitMs);
  if (cycleHours <= 24) {
    return `${hit.getHours()}:${hit.getMinutes().toString().padStart(2, '0')}`;
  }
  return `${hit.getMonth() + 1}/${hit.getDate()}`;
}

function buildCycleInfo(window: RateLimitWindow | null | undefined, now: number): UsageCycleInfo | undefined {
  if (!window) return undefined;
  const utilization = numberOrUndefined(window.used_percent);
  const resetsAtSec = numberOrUndefined(window.resets_at);
  const windowMinutes = numberOrUndefined(window.window_minutes);
  if (utilization === undefined || resetsAtSec === undefined) return undefined;
  const resetsAtMs = resetsAtSec * 1000;
  const resetsAt = new Date(resetsAtMs).toISOString();
  const timeRemaining = formatDuration(resetsAtMs - now);
  const cycleHours = windowMinutes !== undefined ? windowMinutes / 60 : 0;
  const estimatedHitTime = cycleHours > 0
    ? estimateHitTime(utilization, resetsAtMs, cycleHours, now)
    : undefined;
  // When current pace projects to 100% before reset, the chart shows the
  // hit-time marker — the status must say "danger" so the wording matches.
  const status: UsageCycleInfo['status'] = estimatedHitTime
    ? 'danger'
    : statusFromUtilization(utilization);
  return {
    utilization,
    resetsAt,
    timeRemaining,
    estimatedHitTime,
    status,
    statusMessage: '',
  };
}

function classifyWindow(minutes: number | undefined): 'fiveHour' | 'sevenDay' | undefined {
  if (minutes === undefined) return undefined;
  // Free plan: only 7d (10080). Paid plans may include 5h (300).
  // Allow some tolerance — anything under 24h treated as the short window.
  if (minutes <= 60 * 24) return 'fiveHour';
  return 'sevenDay';
}

interface RolloutScan {
  /** Most recent rate_limits event regardless of populated windows. Carries plan/limit state. */
  latest?: { event: TokenCountEvent; rateLimits: RateLimitsPayload };
  /** Most recent rate_limits event with at least one populated window. Carries cycle data. */
  windowed?: { event: TokenCountEvent; rateLimits: RateLimitsPayload };
}

/**
 * Walk events newest-first. Codex keeps emitting rate_limits after a cycle is
 * exhausted, but with both windows null — those are useful for credits/plan
 * state but not for the chart. So we collect two views:
 *  - `latest`: the very newest rate_limits event (any windows)
 *  - `windowed`: the newest event whose primary or secondary is populated
 */
function scanRolloutText(text: string): RolloutScan {
  const lines = text.split('\n');
  const out: RolloutScan = {};
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line?.includes('"rate_limits"')) continue;
    let event: TokenCountEvent;
    try {
      event = JSON.parse(line) as TokenCountEvent;
    } catch {
      continue;
    }
    if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
    const rateLimits = event.payload?.rate_limits;
    if (!rateLimits) continue;
    if (!out.latest) out.latest = { event, rateLimits };
    if (!out.windowed && (rateLimits.primary || rateLimits.secondary)) {
      out.windowed = { event, rateLimits };
    }
    if (out.latest && out.windowed) return out;
  }
  return out;
}

function readRolloutScan(rolloutPath: string): RolloutScan {
  try {
    const stat = statSync(rolloutPath);
    const maxTailBytes = 4 * 1024 * 1024;
    if (stat.size <= maxTailBytes) {
      return scanRolloutText(readFileSync(rolloutPath, 'utf8'));
    }
    const fd = openSync(rolloutPath, 'r');
    try {
      const bytesToRead = Math.min(stat.size, maxTailBytes);
      const buffer = Buffer.alloc(bytesToRead);
      readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
      return scanRolloutText(buffer.toString('utf8'));
    } finally {
      closeSync(fd);
    }
  } catch {
    return {};
  }
}

interface RolloutCandidate {
  path: string;
  mtimeMs: number;
}

export function findRolloutCandidates(sessionsDir: string, limit: number): RolloutCandidate[] {
  if (!existsSync(sessionsDir)) return [];
  const candidates: RolloutCandidate[] = [];

  // Layout: sessionsDir/YYYY/MM/DD/rollout-*.jsonl
  // Guarded like every level below it: existsSync answers "was there a moment
  // ago", not "is readable now" - a directory with no permission, a plain file
  // where the directory should be, or a removal between the two calls all throw
  // here, and this is the one level that used to let that escape.
  let years: string[] = [];
  try { years = readdirSync(sessionsDir).filter(name => /^\d{4}$/.test(name)).sort().reverse(); } catch { return []; }
  outer: for (const year of years) {
    const yearDir = join(sessionsDir, year);
    let months: string[] = [];
    try { months = readdirSync(yearDir).filter(name => /^\d{2}$/.test(name)).sort().reverse(); } catch { continue; }
    for (const month of months) {
      const monthDir = join(yearDir, month);
      let days: string[] = [];
      try { days = readdirSync(monthDir).filter(name => /^\d{2}$/.test(name)).sort().reverse(); } catch { continue; }
      for (const day of days) {
        const dayDir = join(monthDir, day);
        let files: string[] = [];
        try { files = readdirSync(dayDir).filter(name => name.startsWith('rollout-') && name.endsWith('.jsonl')); } catch { continue; }
        for (const file of files) {
          const fullPath = join(dayDir, file);
          try {
            const stat = statSync(fullPath);
            candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs });
          } catch { /* skip unreadable */ }
        }
        // Once we have enough candidates from the most recent days, stop walking older days.
        if (candidates.length >= limit * 2) break outer;
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, limit);
}

export class CodexUsageService {
  private sessionsDir: string;
  private cache: { data: CodexUsageLimits | null; timestamp: number } | null = null;
  private static readonly CACHE_TTL_MS = 30_000;
  // How many recent rollouts to scan when looking for the latest rate_limits event.
  private static readonly ROLLOUT_SCAN_LIMIT = 8;

  constructor(sessionsDir = join(homedir(), '.codex', 'sessions')) {
    this.sessionsDir = sessionsDir;
  }

  async getUsageLimits(): Promise<CodexUsageLimits | null> {
    const now = Date.now();
    if (this.cache && now - this.cache.timestamp < CodexUsageService.CACHE_TTL_MS) {
      return this.cache.data;
    }

    const result = this.computeUsageLimits(now);
    this.cache = { data: result, timestamp: now };
    return result;
  }

  /** Exposed for tests. */
  computeUsageLimits(now: number = Date.now()): CodexUsageLimits | null {
    const candidates = findRolloutCandidates(this.sessionsDir, CodexUsageService.ROLLOUT_SCAN_LIMIT);

    let aggregateLatest: { event: TokenCountEvent; rateLimits: RateLimitsPayload } | undefined;
    let aggregateWindowed: { event: TokenCountEvent; rateLimits: RateLimitsPayload } | undefined;

    for (const candidate of candidates) {
      const scan = readRolloutScan(candidate.path);
      if (!aggregateLatest && scan.latest) aggregateLatest = scan.latest;
      if (!aggregateWindowed && scan.windowed) aggregateWindowed = scan.windowed;
      if (aggregateLatest && aggregateWindowed) break;
    }

    if (!aggregateLatest && !aggregateWindowed) return null;

    const windowedSource = aggregateWindowed ?? aggregateLatest;
    const latestSource = aggregateLatest ?? aggregateWindowed;
    if (!windowedSource || !latestSource) return null;

    const result: CodexUsageLimits = {
      planType: latestSource.rateLimits.plan_type ?? windowedSource.rateLimits.plan_type,
      capturedAt: latestSource.event.timestamp,
    };

    const cycles: Array<{ minutes: number | undefined; window: RateLimitWindow | null | undefined }> = [
      { minutes: windowedSource.rateLimits.primary?.window_minutes, window: windowedSource.rateLimits.primary },
      { minutes: windowedSource.rateLimits.secondary?.window_minutes, window: windowedSource.rateLimits.secondary },
    ];
    for (const { minutes, window } of cycles) {
      const slot = classifyWindow(minutes);
      if (!slot) continue;
      const info = buildCycleInfo(window, now);
      if (info && !result[slot]) result[slot] = info;
    }

    // `credits.has_credits` only describes the separately purchased credit
    // balance and is commonly false while the included plan allowance is still
    // available. Codex exposes the actual blocking state explicitly instead.
    // If the last known cycle has already reset, do not keep a stale exhausted
    // verdict around while waiting for a fresh rollout event.
    const reachedType = latestSource.rateLimits.rate_limit_reached_type;
    const exhausted = typeof reachedType === 'string' && reachedType.length > 0;
    const constrainingCycle = result.fiveHour ?? result.sevenDay;
    const resetAtMs = constrainingCycle ? Date.parse(constrainingCycle.resetsAt) : Number.NaN;
    const resetExpired = Number.isFinite(resetAtMs) && now >= resetAtMs;
    if (exhausted && !resetExpired) {
      result.rateLimitExceeded = true;
    }

    if (!result.fiveHour && !result.sevenDay && !result.rateLimitExceeded) return null;
    return result;
  }
}
