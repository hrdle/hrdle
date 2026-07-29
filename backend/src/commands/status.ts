// `status` command - show service status (systemd on Linux, launchd on macOS)

import { platform } from 'node:os';
import { VERSION } from '../cli';
import { t } from '../i18n';
import { IDENTITY, SERVICE } from '../../../shared/identity';

export async function showStatus(): Promise<void> {
  console.log(`${IDENTITY.productName} v${VERSION}`);
  console.log('');

  if (platform() === 'darwin') {
    showStatusLaunchd();
  } else {
    showStatusSystemd();
  }

  console.log('');
  showTailscaleStatus();
}

function showStatusSystemd(): void {
  // Check main service status
  const serviceResult = Bun.spawnSync(
    ['systemctl', '--user', 'status', SERVICE.systemctl, '--no-pager'],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  if (serviceResult.exitCode === 0) {
    console.log('Service status:');
    console.log(serviceResult.stdout.toString());
  } else if (serviceResult.exitCode === 3) {
    console.log('Service status: Stopped');
    console.log('');
    console.log(t('status.startCommand'));
  } else if (serviceResult.exitCode === 4) {
    console.log('Service status: Not registered');
    console.log('');
    console.log(`To setup: ${IDENTITY.binaryName} setup`);
  } else {
    console.log('Service status: Unknown');
    console.log(serviceResult.stderr.toString());
  }

  console.log('');

  // Check update timer status
  const timerResult = Bun.spawnSync(
    ['systemctl', '--user', 'is-active', SERVICE.updateTimer],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const timerActive = timerResult.stdout.toString().trim() === 'active';
  console.log(`Auto-update: ${timerActive ? 'Enabled' : 'Disabled'}`);

  if (timerActive) {
    const nextResult = Bun.spawnSync(
      [
        'systemctl',
        '--user',
        'show',
        SERVICE.updateTimer,
        '--property=NextElapseUSecRealtime',
      ],
      { stdout: 'pipe' }
    );
    const nextOutput = nextResult.stdout.toString();
    const match = nextOutput.match(/NextElapseUSecRealtime=(.+)/);
    if (match && match[1] !== 'n/a') {
      const usec = parseInt(match[1], 10);
      if (!Number.isNaN(usec)) {
        const date = new Date(usec / 1000);
        console.log(`   Next check: ${date.toLocaleString()}`);
      }
    }
  }
}

function showStatusLaunchd(): void {
  // Main service
  const serviceResult = Bun.spawnSync(
    ['launchctl', 'list', SERVICE.launchdServerLabel],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  if (serviceResult.exitCode === 0) {
    const out = serviceResult.stdout.toString();
    const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
    const exitMatch = out.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
    if (pidMatch) {
      console.log(`Service status: Running (PID ${pidMatch[1]})`);
    } else {
      console.log('Service status: Stopped');
      if (exitMatch) console.log(`   Last exit status: ${exitMatch[1]}`);
      console.log('');
      console.log(
        `   Restart: launchctl kickstart -k gui/$(id -u)/${SERVICE.launchdServerLabel}`,
      );
    }
  } else {
    console.log('Service status: Not registered');
    console.log('');
    console.log(`   To setup: ${IDENTITY.binaryName} setup`);
  }

  console.log('');

  // Update job (StartCalendarInterval, runs daily at 4:00)
  const updateResult = Bun.spawnSync(
    ['launchctl', 'list', SERVICE.launchdUpdateLabel],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const updateActive = updateResult.exitCode === 0;
  console.log(`Auto-update: ${updateActive ? 'Enabled (daily 4:00)' : 'Disabled'}`);
}

function showTailscaleStatus(): void {
  const tailscaleResult = Bun.spawnSync(['tailscale', 'status', '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (tailscaleResult.exitCode === 0) {
    try {
      const status = JSON.parse(tailscaleResult.stdout.toString());
      const hostname = status.Self?.DNSName?.replace(/\.$/, '') || 'unknown';
      console.log(`${t('status.tailscaleConnected')}`);
      console.log(`   Hostname: ${hostname}`);
    } catch {
      console.log('Tailscale: Unknown');
    }
  } else {
    console.log(`${t('status.tailscaleDisconnected')}`);
  }
}
