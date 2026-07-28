/**
 * Product identity — the names, paths, ports and service units that would all
 * have to change together to rename this product (#459).
 *
 * The raw values live in `identity.json` at the repo root so that non-TypeScript
 * consumers can read them too. Everything composed from those values belongs
 * here rather than at the call site: `cchub-update.timer` is not a name anyone
 * chose, it is `${serviceName}-update.timer`, and spelling it out at the call
 * site is what turns one rename into a thousand.
 *
 * Not covered here:
 * - `install.sh` and `.github/workflows/release.yml` keep their own copies. The
 *   installer is fetched and piped to bash with no checkout to read, and Actions
 *   matrix values must be literals. `backend/tests/unit/identity-consistency.test.ts`
 *   fails if they drift from this file.
 * - Display strings and log lines. They say the product's name but nothing
 *   depends on them agreeing, so they stay inline where they read naturally.
 * - `CHANGELOG.md` and `specs/`. Those record what was true at the time and are
 *   deliberately left alone by a rename.
 */
import raw from '../identity.json';

export const IDENTITY = {
  productName: raw.productName,
  tagline: raw.tagline,
  binaryName: raw.binaryName,
  repo: raw.repo,
  assetPrefix: raw.assetPrefix,
  defaultPort: raw.defaultPort,
  devPort: raw.devPort,
  dataDirName: raw.dataDirName,
  dataDirEnv: raw.dataDirEnv,
  configDirName: raw.configDirName,
  serviceName: raw.serviceName,
  launchdPrefix: raw.launchdPrefix,
  storagePrefix: raw.storagePrefix,
  tmpPrefix: raw.tmpPrefix,
  browserLogName: raw.browserLogName,
  keychainService: raw.keychainService,
} as const;

/**
 * Prefixes this app used for browser storage before the current one.
 *
 * Renaming a localStorage key does not fail, it forgets: the theme resets, the
 * keyboard moves back to its default corner, and — because the auth token lives
 * here too — everyone signs out. So old keys are carried forward rather than
 * assumed absent.
 *
 * `cc-hub-` is here because the token key alone was spelled with the hyphen
 * while everything else used `cchub-`. Normalising it is the first thing this
 * mechanism does, which means a rename is not the first time it runs.
 */
export const LEGACY_STORAGE_PREFIXES: readonly string[] =
  raw.legacyStoragePrefixes;

/**
 * Scratch paths under /tmp.
 *
 * `imagesDir` had three separate copies of its literal (the server's static
 * route, the upload handler and the file route) which only work as long as all
 * three agree — one edit away from uploads landing where nothing serves them.
 *
 * `browserLogFile` does not follow `tmpPrefix`: it has always been
 * `cc-hub-browser.log`, with the hyphen, and CLAUDE.md tells people to tail it
 * by that name. Normalising the spelling is a real change to something someone
 * has in their shell history, so it is recorded here as-is rather than quietly
 * corrected — a rename can decide to fix it deliberately.
 */
export const TMP_PATHS = {
  imagesDir: `/tmp/${IDENTITY.tmpPrefix}-images`,
  usageHistoryFile: `/tmp/${IDENTITY.tmpPrefix}-usage-history.json`,
  browserLogFile: `/tmp/${IDENTITY.browserLogName}`,
} as const;

/** systemd unit / launchd label names, all composed from `serviceName`. */
export const SERVICE = {
  /** What `systemctl --user <verb> …` takes. */
  systemctl: IDENTITY.serviceName,
  unitFile: `${IDENTITY.serviceName}.service`,
  updateUnitFile: `${IDENTITY.serviceName}-update.service`,
  updateTimerFile: `${IDENTITY.serviceName}-update.timer`,
  /** What `systemctl --user <verb> …` takes for the update timer. */
  updateTimer: `${IDENTITY.serviceName}-update.timer`,
  launchdServerLabel: `${IDENTITY.launchdPrefix}.server`,
  launchdUpdateLabel: `${IDENTITY.launchdPrefix}.update`,
  launchdServerPlist: `${IDENTITY.launchdPrefix}.server.plist`,
  launchdUpdatePlist: `${IDENTITY.launchdPrefix}.update.plist`,
  /** `cchub.service.d` — where systemd looks for drop-in overrides. */
  dropInDir: `${IDENTITY.serviceName}.service.d`,
} as const;

/** The release asset for a platform, e.g. `cchub-linux-x64`. */
export function assetName(platform: string, arch: string): string {
  return `${IDENTITY.assetPrefix}-${platform}-${arch}`;
}

/** The hook command hosts are told to run, e.g. `cchub notify`. */
export const HOOK_COMMAND = `${IDENTITY.binaryName} notify`;

/**
 * Matches a hook command that invokes us, bare or by absolute path.
 *
 * Used to recognise an entry that is already there. A pattern that stops
 * matching after a rename does not throw — it reports the hook as missing and
 * writes a second one beside it.
 */
export const HOOK_COMMAND_PATTERN = new RegExp(
  `(?:^|/)${IDENTITY.binaryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+notify(?:\\s|$)`,
);

/** `User-Agent` for calls to the GitHub API. */
export function userAgent(version: string): string {
  return `${IDENTITY.binaryName}/${version}`;
}
