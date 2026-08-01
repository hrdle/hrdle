// Phone companion UI — a frame around the setup guide, and the two things that
// guide cannot do for itself.
//
// This screen used to be the whole wizard: seven screens, their wording, the
// connection test, the settings panel. All of that now lives at
// hrdle/hrdle-setup and is served from Cloudflare Workers, because a wording
// change there costs a deploy while the same change here costs a rebuilt ehpk,
// an upload to EVEN Hub, a version bump and a promotion to Beta — which is what
// it cost three times in one afternoon.
//
// What is left is what a web page genuinely cannot do:
//
//   - **The store.** The server address has to be written to the *host's* own
//     store, because `startGlassesMode` reads it from there when the app starts
//     on the G2. Another origin's `localStorage` does not exist as far as the
//     glasses are concerned.
//   - **The camera.** Reading the QR code opens a camera stream, and the guide
//     is a cross-origin frame: handing it one means a permissions-policy
//     delegation the WebView is under no obligation to honour. The scanner runs
//     on this page and the guide only asks for the result.
//   - **Every request to the server.** This one was a surprise. The server
//     answers `Access-Control-Allow-Origin: *`, so CORS was never the obstacle —
//     Private Network Access is. The guide is served from a public origin and a
//     tailnet address sits in CGNAT space, a crossing Chrome refuses outright.
//     Measured, not assumed: from that origin a fetch to api.github.com returns
//     200 and one to a `.ts.net` host does not reach the network at all. This
//     page is not public-origin, so it can, and the guide asks it to.
//
// All of it arrives as postMessage requests and is answered the same way. There
// is no offline copy of the guide: the setup it describes ends in connecting to
// a server over a tailnet, so a phone that cannot reach the internet cannot
// finish anyway, and a second copy of seven screens is a second copy to keep
// correct.

import {
  getDashboard,
  getGlassesSettings,
  getSessions,
  putGlassesSettings,
  setBaseUrl,
} from './api.ts'
import type { Bridge } from './display.ts'
import { scanQr } from './qr-scan.ts'
import { resolveAddress } from './resolve-host.ts'
import { clearStored, clearStoredSync, readStored, readStoredSync, storageKey, writeStoredSync } from './storage.ts'

const URL_SUFFIX = 'url'

/**
 * Where the guide lives.
 *
 * Kept in step with hrdle/hrdle-setup, which serves it. A build of this app is
 * pinned to whatever this says, so moving the guide means one more ehpk — the
 * only thing about it that still does.
 */
const GUIDE_ORIGIN = 'https://hrdle-setup.abe00makoto.workers.dev'

/** Long enough to rule out a slow network, short enough to not look hung. */
const LOAD_TIMEOUT_MS = 12_000

// ── The protocol ──
//
// Mirrored in `src/host-bridge.ts` on the other side. Two copies of a handful of
// string literals, because the two run in different places and share no build.

interface FromGuide {
  type: string
  url?: string
  /** What was typed into the address field: a short address, a hostname or a URL. */
  host?: string
  patch?: { groqApiKey?: string | null; sttLang?: string | null; sttPrompt?: string | null }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Storage ──

interface Store {
  get(suffix: string): Promise<string | null>
  set(suffix: string, value: string): Promise<void>
  clear(suffix: string): Promise<void>
}

/** The host app's store on the device, plain `localStorage` in a browser. */
function makeStore(bridge: Bridge | null): Store {
  if (bridge) {
    return {
      get: (suffix) => readStored((key) => bridge.getLocalStorage(key), suffix),
      set: async (suffix, value) => {
        await bridge.setLocalStorage(storageKey(suffix), value)
      },
      clear: (suffix) => clearStored((key, value) => bridge.setLocalStorage(key, value), suffix),
    }
  }
  return {
    get: async (suffix) => readStoredSync(suffix),
    set: async (suffix, value) => writeStoredSync(suffix, value),
    clear: async (suffix) => clearStoredSync(suffix),
  }
}

// ── Markup ──

const CSS = `
  html, body { margin:0; height:100%; background:#0a0a0a; }
  #app { height:100%; }
  .host-frame { display:block; width:100%; height:100vh; border:0; background:#0a0a0a; }
  .host-msg { font-family:-apple-system,'Helvetica Neue',sans-serif; color:#bbb; background:#0a0a0a;
              min-height:100vh; display:flex; flex-direction:column; align-items:center;
              justify-content:center; gap:14px; padding:32px 24px; text-align:center; }
  .host-msg h1 { font-size:18px; color:#eee; margin:0; font-weight:700; }
  .host-msg p { font-size:13px; line-height:1.7; margin:0; max-width:22em; color:#8d8d8d; }
  .host-msg code { font-family:ui-monospace,Menlo,monospace; font-size:12px; color:#e8a0a0;
                   background:#1a1414; padding:3px 7px; border-radius:5px; word-break:break-all; }
  .host-msg button { margin-top:6px; padding:12px 20px; border-radius:9px; border:none;
                     background:#c9272e; color:#fff; font-size:14px; font-weight:600; cursor:pointer; }
`

/**
 * Shown when the guide does not load.
 *
 * Deliberately not a fallback wizard — just the fact and the address, so someone
 * can open it on any other device. The wording is in English alone because this
 * is the one screen that exists when nothing else could be fetched, and a
 * translation table is one more thing to have failed.
 */
function offlineHtml(): string {
  return `
    <div class="host-msg">
      <h1>Could not load the setup guide</h1>
      <p>${__PRODUCT_NAME__} needs the internet to walk you through setup. Check the connection
      and try again, or open the guide on any other device:</p>
      <code>${GUIDE_ORIGIN}</code>
      <button type="button" id="host-retry">Try again</button>
    </div>
    <style>${CSS}</style>
  `
}

// ── Wiring ──

export async function startPhoneUI(bridge: Bridge | null): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) return
  const app = root
  const store = makeStore(bridge)

  let frame: HTMLIFrameElement | null = null
  let greeted = false

  function reply(message: unknown): void {
    frame?.contentWindow?.postMessage(message, GUIDE_ORIGIN)
  }

  async function onGuideMessage(event: MessageEvent): Promise<void> {
    // Only the frame we made, and only from where we put it. Anything else on
    // the page is not the guide.
    if (!frame || event.source !== frame.contentWindow) return
    if (event.origin !== GUIDE_ORIGIN) return
    const data = event.data as FromGuide | undefined
    if (!data || typeof data.type !== 'string') return

    switch (data.type) {
      case 'hrdle:ready':
        greeted = true
        reply({ type: 'hrdle:host-ready' })
        break

      case 'hrdle:get-url':
        reply({ type: 'hrdle:url', url: await store.get(URL_SUFFIX) })
        break

      case 'hrdle:save-url':
        // The one write that matters: `startGlassesMode` reads this key on the
        // G2, and nothing the guide stores on its own origin would be there.
        if (typeof data.url === 'string' && data.url) await store.set(URL_SUFFIX, data.url)
        break

      case 'hrdle:clear-url':
        await store.clear(URL_SUFFIX)
        break

      case 'hrdle:scan-qr': {
        const outcome = await scanQr()
        reply({ type: 'hrdle:qr-result', ...outcome })
        break
      }

      case 'hrdle:resolve-host': {
        // Typed short, resolved here. The guide cannot make this request itself
        // for the same reason it cannot make any other: a public origin is not
        // allowed to reach a CGNAT address, and the tailnet is entirely CGNAT.
        const outcome = await resolveAddress(typeof data.host === 'string' ? data.host : '')
        reply({ type: 'hrdle:resolved', ...outcome })
        break
      }

      case 'hrdle:connect': {
        if (typeof data.url !== 'string' || !data.url) {
          reply({ type: 'hrdle:connect-result', ok: false, error: 'no address' })
          break
        }
        try {
          setBaseUrl(data.url)
          const [dashboard, sessions] = await Promise.all([getDashboard(), getSessions()])
          reply({
            type: 'hrdle:connect-result',
            ok: true,
            server: {
              version: dashboard.version || '?',
              sessions: sessions.sessions?.length || 0,
              usage: dashboard.usageLimits ? `${dashboard.usageLimits.fiveHour.utilization}%` : '-',
            },
          })
        } catch (err) {
          reply({ type: 'hrdle:connect-result', ok: false, error: reason(err) })
        }
        break
      }

      case 'hrdle:settings-get':
        try {
          reply({ type: 'hrdle:settings', view: await getGlassesSettings() })
        } catch (err) {
          reply({ type: 'hrdle:settings', error: reason(err) })
        }
        break

      case 'hrdle:settings-put':
        try {
          reply({ type: 'hrdle:settings', view: await putGlassesSettings(data.patch ?? {}) })
        } catch (err) {
          reply({ type: 'hrdle:settings', error: reason(err) })
        }
        break
    }
  }

  window.addEventListener('message', (event) => void onGuideMessage(event))

  function showOffline(): void {
    app.innerHTML = offlineHtml()
    app.querySelector('#host-retry')?.addEventListener('click', () => showGuide())
  }

  function showGuide(): void {
    greeted = false
    app.innerHTML = `<iframe class="host-frame" id="host-frame"
      src="${GUIDE_ORIGIN}/#/intro"
      allow="clipboard-write"
      referrerpolicy="no-referrer"></iframe><style>${CSS}</style>`
    frame = app.querySelector<HTMLIFrameElement>('#host-frame')

    // `onerror` does not fire for a page that loads but is not ours, and does
    // not fire at all in some WebViews. The greeting is the real signal: the
    // guide says hello as soon as it runs, so silence means it never did.
    setTimeout(() => {
      if (!greeted) showOffline()
    }, LOAD_TIMEOUT_MS)
  }

  showGuide()
}
