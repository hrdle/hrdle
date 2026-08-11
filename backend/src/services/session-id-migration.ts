import type { HerdrWorkspace } from './herdr-client';
import { listWorkspaces } from './herdr-client';
import { getAllSessionMetadata, rekeySessionMetadata } from './session-metadata';
import { workspacesLabelled } from './herdr';

/**
 * Move settings written against a workspace *name* onto its workspace id.
 *
 * Session metadata - a theme, a custom title, a session's STT vocabulary - was
 * keyed by the same mutable id the addressing bug was about, so every rename
 * quietly abandoned that session's settings. Six such orphans were sitting in
 * the file on the machine this was found on (`Welcome`, `parallel-check`,
 * `hrdle-work-1`, ...), each one a theme somebody chose and then watched
 * disappear without being told why.
 *
 * Runs once at startup and is deliberately conservative: it only moves a key
 * when exactly one live workspace carries that name and the destination has no
 * settings of its own. Anything else is left where it is - a wrong guess here
 * paints a session in a colour chosen for a different one, and the orphan it
 * would have fixed costs only what it already cost.
 */

export interface Rekey {
  from: string;
  to: string;
}

/**
 * Which label-keyed entries can be moved onto a workspace id, given the live
 * workspace list. Pure, so the rules above are testable without a herdr.
 */
export function planRekeys(keys: string[], workspaces: HerdrWorkspace[]): Rekey[] {
  const ids = new Set(workspaces.map((w) => w.workspace_id));
  const taken = new Set(keys.filter((key) => ids.has(key)));
  const plan: Rekey[] = [];
  for (const key of keys) {
    // Already an id: nothing to do, and nothing to overwrite it with.
    if (ids.has(key)) continue;
    const matches = workspacesLabelled(workspaces, key);
    if (matches.length !== 1) continue;
    const to = matches[0].workspace_id;
    // Two names cannot both claim one workspace, and a workspace that already
    // has settings keeps them: the id-keyed entry is the newer of the two.
    if (taken.has(to)) continue;
    taken.add(to);
    plan.push({ from: key, to });
  }
  return plan;
}

/**
 * Best-effort, and quiet when there is nothing to say. A failure here costs the
 * settings that were already lost before it ran, so it must never keep the
 * server from starting.
 */
export async function migrateSessionIds(): Promise<Rekey[]> {
  try {
    const [metadata, workspaces] = await Promise.all([
      getAllSessionMetadata(),
      listWorkspaces(),
    ]);
    const plan = planRekeys(Object.keys(metadata), workspaces);
    if (plan.length === 0) return [];
    await rekeySessionMetadata(plan);
    for (const { from, to } of plan) {
      console.log(`[session-metadata] moved settings for "${from}" onto ${to}`);
    }
    return plan;
  } catch (err) {
    console.warn('[session-metadata] id migration skipped:', err);
    return [];
  }
}
