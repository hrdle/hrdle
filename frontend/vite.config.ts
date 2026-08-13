import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { IDENTITY } from '../shared/identity';

// The release version lives in the root package.json. Baking it into the bundle
// keeps the frontend in step with the backend it talks to: every release changes
// the bundle hash, so the service worker precaches a new build and the update
// prompt fires even when only the backend changed.
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
).version as string;

// Get Tailscale certificate for HTTPS
function getTailscaleCert(): { key: Buffer; cert: Buffer } | undefined {
  try {
    // Check if tailscale command exists
    try {
      execSync('which tailscale', { stdio: 'pipe' });
    } catch {
      console.warn('warning: tailscale command not found, running without HTTPS');
      return undefined;
    }

    // Get Tailscale hostname
    const statusResult = execSync('tailscale status --json', { stdio: 'pipe' });
    const status = JSON.parse(statusResult.toString());
    const dnsName = status.Self?.DNSName;
    if (!dnsName) {
      console.warn('warning: Tailscale DNSName not found, running without HTTPS');
      return undefined;
    }
    const hostname = dnsName.replace(/\.$/, '');

    // Certificate paths (same as backend)
    const certDir = path.join(os.homedir(), '.tailscale-certs');
    const certPath = path.join(certDir, `${hostname}.crt`);
    const keyPath = path.join(certDir, `${hostname}.key`);

    // Check if cert needs to be generated or renewed
    let needsCert = !fs.existsSync(certPath) || !fs.existsSync(keyPath);

    if (!needsCert) {
      // Check if cert expires within 7 days
      const certStat = fs.statSync(certPath);
      const certAgeDays = (Date.now() - certStat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (certAgeDays > 83) {
        needsCert = true;
      }
    }

    if (needsCert) {
      console.log('Generating the Tailscale certificate...');
      fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });

      try {
        execSync(`tailscale cert --cert-file "${certPath}" --key-file "${keyPath}" "${hostname}"`, {
          stdio: 'pipe',
        });
        console.log(`Certificate generated: ${certDir}`);
      } catch (e: unknown) {
        const error = e as { stderr?: Buffer };
        const stderr = error.stderr?.toString() || '';
        console.error('error: failed to generate the Tailscale certificate');
        if (stderr.includes('Access denied') || stderr.includes('cert access denied')) {
          console.error('Hint: run sudo tailscale set --operator=$USER');
        }
        return undefined;
      }
    }

    console.log(`HTTPS: https://${hostname}:${IDENTITY.frontendDevPort}`);
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
  } catch (e) {
    console.warn('warning: failed to set up the Tailscale cert:', e);
    return undefined;
  }
}

const httpsConfig = getTailscaleCert();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    // index.html is a static file that cannot import identity, and the two
    // names it holds are load-bearing: the title is what a PWA installs itself
    // as, and the FOUC script reads the theme key before any bundle runs — a
    // stale prefix there means every load flashes the wrong theme. Substituted
    // at build time so a rename reaches them (#459). `pre` so this runs before
    // Vite's own %VITE_*% substitution looks at the placeholders.
    {
      name: 'identity-html',
      enforce: 'pre' as const,
      transformIndexHtml(html: string) {
        return html
          .replaceAll('%PRODUCT_NAME%', IDENTITY.productName)
          .replaceAll('%STORAGE_PREFIX%', IDENTITY.storagePrefix);
      },
    },
    react(),
    tailwindcss(),
    VitePWA({
      devOptions: {
        enabled: false,
      },
      // `autoUpdate` bakes skipWaiting() into the worker, but in practice the
      // new worker still sat in `waiting` for as long as a tab stayed open, so
      // nothing ever swapped. Prompt mode keeps it waiting on purpose and hands
      // the trigger to useServiceWorkerUpdate, which posts SKIP_WAITING once the
      // user accepts the reload.
      registerType: 'prompt',
      // registerSW() is called from useServiceWorkerUpdate, so vite must not
      // also inject its own registration script.
      injectRegister: null,
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: IDENTITY.productName,
        short_name: IDENTITY.productName,
        description: IDENTITY.tagline,
        theme_color: '#1a1a1a',
        background_color: '#1a1a1a',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3 MiB
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Math is rare and KaTeX is not small: the renderer, its stylesheet and
        // its fonts are about 500 KiB of the precache, downloaded by every
        // device on every release whether or not a transcript ever contains a
        // formula. They are split out of the bundle for exactly that reason, so
        // precaching them puts the cost straight back. Fetched on first sight of
        // math instead, and cached from then on by the rule below.
        globIgnores: ['**/assets/{KaTeX_,MathMarkdown-}*'],
        // /glasses is a separate app the backend serves, not a route of this
        // SPA. navigateFallback defaults to answering EVERY navigation with
        // our index.html, so without this the glasses simulator opens as CC
        // Hub on any browser that has already installed the service worker.
        navigateFallbackDenylist: [/^\/glasses/],
        importScripts: ['sw-notification.js'],
        runtimeCaching: [
          {
            // The math renderer and its fonts, kept once fetched. Their names
            // carry a content hash, so a stale entry can only be an orphan of
            // an older build rather than a wrong answer.
            urlPattern: /\/assets\/(KaTeX_|MathMarkdown-)/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'katex-cache',
              expiration: { maxEntries: 80 },
            },
          },
          {
            urlPattern: /^https:\/\/.*\.trycloudflare\.com\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 10,
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: IDENTITY.frontendDevPort,
    host: '0.0.0.0',
    allowedHosts: true,
    https: httpsConfig,
    watch: {
      // Exclude directories that may cause unnecessary reloads
      // Use absolute paths for parent directory patterns
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        path.resolve(__dirname, '../.claude/**'),
        path.resolve(__dirname, '../.claude-user-prompts/**'),
        path.resolve(__dirname, '../logs/**'),
        path.resolve(__dirname, '../backend/**'),
      ],
    },
    proxy: {
      '/api': {
        target: `https://localhost:${IDENTITY.devPort}`,
        changeOrigin: true,
        secure: false,
        // Allow long uploads (videos etc.)
        proxyTimeout: 10 * 60 * 1000,
        timeout: 10 * 60 * 1000,
        // Ensure Content-Length is preserved for multipart POSTs
        // (http-proxy loses it in some edge cases)
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const cl = req.headers['content-length'];
            if (cl && !proxyReq.getHeader('content-length')) {
              proxyReq.setHeader('content-length', cl);
            }
          });
        },
      },
      '/ws': {
        target: `wss://localhost:${IDENTITY.devPort}`,
        ws: true,
        secure: false,
      },
    },
  },
});
