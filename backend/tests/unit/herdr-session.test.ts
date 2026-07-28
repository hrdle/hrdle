import { afterEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import {
  herdrChildEnv,
  herdrSessionName,
  herdrSocketPath,
} from '../../src/services/herdr-client';

/**
 * Which herdr server this process talks to (#459). Two builds of this app on
 * one machine stay out of each other's panes by running against different herdr
 * sessions, so resolving the wrong socket does not fail — it quietly drives
 * somebody else's terminals.
 */

const ORIGINAL_SESSION = process.env.HERDR_SESSION;
const ORIGINAL_SOCKET = process.env.HERDR_SOCKET_PATH;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore('HERDR_SESSION', ORIGINAL_SESSION);
  restore('HERDR_SOCKET_PATH', ORIGINAL_SOCKET);
});

describe('herdrSocketPath', () => {
  test('falls back to the default session socket', () => {
    delete process.env.HERDR_SESSION;
    delete process.env.HERDR_SOCKET_PATH;

    expect(herdrSocketPath()).toBe(`${homedir()}/.config/herdr/herdr.sock`);
  });

  test('resolves a named session to its own socket', () => {
    delete process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SESSION = 'hrdle';

    expect(herdrSocketPath()).toBe(
      `${homedir()}/.config/herdr/sessions/hrdle/herdr.sock`,
    );
  });

  test('a named session beats an inherited socket', () => {
    // herdr exports HERDR_SOCKET_PATH into every pane it runs, so this app
    // launched from a terminal inside another copy of it inherits a socket
    // nobody chose. If that won, the two would share a herdr server — the
    // collision named sessions exist to prevent, via the one route where it
    // looks like it is working.
    process.env.HERDR_SOCKET_PATH = `${homedir()}/.config/herdr/herdr.sock`;
    process.env.HERDR_SESSION = 'hrdle';

    expect(herdrSocketPath()).toBe(
      `${homedir()}/.config/herdr/sessions/hrdle/herdr.sock`,
    );
  });

  test('an explicit socket still works when no session is named', () => {
    delete process.env.HERDR_SESSION;
    process.env.HERDR_SOCKET_PATH = '/run/somewhere/herdr.sock';

    expect(herdrSocketPath()).toBe('/run/somewhere/herdr.sock');
  });

  test('an empty session name is not a session', () => {
    process.env.HERDR_SESSION = '';
    delete process.env.HERDR_SOCKET_PATH;

    expect(herdrSessionName()).toBeNull();
    expect(herdrSocketPath()).toBe(`${homedir()}/.config/herdr/herdr.sock`);
  });
});

describe('herdrChildEnv', () => {
  test('pins children to the resolved socket rather than leaving it inherited', () => {
    // A child spawned from a systemd unit has no ambient HERDR_SOCKET_PATH and
    // would otherwise fall back to the default socket, driving panes in a
    // session this process is not talking to.
    process.env.HERDR_SESSION = 'hrdle';
    delete process.env.HERDR_SOCKET_PATH;

    expect(herdrChildEnv().HERDR_SOCKET_PATH).toBe(
      `${homedir()}/.config/herdr/sessions/hrdle/herdr.sock`,
    );
  });

  test('overrides an inherited socket that disagrees', () => {
    process.env.HERDR_SESSION = 'hrdle';
    process.env.HERDR_SOCKET_PATH = `${homedir()}/.config/herdr/herdr.sock`;

    expect(herdrChildEnv().HERDR_SOCKET_PATH).toBe(
      `${homedir()}/.config/herdr/sessions/hrdle/herdr.sock`,
    );
  });

  test('keeps the rest of the environment', () => {
    process.env.HERDR_SESSION = 'hrdle';

    expect(herdrChildEnv().PATH).toBe(process.env.PATH as string);
  });
});
