/**
 * Whether the steward exists at all, and how it is run.
 *
 * Off by default, gated on the server rather than in localStorage: hiding a
 * mode in the client leaves its endpoints serving, and a flag the UI writes on
 * mount holds a value nobody chose (`hrdle-desktop-terminal` cost us that).
 *
 * CLAUDE.md's one-week expiry does not apply - this is not a compatibility
 * path but a switch keeping an immature feature off screens. It is deleted,
 * with both its branches, once the feature has reached everyone.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { envVar } from '../../../shared/identity';
import { atomicWriteFile, createMutationLock, ensureDataDir, getDataDir } from '../utils/storage';

export const STEWARD_ENV = envVar('STEWARD');

const SETTINGS_FILE = 'steward.json';

/** The observer's work is frequent and individually light, so the cheap model
 *  is the right default. Separate settings so a worker's long write-up can be
 *  sent somewhere heavier without slowing the observer. */
const DEFAULT_MODEL = 'sonnet';

export interface StewardSettings {
  observerModel: string;
  workerModel: string;
}

interface StewardSettingsFile {
  observerModel?: string;
  workerModel?: string;
}

const withSettingsLock = createMutationLock();

export function isStewardEnabled(): boolean {
  const value = process.env[STEWARD_ENV];
  return value === '1' || value === 'true';
}

function settingsPath(): string {
  return join(getDataDir(), SETTINGS_FILE);
}

export async function getStewardSettings(): Promise<StewardSettings> {
  try {
    const raw = await readFile(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as StewardSettingsFile;
    return {
      observerModel: parsed.observerModel?.trim() || DEFAULT_MODEL,
      workerModel: parsed.workerModel?.trim() || DEFAULT_MODEL,
    };
  } catch {
    return { observerModel: DEFAULT_MODEL, workerModel: DEFAULT_MODEL };
  }
}

export async function setStewardSettings(update: Partial<StewardSettings>): Promise<StewardSettings> {
  return withSettingsLock(async () => {
    const current = await getStewardSettings();
    const next: StewardSettings = {
      observerModel: update.observerModel?.trim() || current.observerModel,
      workerModel: update.workerModel?.trim() || current.workerModel,
    };
    await ensureDataDir();
    await atomicWriteFile(settingsPath(), JSON.stringify(next, null, 2));
    return next;
  });
}
