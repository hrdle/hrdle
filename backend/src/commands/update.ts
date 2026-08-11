// hrdle update command - check and apply updates from GitHub Releases

import { createHash } from 'node:crypto';
import { copyFile, rename, chmod, readFile, unlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  assetName,
  IDENTITY,
  SERVICE,
  userAgent,
} from '../../../shared/identity';
import { VERSION } from '../cli';
import { t } from '../i18n';

const SHA256SUMS_ASSET = 'SHA256SUMS';

/**
 * Verify the first bytes of the downloaded buffer look like a real executable
 * for our target platform. Defense in depth against a tampered/corrupted
 * download even before the SHA-256 check runs.
 */
export function isExecutableMagic(bytes: Uint8Array, binaryName: string): boolean {
  if (bytes.length < 4) return false;
  const b0 = bytes[0] as number;
  const b1 = bytes[1] as number;
  const b2 = bytes[2] as number;
  const b3 = bytes[3] as number;
  if (binaryName.includes('linux')) {
    // ELF: 0x7f 'E' 'L' 'F'
    return b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46;
  }
  if (binaryName.includes('macos') || binaryName.includes('darwin')) {
    // Mach-O thin (64-bit LE on disk = cf fa ed fe), 32-bit (ce fa ed fe),
    // or Universal/fat (cafebabe / cafebabf).
    if (b0 === 0xcf && b1 === 0xfa && b2 === 0xed && b3 === 0xfe) return true;
    if (b0 === 0xce && b1 === 0xfa && b2 === 0xed && b3 === 0xfe) return true;
    if (b0 === 0xca && b1 === 0xfe && b2 === 0xba && (b3 === 0xbe || b3 === 0xbf)) return true;
    return false;
  }
  // Unknown platform — be permissive rather than block updates we don't
  // recognise. The SHA-256 check still applies.
  return true;
}

/**
 * Parse a SHA256SUMS file (one "<hex>  <name>" per line, optional '*' before
 * the name for binary mode) and return the lowercase hash for `binaryName`,
 * or null if absent.
 */
export function parseSha256Sums(text: string, binaryName: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(\S.*)$/);
    if (m && m[2] === binaryName) return m[1].toLowerCase();
  }
  return null;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Read the binary path registered in the systemd/launchd service file */
async function getServiceBinaryPath(): Promise<string | null> {
  const isDarwin = platform() === 'darwin';
  try {
    if (isDarwin) {
      const plistPath = join(
        homedir(),
        'Library',
        'LaunchAgents',
        SERVICE.launchdServerPlist,
      );
      const content = await readFile(plistPath, 'utf-8');
      // Extract first <string> after <key>ProgramArguments</key> array
      const match = content.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);
      return match?.[1] ?? null;
    } else {
      const servicePath = join(
        homedir(),
        '.config',
        'systemd',
        'user',
        SERVICE.unitFile,
      );
      const content = await readFile(servicePath, 'utf-8');
      // Extract exec path from: ExecStart=/bin/zsh -lc 'exec /path/to/hrdle ...'
      const bin = IDENTITY.binaryName;
      const match =
        content.match(new RegExp(`exec\\s+(\\S+${bin})\\b`)) ||
        content.match(new RegExp(`ExecStart=(\\S+${bin})\\b`));
      return match?.[1] ?? null;
    }
  } catch {
    return null;
  }
}

const GITHUB_REPO = IDENTITY.repo;

function getBinaryName(): string {
  const platform = process.platform; // 'linux', 'darwin', etc.
  const arch = process.arch; // 'x64', 'arm64', etc.

  if (platform === 'linux' && arch === 'x64') {
    return assetName('linux', 'x64');
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return assetName('macos', 'arm64');
  }

  // Fallback: try platform-arch pattern
  const platformName = platform === 'darwin' ? 'macos' : platform;
  return assetName(platformName, arch);
}

interface GitHubRelease {
  tag_name: string;
  assets: {
    name: string;
    browser_download_url: string;
  }[];
}

interface GitHubTokenInfo {
  token: string;
  source: 'GITHUB_TOKEN' | 'GH_TOKEN' | 'gh CLI';
}

function getGitHubToken(): GitHubTokenInfo | null {
  if (process.env.GITHUB_TOKEN) {
    return { token: process.env.GITHUB_TOKEN, source: 'GITHUB_TOKEN' };
  }
  if (process.env.GH_TOKEN) {
    return { token: process.env.GH_TOKEN, source: 'GH_TOKEN' };
  }
  try {
    const proc = Bun.spawnSync(['gh', 'auth', 'token'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode === 0) {
      const token = new TextDecoder().decode(proc.stdout).trim();
      if (token) return { token, source: 'gh CLI' };
    }
  } catch {
    // gh not installed — fall through
  }
  return null;
}

async function getLatestRelease(tokenInfo: GitHubTokenInfo | null): Promise<GitHubRelease | null> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': userAgent(VERSION),
  };
  if (tokenInfo) {
    headers.Authorization = `Bearer ${tokenInfo.token}`;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers }
    );

    if (response.ok) {
      return await response.json();
    }
    if (response.status === 404) {
      return null;
    }
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      console.error(`${t(tokenInfo ? 'update.rateLimitedAuth' : 'update.rateLimitedAnon')}`);
      const resetHeader = response.headers.get('x-ratelimit-reset');
      if (resetHeader) {
        const resetDate = new Date(parseInt(resetHeader, 10) * 1000);
        console.error(`   ${t('update.rateLimitResetAt', { time: resetDate.toLocaleString() })}`);
      }
      if (!tokenInfo) {
        console.error(`${t('update.rateLimitHintAnon')}`);
        console.error('   - export GITHUB_TOKEN=<token>');
        console.error('   - gh auth login');
      }
      return null;
    }
    throw new Error(`GitHub API error: ${response.status}`);
  } catch (_error) {
    console.error(`${t('update.githubConnectionFailed')}`);
    return null;
  }
}

/**
 * The newest published release tag, for callers that only want to *report*
 * whether one exists — the dashboard's version panel. `checkAndUpdate` remains
 * the only path that acts on it.
 */
export async function fetchLatestReleaseTag(): Promise<string | null> {
  const release = await getLatestRelease(getGitHubToken());
  return release?.tag_name ?? null;
}

function parseVersion(version: string): number[] {
  // Remove 'v' prefix if present
  const clean = version.replace(/^v/, '');
  return clean.split('.').map(n => parseInt(n, 10));
}

export function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = parseVersion(latest);
  const currentParts = parseVersion(current);

  for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
    const l = latestParts[i] || 0;
    const c = currentParts[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

async function fetchExpectedSha256(
  release: GitHubRelease,
  binaryName: string,
): Promise<string | null> {
  const asset = release.assets.find((a) => a.name === SHA256SUMS_ASSET);
  if (!asset) return null;
  try {
    const res = await fetch(asset.browser_download_url);
    if (!res.ok) return null;
    return parseSha256Sums(await res.text(), binaryName);
  } catch {
    return null;
  }
}

/**
 * Download the binary into `destPath` and verify it before returning. Verifies
 * (a) the byte count against Content-Length when the server provided one,
 * (b) the executable magic bytes for the target platform, and
 * (c) the SHA-256 against the value published in the release's SHA256SUMS.
 * Any failure deletes `destPath` and returns false so the caller never renames
 * an unverified file over the running service binary.
 */
async function downloadBinary(
  url: string,
  destPath: string,
  expectedSha256: string,
  binaryName: string,
): Promise<boolean> {
  try {
    console.log('Downloading...');
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    const declared = response.headers.get('content-length');
    if (declared !== null) {
      const expected = Number.parseInt(declared, 10);
      if (Number.isFinite(expected) && expected !== bytes.byteLength) {
        throw new Error(
          `Length mismatch: got ${bytes.byteLength} bytes but Content-Length was ${expected}`,
        );
      }
    }

    if (!isExecutableMagic(bytes, binaryName)) {
      throw new Error('Downloaded file is not a recognised executable for this platform');
    }

    const actualSha = sha256Hex(bytes);
    if (actualSha !== expectedSha256) {
      throw new Error(
        `Checksum mismatch: expected ${expectedSha256}, got ${actualSha}. Aborting to avoid running an untrusted binary.`,
      );
    }

    await Bun.write(destPath, buffer);
    await chmod(destPath, 0o755);

    return true;
  } catch (error) {
    console.error('Download failed:', error);
    try {
      await unlink(destPath);
    } catch {
      // best-effort cleanup of the partial file
    }
    return false;
  }
}

export async function checkAndUpdate(checkOnly: boolean, autoMode: boolean): Promise<void> {
  const currentVersion = VERSION;

  if (!autoMode) {
    console.log(`Checking for updates... (current: v${currentVersion})`);
  }

  const tokenInfo = getGitHubToken();
  if (tokenInfo && !autoMode) {
    console.log(`${t('update.authUsing', { source: tokenInfo.source })}`);
  }

  const release = await getLatestRelease(tokenInfo);

  if (!release) {
    if (!autoMode) {
      console.log('Could not fetch the release information');
    }
    return;
  }

  const latestVersion = release.tag_name;

  if (!isNewerVersion(latestVersion, currentVersion)) {
    if (!autoMode) {
      console.log(`Already up to date (v${currentVersion})`);
    }
    return;
  }

  console.log(`A new version is available: ${latestVersion}`);

  if (checkOnly) {
    console.log('');
    // The one line here that tells the reader what to type. Spelled out, a
    // renamed build hands them a command that does not exist.
    console.log(`To update: ${IDENTITY.binaryName} update`);
    return;
  }

  // Find the binary asset for current platform
  const binaryName = getBinaryName();
  const asset = release.assets.find(a => a.name === binaryName);
  if (!asset) {
    console.error(`error: binary not found in the release: ${binaryName}`);
    console.log('Available assets:', release.assets.map(a => a.name).join(', '));
    return;
  }

  // Determine the target binary path: prefer the service-registered path over process.execPath
  const servicePath = await getServiceBinaryPath();
  const currentPath = servicePath || process.execPath;
  if (servicePath && servicePath !== process.execPath) {
    console.log(`Service path: ${servicePath}`);
  }

  // Verify the release publishes a SHA256SUMS file and that it contains an
  // entry for our binary BEFORE downloading. Older releases (<= v0.1.161) do
  // not have this; users on those versions are upgrading to the first version
  // that publishes one, so the next update naturally succeeds.
  const expectedSha256 = await fetchExpectedSha256(release, binaryName);
  if (!expectedSha256) {
    console.error(
      `error: SHA256SUMS not found (${binaryName}) - aborting the update because integrity cannot be verified`,
    );
    return;
  }

  // Download to temp location
  const tempPath = `${currentPath}.new`;
  const backupPath = `${currentPath}.bak`;

  const success = await downloadBinary(
    asset.browser_download_url,
    tempPath,
    expectedSha256,
    binaryName,
  );
  if (!success) {
    return;
  }

  // Backup current binary
  try {
    await copyFile(currentPath, backupPath);
    console.log(`Backup: ${backupPath}`);
  } catch {
    console.log('warning: skipped the backup');
  }

  // Also update the CLI binary if it's at a different path
  const cliPath = process.execPath;
  const updateCliBinary = servicePath && servicePath !== cliPath;

  const isDarwin = platform() === 'darwin';
  const uid = process.getuid?.() ?? 501;
  const plistPath = join(
    homedir(),
    'Library',
    'LaunchAgents',
    SERVICE.launchdServerPlist,
  );

  // Stop service before replacing binary (macOS launchd holds the binary open)
  if (isDarwin) {
    Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}`, plistPath]);
    console.log('Stopped the service');
  }

  // Replace binary
  try {
    await rename(tempPath, currentPath);
    console.log(`Updated the binary: ${currentPath}`);
    // Also copy to CLI binary path if different from service path
    if (updateCliBinary) {
      try {
        await copyFile(currentPath, cliPath);
        console.log(`Updated the CLI binary as well: ${cliPath}`);
      } catch {
        console.log(`warning: skipped the CLI binary update: ${cliPath}`);
      }
    }
  } catch (error) {
    console.error('error: failed to replace the binary:', error);
    if (isDarwin) {
      console.log(
        `Hint: launchctl bootout gui/$(id -u)/${SERVICE.launchdServerLabel}`,
      );
    } else {
      console.log(`Hint: systemctl --user stop ${SERVICE.systemctl}`);
    }
    // Try to restart service even if replace failed
    if (isDarwin) {
      Bun.spawnSync(['launchctl', 'bootstrap', `gui/${uid}`, plistPath]);
    }
    return;
  }

  // Restart service
  if (isDarwin) {
    const result = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${uid}`, plistPath]);
    if (result.exitCode === 0) {
      console.log(`${t('update.serviceRestarted')}`);
    } else {
      // Fallback to legacy load
      const legacyResult = Bun.spawnSync(['launchctl', 'load', plistPath]);
      if (legacyResult.exitCode === 0) {
        console.log(`${t('update.serviceRestarted')}`);
      } else {
        console.log(`Restart manually: launchctl bootstrap gui/$(id -u) ${plistPath}`);
      }
    }
  } else {
    const restartResult = Bun.spawnSync([
      'systemctl',
      '--user',
      'restart',
      SERVICE.systemctl,
    ]);
    if (restartResult.exitCode === 0) {
      console.log(`${t('update.serviceRestarted')}`);
    } else {
      console.log(`${t('update.manualRestartRequired')}`);
    }
  }

  console.log('');
  console.log(`Updated v${currentVersion} -> ${latestVersion}`);
}
