// cchub setup command - service registration (systemd on Linux, launchd on macOS)

import { existsSync } from 'node:fs';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { IDENTITY, PASSWORD_ENV, SERVICE } from '../../../shared/identity';
import { t } from '../i18n';
import { herdrBinaryPath } from '../services/herdr-client';
import { migrateCodexHooksToJson } from '../services/codex-hook-config';
import { storePassword as storePasswordInKeychain } from '../utils/keychain';

/**
 * PATH to bake into the systemd units (`Environment=PATH=`).
 *
 * #499: the supervised units launch via `zsh -lc`, a *login but non-interactive*
 * shell that sources `.zshenv`/`.zprofile` but NOT `.zshrc`. Users commonly add
 * `~/.local/bin` / `~/bin` to PATH in `.zshrc`, so the supervised server (and
 * everything it spawns — resumed agents and their Claude Code hooks) can't find
 * `cchub` / `herdr` / `rtk` / `claude` and hooks fail with `command not found`.
 *
 * `cchub setup` is run from the user's interactive terminal, so `process.env.PATH`
 * here already includes their `.zshrc` additions. Bake that in, guaranteeing the
 * two home bin dirs are present up front regardless of what the inherited PATH
 * looks like. `%` is doubled because systemd treats it as a specifier in units.
 */
export function buildServicePath(): string {
  const home = homedir();
  const inherited = (process.env.PATH ?? '').split(':').filter(Boolean);
  // If PATH is somehow empty, still guarantee the standard system dirs so the
  // service can find `/usr/bin/env` etc.
  const base = inherited.length > 0 ? inherited : ['/usr/local/bin', '/usr/bin', '/bin'];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of [join(home, '.local', 'bin'), join(home, 'bin'), ...base]) {
    if (!seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }
  return dirs.join(':').replace(/%/g, '%%');
}

/** Escape special characters for safe inclusion in XML/plist content. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Linux: systemd ───

export const SYSTEMD_SERVICE = `[Unit]
Description=${IDENTITY.productName} - ${IDENTITY.tagline}
After=network.target tailscaled.service

[Service]
Type=simple
ExecStart=__SHELL__ -lc 'exec __EXEC_PATH__ -p __PORT__'
EnvironmentFile=%h/.config/${IDENTITY.configDirName}/env
Environment=PATH=__PATH__
KillMode=process
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;

export const SYSTEMD_UPDATE_SERVICE = `[Unit]
Description=${IDENTITY.productName} update check

[Service]
Type=oneshot
ExecStart=__EXEC_PATH__ update --auto
`;

export const SYSTEMD_UPDATE_TIMER = `[Unit]
Description=Check ${IDENTITY.productName} updates daily

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
`;

// ─── macOS: launchd ───

/**
 * Build the launchd plist for the cchub server.
 * The password is NOT embedded here — it is read from the macOS Keychain at
 * runtime by `cchub` itself, so the plist file stays free of secrets.
 */
export function buildLaunchdPlist(execPath: string, port: number): string {
  const args = [execPath, '-p', String(port)];
  const logPath = join(
    homedir(),
    IDENTITY.dataDirName,
    `${IDENTITY.binaryName}.log`,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE.launchdServerLabel}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${escapeXml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
}

export function buildLaunchdUpdatePlist(execPath: string): string {
  const logPath = join(homedir(), IDENTITY.dataDirName, 'update.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE.launchdUpdateLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(execPath)}</string>
    <string>update</string>
    <string>--auto</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

// ─── herdr provisioning ───

const HERDR_SYSTEMD_SERVICE = `[Unit]
Description=herdr terminal multiplexer server (${IDENTITY.productName} backend)

[Service]
Type=simple
ExecStart=__HERDR_PATH__ server
Restart=always
RestartSec=2
Environment=LANG=en_US.UTF-8
Environment=PATH=__PATH__

[Install]
WantedBy=default.target
`;

function buildHerdrLaunchdPlist(herdrPath: string): string {
  const logPath = join(homedir(), IDENTITY.dataDirName, 'herdr.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.herdr.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(herdrPath)}</string>
    <string>server</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>
</dict>
</plist>
`;
}

const HERDR_CONFIG_TOML = `# ${IDENTITY.productName} herdr backend configuration (written by \`${IDENTITY.binaryName} setup\`)

[session]
# Restart agent panes (Claude Code etc.) in their native conversation
# sessions after a server restart.
resume_agents_on_restore = true

[experimental]
# Persist recent pane screen contents across server restarts.
pane_history = true
`;

type AgentIntegration = {
  name: string;
  command: string;
  configDir: string;
};

const AGENT_INTEGRATIONS: AgentIntegration[] = [
  { name: 'Claude Code', command: 'claude', configDir: join(homedir(), '.claude') },
  { name: 'Codex', command: 'codex', configDir: join(homedir(), '.codex') },
  { name: 'Kimi Code', command: 'kimi', configDir: join(homedir(), '.kimi-code') },
  // OpenCode keeps its config under XDG rather than a dotfile directory of its
  // own, and its herdr integration is an ESM plugin dropped in there.
  { name: 'OpenCode', command: 'opencode', configDir: join(homedir(), '.config', 'opencode') },
];

function isCommandAvailable(command: string): boolean {
  return Bun.spawnSync(['which', command]).exitCode === 0;
}

function getInstalledAgentIntegrations(): AgentIntegration[] {
  return AGENT_INTEGRATIONS.filter(
    agent => isCommandAvailable(agent.command) && existsSync(agent.configDir),
  );
}

/** Install herdr hooks only for agents that are actually initialized locally. */
function provisionAgentIntegrations(herdrPath: string): AgentIntegration[] {
  const commandAvailable = AGENT_INTEGRATIONS.filter(agent => isCommandAvailable(agent.command));
  const installed = getInstalledAgentIntegrations();

  if (installed.length === 0) {
    if (commandAvailable.length > 0) {
      const names = commandAvailable.map(agent => agent.name).join(' / ');
      console.log(t('setup.agentsNotInitialized', { agents: names }));
      console.log(t('setup.agentInitHint'));
    } else {
      console.log(t('setup.agentsNotFound'));
      console.log(t('setup.agentInitHint'));
    }
    return installed;
  }

  for (const agent of installed) {
    const integ = Bun.spawnSync([herdrPath, 'integration', 'install', agent.command]);
    if (integ.exitCode === 0) {
      console.log(t('setup.herdrIntegrationConfigured', { agent: agent.name }));
    } else {
      console.error(t('setup.herdrIntegrationFailed', { agent: agent.name }));
      console.error(integ.stderr.toString());
    }
  }

  return installed;
}

/**
 * Provision the herdr backend: supervised server (systemd / launchd),
 * config.toml with agent-resume enabled, and integrations for initialized
 * agent CLIs (native session identity for restore).
 */
async function provisionHerdr(): Promise<void> {
  console.log(t('setup.herdrTitle'));

  const herdrPath = herdrBinaryPath();
  if (!herdrPath) {
    console.error(t('setup.herdrNotFound'));
    console.error(`   ${t('setup.herdrInstallHint')}`);
    console.log('');
    return;
  }

  // config.toml: create with our defaults; never clobber an existing file.
  const herdrConfigDir = join(homedir(), '.config', 'herdr');
  const configPath = join(herdrConfigDir, 'config.toml');
  await mkdir(herdrConfigDir, { recursive: true });
  const existingConfig = await Bun.file(configPath)
    .text()
    .catch(() => null);
  if (existingConfig === null) {
    await writeFile(configPath, HERDR_CONFIG_TOML);
    console.log(t('setup.herdrConfigCreated', { path: configPath }));
  } else if (!existingConfig.includes('resume_agents_on_restore')) {
    console.log(t('setup.herdrConfigMissingResume'));
    console.log(t('setup.herdrConfigResumeHint'));
  }

  // Supervised server.
  const wasRunning = Bun.spawnSync([herdrPath, 'status', 'server'])
    .stdout.toString()
    .includes('status: running');
  if (platform() === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.herdr.server.plist');
    await writeFile(plistPath, buildHerdrLaunchdPlist(herdrPath));
    console.log(t('setup.herdrServiceFile', { path: plistPath }));
    if (wasRunning) {
      console.log(t('setup.herdrAlreadyRunning'));
      console.log(`   herdr server stop && launchctl bootstrap gui/$(id -u) ${plistPath}`);
      console.log(t('setup.herdrManualSwitch'));
    } else {
      Bun.spawnSync(['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}`, plistPath]);
      Bun.spawnSync(['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath]);
      console.log(t('setup.herdrStartedLaunchd'));
    }
  } else {
    const systemdDir = join(homedir(), '.config', 'systemd', 'user');
    await mkdir(systemdDir, { recursive: true });
    const unitPath = join(systemdDir, 'herdr.service');
    await writeFile(
      unitPath,
      HERDR_SYSTEMD_SERVICE.replace(/__HERDR_PATH__/g, herdrPath).replace(/__PATH__/g, buildServicePath()),
    );
    console.log(t('setup.herdrServiceFile', { path: unitPath }));
    Bun.spawnSync(['systemctl', '--user', 'daemon-reload']);
    if (wasRunning && !isHerdrSystemdActive()) {
      Bun.spawnSync(['systemctl', '--user', 'enable', 'herdr']);
      console.log(t('setup.herdrSystemdOutside'));
      console.log('   herdr server stop && systemctl --user start herdr');
      console.log(t('setup.herdrManualSwitch'));
    } else {
      const res = Bun.spawnSync(['systemctl', '--user', 'enable', '--now', 'herdr']);
      if (res.exitCode === 0) {
        console.log(t('setup.herdrEnabledSystemd'));
      } else {
        console.error(t('setup.herdrStartFailed'));
        console.error(res.stderr.toString());
      }
    }
  }

  // Agent integrations report native session ids to herdr so conversations
  // survive server restarts. Only initialized agents are passed to herdr;
  // invoking an integration for an uninitialized CLI produces misleading
  // "config directory not found" errors.
  const installedAgents = provisionAgentIntegrations(herdrPath);
  if (installedAgents.some(agent => agent.command === 'codex')) {
    try {
      const migration = await migrateCodexHooksToJson(join(homedir(), '.codex'));
      if (migration.changed) {
        console.log(t('setup.codexHooksMigrated'));
      }
    } catch (error) {
      console.error(t('setup.codexHooksMigrationFailed'));
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
  console.log('');
}

function isHerdrSystemdActive(): boolean {
  return (
    Bun.spawnSync(['systemctl', '--user', 'is-active', 'herdr']).stdout.toString().trim() ===
    'active'
  );
}

// ─── Setup entry point ───

/**
 * Contents of the systemd EnvironmentFile.
 *
 * The variable name has to be one the server reads. It wrote a bare `PASSWORD=`
 * for a long time while startup looked at `CCHUB_PASSWORD`, so a password set
 * through `setup -P` was configured, reported, and never used — the server came
 * up unauthenticated. Nothing about that combination fails, which is why the
 * name is composed here from the same constant startup reads.
 */
export function envFileContent(password?: string): string {
  return password
    ? `${PASSWORD_ENV}=${password}\n`
    : `# ${PASSWORD_ENV}=yourpassword\n`;
}

export async function setupService(port: number, password?: string): Promise<void> {
  await provisionHerdr();
  if (platform() === 'darwin') {
    await setupLaunchd(port, password);
  } else {
    await setupSystemd(port, password);
  }
}

async function setupLaunchd(port: number, password?: string): Promise<void> {
  const home = homedir();
  const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
  const logDir = join(home, IDENTITY.dataDirName);
  const execPath = process.execPath;

  console.log(t('setup.macTitle'));
  console.log('');

  await mkdir(launchAgentsDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  // Store password in macOS Keychain instead of embedding in plist (which is
  // world-readable). cchub at runtime reads it back via `security`.
  if (password) {
    if (storePasswordInKeychain(password)) {
      console.log(t('setup.keychainSaved'));
    } else {
      console.log(t('setup.keychainFailed'));
    }
  }

  // Main service plist (no password embedded — read from Keychain at runtime)
  const plistPath = join(launchAgentsDir, SERVICE.launchdServerPlist);
  await writeFile(plistPath, buildLaunchdPlist(execPath, port));
  console.log(t('setup.serviceFile', { path: plistPath }));

  // Update plist
  const updatePlistPath = join(launchAgentsDir, SERVICE.launchdUpdatePlist);
  await writeFile(updatePlistPath, buildLaunchdUpdatePlist(execPath));
  console.log(t('setup.updateServiceFile', { path: updatePlistPath }));

  console.log('');

  // Unload if already loaded (ignore errors)
  Bun.spawnSync(['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}`, plistPath]);

  // Load service
  const loadResult = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath]);
  if (loadResult.exitCode === 0) {
    console.log(t('setup.serviceStarted'));
  } else {
    // Fallback to legacy load
    const legacyResult = Bun.spawnSync(['launchctl', 'load', plistPath]);
    if (legacyResult.exitCode === 0) {
      console.log(t('setup.serviceStarted'));
    } else {
      console.error(t('setup.serviceStartFailed'));
      console.error(legacyResult.stderr.toString());
    }
  }

  // Load update service
  Bun.spawnSync(['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}`, updatePlistPath]);
  Bun.spawnSync(['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, updatePlistPath]);
  console.log(t('setup.autoUpdateEnabled'));

  console.log('');
  console.log(t('setup.managementCommands'));
  console.log(`  launchctl list | grep ${IDENTITY.binaryName}        # Status`);
  console.log(
    `  launchctl kickstart -k gui/$(id -u)/${SERVICE.launchdServerLabel}  # Restart`,
  );
  console.log(
    `  launchctl bootout gui/$(id -u)/${SERVICE.launchdServerLabel}       # Stop`,
  );
  console.log(
    `  tail -f ~/${IDENTITY.dataDirName}/${IDENTITY.binaryName}.log        # Logs`,
  );
  console.log('');
}

async function setupSystemd(port: number, password?: string): Promise<void> {
  const home = homedir();
  const configDir = join(home, '.config', IDENTITY.configDirName);
  const systemdDir = join(home, '.config', 'systemd', 'user');
  const execPath = process.execPath;

  console.log(t('setup.setupTitle'));
  console.log('');

  await mkdir(configDir, { recursive: true });
  await mkdir(systemdDir, { recursive: true });

  // Environment file
  const envContent = envFileContent(password);
  const envPath = join(configDir, 'env');
  await writeFile(envPath, envContent);
  await chmod(envPath, 0o600);
  console.log(t('setup.envFile', { path: envPath }));

  // Main service
  const shell = process.env.SHELL || '/bin/bash';
  const serviceContent = SYSTEMD_SERVICE
    .replace(/__SHELL__/g, shell)
    .replace(/__EXEC_PATH__/g, execPath)
    .replace(/__PORT__/g, String(port))
    .replace(/__PATH__/g, buildServicePath());
  const servicePath = join(systemdDir, SERVICE.unitFile);
  await writeFile(servicePath, serviceContent);
  console.log(t('setup.serviceFile', { path: servicePath }));

  // Update service
  const updateServicePath = join(systemdDir, SERVICE.updateUnitFile);
  await writeFile(updateServicePath, SYSTEMD_UPDATE_SERVICE.replace(/__EXEC_PATH__/g, execPath));
  console.log(t('setup.updateServiceFile', { path: updateServicePath }));

  // Update timer
  const updateTimerPath = join(systemdDir, SERVICE.updateTimerFile);
  await writeFile(updateTimerPath, SYSTEMD_UPDATE_TIMER);
  console.log(t('setup.updateTimerFile', { path: updateTimerPath }));

  console.log('');

  // Reload and enable
  Bun.spawnSync(['systemctl', '--user', 'daemon-reload']);

  const enableResult = Bun.spawnSync([
    'systemctl',
    '--user',
    'enable',
    '--now',
    SERVICE.systemctl,
  ]);
  if (enableResult.exitCode === 0) {
    console.log(`${t('setup.serviceEnabled')}`);
  } else {
    console.error(t('setup.serviceEnableFailed'));
    console.error(enableResult.stderr.toString());
  }

  const timerResult = Bun.spawnSync([
    'systemctl',
    '--user',
    'enable',
    '--now',
    SERVICE.updateTimer,
  ]);
  if (timerResult.exitCode === 0) {
    console.log(t('setup.autoUpdateTimerEnabled'));
  }

  console.log('');
  console.log(`${t('setup.commands')}`);
  console.log(`  systemctl --user status ${SERVICE.systemctl}    # Status`);
  console.log(`  ${t('setup.cmdRestart')}`);
  console.log(`  ${t('setup.cmdStop')}`);
  console.log(`  ${t('setup.cmdLogs')}`);
  console.log('');

  // Enable linger
  const lingerResult = Bun.spawnSync(['loginctl', 'show-user', process.env.USER || '', '--property=Linger']);
  if (!lingerResult.stdout.toString().includes('Linger=yes')) {
    console.log(`${t('setup.enablingAutostart')}`);
    const result = Bun.spawnSync(['loginctl', 'enable-linger', process.env.USER || '']);
    if (result.exitCode === 0) {
      console.log(`${t('setup.autostartEnabled')}`);
    } else {
      console.log(`warning: ${t('setup.autostartFailed')}`);
      console.log(`   ${t('setup.autostartCommand')}`);
    }
    console.log('');
  }

  if (!password) {
    console.log(`warning: ${t('setup.passwordNotSetEnv')}`);
  }
}
