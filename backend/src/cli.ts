// CLI argument parser and commands
import pkg from '../../package.json';
import { t } from './i18n';
import { IDENTITY } from '../../shared/identity';

const VERSION = pkg.version;

/**
 * The port, from identity. Spelled out, it survives a rename in the
 * worst way: `--help` reads its number from identity and says one thing, while
 * the server binds the other. A renamed build then goes for the port the
 * product it replaces is already serving on, and dies with EADDRINUSE on a
 * machine where both are installed.
 *
 * There is deliberately no dev branch here. One used to sit in front of this,
 * picking `devPort` when `--watch` appeared in argv — but bun does not pass
 * `--watch` to the script, so it was false in every run and the explicit
 * `-p` in the dev script was what actually chose the port. Restoring the
 * detection would do more than undo dead code: this default is also where
 * `hrdle send` and `hrdle peek` address the local server (`options.port`
 * below), and those want the installed service, not whatever a checkout
 * happens to be running. scripts/dev-backend.sh passes `-p` instead.
 */
const DEFAULT_PORT = IDENTITY.defaultPort;

interface CliOptions {
  command: 'serve' | 'setup' | 'uninstall' | 'update' | 'status' | 'notify' | 'help' | 'version' | 'debug' | 'send' | 'peek' | 'glasses' | 'address' | 'stt-prompt' | 'steward' | 'steward-do';
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
  /** `--choices`, shared by `glasses` and `steward ask`. */
  choices?: string[];
  stewardVerb?: 'notify' | 'ask' | 'report' | 'line' | 'turns' | 'screen';
  /** Positional words after the verb, in order. */
  stewardArgs?: string[];
  stewardDetail?: string;
  stewardMode?: 'single' | 'multi' | 'freeText';
  stewardStep?: { index: number; total: number };
  stewardFile?: string;
  stewardDoVerb?: string;
  stewardDoArgs?: string[];
  /** `--session`, shared by every command that addresses one. */
  session?: string;
  sttPromptText?: string;
  sttPromptClear?: boolean;
  sttGlossary?: boolean;
  sttPromptReplace?: boolean;
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
  ${IDENTITY.binaryName} address             Print where this server can be reached: the short
                            address for the glasses app's Connect step, and the
                            URL for a browser
  ${IDENTITY.binaryName} notify              Send hook event (reads JSON from stdin)
  ${IDENTITY.binaryName} steward <verb>      How the steward reaches its owner. Prints JSON.
                            notify <text> [--detail <md>]
                            ask <text> [--choices "a,b"] [--mode single|multi|freeText]
                                       [--step 2/3] [--detail <md>]   -> ask_id
                            report <heading> --file <rows>  (one row per line)
                            line <session> <text>
                            turns <session> --file <json>
                            screen
                            Fails unless the steward is enabled on the server.
  ${IDENTITY.binaryName} steward-do <verb>   The only way the steward touches a session. Runs
                            against the watched herdr server, not the steward's
                            own, and journals every action.
                            watch | read <agent> | clear <agent>
                            say <agent> <text> | stop <agent> | journal [n]
  ${IDENTITY.binaryName} glasses <text>      Post a self-note to the G2 glasses relay channel
                            [--kind waiting|info] [--choices "a,b"] [--session <id>]
                            (session is auto-resolved: cwd → process ancestors)
  ${IDENTITY.binaryName} stt-prompt [words]  Words this session's speech is made of. They lead
                            the vocabulary sent with its transcriptions, ahead
                            of the shared glossary. No argument prints what is
                            set; words are added to the list, --replace swaps
                            it and --clear removes it. A workspace that speaks
                            none of this product's words takes --no-glossary
                            and gets the whole budget for its own.
                            [--session <id>] [--replace] [--glossary|--no-glossary]
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

    if (options.command === 'steward-do' && !arg.startsWith('-')) {
      if (!options.stewardDoVerb) {
        options.stewardDoVerb = arg;
      } else {
        if (!options.stewardDoArgs) options.stewardDoArgs = [];
        options.stewardDoArgs.push(arg);
      }
      i++;
      continue;
    }

    // Once `steward` has been seen, every bare word after it belongs to it.
    // Its verbs and its text are arbitrary words, and several of them are also
    // command names - `steward notify "..."` was being re-read as the `notify`
    // command, and any message containing `update` or `status` would be too.
    if (options.command === 'steward' && !arg.startsWith('-')) {
      if (!options.stewardVerb) {
        options.stewardVerb = arg as CliOptions['stewardVerb'];
      } else {
        if (!options.stewardArgs) options.stewardArgs = [];
        options.stewardArgs.push(arg);
      }
      i++;
      continue;
    }

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
      case 'address':
        options.command = 'address';
        break;
      case 'notify':
        options.command = 'notify';
        break;
      case 'steward':
        options.command = 'steward';
        break;
      case 'steward-do':
        options.command = 'steward-do';
        break;
      case '--detail':
        i++;
        options.stewardDetail = args[i];
        if (options.stewardDetail === undefined) {
          console.error('--detail takes markdown text');
          process.exit(1);
        }
        break;
      case '--mode': {
        i++;
        const mode = args[i];
        if (mode !== 'single' && mode !== 'multi' && mode !== 'freeText') {
          console.error('--mode takes single, multi or freeText');
          process.exit(1);
        }
        options.stewardMode = mode;
        break;
      }
      case '--step': {
        i++;
        const step = (args[i] ?? '').match(/^(\d+)\/(\d+)$/);
        if (!step) {
          console.error('--step looks like 2/3');
          process.exit(1);
        }
        options.stewardStep = { index: Number(step[1]), total: Number(step[2]) };
        break;
      }
      case '--file':
        i++;
        options.stewardFile = args[i];
        if (!options.stewardFile) {
          console.error('--file takes a path');
          process.exit(1);
        }
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
          console.error('--kind takes either waiting or info');
          process.exit(1);
        }
        options.glassesKind = kind;
        break;
      }
      case '--choices':
        i++;
        if (!args[i]) {
          console.error('--choices takes a comma-separated list of choices');
          process.exit(1);
        }
        options.choices = args[i].split(',').map((c) => c.trim()).filter((c) => c.length > 0);
        break;
      case '--session':
        i++;
        if (!args[i]) {
          console.error('--session takes a session id');
          process.exit(1);
        }
        options.session = args[i];
        break;
      case 'stt-prompt': {
        options.command = 'stt-prompt';
        const next = args[i + 1];
        if (next && !next.startsWith('-')) {
          options.sttPromptText = next;
          i++;
        }
        break;
      }
      case '--clear':
        options.sttPromptClear = true;
        break;
      case '--replace':
        options.sttPromptReplace = true;
        break;
      case '--no-glossary':
        options.sttGlossary = false;
        break;
      case '--glossary':
        options.sttGlossary = true;
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
          console.error('--wait-ms must be a non-negative integer');
          process.exit(1);
        }
        break;
      case '--lines':
        i++;
        options.sendLines = parseInt(args[i], 10);
        if (Number.isNaN(options.sendLines) || options.sendLines < 0) {
          console.error('--lines must be a non-negative integer');
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
          console.error('--seconds must be a positive integer');
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
          console.error(`${t('cli.errorInvalidPort')}`);
          process.exit(1);
        }
        break;
      case '-H':
      case '--host':
        i++;
        options.host = args[i];
        if (!options.host) {
          console.error(`${t('cli.errorNoHost')}`);
          process.exit(1);
        }
        break;
      case '-P':
      case '--password':
        i++;
        options.password = args[i];
        if (!options.password) {
          console.error(`${t('cli.errorNoPassword')}`);
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
          console.error(`${t('cli.errorUnknownOption', { option: arg })}`);
          console.error(`Help: ${IDENTITY.binaryName} --help`);
          process.exit(1);
        }
        // A bare word belonging to `stt-prompt` reaches here whenever a flag
        // came between it and the command. Dropping it made the write a
        // silent no-op that printed the current value instead - a write
        // command that reports success by showing you the thing it did not
        // change.
        if (options.command === 'stt-prompt' && options.sttPromptText === undefined) {
          options.sttPromptText = arg;
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

    case 'address':
      await runAddress(options.port);
      return 'exit';

    case 'notify':
      await runNotify(options);
      return 'exit';

    case 'steward':
      await runStewardCommand(options);
      return 'exit';

    case 'steward-do': {
      const { runStewardDo } = await import('./commands/steward-do');
      await runStewardDo(options);
      return 'exit';
    }

    case 'glasses':
      await runGlasses(options);
      return 'exit';

    case 'stt-prompt':
      await runSttPromptCommand(options);
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

async function runStewardCommand(options: CliOptions): Promise<void> {
  const { runSteward } = await import('./commands/steward');
  await runSteward({ ...options, stewardChoices: options.choices });
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
    kind: options.glassesKind ?? (options.choices?.length ? 'waiting' : 'info'),
    choices: options.choices,
    session: options.session,
    port: options.port,
  });
}

async function runSttPromptCommand(options: CliOptions): Promise<void> {
  const { runSttPrompt } = await import('./commands/stt-prompt');
  // Three states, and `undefined` is not "empty": no argument means show, and
  // only --clear removes what is set. A bare `hrdle stt-prompt` wiping the
  // session's vocabulary would be the kind of surprise this whole issue is
  // about.
  await runSttPrompt({
    text: options.sttPromptClear ? null : options.sttPromptText,
    replace: options.sttPromptReplace,
    glossary: options.sttGlossary,
    session: options.session,
    port: options.port,
  });
}

async function runSend(options: CliOptions): Promise<void> {
  if (!options.sendTarget) {
    console.error(
      `target is required: ${IDENTITY.binaryName} send <peer>:<session>:<paneId> [text]`,
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
    console.error(`${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function runPeek(options: CliOptions): Promise<void> {
  if (!options.peekTarget) {
    console.error(
      `target is required: ${IDENTITY.binaryName} peek <peer>:<session>:<paneId>`,
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
    console.error(`${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function runStatus(): Promise<void> {
  const { showStatus } = await import('./commands/status');
  await showStatus();
}

async function runAddress(port: number): Promise<void> {
  const { showAddress } = await import('./commands/address');
  showAddress(port);
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
