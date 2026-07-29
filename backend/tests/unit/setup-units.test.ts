import { describe, expect, test } from 'bun:test';
import {
  buildLaunchdPlist,
  buildLaunchdUpdatePlist,
  SYSTEMD_SERVICE,
  SYSTEMD_UPDATE_SERVICE,
  SYSTEMD_UPDATE_TIMER,
} from '../../src/commands/setup';

/**
 * Golden text for the service definitions `hrdle setup` writes.
 *
 * These are composed from `identity.json`, which is exactly the kind of thing
 * that can alter the output by a character without anyone noticing — and the
 * output is a systemd unit and a launchd plist, where a wrong label or a
 * missing EnvironmentFile means the service silently stops coming back after a
 * reboot.
 *
 * Spelled out rather than composed from identity a second time: a golden that
 * builds itself the same way the code does agrees with any output at all. So
 * the rename (#459) had to edit these by hand, which is the point of them.
 */

describe('systemd units', () => {
  test('main service is unchanged', () => {
    expect(SYSTEMD_SERVICE).toBe(`[Unit]
Description=Hrdle - Coding Agent Session Manager
After=network.target tailscaled.service

[Service]
Type=simple
ExecStart=__SHELL__ -lc 'exec __EXEC_PATH__ -p __PORT__'
EnvironmentFile=%h/.config/hrdle/env
Environment=PATH=__PATH__
KillMode=process
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`);
  });

  test('update service is unchanged', () => {
    expect(SYSTEMD_UPDATE_SERVICE).toBe(`[Unit]
Description=Hrdle update check

[Service]
Type=oneshot
ExecStart=__EXEC_PATH__ update --auto
`);
  });

  test('update timer is unchanged', () => {
    expect(SYSTEMD_UPDATE_TIMER).toBe(`[Unit]
Description=Check Hrdle updates daily

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
`);
  });
});

describe('launchd plists', () => {
  test('server plist keeps its label and log path', () => {
    const plist = buildLaunchdPlist('/home/u/bin/hrdle', 5924);
    expect(plist).toContain('<string>com.hrdle.server</string>');
    expect(plist).toContain('.hrdle/hrdle.log');
    // The port has to survive as its own argv entry, not folded into the path.
    expect(plist).toContain('<string>-p</string>');
    expect(plist).toContain('<string>5924</string>');
  });

  test('update plist keeps its label and log path', () => {
    const plist = buildLaunchdUpdatePlist('/home/u/bin/hrdle');
    expect(plist).toContain('<string>com.hrdle.update</string>');
    expect(plist).toContain('.hrdle/update.log');
    expect(plist).toContain('<string>update</string>');
    expect(plist).toContain('<string>--auto</string>');
  });
});
