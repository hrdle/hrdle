// macOS Keychain helpers for storing the hrdle server password.
//
// Linux has no equivalent reliable headless secret store, so these helpers are
// no-ops on non-darwin platforms.

import { IDENTITY } from '../../../shared/identity';

const SERVICE = IDENTITY.keychainService;

function getAccount(): string {
  return process.env.USER || IDENTITY.keychainService;
}

/** Read the hrdle password from the macOS Keychain. Returns undefined if not stored or not on darwin. */
export function readPassword(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const result = Bun.spawnSync(['security', 'find-generic-password', '-s', SERVICE, '-w']);
    if (result.exitCode !== 0) return undefined;
    const out = result.stdout.toString().trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Store (or update) the hrdle password in the macOS Keychain. Returns true on success. */
export function storePassword(password: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    // -U updates the existing entry if present, otherwise adds a new one.
    const result = Bun.spawnSync([
      'security', 'add-generic-password',
      '-s', SERVICE,
      '-a', getAccount(),
      '-w', password,
      '-U',
    ]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Delete the hrdle password from the macOS Keychain. Returns true if deleted. */
export function deletePassword(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const result = Bun.spawnSync(['security', 'delete-generic-password', '-s', SERVICE]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
