/**
 * Where the steward's files live.
 *
 * A leaf on purpose. These are read by the one-shot CLIs, and importing them
 * from the runtime dragged in `routes/terminal-mux` and the whole session tree
 * behind it - which leaves handles open and would keep `hrdle steward` alive
 * after its work if the CLI path ever stopped calling `process.exit`.
 */

import { join } from 'node:path';
import { getDataDir } from '../utils/storage';

/** Where the observer runs, and where its own notes live. */
export function stewardHomeDir(): string {
  return join(getDataDir(), 'steward');
}

/**
 * What the observer should be looking at, written where its tools can read it.
 *
 * herdr exports `HERDR_SOCKET_PATH` into every pane, so a bare `herdr agent
 * list` inside the observer's pane enumerates the observer and nothing else
 * (measured). Pointing the workspace at the default socket instead is worse:
 * the agent integration hook then reports the observer's pane id to the very
 * server it is watching.
 */
export const TARGET_FILE = 'target.json';

export interface StewardTarget {
  /** The herdr server the steward observes - the default one, i.e. the user's. */
  socketPath: string;
  session: string | null;
  /** Where `hrdle steward` should deliver, so the observer never passes `-p`. */
  port: number;
}
