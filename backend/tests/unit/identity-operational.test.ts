import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  HOOK_COMMAND,
  HOOK_COMMAND_PATTERN,
  IDENTITY,
  SERVICE,
} from '../../../shared/identity';
import { notifyCommandFor } from '../../src/services/notify-command';

/**
 * A third round of names that a rename would break without breaking anything
 * visibly — the same shape as the ones in #635 and #637, found while sorting
 * the remaining literals into "display" and "not display".
 *
 * What each one costs when it stops agreeing with the binary:
 *
 * - The systemd drop-in directory: `cchub debug enable` writes a unit override
 *   for a unit that no longer exists. systemd has nothing to complain about, so
 *   the inspector simply never turns on.
 * - The hook command: what gets written into the user's Claude/Codex config.
 *   Wrong, and notifications stop with no error anywhere.
 * - The hook pattern: how an already-installed hook is recognised. Stops
 *   matching and setup writes a second one next to the first.
 */

describe('systemd drop-in', () => {
  test('the drop-in directory belongs to the unit we restart', () => {
    // systemd only reads <unit>.d/, so these two agreeing is the whole feature.
    expect(SERVICE.dropInDir).toBe(`${SERVICE.unitFile}.d`);
  });
});

describe('hook command', () => {
  test('an absolute path to our binary is used as-is', () => {
    expect(notifyCommandFor(`/home/me/bin/${IDENTITY.binaryName}`)).toBe(
      `/home/me/bin/${IDENTITY.binaryName} notify`,
    );
  });

  test('running from a different binary falls back to the bare command', () => {
    // `bun run src/index.ts` makes execPath the bun binary, and `<bun> notify`
    // is not something anyone wants baked into their hooks.
    expect(notifyCommandFor('/home/me/.bun/bin/bun')).toBe(HOOK_COMMAND);
  });

  test('a path with spaces is quoted for the shell that runs it', () => {
    expect(notifyCommandFor(`/home/my name/${IDENTITY.binaryName}`)).toBe(
      `"/home/my name/${IDENTITY.binaryName}" notify`,
    );
  });
});

describe('hook detection pattern', () => {
  test('matches the bare command', () => {
    expect(HOOK_COMMAND_PATTERN.test(HOOK_COMMAND)).toBe(true);
  });

  test('matches an absolute path, which is what setup actually writes', () => {
    expect(
      HOOK_COMMAND_PATTERN.test(`/home/me/bin/${IDENTITY.binaryName} notify`),
    ).toBe(true);
  });

  test('does not match a different subcommand', () => {
    expect(HOOK_COMMAND_PATTERN.test(`${IDENTITY.binaryName} setup`)).toBe(false);
  });

  test('does not match a binary that merely ends with our name', () => {
    // `/usr/bin/notcchub notify` is somebody else's program.
    expect(HOOK_COMMAND_PATTERN.test(`not${IDENTITY.binaryName} notify`)).toBe(
      false,
    );
  });

  test('tolerates a name with regex metacharacters', () => {
    // Nothing today needs this, but the pattern is built by interpolation and a
    // future name containing a dot would otherwise match more than it should.
    expect(() => new RegExp(HOOK_COMMAND_PATTERN.source)).not.toThrow();
  });
});

/**
 * Scans for the literals themselves, because the assertions above cannot.
 *
 * They check that `dropInDir` is `unitFile` plus `.d`, which stays true no
 * matter what any call site does — and a call site holding its own
 * `'cchub.service.d'` is exactly how these three got missed by the two rounds
 * that came before. This is what those rounds were lacking.
 *
 * Deliberately narrow. It looks for names that have to agree with something
 * else to work, not for every mention of the product: comments and log lines
 * say the name for the reader's benefit and nothing breaks when they are stale.
 */
describe('no operational identity left as a literal', () => {
  // Composed from identity.json rather than written out, because a scan that
  // names one product keeps passing after that product is renamed — it just
  // stops looking for anything that exists. Renaming the file has to rename
  // what this looks for, or the guard quietly retires (#459).
  const esc = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const OPERATIONAL = [
    {
      pattern: new RegExp(`['"\`][^'"\`]*${esc(SERVICE.unitFile)}`),
      what: 'a systemd unit name',
    },
    {
      pattern: new RegExp(`['"\`][^'"\`]*${esc(IDENTITY.launchdPrefix)}`),
      what: 'a launchd label',
    },
    {
      pattern: new RegExp(`['"\`]/tmp/${esc(IDENTITY.tmpPrefix)}`),
      what: 'a scratch path',
    },
    {
      pattern: new RegExp(`['"\`][^'"\`]*${esc(IDENTITY.dataDirName)}['"\`/]`),
      what: 'the data directory',
    },
    { pattern: new RegExp(esc(IDENTITY.dataDirEnv)), what: 'the data directory env var' },
  ];

  // Where the literals are the point: identity.ts defines them, and the tests
  // assert against them on purpose.
  const ALLOWED = /shared\/identity\.ts$|\/tests\/|__tests__\//;

  test('backend and shared sources go through identity', async () => {
    const proc = Bun.spawnSync([
      'git',
      'ls-files',
      'backend/src',
      'shared',
      'frontend/src',
    ], { cwd: join(import.meta.dir, '..', '..', '..') });
    const files = new TextDecoder()
      .decode(proc.stdout)
      .split('\n')
      .filter((f) => /\.tsx?$/.test(f) && !ALLOWED.test(f));
    expect(files.length).toBeGreaterThan(50); // the scan actually found sources

    const offenders: string[] = [];
    for (const file of files) {
      const text = await Bun.file(
        join(import.meta.dir, '..', '..', '..', file),
      ).text();
      text.split('\n').forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) {
          return;
        }
        for (const { pattern, what } of OPERATIONAL) {
          if (pattern.test(line)) {
            offenders.push(`${file}:${i + 1} holds ${what}: ${code.slice(0, 70)}`);
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
