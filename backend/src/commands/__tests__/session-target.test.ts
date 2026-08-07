import { describe, expect, test } from 'bun:test';
import { resolveSessionTarget } from '../session-target';

/**
 * Session resolution for the CLI commands an agent runs from inside its own
 * pane - `hrdle glasses` (#504) and `hrdle stt-prompt` (#210): cwd unique match
 * → /proc ancestor ↔ pane foreground pid (worktree defense) → --session
 * required.
 */

interface Pane {
  paneId: string;
  isActive?: boolean;
  pid?: number;
}

function session(id: string, currentPath: string, panes: Pane[]) {
  return { id, currentPath, panes };
}

describe('resolveSessionTarget', () => {
  test('unique exact cwd match resolves, preferring the active pane', () => {
    const sessions = [
      session('a', '/home/u/proj', [
        { paneId: '%0', isActive: false, pid: 100 },
        { paneId: '%1', isActive: true, pid: 101 },
      ]),
      session('b', '/home/u/other', [{ paneId: '%0', isActive: true, pid: 200 }]),
    ];
    const r = resolveSessionTarget(sessions, '/home/u/proj', new Set());
    expect(r).toEqual({ target: { sessionId: 'a', paneId: '%1' } });
  });

  test('prefix cwd match resolves (Bash tool in a subdirectory)', () => {
    const sessions = [
      session('a', '/home/u/proj', [{ paneId: '%0', isActive: true, pid: 100 }]),
      session('b', '/home/u/other', [{ paneId: '%0', isActive: true, pid: 200 }]),
    ];
    const r = resolveSessionTarget(sessions, '/home/u/proj/packages/x', new Set());
    expect(r).toEqual({ target: { sessionId: 'a', paneId: '%0' } });
  });

  test('nested projects: the deepest cwd prefix wins', () => {
    const sessions = [
      session('outer', '/home/u/proj', [{ paneId: '%0', isActive: true, pid: 100 }]),
      session('inner', '/home/u/proj/sub', [{ paneId: '%0', isActive: true, pid: 200 }]),
    ];
    const r = resolveSessionTarget(sessions, '/home/u/proj/sub/dir', new Set());
    expect(r).toEqual({ target: { sessionId: 'inner', paneId: '%0' } });
  });

  test('worktree: ambiguous cwd falls back to the ancestor pid match', () => {
    // Two sessions share one cwd (worktree); only one's agent is our ancestor.
    const sessions = [
      session('a', '/home/u/proj', [{ paneId: '%0', isActive: true, pid: 100 }]),
      session('b', '/home/u/proj', [{ paneId: '%3', isActive: false, pid: 200 }]),
    ];
    const ancestors = new Set([1, 50, 200, 201]); // our ppid chain includes pane b's agent
    const r = resolveSessionTarget(sessions, '/home/u/proj', ancestors);
    expect(r).toEqual({ target: { sessionId: 'b', paneId: '%3' } });
  });

  test('fully ambiguous (no cwd, no ancestor match) is an error', () => {
    const sessions = [
      session('a', '/home/u/proj', [{ paneId: '%0', pid: 100 }]),
      session('b', '/home/u/proj', [{ paneId: '%0', pid: 200 }]),
    ];
    const r = resolveSessionTarget(sessions, '/elsewhere', new Set([999]));
    expect('error' in r && r.error).toContain('--session');
  });

  test('ancestor match with several candidates is an error', () => {
    const sessions = [
      session('a', '/x/a', [{ paneId: '%0', pid: 100 }]),
      session('b', '/x/b', [{ paneId: '%0', pid: 200 }]),
    ];
    const r = resolveSessionTarget(sessions, '/elsewhere', new Set([100, 200]));
    expect('error' in r).toBe(true);
  });
});
