import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { auth } from './routes/auth';
import { logs } from './routes/logs';
import { sessions } from './routes/sessions';
import { upload } from './routes/upload';
import { files } from './routes/files';
import { dashboard } from './routes/dashboard';
import { notify } from './routes/notify';
import { peers } from './routes/peers';
import { herdr } from './routes/herdr';
import { glasses } from './routes/glasses';
import { glassesRelay } from './routes/glasses-relay';
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
import { IDENTITY, TMP_PATHS } from '../../shared/identity';

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
<title>CC Hub - Clear Cache</title>
<style>body{background:#1a1a1a;color:#fff;font-family:system-ui;padding:20px;text-align:center}
.status{margin:20px 0;padding:15px;border-radius:8px;background:#333}
.ok{color:#4ade80}.err{color:#f87171}button{padding:12px 24px;font-size:16px;
background:#3b82f6;color:#fff;border:none;border-radius:8px;cursor:pointer;margin:10px}
button:active{background:#2563eb}</style></head>
<body><h1>CC Hub Cache Clear</h1><div id="log"></div>
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
// `/api/workspaces` is the canonical name (a CC Hub session IS a herdr
// workspace); `/api/sessions` stays as an alias for CLI / peers / glasses.
app.use('/api/workspaces/*', conditionalAuthMiddleware);
app.use('/api/workspaces', conditionalAuthMiddleware);
app.use('/api/upload/*', conditionalAuthMiddleware);
app.use('/api/files/*', conditionalAuthMiddleware);
app.use('/api/dashboard', conditionalAuthMiddleware);
app.use('/api/peers', conditionalAuthMiddleware);
app.use('/api/peers/*', conditionalAuthMiddleware);
app.use('/api/herdr/*', conditionalAuthMiddleware);
// `/api/glasses/relay*` stays OUTSIDE the auth glob (#504): local agents post
// self-notes via `cchub glasses` from inside panes where no token exists —
// unauthenticated local trust, same pattern as /api/notify. The STT and any
// other glasses endpoints remain protected.
app.use('/api/glasses/*', (c, next) => {
  if (c.req.path.startsWith('/api/glasses/relay')) return next();
  return conditionalAuthMiddleware(c, next);
});

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
app.route('/api/glasses/relay', glassesRelay);
app.route('/api/glasses', glasses);

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
            isAssetHit && (path.startsWith('/assets/') || path.startsWith('/glasses/assets/'))
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
// owns all pane PTYs, so cchub restarts don't kill running agents).
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
try {
  const status = JSON.parse(statusResult.stdout.toString());
  const dnsName = status.Self?.DNSName;
  if (!dnsName) {
    throw new Error('DNSName not found in Tailscale status');
  }
  // Remove trailing dot if present
  tailscaleHostname = dnsName.replace(/\.$/, '');
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
//   2. CCHUB_PASSWORD env var (set by systemd EnvironmentFile etc.)
//   3. macOS Keychain (service: cchub) — populated by `cchub setup`
let resolvedPassword: string | undefined = args.password;
let passwordSource: 'cli' | 'env' | 'keychain' | 'none' = args.password ? 'cli' : 'none';
if (!resolvedPassword && process.env.CCHUB_PASSWORD) {
  resolvedPassword = process.env.CCHUB_PASSWORD;
  passwordSource = 'env';
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
  process.env.CCHUB_PASSWORD = resolvedPassword;
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
process.env.CCHUB_PORT = String(port);

console.log(`${IDENTITY.productName} v${VERSION}`);
console.log(`   URL: https://${tailscaleHostname}:${port}`);
console.log(`   Static: ${EMBEDDED_MODE ? '(embedded)' : staticRoot}`);

export default {
  port,
  hostname: host,
  // Allow large uploads (videos etc.) — 10GB
  maxRequestBodySize: 10 * 1024 * 1024 * 1024,
  tls: {
    cert: Bun.file(certPath),
    key: Bun.file(keyPath),
  },
  async fetch(req: Request, server: { upgrade: (req: Request, opts?: { data: MuxData }) => boolean }) {
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
