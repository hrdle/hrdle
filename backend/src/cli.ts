// CLI argument parser and commands
import pkg from '../../package.json';
import { t } from './i18n';
import { IDENTITY } from '../../shared/identity';

const VERSION = pkg.version;

// Development mode detection (running with bun run --watch)
const isDev = process.argv.some(arg => arg.includes('--watch'));
// Both ports are identity's (#459). Spelled out, they survive a rename in the
// worst way: `--help` reads its number from identity and says one thing, while
// the server binds the other. A renamed build then goes for the port the
// product it replaces is already serving on, and dies with EADDRINUSE on a
// machine where both are installed.
const DEFAULT_PORT = isDev ? IDENTITY.devPort : IDENTITY.defaultPort;

interface CliOptions {
  command: 'serve' | 'setup' | 'uninstall' | 'update' | 'status' | 'notify' | 'help' | 'version' | 'debug' | 'send' | 'peek' | 'glasses';
  port: number;
  host: string;
  password?: string;
  updateCheck?: boolean;
  updateAuto?: boolean;
  debugSubcommand?: 'enable' | 'disable' | 'profile' | 'status';
  debugPort?: number;
  debugSeconds?: number;
  sendTarget?: string;
  sendText?: string;
  sendStdin?: boolean;
  sendNewline?: boolean;
  sendSubmit?: boolean;
  sendBase64?: boolean;
  sendWait?: boolean;
  sendWaitMs?: number;
  sendLines?: number;
  peekTarget?: string;
  glassesText?: string;
  glassesKind?: 'waiting' | 'info';
  glassesChoices?: string[];
  glassesSession?: string;
}

function printHelp(): void {
  console.log(`
${IDENTITY.productName} v${VERSION} - ${IDENTITY.tagline}

${t('cli.usage')}
  ${t('cli.serverStart')}
  ${IDENTITY.binaryName} setup [options]     Register service (systemd on Linux, launchd on macOS)
  ${IDENTITY.binaryName} uninstall           Remove service registration
  ${IDENTITY.binaryName} update [options]    Check and apply updates
  ${IDENTITY.binaryName} status              Show service status
  ${IDENTITY.binaryName} notify              Send hook event (reads JSON from stdin)
  ${IDENTITY.binaryName} glasses <text>      Post a self-note to the G2 glasses relay channel
                            [--kind waiting|info] [--choices "a,b"] [--session <id>]
                            (session is auto-resolved: cwd → process ancestors)
  ${IDENTITY.binaryName} send <target> [text]  Send input to a pane on a peer or local server
                              target: <peer>:<session>:<paneId>
                              (peer can be 'local', a peer id, or a nickname)
  ${IDENTITY.binaryName} peek <target>       Snapshot a pane's current viewport (last 20 rows
                            by default) — useful for checking peer state
                            without opening the peer UI.
  ${IDENTITY.binaryName} debug <sub>         Toggle Bun inspector mode on the running service
                            sub: enable | disable | profile | status

${t('cli.options')}
  ${t('cli.optionPort')}
  ${t('cli.optionHost')}
  ${t('cli.optionPassword')}

update options:
  --check                Check only (no update)
  --auto                 Auto-update mode (for timer)

debug options:
  --port <port>          Inspector port (default 9229)
  --seconds <n>          For 'profile' sub: enable for N seconds then auto-disable

send options:
  --stdin                Read payload from stdin instead of arg
  --newline              Append \\r to payload (acts like pressing Enter once)
  --submit               Wrap payload in bracketed paste markers + Enter for
                         Claude Code / Codex TUI submit (works at any length)
  --base64               Treat payload as base64 (binary-safe)
  --wait                 After sending, snapshot the peer pane viewport and
                         print it (with detected state: idle / processing /
                         permission_prompt / ask_user_question / unknown).
  --wait-ms <n>          Delay before snapshot when --wait is set (default 800)
  --lines <n>            Trailing rows to include in viewport (default 20)

peek options:
  --lines <n>            Trailing rows to include in viewport (default 20)

${t('cli.examples')}
  ${t('cli.exampleStart')}
  ${t('cli.exampleWithPort')}
  ${IDENTITY.binaryName} setup -P secret      Register service with password (stored in Keychain on macOS)
  ${IDENTITY.binaryName} update               Update to latest
`);
}

function printVersion(): void {
  console.log(`${IDENTITY.binaryName} v${VERSION}`);
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    command: 'serve',
    port: DEFAULT_PORT,
    host: '0.0.0.0',
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    switch (arg) {
      case 'setup':
        options.command = 'setup';
        break;
      case 'uninstall':
        options.command = 'uninstall';
        break;
      case 'update':
        options.command = 'update';
        break;
      case 'status':
        options.command = 'status';
        break;
      case 'notify':
        options.command = 'notify';
        break;
      case 'glasses': {
        options.command = 'glasses';
        const next = args[i + 1];
        if (next && !next.startsWith('-')) {
          options.glassesText = next;
          i++;
        }
        break;
      }
      case '--kind': {
        i++;
        const kind = args[i];
        if (kind !== 'waiting' && kind !== 'info') {
          console.error('❌ --kind は waiting か info を指定してください');
          process.exit(1);
        }
        options.glassesKind = kind;
        break;
      }
      case '--choices':
        i++;
        if (!args[i]) {
          console.error('❌ --choices にはカンマ区切りの選択肢を指定してください');
          process.exit(1);
        }
        options.glassesChoices = args[i].split(',').map((c) => c.trim()).filter((c) => c.length > 0);
        break;
      case '--session':
        i++;
        if (!args[i]) {
          console.error('❌ --session にはセッション id を指定してください');
          process.exit(1);
        }
        options.glassesSession = args[i];
        break;
      case 'send': {
        options.command = 'send';
        const next = args[i + 1];
        if (next && !next.startsWith('-')) {
          options.sendTarget = next;
          i++;
          const maybeText = args[i + 1];
          if (maybeText !== undefined && !maybeText.startsWith('-')) {
            options.sendText = maybeText;
            i++;
          }
        }
        break;
      }
      case 'peek': {
        options.command = 'peek';
        const next = args[i + 1];
        if (next && !next.startsWith('-')) {
          options.peekTarget = next;
          i++;
        }
        break;
      }
      case '--stdin':
        options.sendStdin = true;
        break;
      case '--newline':
        options.sendNewline = true;
        break;
      case '--submit':
        options.sendSubmit = true;
        break;
      case '--base64':
        options.sendBase64 = true;
        break;
      case '--wait':
        options.sendWait = true;
        break;
      case '--wait-ms':
        i++;
        options.sendWaitMs = parseInt(args[i], 10);
        if (Number.isNaN(options.sendWaitMs) || options.sendWaitMs < 0) {
          console.error('❌ --wait-ms must be a non-negative integer');
          process.exit(1);
        }
        break;
      case '--lines':
        i++;
        options.sendLines = parseInt(args[i], 10);
        if (Number.isNaN(options.sendLines) || options.sendLines < 0) {
          console.error('❌ --lines must be a non-negative integer');
          process.exit(1);
        }
        break;
      case 'debug': {
        options.command = 'debug';
        // Next non-flag arg is the sub-command.
        const sub = args[i + 1];
        if (sub === 'enable' || sub === 'disable' || sub === 'profile' || sub === 'status') {
          options.debugSubcommand = sub;
          i++;
        } else {
          options.debugSubcommand = 'status';
        }
        break;
      }
      case '--seconds':
        i++;
        options.debugSeconds = parseInt(args[i], 10);
        if (Number.isNaN(options.debugSeconds) || options.debugSeconds < 1) {
          console.error('❌ --seconds must be a positive integer');
          process.exit(1);
        }
        break;
      case '-h':
      case '--help':
        options.command = 'help';
        break;
      case '-v':
      case '--version':
        options.command = 'version';
        break;
      case '-p':
      case '--port':
        i++;
        options.port = parseInt(args[i], 10);
        if (Number.isNaN(options.port) || options.port < 1 || options.port > 65535) {
          console.error(`❌ ${t('cli.errorInvalidPort')}`);
          process.exit(1);
        }
        break;
      case '-H':
      case '--host':
        i++;
        options.host = args[i];
        if (!options.host) {
          console.error(`❌ ${t('cli.errorNoHost')}`);
          process.exit(1);
        }
        break;
      case '-P':
      case '--password':
        i++;
        options.password = args[i];
        if (!options.password) {
          console.error(`❌ ${t('cli.errorNoPassword')}`);
          process.exit(1);
        }
        break;
      case '--check':
        options.updateCheck = true;
        break;
      case '--auto':
        options.updateAuto = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`❌ ${t('cli.errorUnknownOption', { option: arg })}`);
          console.error(`Help: ${IDENTITY.binaryName} --help`);
          process.exit(1);
        }
    }
    i++;
  }

  return options;
}

export async function runCli(options: CliOptions): Promise<'serve' | 'exit'> {
  switch (options.command) {
    case 'help':
      printHelp();
      return 'exit';

    case 'version':
      printVersion();
      return 'exit';

    case 'setup':
      await runSetup(options);
      return 'exit';

    case 'uninstall':
      await runUninstall();
      return 'exit';

    case 'update':
      await runUpdate(options);
      return 'exit';

    case 'status':
      await runStatus();
      return 'exit';

    case 'notify':
      await runNotify(options);
      return 'exit';

    case 'glasses':
      await runGlasses(options);
      return 'exit';

    case 'send':
      await runSend(options);
      return 'exit';

    case 'peek':
      await runPeek(options);
      return 'exit';

    case 'debug':
      await runDebug(options);
      return 'exit';

    case 'serve':
      return 'serve';
  }
}

async function runSetup(options: CliOptions): Promise<void> {
  const { setupService } = await import('./commands/setup');
  await setupService(options.port, options.password);
}

async function runUninstall(): Promise<void> {
  const { uninstallService } = await import('./commands/uninstall');
  await uninstallService();
}

async function runUpdate(options: CliOptions): Promise<void> {
  const { checkAndUpdate } = await import('./commands/update');
  await checkAndUpdate(options.updateCheck ?? false, options.updateAuto ?? false);
}

async function runNotify(options: CliOptions): Promise<void> {
  const { sendNotify } = await import('./commands/notify');
  await sendNotify(options.port);
}

async function runGlasses(options: CliOptions): Promise<void> {
  const { runGlasses: impl } = await import('./commands/glasses');
  await impl({
    text: options.glassesText,
    kind: options.glassesKind ?? (options.glassesChoices?.length ? 'waiting' : 'info'),
    choices: options.glassesChoices,
    session: options.glassesSession,
    port: options.port,
  });
}

async function runSend(options: CliOptions): Promise<void> {
  if (!options.sendTarget) {
    console.error(
      `❌ target is required: ${IDENTITY.binaryName} send <peer>:<session>:<paneId> [text]`,
    );
    process.exit(1);
  }
  const { runSend: runSendImpl } = await import('./commands/send');
  try {
    await runSendImpl({
      target: options.sendTarget,
      text: options.sendText,
      stdin: options.sendStdin ?? false,
      newline: options.sendNewline ?? false,
      submit: options.sendSubmit ?? false,
      base64: options.sendBase64 ?? false,
      localPort: options.port,
      wait: options.sendWait ?? false,
      waitMs: options.sendWaitMs ?? 800,
      lines: options.sendLines ?? 20,
    });
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function runPeek(options: CliOptions): Promise<void> {
  if (!options.peekTarget) {
    console.error(
      `❌ target is required: ${IDENTITY.binaryName} peek <peer>:<session>:<paneId>`,
    );
    process.exit(1);
  }
  const { runPeek: runPeekImpl } = await import('./commands/send');
  try {
    await runPeekImpl({
      target: options.peekTarget,
      lines: options.sendLines ?? 20,
      localPort: options.port,
    });
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function runStatus(): Promise<void> {
  const { showStatus } = await import('./commands/status');
  await showStatus();
}

async function runDebug(options: CliOptions): Promise<void> {
  const { runDebug: runDebugImpl } = await import('./commands/debug');
  // `options.port` is the server port; reuse the original DEFAULT_PORT default
  // for that and let debug.ts pick the inspector port itself when the user
  // hasn't passed an explicit override (we don't currently expose a separate
  // `--inspect-port` flag — debug.ts defaults to 9229).
  await runDebugImpl({
    sub: options.debugSubcommand ?? 'status',
    seconds: options.debugSeconds,
  });
}

export { VERSION };
