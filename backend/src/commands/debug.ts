// `cchub debug` — toggle Bun inspector mode on the running systemd user service.
//
// Bun supports inspector / cpu profiling via the `BUN_OPTIONS` environment
// variable on compiled binaries. We expose it as a systemd drop-in so the user
// can flip it on for a short profiling window without touching the main unit
// file or recompiling.

import { spawn } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, unlink, access } from 'node:fs/promises';
import { SERVICE } from '../../../shared/identity';

const DROP_IN_DIR = join(
  homedir(),
  '.config',
  'systemd',
  'user',
  SERVICE.dropInDir,
);
const DROP_IN_FILE = join(DROP_IN_DIR, '99-inspect.conf');
const DEFAULT_INSPECT_PORT = 9229;

interface DebugOptions {
  sub: 'enable' | 'disable' | 'profile' | 'status';
  seconds?: number;
}

export async function runDebug(opts: DebugOptions): Promise<void> {
  if (platform() !== 'linux') {
    console.error('❌ `cchub debug` currently supports Linux systemd-user only.');
    process.exit(1);
  }

  switch (opts.sub) {
    case 'enable':
      await enableInspector();
      break;
    case 'disable':
      await disableInspector();
      break;
    case 'profile':
      await profileInspector(opts.seconds ?? 30);
      break;
    case 'status':
      await showInspectorStatus();
      break;
  }
}

async function enableInspector(): Promise<void> {
  const port = DEFAULT_INSPECT_PORT;
  const conf = [
    '[Service]',
    `Environment="BUN_OPTIONS=--inspect=0.0.0.0:${port}"`,
    '',
  ].join('\n');
  await mkdir(DROP_IN_DIR, { recursive: true });
  await writeFile(DROP_IN_FILE, conf);
  await runSystemctl(['daemon-reload']);
  console.log(`🔧 Reloading systemd, restarting ${SERVICE.unitFile}…`);
  await runSystemctl(['restart', SERVICE.unitFile]);
  console.log('');
  console.log(`✅ Inspector enabled on 0.0.0.0:${port}`);
  console.log('');
  console.log('Connect with Chrome DevTools:');
  console.log('  1. Open chrome://inspect');
  console.log(`  2. Configure… → add "<host>:${port}" (e.g. 100.91.210.90:${port})`);
  console.log('  3. The "cchub" remote target should appear — click "inspect"');
  console.log('  4. Performance tab → Record → reproduce → Stop → save .cpuprofile');
  console.log('');
  console.log('Disable again with: cchub debug disable');
}

async function disableInspector(): Promise<void> {
  let removed = false;
  try {
    await access(DROP_IN_FILE);
    await unlink(DROP_IN_FILE);
    removed = true;
  } catch {
    // drop-in didn't exist
  }
  if (!removed) {
    console.log('ℹ️  Inspector was not enabled (no drop-in present).');
    return;
  }
  await runSystemctl(['daemon-reload']);
  console.log(`🔧 Reloading systemd, restarting ${SERVICE.unitFile}…`);
  await runSystemctl(['restart', SERVICE.unitFile]);
  console.log(`✅ Inspector disabled, ${SERVICE.unitFile} back to normal.`);
}

async function profileInspector(seconds: number): Promise<void> {
  await enableInspector();
  console.log('');
  console.log(`⏱️  Profiling window: ${seconds}s. Inspector will be torn down automatically.`);
  console.log('   Press Ctrl-C to keep it open longer — disable later with `cchub debug disable`.');
  await sleep(seconds * 1000);
  console.log('');
  console.log('⏰ Window elapsed, disabling inspector…');
  await disableInspector();
}

async function showInspectorStatus(): Promise<void> {
  let enabled = false;
  try {
    await access(DROP_IN_FILE);
    enabled = true;
  } catch {
    // not present
  }
  if (enabled) {
    console.log(`🟢 Inspector enabled (drop-in: ${DROP_IN_FILE})`);
    console.log(`   Port: ${DEFAULT_INSPECT_PORT}`);
  } else {
    console.log('⚪ Inspector disabled.');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSystemctl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('systemctl', ['--user', ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`systemctl --user ${args.join(' ')} exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}
