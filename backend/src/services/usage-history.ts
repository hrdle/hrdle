import { readFile, writeFile } from 'node:fs/promises';
import type { UsageScopedLimit, UsageSnapshot } from '../../../shared/types';
import { TMP_PATHS } from '../../../shared/identity';

const HISTORY_FILE = TMP_PATHS.usageHistoryFile;
const THROTTLE_MS = 30 * 1000; // 30 seconds
const MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000; // 8 days

function onlySnapshots(items: unknown[]): UsageSnapshot[] {
  return items.filter(
    (s): s is UsageSnapshot =>
      !!s && typeof s === 'object' && 'timestamp' in (s as Record<string, unknown>),
  );
}

export class UsageHistoryService {
  private lastRecordTime = 0;

  async getHistory(): Promise<UsageSnapshot[]> {
    try {
      const content = await readFile(HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? onlySnapshots(parsed) : [];
    } catch {
      return [];
    }
  }

  async recordSnapshot(
    fiveHour: { utilization: number; resetsAt: string },
    sevenDay: { utilization: number; resetsAt: string },
    scopedLimits?: UsageScopedLimit[],
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastRecordTime < THROTTLE_MS) {
      return;
    }
    this.lastRecordTime = now;

    const snapshots = await this.getHistory();

    const snapshot: UsageSnapshot = {
      timestamp: new Date(now).toISOString(),
      fiveHour: { utilization: fiveHour.utilization, resetsAt: fiveHour.resetsAt },
      sevenDay: { utilization: sevenDay.utilization, resetsAt: sevenDay.resetsAt },
    };

    // Omit the key entirely when there are no scoped limits, so a plan without
    // them doesn't grow every snapshot by an empty object.
    if (scopedLimits?.length) {
      snapshot.scoped = Object.fromEntries(
        scopedLimits.map((l) => [l.key, { utilization: l.utilization, resetsAt: l.resetsAt }]),
      );
    }

    snapshots.push(snapshot);

    // Prune old snapshots (older than 8 days)
    const cutoff = now - MAX_AGE_MS;
    const pruned = snapshots.filter(s => new Date(s.timestamp).getTime() > cutoff);

    try {
      await writeFile(HISTORY_FILE, JSON.stringify(pruned));
    } catch (err) {
      console.error('Failed to write usage history:', err);
    }
  }
}
