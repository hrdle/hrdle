import { describe, expect, test } from 'bun:test';
import { isFlatSegment, SessionHistoryService } from '../../src/services/session-history';

// Regression for #233: client-supplied projectDirName / sessionId are joined
// under ~/.claude/projects. Path-separator or `..` values must be rejected so
// they can't traverse out and enumerate/read arbitrary host files.

describe('isFlatSegment', () => {
  test('accepts real project dir names and session ids', () => {
    expect(isFlatSegment('-home-m0a-hrdle-work-1')).toBe(true);
    expect(isFlatSegment('54e8db01-6213-4169-8de9-1d2be2ac3513')).toBe(true);
  });

  test('rejects traversal / separator / empty values', () => {
    for (const v of ['../../../etc', '..', '.', '', 'a/b', 'a\\b', '/etc', 'x\0y', '../../home/m0a/.ssh']) {
      expect(isFlatSegment(v)).toBe(false);
    }
  });
});

describe('SessionHistoryService traversal inputs', () => {
  const svc = new SessionHistoryService();

  test('getProjectSessions rejects traversal dir name (returns [])', async () => {
    expect(await svc.getProjectSessions('../../../etc')).toEqual([]);
    expect(await svc.getProjectSessions('../..')).toEqual([]);
  });

  test('getConversation rejects traversal sessionId/projectDirName (returns [])', async () => {
    expect(await svc.getConversation('../../../../etc/passwd')).toEqual([]);
    expect(await svc.getConversation('passwd', '../../../../etc')).toEqual([]);
  });

  test('getSessionsMetadata skips traversal session ids', async () => {
    const r = await svc.getSessionsMetadata(['../../../etc/passwd', 'a/b']);
    expect(Object.keys(r)).toEqual([]);
  });
});
