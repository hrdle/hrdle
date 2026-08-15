import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../../shared/identity';
import { STEWARD_ENV } from '../steward-config';
import { startStewardRuntime, stewardHomeDir, stewardSessionName, stopStewardRuntime } from '../steward-runtime';

const DATA_DIR_ENV = IDENTITY.dataDirEnv;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    session: process.env.HERDR_SESSION,
    gate: process.env[STEWARD_ENV],
    dataDir: process.env[DATA_DIR_ENV],
  };
});

afterEach(() => {
  stopStewardRuntime();
  for (const [key, name] of [
    ['session', 'HERDR_SESSION'],
    ['gate', STEWARD_ENV],
    ['dataDir', DATA_DIR_ENV],
  ] as const) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key] as string;
  }
});

describe('where the steward lives', () => {
  // A fixed name would put a dev build's steward in the same session as the
  // installed one, and then two hrdles drive one observer.
  it('derives its session name from the one we are watching', () => {
    delete process.env.HERDR_SESSION;
    expect(stewardSessionName()).toBe('steward');

    process.env.HERDR_SESSION = 'steward-dev';
    expect(stewardSessionName()).toBe('steward-dev-steward');
  });

  it('keeps its home under the data directory, so a dev run is separated with it', () => {
    const scratch = join(tmpdir(), 'steward-home-test');
    process.env[DATA_DIR_ENV] = scratch;
    expect(stewardHomeDir()).toBe(join(scratch, 'steward'));
  });
});

describe('the gate', () => {
  it('starts nothing when off', () => {
    delete process.env[STEWARD_ENV];
    // Nothing to assert on directly - what matters is that it neither throws
    // nor spawns herdr. A started supervisor would keep the loop alive and the
    // test process would not exit.
    expect(() => startStewardRuntime(3457)).not.toThrow();
    expect(() => stopStewardRuntime()).not.toThrow();
  });
});
