import { describe, expect, test } from 'bun:test';
import { FileChangeTracker } from '../../src/services/file-change-tracker';

describe('FileChangeTracker', () => {
  // Note: These tests use the actual ~/.claude/projects directory
  // They verify the service works correctly with real or missing data
  const tracker = new FileChangeTracker();

  describe('getChangesForSessionId', () => {
    test('should return an array', async () => {
      const changes = await tracker.getChangesForSessionId('/some/path', 'some-session-id');
      expect(Array.isArray(changes)).toBe(true);
    });

    test('should return empty array for unknown session', async () => {
      const changes = await tracker.getChangesForSessionId('/home/user/project', 'nonexistent-session-xyz');
      expect(changes).toEqual([]);
    });
  });
});
