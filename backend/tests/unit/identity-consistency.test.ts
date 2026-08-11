import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  assetName,
  IDENTITY,
  SERVICE,
  TMP_PATHS,
} from '../../../shared/identity';

/**
 * `identity.json` is the single source of truth for what this product is
 * called, but two consumers cannot read it:
 *
 * - `install.sh` is fetched and piped straight to bash, so there is no checkout
 *   on disk to read the file from — and it could not bootstrap one anyway, since
 *   the repository to clone is itself a value in the file.
 * - `.github/workflows/release.yml` builds its matrix from literals, which
 *   Actions evaluates before any step could run `jq`.
 *
 * Both therefore keep their own copies, and this test is what keeps the copies
 * honest. A rename that misses one of them produces an installer that downloads
 * an asset the release never published — which only shows up at install time,
 * on someone else's machine.
 */

const ROOT = join(import.meta.dir, '..', '..', '..');

async function read(relative: string): Promise<string> {
  return await Bun.file(join(ROOT, relative)).text();
}

describe('install.sh agrees with identity.json', () => {
  test('downloads from the release repository', async () => {
    const sh = await read('install.sh');
    expect(sh).toContain(`https://api.github.com/repos/${IDENTITY.repo}/releases/latest`);
  });

  test('names both published assets', async () => {
    const sh = await read('install.sh');
    expect(sh).toContain(assetName('linux', 'x64'));
    expect(sh).toContain(assetName('macos', 'arm64'));
  });

  test('installs under the binary name', async () => {
    const sh = await read('install.sh');
    expect(sh).toContain(`install_dir/${IDENTITY.binaryName}`);
  });

  test('advertises the default port', async () => {
    const sh = await read('install.sh');
    expect(sh).toContain(String(IDENTITY.defaultPort));
  });
});

describe('release.yml agrees with identity.json', () => {
  test('builds and uploads both assets', async () => {
    const yml = await read('.github/workflows/release.yml');
    for (const asset of [assetName('linux', 'x64'), assetName('macos', 'arm64')]) {
      // Once as the matrix artifact, once in the upload list at minimum.
      expect(yml.split(asset).length - 1).toBeGreaterThanOrEqual(2);
    }
  });

  test('renames the built binary from the binary name', async () => {
    const yml = await read('.github/workflows/release.yml');
    expect(yml).toContain(`dist/${IDENTITY.binaryName} `);
  });
});

describe('derived service names', () => {
  test('systemd units all descend from serviceName', () => {
    expect(SERVICE.unitFile).toBe(`${IDENTITY.serviceName}.service`);
    expect(SERVICE.updateUnitFile).toBe(`${IDENTITY.serviceName}-update.service`);
    expect(SERVICE.updateTimerFile).toBe(`${IDENTITY.serviceName}-update.timer`);
  });

  test('launchd labels all descend from launchdPrefix', () => {
    expect(SERVICE.launchdServerLabel).toBe(`${IDENTITY.launchdPrefix}.server`);
    expect(SERVICE.launchdUpdateLabel).toBe(`${IDENTITY.launchdPrefix}.update`);
    expect(SERVICE.launchdServerPlist).toBe(`${SERVICE.launchdServerLabel}.plist`);
    expect(SERVICE.launchdUpdatePlist).toBe(`${SERVICE.launchdUpdateLabel}.plist`);
  });

  test('asset names match what update.ts asks GitHub for', () => {
    expect(assetName('linux', 'x64')).toBe(`${IDENTITY.assetPrefix}-linux-x64`);
    expect(assetName('macos', 'arm64')).toBe(`${IDENTITY.assetPrefix}-macos-arm64`);
  });
});

/**
 * These are the paths of files that exist on running installs. A refactor that
 * moves one of them does not fail — it silently starts reading an empty
 * history, or serving uploads from a directory nothing writes to. So they are
 * spelled out here rather than derived, and moving one is a deliberate edit to
 * this file.
 *
 * The rename (#459) is such an edit. It also has to keep these clear of the
 * hrdle install they replace, which keeps its own files under the same /tmp
 * while the two run side by side.
 */
describe('scratch paths only move when someone means to move them', () => {
  test('images dir is the one path all three consumers resolve to', () => {
    expect(TMP_PATHS.imagesDir).toBe('/tmp/hrdle-images');
  });

  test('usage history file carries our own prefix', () => {
    expect(TMP_PATHS.usageHistoryFile).toBe('/tmp/hrdle-usage-history.json');
  });

  test('browser log is spelled the way CLAUDE.md tells people to tail it', () => {
    expect(TMP_PATHS.browserLogFile).toBe('/tmp/hrdle-browser.log');
  });

  test('keychain service name is our own', () => {
    // The macOS password lives under this service name. Changing it does not
    // fail — it just stops finding the password already stored, which is what
    // a separate product should do: hrdle's password stays hrdle's.
    expect(IDENTITY.keychainService).toBe('hrdle');
  });
});
