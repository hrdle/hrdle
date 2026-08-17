import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { auth } from './routes/auth';
import { logs } from './routes/logs';
import { sessions } from './routes/sessions';
import { upload } from './routes/upload';
import { files } from './routes/files';
import { dashboard, getDashboard } from './routes/dashboard';
import { notify } from './routes/notify';
import { peers } from './routes/peers';
import { shortTailscaleIp, startDiscoveryServer } from './services/discovery';
import { migrateSessionIds } from './services/session-id-migration';
import { herdr } from './routes/herdr';
import { glasses } from './routes/glasses';
import { steward } from './routes/steward';
import { startStewardRuntime } from './services/steward-runtime';
import { glassesRelay } from './routes/glasses-relay';
import { push } from './routes/push';
import { muxOpen, muxMessage, muxClose, type MuxData } from './routes/terminal-mux';
import { parseArgs, runCli, VERSION } from './cli';
import { conditionalAuthMiddleware, isAuthRequired, getJwtSecret, initJwtSecret } from './middleware/auth';
import { AuthService } from './services/auth';
import { getDataDir } from './utils/storage';
import {
  herdrBinaryPath,
  herdrRpc,
  herdrSessionName,
  herdrSocketPath,
} from './services/herdr-client';
import { t } from './i18n';
import { IDENTITY, PASSWORD_ENV, TMP_PATHS, envVar } from '../../shared/identity';

// Global error handlers to prevent silent crashes
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

// Parse CLI arguments
const args = parseArgs(process.argv.slice(2));
const cliResult = await runCli(args);

if (cliResult === 'exit') {
  process.exit(0);
}

// Server mode - continue with startup

// Try to load embedded assets (available in compiled binary)
let getStaticAsset: ((path: string) => { content: Buffer; contentType: string } | null) | null = null;
let EMBEDDED_MODE = false;
try {
  const staticAssets = await import('./static-assets');
  getStaticAsset = staticAssets.getStaticAsset;
  EMBEDDED_MODE = true;
} catch {
  // Static assets not bundled, use file system
}

const app = new Hono();

// Middleware - custom logger that skips noisy polling endpoints
app.use('*', logger((message, ...rest) => {
  // Skip GET /api/sessions|/api/workspaces polling logs (fired every 5s per client)
  if (
    message.includes('GET') &&
    (message.includes('/api/sessions') || message.includes('/api/workspaces')) &&
    !message.includes('/api/sessions/') &&
    !message.includes('/api/workspaces/')
  ) {
    return;
  }
  // Skip POST /api/notify hook traffic — fires on every Claude/Codex hook
  // event (Stop, PreToolUse, PostToolUse, UserPromptSubmit, ...). At ~1/sec
  // during active sessions the logger middleware itself was ~5% of CPU.
  if (message.includes('/api/notify') && !message.includes('/api/notify/')) {
    return;
  }
  console.log(message, ...rest);
}));
app.use('*', cors({
  origin: '*',
}));

// Health check
app.get('/health', (c) => c.json({ status: 'ok', version: VERSION }));

// Cache clear page - unregisters SW and clears all caches
app.get('/clear-cache', (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${IDENTITY.productName} - Clear Cache</title>
<style>body{background:#1a1a1a;color:#fff;font-family:system-ui;padding:20px;text-align:center}
.status{margin:20px 0;padding:15px;border-radius:8px;background:#333}
.ok{color:#4ade80}.err{color:#f87171}button{padding:12px 24px;font-size:16px;
background:#3b82f6;color:#fff;border:none;border-radius:8px;cursor:pointer;margin:10px}
button:active{background:#2563eb}</style></head>
<body><h1>${IDENTITY.productName} Cache Clear</h1><div id="log"></div>
<button onclick="clearAll()">Clear Cache & Reload</button>
<script>
var log=document.getElementById('log');
function addLog(msg,ok){var d=document.createElement('div');d.className='status '+(ok?'ok':'err');d.textContent=msg;log.appendChild(d);}
async function clearAll(){
  log.innerHTML='';
  try{
    var regs=await navigator.serviceWorker.getRegistrations();
    for(var r of regs){await r.unregister();addLog('SW unregistered: '+r.scope,true);}
    if(!regs.length)addLog('No SW registered',true);
  }catch(e){addLog('SW error: '+e,false);}
  try{
    var keys=await caches.keys();
    for(var k of keys){await caches.delete(k);addLog('Cache deleted: '+k,true);}
    if(!keys.length)addLog('No caches found',true);
  }catch(e){addLog('Cache error: '+e,false);}
  addLog('Reloading in 2s...',true);
  setTimeout(function(){location.href='/';},2000);
}
addLog('Version: ${VERSION}',true);
</script></body></html>`);
});

// Auth routes (no auth required for login/required check)
app.route('/api/auth', auth);

// Public images route (no auth required - images are user-uploaded screenshots)
const IMAGES_DIR = TMP_PATHS.imagesDir;
app.get('/api/images/:filename', async (c) => {
  const { readFile } = await import('node:fs/promises');
  const { join, basename } = await import('node:path');

  const filename = c.req.param('filename');

  // Security: only allow alphanumeric, dash, dot for filename
  if (!filename || !/^[\w\-.]+\.(png|jpg|jpeg|gif|webp)$/i.test(filename)) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  const filePath = join(IMAGES_DIR, basename(filename));

  try {
    const data = await readFile(filePath);
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };

    return new Response(data, {
      headers: {
        'Content-Type': mimeTypes[ext || 'png'] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return c.json({ error: 'Image not found' }, 404);
  }
});

// Protected API routes (require auth if password is set)
app.use('/api/logs/*', conditionalAuthMiddleware);
app.use('/api/sessions/*', conditionalAuthMiddleware);
app.use('/api/sessions', conditionalAuthMiddleware);
// `/api/workspaces` is the canonical name (a Hrdle session IS a herdr
// workspace); `/api/sessions` stays as an alias for CLI / peers / glasses.
app.use('/api/workspaces/*', conditionalAuthMiddleware);
app.use('/api/workspaces', conditionalAuthMiddleware);
app.use('/api/upload/*', conditionalAuthMiddleware);
app.use('/api/files/*', conditionalAuthMiddleware);
app.use('/api/dashboard', conditionalAuthMiddleware);
app.use('/api/peers', conditionalAuthMiddleware);
app.use('/api/peers/*', conditionalAuthMiddleware);
app.use('/api/herdr/*', conditionalAuthMiddleware);
// `/api/glasses/relay*` stays OUTSIDE the auth glob: local agents post
// self-notes via `hrdle glasses` from inside panes where no token exists —
// unauthenticated local trust, same pattern as /api/notify. The STT and any
// other glasses endpoints remain protected.
// Adding a device to the push list is a browser asking for a copy of every
// notification, so it needs the same password the UI does. The exception is the
// service worker's re-subscribe after a push service rotates an endpoint: a
// worker cannot read the token out of localStorage, and a subscription that
// cannot be renewed goes silently dead. That path is a no-op unless a matching
// endpoint is already stored, so it can only refresh a device that was
// authenticated once already.
app.use('/api/push/*', (c, next) => {
  if (c.req.path === '/api/push/renew') return next();
  return conditionalAuthMiddleware(c, next);
});
app.use('/api/glasses/*', (c, next) => {
  if (c.req.path.startsWith('/api/glasses/relay')) return next();
  return conditionalAuthMiddleware(c, next);
});
app.use('/api/steward', conditionalAuthMiddleware);
app.use('/api/steward/*', conditionalAuthMiddleware);

app.route('/api/logs', logs);
app.route('/api/sessions', sessions);
// Alias mount: same router, canonical `workspace` name (see auth note above).
app.route('/api/workspaces', sessions);
app.route('/api/upload', upload);
app.route('/api/files', files);
app.route('/api/dashboard', dashboard);
app.route('/api/notify', notify);
app.route('/api/peers', peers);
app.route('/api/herdr', herdr);
app.route('/api/push', push);
app.route('/api/glasses/relay', glassesRelay);
app.route('/api/glasses', glasses);
app.route('/api/steward', steward);

// Static files handling
const staticRoot = process.env.STATIC_ROOT || '../frontend/dist';

if (EMBEDDED_MODE && getStaticAsset) {
  // Serve from embedded assets
  app.get('*', (c) => {
    const path = c.req.path;

    // Skip API routes
    if (path.startsWith('/api/')) {
      return c.notFound();
    }

    // Try to get asset
    let asset = getStaticAsset?.(path);

    // SPA fallback: any unknown route serves index.html, so it must NOT be
    // cached under the requested path (e.g. /dashboard).
    let isAssetHit = !!asset;
    if (!asset) {
      asset = getStaticAsset?.('/index.html');
      isAssetHit = false;
    }

    if (asset) {
      return new Response(new Uint8Array(asset.content), {
        headers: {
          'Content-Type': asset.contentType,
          // Vite emits content-hashed files under /assets/ (index-a1b2.js),
          // so their contents never change for a given URL -> cache forever.
          // Everything else (index.html, favicon, sw, icons) must be
          // revalidated on every load so a new release is picked up without a
          // manual cache clear.
          'Cache-Control':
            isAssetHit &&
            (path.startsWith('/assets/') ||
              path.startsWith('/glasses/assets/') ||
              path.startsWith('/glasses-steward/assets/'))
              ? 'public, max-age=31536000, immutable'
              : 'no-cache, must-revalidate',
        },
      });
    }

    return c.notFound();
  });
} else {
  // Serve from file system (development mode)
  // Glasses simulator first: it has its own dist and must not fall through to
  // the frontend's SPA index.html.
  const glassesRoot = process.env.GLASSES_STATIC_ROOT || '../glasses/dist-web';
  // The steward app's simulator is mounted first: `/glasses-steward` would
  // otherwise be swallowed by the `/glasses/*` pattern below it.
  const stewardGlassesRoot = process.env.GLASSES_STEWARD_STATIC_ROOT || '../glasses-steward/dist-web';
  app.use(
    '/glasses-steward/*',
    serveStatic({
      root: stewardGlassesRoot,
      rewriteRequestPath: (p) => p.replace(/^\/glasses-steward/, ''),
    })
  );
  app.get('/glasses-steward', serveStatic({ root: stewardGlassesRoot, path: '/index.html' }));
  app.use(
    '/glasses/*',
    serveStatic({ root: glassesRoot, rewriteRequestPath: (p) => p.replace(/^\/glasses/, '') })
  );
  app.get('/glasses', serveStatic({ root: glassesRoot, path: '/index.html' }));
  app.use('/*', serveStatic({ root: staticRoot }));
  app.get('*', serveStatic({ root: staticRoot, path: '/index.html' }));
}

// Export app type for Hono RPC
export type AppType = typeof app;

// Tailscale certificate setup (required)
const fs = await import('node:fs');
const path = await import('node:path');

// Check if tailscale command exists
const whichResult = Bun.spawnSync(['which', 'tailscale']);
if (whichResult.exitCode !== 0) {
  console.error(`${t('server.tailscaleNotFound')}`);
  console.error('   Install: https://tailscale.com/download');
  process.exit(1);
}

// herdr backend: verify the binary exists, then make sure the headless
// server is reachable — auto-start it if not (it daemon-izes per user and
// owns all pane PTYs, so hrdle restarts don't kill running agents).
const herdrPath = herdrBinaryPath();
if (!herdrPath) {
  console.error(`${t('server.herdrNotFound')}`);
  console.error(`   ${t('server.herdrInstallHint')}`);
  process.exit(1);
}

// The socket API version this build was developed and tested against.
// herdr auto-update only NOTIFIES (never self-applies), but a manual
// `herdr update` + server restart can bump the protocol; surface that
// loudly instead of failing on odd RPC shapes later.
const HERDR_TESTED_PROTOCOL = 16;

interface HerdrPong {
  version?: string;
  protocol?: number;
}

async function herdrPing(): Promise<HerdrPong | null> {
  try {
    return await herdrRpc<HerdrPong>('ping', {});
  } catch {
    return null;
  }
}

let herdrPong = await herdrPing();
if (!herdrPong) {
  const herdrSession = herdrSessionName();
  console.log(
    herdrSession
      ? `⏳ herdr server not running; starting it (session ${herdrSession})...`
      : '⏳ herdr server not running; starting it...',
  );
  // `--session` rather than only pointing the child at a socket: HERDR_SOCKET_PATH
  // moves the socket but leaves the logs and session.json in the default session
  // directory, so two servers started that way would write the same workspace
  // state over each other. Dropping it from the child's environment keeps an
  // inherited value from quietly putting us back there.
  const { HERDR_SOCKET_PATH: _inherited, ...childEnv } = process.env;
  Bun.spawn(
    herdrSession
      ? [herdrPath, '--session', herdrSession, 'server']
      : [herdrPath, 'server'],
    {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env: herdrSession ? childEnv : process.env,
    },
  ).unref();
  for (let i = 0; i < 20 && !herdrPong; i++) {
    await new Promise((r) => setTimeout(r, 250));
    herdrPong = await herdrPing();
  }
  if (!herdrPong) {
    console.error(`${t('server.herdrStartFailed')}`);
    console.error(`   socket: ${herdrSocketPath()}`);
    process.exit(1);
  }
  console.log('herdr server started');
}
console.log(`herdr ${herdrPong.version ?? '?'} (protocol ${herdrPong.protocol ?? '?'})`);

// Settings written against a workspace name move onto its workspace id.
// Needs herdr, so it runs here rather than at import time, and it is not
// awaited: nothing about serving depends on it.
void migrateSessionIds();
if (herdrPong.protocol !== undefined && herdrPong.protocol !== HERDR_TESTED_PROTOCOL) {
  console.warn(
    `warning: herdr protocol ${herdrPong.protocol} differs from the tested protocol ${HERDR_TESTED_PROTOCOL}. ` +
      'Terminal features may misbehave — check the herdr changelog before relying on this setup.',
  );
}

// Get Tailscale hostname
const statusResult = Bun.spawnSync(['tailscale', 'status', '--json']);
if (statusResult.exitCode !== 0) {
  console.error(`${t('server.tailscaleNotRunning')}`);
  console.error(`   ${t('server.tailscaleCheckRunning')}`);
  process.exit(1);
}

let tailscaleHostname: string;
/** This machine's own tailnet address, for the short form the setup screen takes. */
let tailscaleIp: string | null = null;
try {
  const status = JSON.parse(statusResult.stdout.toString());
  const dnsName = status.Self?.DNSName;
  if (!dnsName) {
    throw new Error('DNSName not found in Tailscale status');
  }
  // Remove trailing dot if present
  tailscaleHostname = dnsName.replace(/\.$/, '');
  const ips = status.Self?.TailscaleIPs;
  tailscaleIp = Array.isArray(ips) ? (ips.find((ip: unknown) => typeof ip === 'string' && ip.includes('.')) ?? null) : null;
} catch (_e) {
  console.error(`${t('server.tailscaleParseError')}`);
  process.exit(1);
}

const certDir = path.join(process.env.HOME || '/tmp', '.tailscale-certs');
const certPath = path.join(certDir, `${tailscaleHostname}.crt`);
const keyPath = path.join(certDir, `${tailscaleHostname}.key`);

// Check if cert needs to be generated or renewed
let needsCert = !fs.existsSync(certPath) || !fs.existsSync(keyPath);

if (!needsCert) {
  // Check if cert is expiring soon (within 7 days)
  try {
    const checkResult = Bun.spawnSync([
      'openssl', 'x509', '-in', certPath, '-checkend', String(7 * 24 * 60 * 60)
    ]);
    needsCert = checkResult.exitCode !== 0;
  } catch {
    needsCert = true;
  }
}

if (needsCert) {
  console.log('Generating the Tailscale certificate...');
  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });

  const certResult = Bun.spawnSync([
    'tailscale', 'cert',
    '--cert-file', certPath,
    '--key-file', keyPath,
    tailscaleHostname
  ]);

  if (certResult.exitCode !== 0) {
    const stderr = certResult.stderr.toString();
    console.error(`${t('server.tailscaleCertError')}`);
    console.error(stderr);
    if (stderr.includes('Access denied') || stderr.includes('cert access denied')) {
      console.error('');
      console.error('Hint: Run this command once:');
      console.error('   sudo tailscale set --operator=$USER');
    }
    process.exit(1);
  }
  console.log(`Certificate generated: ${certDir}`);
}

// Store password in environment for auth middleware. Priority:
//   1. -P CLI arg
//   2. PASSWORD_ENV (set by the systemd EnvironmentFile `setup` writes), then
//      the spellings this app used before the rename
//   3. macOS Keychain — populated by `setup`
let resolvedPassword: string | undefined = args.password;
let passwordSource: 'cli' | 'env' | 'keychain' | 'none' = args.password ? 'cli' : 'none';
for (const name of [PASSWORD_ENV]) {
  if (resolvedPassword) break;
  if (process.env[name]) {
    resolvedPassword = process.env[name];
    passwordSource = 'env';
  }
}
if (!resolvedPassword && process.platform === 'darwin') {
  const { readPassword } = await import('./utils/keychain');
  const fromKeychain = readPassword();
  if (fromKeychain) {
    resolvedPassword = fromKeychain;
    passwordSource = 'keychain';
  }
}
if (resolvedPassword) {
  process.env[PASSWORD_ENV] = resolvedPassword;
  const sourceLabel = passwordSource === 'keychain' ? ' (Keychain)' :
    passwordSource === 'env' ? ' (env)' : '';
  console.log(`${t('server.passwordEnabled')}${sourceLabel}`);
} else {
  console.log(`warning: ${t('server.passwordNotSet')}`);
}

// Resolve the JWT signing secret (generates + persists a random one on first
// run). Must run before any request is served so no token is ever signed with
// a guessable default.
await initJwtSecret();

// Start server
const port = args.port;
const host = args.host;
process.env[envVar('PORT')] = String(port);

const serverUrl = `https://${tailscaleHostname}:${port}`;

const serverOptions = {
  port,
  hostname: host,
  // Allow large uploads (videos etc.) — 10GB
  maxRequestBodySize: 10 * 1024 * 1024 * 1024,
  /**
   * Seconds a request may go without traffic before Bun closes it.
   *
   * Bun's default is 10, and the `idleTimeout: 60` further down applies to the
   * `websocket` object, not to HTTP - so every HTTP request ran on the default.
   * Six speech transcriptions died at it in the two days to 2026-08-06, each
   * arriving on the glasses as "nothing was recognized":
   *
   *   [Bun.serve]: request timed out after 10 seconds
   *   --> POST /api/glasses/stt 500 11s
   *
   * Groq is not the slow part - 8 seconds of audio transcribes in ~0.33s from
   * this host. What takes the time is the upload from the phone over the
   * tailnet, so the requests that died were the long recordings on a slow
   * link: exactly the ones worth not losing. Recording has no length limit, on
   * purpose.
   *
   * 120 rather than the 255 Bun allows, because this is also the ceiling on a
   * request that has genuinely stalled, and 10GB of upload is allowed above.
   * At the G2's 16kHz mono PCM (32KB/s) it covers a several-minute recording
   * over a link slow enough to be worth worrying about.
   */
  idleTimeout: 120,
  tls: {
    cert: Bun.file(certPath),
    key: Bun.file(keyPath),
  },
  async fetch(req: Request, server: import('bun').Server<MuxData>) {
    const url = new URL(req.url);

    // Handle WebSocket upgrades for mux endpoint
    if (url.pathname === '/ws/mux') {
      if (isAuthRequired()) {
        const token = url.searchParams.get('token');
        if (!token) {
          return new Response('Authentication required', { status: 401 });
        }
        try {
          const authService = new AuthService(getDataDir(), getJwtSecret());
          await authService.verifyToken(token);
        } catch {
          return new Response('Invalid or expired token', { status: 401 });
        }
      }

      const deviceId = url.searchParams.get('deviceId') || undefined;
      const upgraded = server.upgrade(req, {
        data: {
          mux: true,
          visitorId: crypto.randomUUID(),
          deviceId,
          subscriptions: new Map(),
          conversationWatchers: new Map(),
          lastPingAt: Date.now(),
        },
      });
      if (upgraded) return undefined as unknown as Response;
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    // Handle regular HTTP requests
    return app.fetch(req);
  },
  websocket: {
    open(ws: import('bun').ServerWebSocket<MuxData>) {
      if (ws.data?.mux) return muxOpen(ws);
    },
    message(ws: import('bun').ServerWebSocket<MuxData>, message: string | Buffer) {
      if (ws.data?.mux) return muxMessage(ws, message);
    },
    close(ws: import('bun').ServerWebSocket<MuxData>, code: number, reason: string) {
      if (ws.data?.mux) return muxClose(ws, code, reason);
    },
    idleTimeout: 60,
    sendPings: true,
  },
};

/**
 * Whether whatever holds the port is a running instance of this server.
 *
 * `/health` is unauthenticated precisely so a probe like this needs no token.
 */
async function isOwnServerRunning(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

// Serve explicitly rather than through the default export: Bun's entry-point
// serve turns a taken port into an uncaught exception with a stack pointing at
// `bun:main`, which reads as a crash in Bun rather than as "the server you are
// trying to start is already running". Almost every occurrence is exactly that.
try {
  Bun.serve(serverOptions);
} catch (err) {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'EADDRINUSE') {
    // Nearly always our own service. Ask it: a server that answers /health is
    // the one this command was about to start, so there is nothing to report
    // beyond "it is already up" - and nothing went wrong, so it is not an error.
    const running = await isOwnServerRunning(serverUrl);
    if (running) {
      console.log(`${IDENTITY.productName} is already running at ${serverUrl}`);
      process.exit(0);
    }
    console.error(`error: port ${port} is already in use by another program.`);
    console.error(`  Stop it, or start ${IDENTITY.productName} on another port with -p <port>.`);
  } else {
    console.error(
      `error: could not start the server on port ${port}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  process.exit(1);
}

console.log(`${IDENTITY.productName} v${VERSION}`);
console.log(`   URL: ${serverUrl}`);
console.log(`   Static: ${EMBEDDED_MODE ? '(embedded)' : staticRoot}`);

// The plaintext signpost, one port up. A phone that has only been told
// `91.210.90` cannot reach the HTTPS port - the certificate is for the FQDN -
// so this is what turns a short address into the real one. Started only after
// the main port is ours: when a second instance loses the race for it, the
// neighbouring port is taken by the same running server, and warning about it
// would only bury the one error that matters.
const discovery = startDiscoveryServer(port + 1, {
  product: IDENTITY.productName,
  version: VERSION,
  url: serverUrl,
});
if (discovery) {
  const short = tailscaleIp ? shortTailscaleIp(tailscaleIp) : null;
  if (short) {
    console.log(`   Short address: ${short}   (for the glasses app's setup screen)`);
  }
}

// The steward runs whether or not anyone has a screen open — that is the point
// of it — so it starts here rather than off the first client connecting. A no-op
// unless the gate is on.
startStewardRuntime(port);

// Build the dashboard payload once in the background so the first client to ask
// is served from cache like every one after it. Everything downstream of this
// serves stale-while-revalidate, which only helps once there is something to
// serve — without a warm-up the first open of each server's life still pays the
// full upstream round trip. Delayed so it does not compete with startup.
setTimeout(() => {
  getDashboard().catch((err) => console.error('Dashboard warm-up failed:', err));
}, 3000);
