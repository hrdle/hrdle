// The phone screen: one address, and a check that it works.
//
// Deliberately not the other app's setup wizard. That one frames
// hrdle/hrdle-setup, seven screens explaining how to install the server, run
// it, and reach it over a tailnet. Whoever is installing this app has a server
// with a steward already running on it - they have been reading its messages on
// a phone - so the whole of what is left is: which machine, and does it answer.
//
// Two things a web page genuinely cannot do for itself are why this exists at
// all rather than living in the guide:
//
//   - **The store.** The address goes into the *host's* own store, because
//     that is where `startGlassesMode` reads it from when the app runs on the
//     G2. Another origin's `localStorage` does not exist as far as the glasses
//     are concerned.
//   - **The request.** A public origin cannot reach a CGNAT address: Private
//     Network Access refuses that crossing whatever CORS says, and a tailnet is
//     entirely CGNAT. This page is not public-origin, so it can.

import { getSteward, getStewardEnabled, setBaseUrl } from './api.ts'
import type { Bridge } from './display.ts'
import { resolveAddress } from './resolve-host.ts'
import { clearStored, clearStoredSync, readStored, readStoredSync, storageKey, writeStoredSync } from './storage.ts'

const URL_SUFFIX = 'url'

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

const CSS = `
  html, body { margin:0; height:100%; background:#0a0a0a; }
  #app { min-height:100%; }
  .wrap { font-family:-apple-system,'Helvetica Neue',sans-serif; color:#e8e8e8; padding:28px 22px 40px;
          display:flex; flex-direction:column; gap:18px; max-width:30em; margin:0 auto; }
  h1 { font-size:19px; margin:0; font-weight:700; }
  p { font-size:13px; line-height:1.7; margin:0; color:#9a9a9a; }
  label { font-size:12px; color:#9a9a9a; display:block; margin-bottom:6px; }
  input { width:100%; box-sizing:border-box; padding:13px 12px; font-size:16px; border-radius:9px;
          border:1px solid #333; background:#141414; color:#f0f0f0; }
  button { padding:13px 18px; border-radius:9px; border:none; background:#c9272e; color:#fff;
           font-size:15px; font-weight:600; }
  button.secondary { background:#242424; color:#bbb; font-weight:500; }
  .row { display:flex; gap:10px; }
  .row button { flex:1; }
  code { font-family:ui-monospace,Menlo,monospace; font-size:12px; color:#d8b478;
         background:#1a1714; padding:3px 7px; border-radius:5px; word-break:break-all; }
  .status { font-size:13px; line-height:1.6; }
  .status.ok { color:#7fd1a0; }
  .status.bad { color:#e0837b; }
  .hint { font-size:12px; color:#6f6f6f; }
`

export async function startPhoneUI(bridge: Bridge | null): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) return
  const store = makeStore(bridge)
  const saved = await store.get(URL_SUFFIX)

  document.title = `${__PRODUCT_NAME__} Steward`
  root.innerHTML = `
    <div class="wrap">
      <h1>${__PRODUCT_NAME__} Steward</h1>
      <p>Your steward's screens, on the glasses. This needs the address of the
      machine ${__BINARY_NAME__} runs on, and a steward switched on over there.</p>
      <div>
        <label for="addr">Address</label>
        <input id="addr" type="text" inputmode="url" autocapitalize="off" autocorrect="off"
               spellcheck="false" placeholder="91.210.90" value="${saved ? escapeHtml(saved) : ''}" />
        <p class="hint">The short form of a Tailscale address is enough - every one of
        them starts <code>100.</code> A hostname or a full URL also works.</p>
      </div>
      <div class="row">
        <button type="button" id="connect">Connect</button>
        <button type="button" class="secondary" id="forget">Forget</button>
      </div>
      <p class="status" id="status">${saved ? `Saved: <code>${escapeHtml(saved)}</code>` : ''}</p>
    </div>
    <style>${CSS}</style>
  `

  const addr = root.querySelector<HTMLInputElement>('#addr')
  const status = root.querySelector<HTMLElement>('#status')

  function say(message: string, kind: '' | 'ok' | 'bad' = ''): void {
    if (!status) return
    status.className = `status ${kind}`.trim()
    status.innerHTML = message
  }

  root.querySelector('#forget')?.addEventListener('click', async () => {
    await store.clear(URL_SUFFIX)
    if (addr) addr.value = ''
    say('Forgotten. The glasses will ask again next time they start.')
  })

  root.querySelector('#connect')?.addEventListener('click', async () => {
    const typed = addr?.value ?? ''
    say('Looking...')
    const outcome = await resolveAddress(typed)
    if (!outcome.url) {
      say(escapeHtml(outcome.error ?? 'Could not resolve that address.'), 'bad')
      return
    }

    setBaseUrl(outcome.url)
    // Not just reachability: this app is only worth anything against a server
    // whose steward is switched on, and `/enabled` answers either way - so a
    // gate that is off is reported as itself rather than as a broken address.
    if (!(await getStewardEnabled())) {
      say(
        `Reached <code>${escapeHtml(outcome.url)}</code>, but its steward is switched off.<br>` +
          `Set <code>HRDLE_STEWARD=1</code> on that server and restart it.`,
        'bad',
      )
      await store.set(URL_SUFFIX, outcome.url)
      return
    }

    await store.set(URL_SUFFIX, outcome.url)
    try {
      const { thread, lines } = await getSteward()
      say(
        `Connected to <code>${escapeHtml(outcome.url)}</code>.<br>` +
          `${lines.length} session${lines.length === 1 ? '' : 's'} written, ` +
          `${thread.length} entr${thread.length === 1 ? 'y' : 'ies'} in the thread.<br>` +
          'Launch the app from the glasses menu.',
        'ok',
      )
    } catch (err) {
      say(
        `Saved <code>${escapeHtml(outcome.url)}</code>, but reading the steward failed: ` +
          `${escapeHtml(err instanceof Error ? err.message : String(err))}`,
        'bad',
      )
    }
  })
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}
