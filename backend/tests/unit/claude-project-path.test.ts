import { describe, expect, it } from 'bun:test';
import { claudeProjectDirName } from '../../src/utils/claude-project-path';

// The expectations here are not derived from the implementation: each one was
// measured by starting Claude Code 2.1.327 in that directory and reading back
// the bucket it created under ~/.claude/projects/.
describe('claudeProjectDirName', () => {
	it('collapses path separators', () => {
		expect(claudeProjectDirName('/home/m0a/repos/hrdle')).toBe('-home-m0a-repos-hrdle');
	});

	it('collapses dots', () => {
		expect(claudeProjectDirName('/home/m0a/.hrdle-dev/steward')).toBe(
			'-home-m0a--hrdle-dev-steward',
		);
	});

	it('collapses underscores', () => {
		expect(claudeProjectDirName('/tmp/probe_under.dir')).toBe('-tmp-probe-under-dir');
	});

	it('collapses non-ASCII, one dash per UTF-16 code unit', () => {
		// An astral character is two code units, so it becomes two dashes - the
		// implementation must not carry a `u` flag or this bucket stops matching.
		expect(claudeProjectDirName('/tmp/probe_ja日本🙂x')).toBe('-tmp-probe-ja----x');
	});

	it('leaves letters, digits and dashes alone', () => {
		expect(claudeProjectDirName('/home/m0a/repos/hrdle-work-1')).toBe(
			'-home-m0a-repos-hrdle-work-1',
		);
	});
});
