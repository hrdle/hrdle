import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, createMutationLock, ensureDataDir } from '../utils/storage';

/**
 * Completed days of Kimi spend, kept so the chart is not stuck at seven.
 *
 * The seven-day limit is not a choice, it is how far back `kimi-usage.ts` can
 * see: the aggregation reads `wire.jsonl` under a rolling cutoff, and a day
 * that falls out of it is gone. But a *finished* local day never changes -
 * nothing can append a record dated yesterday - so once computed it can simply
 * be written down and never recomputed.
 *
 * Which is why this needs no timer. The rollup happens inside the aggregation
 * that was going to run anyway (the dashboard's own build, plus the warm-up
 * shortly after boot), and it writes only when a day's figure is new or has
 * changed. A day is lost only if the server saw none of the seven days it
 * belonged to, which means a week of downtime.
 *
 * A day's cost is priced at the list price in force when it was rolled up.
 * That is deliberate: it is closer to what was actually billed than
 * re-pricing history at today's rates would be.
 */

const STORE_FILE = 'kimi-daily-usage.json';
/** Roughly a year. The file is a few tens of KB at that size. */
const RETAIN_DAYS = 400;
const STORE_VERSION = 1;

export interface StoredDay {
  turns: number;
  totalTokens: number;
  /** Absent means the day's models had no price, never that it was free. */
  costUsd?: number;
}

interface StoreFile {
  version: number;
  /**
   * Keyed by local `YYYY-MM-DD`. **Presence is the record that the day was
   * observed at all** - a day with zero turns is stored as zeroes, and a day
   * missing from here is one this server never saw, which is a different
   * thing and must not be drawn as a quiet day.
   */
  days: Record<string, StoredDay>;
}

const withStoreLock = createMutationLock();

function isStoredDay(value: unknown): value is StoredDay {
  if (typeof value !== 'object' || value === null) return false;
  const day = value as Record<string, unknown>;
  return typeof day.turns === 'number' && typeof day.totalTokens === 'number';
}

function parse(text: string): Map<string, StoredDay> {
  const days = new Map<string, StoredDay>();
  const parsed = JSON.parse(text) as Partial<StoreFile>;
  if (!parsed || typeof parsed !== 'object' || !parsed.days) return days;
  for (const [date, day] of Object.entries(parsed.days)) {
    // A hand-edited or half-written file should cost the days it broke, not
    // every day in the file.
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && isStoredDay(day)) {
      days.set(date, {
        turns: day.turns,
        totalTokens: day.totalTokens,
        costUsd: typeof day.costUsd === 'number' ? day.costUsd : undefined,
      });
    }
  }
  return days;
}

function sameDay(a: StoredDay | undefined, b: StoredDay): boolean {
  return (
    a !== undefined &&
    a.turns === b.turns &&
    a.totalTokens === b.totalTokens &&
    a.costUsd === b.costUsd
  );
}

/**
 * Merge freshly computed days over what is on disk, dropping anything past the
 * retention horizon. Returns null when nothing changed, so the caller can skip
 * the write - this runs on every dashboard build, and most of them have
 * nothing new to say.
 */
export function mergeDays(
  stored: Map<string, StoredDay>,
  computed: Map<string, StoredDay>,
  oldestKept: string,
): Map<string, StoredDay> | null {
  const merged = new Map(stored);
  let changed = false;
  for (const [date, day] of computed) {
    if (!sameDay(merged.get(date), day)) {
      merged.set(date, day);
      changed = true;
    }
  }
  for (const date of merged.keys()) {
    if (date < oldestKept) {
      merged.delete(date);
      changed = true;
    }
  }
  return changed ? merged : null;
}

export class KimiUsageStore {
  private cache: Map<string, StoredDay> | null = null;

  async load(): Promise<Map<string, StoredDay>> {
    if (this.cache) return this.cache;
    let days: Map<string, StoredDay>;
    try {
      days = parse(await readFile(join(await ensureDataDir(), STORE_FILE), 'utf-8'));
    } catch {
      // No file yet, or an unreadable one. Either way the live seven days are
      // still there - history starts accumulating from now.
      days = new Map();
    }
    this.cache = days;
    return days;
  }

  /**
   * Write down completed days. Today is never passed in: it is still being
   * added to, and a partial day stored as final would freeze at whatever the
   * clock read when the panel was last open.
   */
  async record(completed: Map<string, StoredDay>, oldestKept: string): Promise<void> {
    if (completed.size === 0) return;
    await withStoreLock(async () => {
      const stored = await this.load();
      const merged = mergeDays(stored, completed, oldestKept);
      if (!merged) return;
      this.cache = merged;
      const file: StoreFile = {
        version: STORE_VERSION,
        days: Object.fromEntries([...merged].sort(([a], [b]) => a.localeCompare(b))),
      };
      try {
        await atomicWriteFile(
          join(await ensureDataDir(), STORE_FILE),
          JSON.stringify(file, null, 2),
        );
      } catch (err) {
        // A dashboard that cannot write its history file still has one to
        // show; losing a day of history is not worth failing the request.
        console.warn('[kimi-usage] failed to persist daily history:', err);
      }
    });
  }

  static get retainDays(): number {
    return RETAIN_DAYS;
  }
}
