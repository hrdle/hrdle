// cchub uninstall command - remove service registration (systemd on Linux, launchd on macOS)

import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { t } from '../i18n';
import { deletePassword as deletePasswordFromKeychain } from '../utils/keychain';
import { IDENTITY, SERVICE } from '../../../shared/identity';

export async function uninstallService(): Promise<void> {
  if (platform() === 'darwin') {
    await uninstallLaunchd();
  } else {
    await uninstallSystemd();
  }
}

async function uninstallLaunchd(): Promise<void> {
  const home = homedir();
  const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
  const plistPath = join(launchAgentsDir, SERVICE.launchdServerPlist);
  const updatePlistPath = join(launchAgentsDir, SERVICE.launchdUpdatePlist);
  const uid = process.getuid?.() ?? 501;

  console.log(`🗑️  ${t('uninstall.title')}`);
  console.log('');

  // Stop services
  if (existsSync(plistPath)) {
    Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}`, plistPath]);
    await unlink(plistPath);
    console.log(`✅ ${t('uninstall.removedService')}: ${plistPath}`);
  } else {
    console.log(`⏭️  ${t('uninstall.notFound')}: ${plistPath}`);
  }

  if (existsSync(updatePlistPath)) {
    Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}`, updatePlistPath]);
    await unlink(updatePlistPath);
    console.log(`✅ ${t('uninstall.removedUpdate')}: ${updatePlistPath}`);
  } else {
    console.log(`⏭️  ${t('uninstall.notFound')}: ${updatePlistPath}`);
  }

  // Remove password from Keychain (no-op if not stored)
  if (deletePasswordFromKeychain()) {
    console.log('🔐 Keychain からパスワードを削除しました');
  }

  console.log('');
  console.log(`✅ ${t('uninstall.done')}`);

  const logDir = join(home, IDENTITY.dataDirName);
  if (existsSync(logDir)) {
    console.log('');
    console.log(`💡 ${t('uninstall.logsHint')}: rm -rf ${logDir}`);
  }
}

async function uninstallSystemd(): Promise<void> {
  const home = homedir();
  const systemdDir = join(home, '.config', 'systemd', 'user');
  const servicePath = join(systemdDir, SERVICE.unitFile);
  const updateServicePath = join(systemdDir, SERVICE.updateUnitFile);
  const updateTimerPath = join(systemdDir, SERVICE.updateTimerFile);

  console.log(`🗑️  ${t('uninstall.title')}`);
  console.log('');

  // Stop and disable services
  Bun.spawnSync(['systemctl', '--user', 'stop', SERVICE.systemctl]);
  Bun.spawnSync(['systemctl', '--user', 'disable', SERVICE.systemctl]);
  Bun.spawnSync(['systemctl', '--user', 'stop', SERVICE.updateTimer]);
  Bun.spawnSync(['systemctl', '--user', 'disable', SERVICE.updateTimer]);

  for (const [path, label] of [
    [servicePath, t('uninstall.removedService')],
    [updateServicePath, t('uninstall.removedUpdate')],
    [updateTimerPath, t('uninstall.removedTimer')],
  ] as const) {
    if (existsSync(path)) {
      await unlink(path);
      console.log(`✅ ${label}: ${path}`);
    } else {
      console.log(`⏭️  ${t('uninstall.notFound')}: ${path}`);
    }
  }

  Bun.spawnSync(['systemctl', '--user', 'daemon-reload']);

  console.log('');
  console.log(`✅ ${t('uninstall.done')}`);

  const configDir = join(home, '.config', IDENTITY.configDirName);
  if (existsSync(configDir)) {
    console.log('');
    console.log(`💡 ${t('uninstall.configHint')}: rm -rf ${configDir}`);
  }
}
