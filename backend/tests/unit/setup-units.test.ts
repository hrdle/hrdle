import { describe, expect, test } from 'bun:test';
import {
  buildLaunchdPlist,
  buildLaunchdUpdatePlist,
  SYSTEMD_SERVICE,
  SYSTEMD_UPDATE_SERVICE,
  SYSTEMD_UPDATE_TIMER,
} from '../../src/commands/setup';

/**
 * Golden text for the service definitions `cchub setup` writes.
 *
 * These used to be literals and are now composed from `identity.json`, which is
 * exactly the kind of change that can alter the output by a character without
 * anyone noticing — and the output is a systemd unit and a launchd plist, where
 * a wrong label or a missing EnvironmentFile means the service silently stops
 * coming back after a reboot.
 *
 * The strings below were taken from the units this machine already had on disk,
 * written by the pre-refactor code, and verified byte-identical against the
 * composed versions.
 */

describe('systemd units', () => {
  test('main service is unchanged', () => {
    expect(SYSTEMD_SERVICE).toBe(`[Unit]
Description=CC Hub - Claude Code Session Manager
After=network.target tailscaled.service

[Service]
Type=simple
ExecStart=__SHELL__ -lc 'exec __EXEC_PATH__ -p __PORT__'
EnvironmentFile=%h/.config/cchub/env
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
Description=CC Hub update check

[Service]
Type=oneshot
ExecStart=__EXEC_PATH__ update --auto
`);
  });

  test('update timer is unchanged', () => {
    expect(SYSTEMD_UPDATE_TIMER).toBe(`[Unit]
Description=Check CC Hub updates daily

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
    const plist = buildLaunchdPlist('/home/u/bin/cchub', 5923);
    expect(plist).toContain('<string>com.cchub.server</string>');
    expect(plist).toContain('.cc-hub/cchub.log');
    // The port has to survive as its own argv entry, not folded into the path.
    expect(plist).toContain('<string>-p</string>');
    expect(plist).toContain('<string>5923</string>');
  });

  test('update plist keeps its label and log path', () => {
    const plist = buildLaunchdUpdatePlist('/home/u/bin/cchub');
    expect(plist).toContain('<string>com.cchub.update</string>');
    expect(plist).toContain('.cc-hub/update.log');
    expect(plist).toContain('<string>update</string>');
    expect(plist).toContain('<string>--auto</string>');
  });
});
