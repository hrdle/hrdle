/**
 * Whether a newer release of hrdle itself exists.
 *
 * The self-updater has always known this — `hrdle update --check` asks GitHub
 * and prints the answer — but only to a terminal nobody has open. The dashboard
 * is where the question gets asked in practice ("am I running the current
 * thing?"), so the same lookup is surfaced there beside herdr's.
 *
 * Reporting only. Installing stays with `hrdle update`, which replaces the
 * running binary and restarts the service.
 */

import { VERSION } from '../cli';
import { fetchLatestReleaseTag, isNewerVersion } from '../commands/update';
import type { HrdleUpdateStatus } from '../../../shared/types';

/** Releases are a human act; asking GitHub more often than this buys nothing. */
const TTL_MS = 6 * 60 * 60 * 1000;
/**
 * Unauthenticated GitHub allows 60 requests an hour for the whole host. The
 * dashboard polls every few seconds, so a failure that retried freely would
 * spend the budget in a minute and take `hrdle update` down with it.
 */
const BACKOFF_MS = 30 * 60 * 1000;

class HrdleUpdateService {
  private latest: string | undefined;
  private latestAt = 0;
  private failedAt = 0;
  private inFlight: Promise<string | undefined> | null = null;

  /** Never throws: an unreachable GitHub reports the current version and no verdict. */
  async getStatus(): Promise<HrdleUpdateStatus> {
    const latestVersion = await this.readLatest();
    return {
      currentVersion: VERSION,
      latestVersion,
      updateAvailable: latestVersion ? isNewerVersion(latestVersion, VERSION) : undefined,
    };
  }

  private async readLatest(): Promise<string | undefined> {
    const now = Date.now();
    if (this.latest && now - this.latestAt < TTL_MS) return this.latest;
    // A failure keeps serving the last good answer rather than retracting a
    // notice the user is looking at.
    if (now - this.failedAt < BACKOFF_MS) return this.latest;
    if (this.inFlight) return this.inFlight;

    this.inFlight = fetchLatestReleaseTag()
      .then((tag) => {
        if (!tag) {
          this.failedAt = Date.now();
          return this.latest;
        }
        this.latest = tag.replace(/^v/i, '');
        this.latestAt = Date.now();
        return this.latest;
      })
      .catch(() => {
        this.failedAt = Date.now();
        return this.latest;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

export const hrdleUpdateService = new HrdleUpdateService();
