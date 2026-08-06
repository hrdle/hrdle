import { describe, expect, test } from 'bun:test';
import type { HerdrWorkspace } from '../herdr-client';
import { resolveByLabel, workspacesLabelled } from '../herdr';
import { planRekeys } from '../session-id-migration';

/**
 * A session's address used to be its workspace label - text a person edits,
 * and which the workspace-naming convention has every agent rewrite twice per
 * task. Renaming one sent the next message nowhere, and two workspaces sharing
 * a name sent it somewhere wrong with a 200 (#186).
 */

const ws = (workspace_id: string, label?: string): HerdrWorkspace =>
  ({ workspace_id, label }) as HerdrWorkspace;

describe('resolveByLabel', () => {
  test('resolves a name only one workspace carries', () => {
    const list = [ws('w1', 'life'), ws('w2', 'release work — 作業中')];
    expect(resolveByLabel(list, 'life')?.workspace_id).toBe('w1');
  });

  test('refuses an ambiguous name rather than taking the first', () => {
    // The failure this exists for: the caller is told which session it reached
    // by being told nothing reached one, instead of a 200 naming no workspace.
    const list = [ws('w1', '汎用'), ws('w2', '汎用')];
    expect(resolveByLabel(list, '汎用')).toBeNull();
  });

  test('is null for a name nothing carries', () => {
    expect(resolveByLabel([ws('w1', 'life')], 'gone')).toBeNull();
  });

  test('ignores surrounding whitespace on the stored label', () => {
    expect(resolveByLabel([ws('w1', ' life ')], 'life')?.workspace_id).toBe('w1');
  });
});

describe('workspacesLabelled', () => {
  test('returns every workspace with the name, which is what "is it taken" needs', () => {
    const list = [ws('w1', '汎用'), ws('w2', '汎用'), ws('w3', 'life')];
    expect(workspacesLabelled(list, '汎用').map((w) => w.workspace_id)).toEqual(['w1', 'w2']);
  });
});

describe('planRekeys', () => {
  const live = [ws('w1', 'life'), ws('w2', 'グラス開発'), ws('w3', '汎用'), ws('w4', '汎用')];

  test('moves a label-keyed entry onto the workspace that carries the label', () => {
    expect(planRekeys(['life', 'グラス開発'], live)).toEqual([
      { from: 'life', to: 'w1' },
      { from: 'グラス開発', to: 'w2' },
    ]);
  });

  test('leaves an ambiguous label alone rather than colouring the wrong session', () => {
    expect(planRekeys(['汎用'], live)).toEqual([]);
  });

  test('leaves an orphan whose workspace is gone', () => {
    expect(planRekeys(['hrdle-work-1'], live)).toEqual([]);
  });

  test('never overwrites settings a workspace id already has', () => {
    // `w1` was written after the change; `life` is the same session's older
    // entry. The newer one wins - the older one is what a rename abandoned.
    expect(planRekeys(['w1', 'life'], live)).toEqual([]);
  });

  test('two names cannot both claim one workspace', () => {
    // Contrived, but the guard is what keeps the second move from silently
    // replacing the first one's settings.
    const one = [ws('w1', 'same')];
    expect(planRekeys(['same', 'same'], one)).toEqual([{ from: 'same', to: 'w1' }]);
  });

  test('an already-migrated file is a no-op', () => {
    expect(planRekeys(['w1', 'w2'], live)).toEqual([]);
  });
});
