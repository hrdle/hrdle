// Phone companion UI — the setup wizard, shown when the app is launched from
// the Even Hub app menu (`appMenu`).
//
// This screen is the only thing someone who installed the glasses app from the
// store has, and what stands between them and a working setup is a computer,
// two other tools, a command that needs sudo, and a URL nobody has memorised.
// It used to present all of that as one scrolling page with the URL field
// already visible at the bottom — which invites a person who has installed
// nothing to type something into it and fail.
//
// One screen, one thing to do. The order lives in `setup-wizard.ts`; this file
// renders it and wires the two screens that actually do something (connect, and
// the settings on the last one).
//
// It runs in a browser too — `main.ts` routes `?phone` here with a null bridge —
// because nine screens cannot be built by burning an ehpk for every wording
// change. The store is the only thing that differs, and `makeStore` absorbs it.

import { getDashboard, getSessions, setBaseUrl } from './api.ts'
import type { Bridge } from './display.ts'
import { scanQr } from './qr-scan.ts'
import { settingsPanelHtml, wireSettingsPanel } from './settings-ui.ts'
import {
  CONNECTED_STEP,
  CONNECT_STEP,
  TOTAL_STEPS,
  type WizardStepId,
  nextStep,
  parseStep,
  prevStep,
  stepById,
  stepIndex,
} from './setup-wizard.ts'
import {
  clearStored,
  clearStoredSync,
  readStored,
  readStoredSync,
  storageKey,
  writeStoredSync,
} from './storage.ts'

const URL_SUFFIX = 'url'
/** Where the wizard was left off, so closing the app mid-setup is not a restart. */
const STEP_SUFFIX = 'setup-step'

const INSTALL_CMD = `curl -fsSL https://raw.githubusercontent.com/${__REPO__}/main/install.sh | bash`

// ── Storage ──

interface Store {
  get(suffix: string): Promise<string | null>
  set(suffix: string, value: string): Promise<void>
  clear(suffix: string): Promise<void>
}

/**
 * The host app's store on the device, plain `localStorage` in the browser.
 *
 * Without the second half the browser could show the wizard but never remember
 * anything, so every reload would restart it and the connect screen could not
 * be tested at all — which is most of what there is to test.
 */
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

// Red, from the app's own icon: a dark panel with a lit red slit across it.
//
// Brand and state are kept apart on purpose. Everything that is simply "this
// app" — the mark, the progress bar, headings, the primary button — is red.
// Everything that reports a condition keeps the colour that condition has
// everywhere else: green for a server that answered, red for one that did not.
// Painting a success indicator in the brand colour would make "Connected" and
// "Could not connect" the same colour, which no amount of wording recovers.
const CSS = `
  .wiz { font-family: -apple-system, 'Helvetica Neue', sans-serif; background:#0a0a0a; color:#eee;
         min-height:100vh; display:flex; flex-direction:column;
         --panel-accent:#ff6167; --panel-accent-strong:#c9272e; }
  .wiz * { box-sizing:border-box; }
  .wiz-top { padding:16px 20px 0; }
  .wiz-brand { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
  .wiz-mark { width:26px; height:26px; background:#e0353c; color:#fff; border-radius:7px;
              display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:700; }
  .wiz-name { font-size:14px; font-weight:700; letter-spacing:.02em; }
  .wiz-bar { height:3px; background:#1a1a1a; border-radius:2px; overflow:hidden; }
  .wiz-bar i { display:block; height:100%;
               background:linear-gradient(to right, #8c1f24, #ff5a60); transition:width .25s ease; }
  .wiz-meta { display:flex; justify-content:space-between; align-items:center;
              font-size:11px; color:#666; margin-top:8px; }
  .wiz-where { border:1px solid #333; border-radius:99px; padding:2px 9px; font-size:10.5px; }
  .wiz-where.pc { color:#ff9a6b; border-color:#5a3324; }
  .wiz-where.phone { color:#a8b4c4; border-color:#3a4048; }
  .wiz-body { flex:1; padding:18px 20px 8px; }
  .wiz-title { font-size:21px; font-weight:700; margin:0 0 8px; line-height:1.3; }
  .wiz-lead { font-size:14px; color:#aaa; line-height:1.65; margin:0 0 16px; }
  .wiz-card { background:#111; border:1px solid #222; border-radius:12px; padding:14px; margin-bottom:12px; }
  .wiz-card h3 { font-size:13px; color:#ff6167; font-weight:600; margin:0 0 8px; }
  .wiz-card p { font-size:13px; color:#bbb; line-height:1.65; margin:0 0 8px; }
  .wiz-card p:last-child { margin-bottom:0; }
  .wiz-note { font-size:12px; color:#888; line-height:1.6; margin:8px 0 0; }
  .wiz-warn { border-color:#5a2226; background:#180c0d; }
  .wiz-warn h3 { color:#ff8a8f; }
  .wiz-points { list-style:none; padding:0; margin:0; font-size:13px; color:#bbb; line-height:1.6; }
  .wiz-points li { display:flex; gap:9px; margin-bottom:8px; }
  .wiz-points li:last-child { margin-bottom:0; }
  .wiz-points li::before { content:'\\25C6'; color:#e0353c; font-size:11px; line-height:1.5; }
  .wiz-cmd { position:relative; background:#0d0d0d; border:1px solid #232323; border-radius:8px;
             padding:11px 58px 11px 11px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
             font-size:11.5px; color:#ff9d9d; word-break:break-all; line-height:1.6; margin:8px 0; }
  .wiz-cmd button { position:absolute; top:6px; right:6px; background:#282828; border:none; color:#bbb;
                    font-size:11px; padding:4px 9px; border-radius:5px; cursor:pointer; }
  .wiz code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.9em;
              color:#e8a0a0; background:#1a1414; padding:1px 5px; border-radius:4px; }
  .wiz-kv { display:grid; grid-template-columns:auto 1fr; gap:5px 12px; font-size:13px; color:#ccc; }
  .wiz-kv span:nth-child(odd) { color:#888; }
  .wiz-input { width:100%; padding:12px; border-radius:8px; border:1px solid #333; background:#1a1a1a;
               color:#eee; font-size:14px; font-family:ui-monospace, Menlo, monospace; }
  .wiz-input:focus { outline:none; border-color:#e0353c; }
  .wiz-status { font-size:13px; margin-top:10px; min-height:18px; }
  .wiz-foot { position:sticky; bottom:0; display:flex; gap:8px; padding:12px 20px 20px;
              background:linear-gradient(to top, #0a0a0a 60%, transparent); }
  .wiz-primary, .wiz-ghost { padding:13px 16px; border-radius:9px; font-size:14px; cursor:pointer; }
  .wiz-primary { flex:1; border:none; background:#c9272e; color:#fff; font-weight:600; }
  .wiz-primary[disabled] { background:#333; color:#888; }
  .wiz-ghost { border:1px solid #3a3a3a; background:transparent; color:#999; font-weight:500; }
  .wiz-wide { display:block; width:100%; margin:4px 0 12px; }
  .wiz-link { color:#ff8a8f; text-decoration:underline; }
  .wiz-linkbtn { display:block; text-align:center; padding:12px; border-radius:9px;
                 border:1px solid #5a2226; background:#180c0d; color:#ff8a8f;
                 text-decoration:none; font-size:14px; font-weight:600; margin:8px 0; }
  .wiz-scan { display:block; width:100%; padding:13px; border-radius:9px; border:1px solid #5a2226;
              background:#180c0d; color:#ff8a8f; font-size:14px; font-weight:600; cursor:pointer;
              margin:0 0 10px; }
  .wiz-scan[disabled] { opacity:.55; }
  .wiz-or { display:flex; align-items:center; gap:10px; color:#666; font-size:11px; margin:2px 0 10px; }
  .wiz-or::before, .wiz-or::after { content:''; flex:1; height:1px; background:#242424; }
  .wiz-ok { color:#4ade80; }
  .wiz-dot { width:9px; height:9px; border-radius:50%; background:#4ade80; animation:wiz-pulse 2s infinite; }
  @keyframes wiz-pulse { 0%,100% { opacity:1 } 50% { opacity:.35 } }
`

/**
 * A copyable command.
 *
 * The text is wrapped rather than read back off the parent: the button lives
 * inside the same box, so `parentElement.textContent` includes the button's own
 * label — and that label changes to `copied` for a second and a half after a
 * press, which is exactly when someone taps it again.
 */
function cmd(text: string): string {
  return `<div class="wiz-cmd"><span data-cmd>${text}</span><button type="button" data-copy>copy</button></div>`
}

function link(href: string, label: string): string {
  return `<a class="wiz-link" href="${href}" target="_blank" rel="noreferrer">${label}</a>`
}

/**
 * A link big enough to be an obvious tap target.
 *
 * The inline version was reported as "where is the install link?" from the
 * device: a coloured phrase inside a paragraph does not read as something to
 * press on a phone. Anywhere the next thing to do is "go and get an app", it
 * should look like a control rather than like prose.
 */
function linkButton(href: string, label: string): string {
  return `<a class="wiz-linkbtn" href="${href}" target="_blank" rel="noreferrer">${label}</a>`
}

/**
 * The body of one screen.
 *
 * Wording lives here rather than in `setup-wizard.ts` on purpose: that file is
 * the order and the traversal, and is tested without a DOM.
 */
function screenHtml(id: WizardStepId): { title: string; html: string } {
  switch (id) {
    case 'intro':
      return {
        title: `What ${__PRODUCT_NAME__} is`,
        html: `
          <p class="wiz-lead">${__PRODUCT_NAME__} runs coding agents — Claude Code, Codex, Grok, Kimi —
          on a computer of yours, and puts them on this phone and on the G2.</p>
          <div class="wiz-card">
            <ul class="wiz-points">
              <li>Run several agent sessions at once and switch between them</li>
              <li>Watch what each one is doing, live</li>
              <li>Approve or reject a prompt from the glasses, with the ring</li>
              <li>Read back the conversation</li>
            </ul>
          </div>
          <div class="wiz-card wiz-warn">
            <h3>You will need a computer</h3>
            <p>The glasses and this phone are screens. The agents themselves run on a
            machine of yours that stays on — ${__PRODUCT_NAME__} is what puts them here.</p>
          </div>
          <p class="wiz-note">Six short steps: a few commands on that computer, then point this
          phone's camera at a code it prints. About ten minutes.</p>
        `,
      }

    case 'machine':
      return {
        title: 'A machine to run it on',
        html: `
          <p class="wiz-lead">Pick the computer the agents will run on.</p>
          <div class="wiz-card">
            <h3>Supported today</h3>
            <div class="wiz-kv">
              <span>Linux</span><span>x86_64</span>
              <span>macOS</span><span>Apple silicon</span>
            </div>
          </div>
          <div class="wiz-card">
            <h3>It should stay awake</h3>
            <p>Nothing reaches you while that machine is asleep — a session you started
            in the morning is only there in the afternoon if it kept running.</p>
            <p>A laptop works, for as long as it is open. A machine that stays on is better.</p>
          </div>
        `,
      }

    case 'agent':
      return {
        title: 'Install a coding agent',
        html: `
          <p class="wiz-lead">${__PRODUCT_NAME__} drives agents; it is not one itself.
          Install at least one on that computer and sign in.</p>
          <div class="wiz-card">
            <h3>Claude Code</h3>
            ${cmd('npm install -g @anthropic-ai/claude-code')}
            <p class="wiz-note">Then run <code>claude</code> once and sign in.</p>
          </div>
          <div class="wiz-card wiz-warn">
            <h3>Sign in now, not later</h3>
            <p>An agent that has never been signed in shows a login screen when it
            starts — and a login screen is not something you want to meet through
            the glasses.</p>
          </div>
          <p class="wiz-note">Codex, Grok Build and Kimi Code work too, and you can add
          them later. One is enough to finish this setup.</p>
        `,
      }

    case 'tailscale':
      return {
        title: 'Put the computer on Tailscale',
        html: `
          <p class="wiz-lead">Tailscale is how this phone reaches that machine, and where its
          HTTPS certificate comes from. No ports are opened to the internet.</p>
          <div class="wiz-card">
            <h3>Linux</h3>
            ${cmd('curl -fsSL https://tailscale.com/install.sh | sh')}
            <h3 style="margin-top:12px">macOS</h3>
            ${cmd('brew install tailscale')}
            <p class="wiz-note">Install it with brew rather than the App Store — the App Store
            build ships no command line tool, and setup needs one.</p>
          </div>
          <div class="wiz-card">
            <h3>Then allow certificates, once</h3>
            ${cmd('sudo tailscale set --operator=$USER')}
            <p class="wiz-note">Without this ${__BINARY_NAME__} cannot issue its HTTPS certificate
            and will refuse to start.</p>
          </div>
          <p class="wiz-note">${link('https://tailscale.com/download', 'Tailscale downloads')} —
          sign in with any account you like; you will use the same one on this phone later.</p>
        `,
      }

    case 'install':
      return {
        title: `Install ${__PRODUCT_NAME__}`,
        html: `
          <p class="wiz-lead">One command. Leave that window open when it finishes —
          it ends by drawing a QR code, and the next screen reads it.</p>
          ${cmd(INSTALL_CMD)}
          <div class="wiz-card">
            <h3>What it does</h3>
            <p>Installs ${__BINARY_NAME__} into <code>~/bin</code> and
            ${link('https://herdr.dev/', 'herdr')} if it is missing, registers the service so it
            survives a reboot, and prints the address as a QR code.</p>
            <p class="wiz-note">If it says a sudo command is still needed, run that line and then
            <code>${__BINARY_NAME__} setup</code>.</p>
          </div>
          <div class="wiz-card">
            <h3>Want a password on it?</h3>
            <p class="wiz-note">As installed, anything signed in to your tailnet can open it —
            usually your own devices, and nothing is exposed to the internet either way. To be
            asked for a password in the browser instead, run:</p>
            ${cmd(`${__BINARY_NAME__} setup -P yourpassword`)}
          </div>
        `,
      }

    case 'connect':
      return {
        title: `Connect to ${__PRODUCT_NAME__}`,
        html: `
          <p class="wiz-lead">Two things on this phone: join the tailnet, then point the camera
          at the code on the computer.</p>
          <div class="wiz-card">
            <h3>1 &middot; Tailscale on this phone</h3>
            ${linkButton('https://play.google.com/store/apps/details?id=com.tailscale.ipn', 'Google Play')}
            ${linkButton('https://apps.apple.com/app/tailscale/id1470499037', 'App Store')}
            <p class="wiz-note">Sign in with the same account you used on the computer, or the
            two cannot see each other. If neither link opens from here, copy this into a
            browser:</p>
            ${cmd('https://tailscale.com/download')}
          </div>
          <div class="wiz-card">
            <h3>2 &middot; Scan the code</h3>
            <p class="wiz-note">The installer printed one when it finished. To bring it back,
            run this on the computer:</p>
            ${cmd(`${__BINARY_NAME__} qr`)}
            <button type="button" class="wiz-scan" id="wiz-scan">Scan the QR code</button>
            <div id="wiz-scan-status" class="wiz-status" style="margin:0 0 6px"></div>
            <div class="wiz-or">or type the address</div>
            <input id="wiz-url" class="wiz-input" type="url" inputmode="url" autocapitalize="off"
                   autocorrect="off" spellcheck="false"
                   placeholder="https://your-machine.tailnet.ts.net:${__DEFAULT_PORT__}" />
          </div>
          <div id="wiz-connect-status" class="wiz-status"></div>
          <div class="wiz-card" style="margin-top:14px">
            <h3>If it will not connect</h3>
            <p class="wiz-note">Check that Tailscale says connected on this phone, that
            <code>${__BINARY_NAME__} status</code> on the computer says it is running, and that the
            host name matches exactly — the certificate is issued for that name.</p>
          </div>
        `,
      }

    case 'done':
      return {
        title: 'Ready',
        html: `
          <div class="wiz-card" style="border-color:#1a3a1a; background:#0a1a0a">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px">
              <div class="wiz-dot"></div>
              <h3 class="wiz-ok" style="margin:0">Connected</h3>
            </div>
            <div id="wiz-server" class="wiz-kv"></div>
          </div>
          <div class="wiz-card">
            <h3>Launch it on the glasses</h3>
            <p>Open ${__PRODUCT_NAME__} from the G2 app menu. Swipe to move between sessions,
            tap to select, double tap to go back.</p>
          </div>
          ${settingsPanelHtml()}
          <div id="wiz-diag" class="wiz-cmd" style="color:#888; padding-right:11px"></div>
          <button type="button" class="wiz-ghost wiz-wide" id="wiz-disconnect">Disconnect</button>
        `,
      }
  }
}

/** Header, progress and the two footer buttons around a screen's body. */
function shellHtml(id: WizardStepId, connected: boolean): string {
  const step = stepById(id)
  const index = stepIndex(id)
  const { title, html } = screenHtml(id)
  const pct = Math.round(((index + 1) / TOTAL_STEPS) * 100)
  const where = step.where === 'pc' ? 'On your computer' : 'On this phone'

  const back =
    index > 0 ? '<button type="button" class="wiz-ghost" id="wiz-back">Back</button>' : ''

  const primary =
    id === CONNECT_STEP
      ? '<button type="button" class="wiz-primary" id="wiz-connect">Connect</button>'
      : `<button type="button" class="wiz-primary" id="wiz-next">${
          index === 0 ? 'Start setup' : 'Done — next'
        }</button>`

  // Someone who already has a server running should not walk through eight
  // screens about installing one.
  const skip =
    index === 0 && !connected
      ? '<button type="button" class="wiz-ghost" id="wiz-skip">Already running</button>'
      : ''

  return `
    <div class="wiz">
      <div class="wiz-top">
        <div class="wiz-brand">
          <div class="wiz-mark">H</div>
          <div class="wiz-name">${__PRODUCT_NAME__}<span style="color:#666; font-weight:400"> for EVEN G2</span></div>
        </div>
        <div class="wiz-bar"><i style="width:${pct}%"></i></div>
        <div class="wiz-meta">
          <span>Step ${index + 1} of ${TOTAL_STEPS} &middot; ${step.label}</span>
          <span class="wiz-where ${step.where}">${where}</span>
        </div>
      </div>
      <div class="wiz-body">
        <h1 class="wiz-title">${title}</h1>
        ${html}
      </div>
      ${
        // The last screen has nothing to advance to, and a sticky bar floating
        // over the settings panel below it only hides the fields.
        id === CONNECTED_STEP ? '' : `<div class="wiz-foot">${back}${primary}${skip}</div>`
      }
    </div>
    <style>${CSS}</style>
  `
}

// ── Wiring ──

export async function startPhoneUI(bridge: Bridge | null): Promise<void> {
  const app = document.querySelector<HTMLDivElement>('#app')!
  const store = makeStore(bridge)

  let step = parseStep(await store.get(STEP_SUFFIX))
  let url = (await store.get(URL_SUFFIX)) || ''
  let connected = false
  let status = ''
  /** What the last successful connection learned; the done screen's card. */
  let summary: {
    url: string
    version: string
    sessions: number
    usage: string
    first?: string
  } | null = null

  // biome-ignore lint: dynamic import to avoid initialization order issues
  let diagClient: any = null
  let diagTimer: ReturnType<typeof setInterval> | null = null

  function stopWsDiag(): void {
    if (diagTimer) {
      clearInterval(diagTimer)
      diagTimer = null
    }
    diagClient?.close()
    diagClient = null
  }

  /**
   * A URL typed by a person, made into one that can be fetched.
   *
   * Both halves matter on a phone keyboard: the scheme is four characters of
   * punctuation nobody wants to type, and the port is the part people forget
   * and then cannot diagnose.
   */
  function normalizeUrl(input: string): string {
    let value = input.trim().replace(/\/+$/, '')
    if (!value) return ''
    if (!value.match(/^https?:\/\//)) value = `https://${value}`
    if (!value.match(/:\d+$/)) value = `${value}:${__DEFAULT_PORT__}`
    return value
  }

  async function goTo(next: WizardStepId): Promise<void> {
    step = next
    await store.set(STEP_SUFFIX, next)
    render()
  }

  function render(): void {
    stopWsDiag()
    app.innerHTML = shellHtml(step, connected)

    app.querySelector('#wiz-next')?.addEventListener('click', () => void goTo(nextStep(step)))
    app.querySelector('#wiz-back')?.addEventListener('click', () => void goTo(prevStep(step)))
    app.querySelector('#wiz-skip')?.addEventListener('click', () => void goTo(CONNECT_STEP))

    // One handler for every copy button on the screen.
    for (const button of app.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
      button.addEventListener('click', () => {
        const text = button.parentElement?.querySelector('[data-cmd]')?.textContent?.trim() || ''
        if (!text) return
        navigator.clipboard
          .writeText(text)
          .then(() => {
            button.textContent = 'copied'
            setTimeout(() => {
              button.textContent = 'copy'
            }, 1500)
          })
          .catch(() => {
            button.textContent = 'failed'
          })
      })
    }

    if (step === CONNECT_STEP) wireConnect()
    if (step === CONNECTED_STEP) wireDone()
  }

  function wireConnect(): void {
    const input = app.querySelector<HTMLInputElement>('#wiz-url')
    const button = app.querySelector<HTMLButtonElement>('#wiz-connect')
    const statusEl = app.querySelector<HTMLDivElement>('#wiz-connect-status')
    if (!input || !button || !statusEl) return

    input.value = url
    statusEl.innerHTML = status
    input.addEventListener('blur', () => {
      const normalized = normalizeUrl(input.value)
      if (normalized) input.value = normalized
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') button.click()
    })

    const scan = app.querySelector<HTMLButtonElement>('#wiz-scan')
    const scanStatus = app.querySelector<HTMLDivElement>('#wiz-scan-status')
    scan?.addEventListener('click', async () => {
      scan.setAttribute('disabled', '')
      if (scanStatus) scanStatus.innerHTML = '<span style="color:#ff0">Opening the camera...</span>'
      // `scanQr` is imported statically, and has to be. Loading the decoder on
      // demand costs an `await` before the camera is asked for, and an `await`
      // spends the user gesture this press carried — after which the browser
      // refuses to open a file chooser at all. The device path goes through the
      // host bridge and does not care, so this failed only in the browser,
      // which is the one place the screen can be tested.
      const outcome = await scanQr(bridge)
      scan.removeAttribute('disabled')
      if (outcome.cancelled) {
        if (scanStatus) scanStatus.innerHTML = ''
        return
      }
      if (outcome.error) {
        if (scanStatus) scanStatus.innerHTML = `<span style="color:#ff5555">${outcome.error}</span>`
        return
      }
      if (outcome.url) {
        input.value = normalizeUrl(outcome.url)
        if (scanStatus) scanStatus.innerHTML = '<span class="wiz-ok">Address read</span>'
        // Straight on to connecting: the scan already did the only thing this
        // screen asks for, and a second press to confirm an address the user
        // never typed is a step with nothing in it.
        button.click()
      }
    })

    button.addEventListener('click', async () => {
      const candidate = normalizeUrl(input.value)
      if (!candidate) {
        statusEl.innerHTML = '<span style="color:#f44">Enter the URL first</span>'
        return
      }
      input.value = candidate
      button.setAttribute('disabled', '')
      statusEl.innerHTML = '<span style="color:#ff0">Connecting...</span>'
      const ok = await tryConnect(candidate)
      if (ok) {
        // Everything the earlier screens ask about is proven by a server that
        // answers, so they are completed rather than walked through.
        await goTo(CONNECTED_STEP)
        return
      }
      button.removeAttribute('disabled')
      statusEl.innerHTML = status
    })
  }

  function wireDone(): void {
    void wireSettingsPanel()
    paintServer()
    void startWsDiag(summary?.first)
    app.querySelector('#wiz-disconnect')?.addEventListener('click', async () => {
      stopWsDiag()
      await store.clear(URL_SUFFIX)
      connected = false
      url = ''
      status = ''
      summary = null
      await goTo(CONNECT_STEP)
    })
  }

  /**
   * Ask the server for two things it can only answer if it is really up.
   *
   * Returns whether it answered. On the way it fills in the summary the done
   * screen shows, which is also the proof: a version number and a session count
   * are not something an unreachable host produces.
   */
  async function tryConnect(candidate: string): Promise<boolean> {
    try {
      setBaseUrl(candidate)
      const [dashboard, sessions] = await Promise.all([getDashboard(), getSessions()])
      url = candidate
      await store.set(URL_SUFFIX, candidate)
      connected = true
      status = '<span class="wiz-ok">Connected</span>'
      summary = {
        url: candidate,
        version: dashboard.version || '?',
        sessions: sessions.sessions?.length || 0,
        usage: dashboard.usageLimits ? `${dashboard.usageLimits.fiveHour.utilization}%` : '-',
        first: sessions.sessions?.[0]?.id,
      }
      return true
    } catch (err) {
      connected = false
      status = `<span style="color:#f44">Could not connect: ${(err as Error).message}</span>`
      return false
    }
  }

  /** Fill the done screen's server card, once it exists in the DOM. */
  function paintServer(): void {
    const target = app.querySelector<HTMLDivElement>('#wiz-server')
    if (!target || !summary) return
    const { url: at, version, sessions, usage } = summary
    target.innerHTML = `
      <span>Server</span><span style="font-family:ui-monospace,Menlo,monospace; font-size:12px; word-break:break-all">${at}</span>
      <span>Version</span><span>v${version}</span>
      <span>Sessions</span><span>${sessions}</span>
      <span>API usage</span><span>${usage}</span>
    `
  }

  /**
   * The live WebSocket read-out on the done screen.
   *
   * It answers the question the HTTP check cannot: the terminal stream is a
   * different path through the same server, and it is the one the glasses
   * actually use.
   */
  async function startWsDiag(firstSession?: string): Promise<void> {
    const target = app.querySelector<HTMLDivElement>('#wiz-diag')
    if (!target) return
    const { WsClient } = await import('./ws-client.ts')

    diagClient = new WsClient({
      onSessionsUpdated() {},
      onTerminalOutput() {},
      onReady() {
        if (firstSession) diagClient?.subscribe(firstSession)
      },
      onError(message: string) {
        target.innerHTML = `<span style="color:#f44">WS error: ${message}</span>`
      },
    })
    diagClient.connect()

    diagTimer = setInterval(() => {
      if (!diagClient) return
      const state = diagClient.getState()
      const subscribed = diagClient.getSubscribed()
      target.innerHTML = [
        `WS <span style="color:${state === 'OPEN' ? '#4ade80' : '#ff5555'}">${state}</span>`,
        `sub ${subscribed || 'none'}`,
        `buf ${subscribed ? diagClient.getTerminalText(subscribed).length : 0}ch`,
      ].join(' &middot; ')
    }, 1000)
  }

  // A saved URL means this phone has connected before. Try it before showing
  // anything: someone returning to a working setup should see the done screen,
  // not the wizard they already finished.
  if (url) {
    const ok = await tryConnect(url)
    if (ok) {
      await goTo(CONNECTED_STEP)
      return
    }
    // It did not answer. The saved step is where they actually were — except
    // that the done screen is a lie without a server behind it.
    if (step === CONNECTED_STEP) step = CONNECT_STEP
  } else if (step === CONNECTED_STEP) {
    step = CONNECT_STEP
  }

  render()
}
