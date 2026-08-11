import { describe, test, expect } from 'bun:test';
import { claudeProjectDirName } from '../claude-project-path';

// The five Claude-projects callers (session-metrics, file-change-tracker,
// conversation-watcher, codex-history, claude-code) all now share this
// helper; lock down its contract so a future refactor can't silently break
// paths-containing-dots again.
describe('claudeProjectDirName', () => {
  test('collapses both slashes and dots', () => {
    expect(claudeProjectDirName('/home/m0a/repo/github.com/m0a/hrdle')).toBe(
      '-home-m0a-repo-github-com-m0a-hrdle',
    );
    expect(claudeProjectDirName('/Users/x/.config/foo')).toBe('-Users-x--config-foo');
  });

  test('plain ASCII path without dots is slash-collapsed', () => {
    expect(claudeProjectDirName('/home/m0a/hrdle')).toBe('-home-m0a-hrdle');
  });

  test('empty string maps to empty string', () => {
    expect(claudeProjectDirName('')).toBe('');
  });

  test('dot-only segments are still flattened', () => {
    expect(claudeProjectDirName('a.b.c')).toBe('a-b-c');
  });
});
