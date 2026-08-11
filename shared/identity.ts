/**
 * Product identity — the names, paths, ports and service units that would all
 * have to change together to rename this product.
 *
 * The raw values live in `identity.json` at the repo root so that non-TypeScript
 * consumers can read them too. Everything composed from those values belongs
 * here rather than at the call site: `hrdle-update.timer` is not a name anyone
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
// The attribute is required by Node's ESM loader and ignored by Bun and Vite.
// Without it this module is unreadable from anything Node runs — which is how
// playwright.config.ts, the first consumer outside the Bun/Vite toolchain,
// found it: ERR_IMPORT_ATTRIBUTE_MISSING before a single test started.
import raw from '../identity.json' with { type: 'json' };

export const IDENTITY = {
  productName: raw.productName,
  tagline: raw.tagline,
  binaryName: raw.binaryName,
  repo: raw.repo,
  assetPrefix: raw.assetPrefix,
  defaultPort: raw.defaultPort,
  devPort: raw.devPort,
  frontendDevPort: raw.frontendDevPort,
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
 * Scratch paths under /tmp.
 *
 * `imagesDir` had three separate copies of its literal (the server's static
 * route, the upload handler and the file route) which only work as long as all
 * three agree — one edit away from uploads landing where nothing serves them.
 *
 * `browserLogFile` does not follow `tmpPrefix` but carries its own
 * `browserLogName`: CLAUDE.md tells people to tail it by that name, and a
 * spelling normalised here is a real change to something someone has in their
 * shell history.
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
  /** `hrdle.service.d` — where systemd looks for drop-in overrides. */
  dropInDir: `${IDENTITY.serviceName}.service.d`,
} as const;

/** The release asset for a platform, e.g. `hrdle-linux-x64`. */
export function assetName(platform: string, arch: string): string {
  return `${IDENTITY.assetPrefix}-${platform}-${arch}`;
}

/**
 * An environment variable this app reads, e.g. `HRDLE_STT_PROMPT`.
 *
 * `dataDirEnv` predates this and stays spelled out in identity.json: it is
 * documented and someone may have it exported, so it is a value a rename
 * decides about rather than one that follows automatically. Variables added
 * since compose from the binary name here — `HRDLE_STT_PROMPT` survived the
 * rename by a day precisely because it was written out at the call site, and
 * `glasses/vite.config.ts` was already building `HRDLE_URL` this way.
 */
export function envVar(suffix: string): string {
  return `${IDENTITY.binaryName.toUpperCase()}_${suffix}`;
}

/**
 * The environment variable holding the server password, e.g. `HRDLE_PASSWORD`.
 *
 * Both the writer (`setup`, which puts it in the service env file) and the
 * reader (startup, and the auth middleware behind it) must use this one name.
 * They did not: setup wrote a bare `PASSWORD=` while the server read
 * `HRDLE_PASSWORD`, so a password configured through `setup -P` on Linux was
 * never seen and the server came up **unauthenticated** while reporting itself
 * as configured. Nothing fails when these disagree, which is why it lasted.
 */
export const PASSWORD_ENV = envVar('PASSWORD');

/** The hook command hosts are told to run, e.g. `hrdle notify`. */
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
