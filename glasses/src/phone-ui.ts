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
import { type Lang, getLang, setLang, t } from './i18n.ts'
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
  .wiz-langs { margin-left:auto; display:flex; gap:4px; }
  .wiz-lang { background:transparent; border:1px solid #2e2e2e; color:#777; border-radius:99px;
              font-size:10.5px; padding:3px 9px; cursor:pointer; }
  .wiz-lang.on { border-color:#5a2226; color:#ff8a8f; }
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
  .wiz-net { margin:0 0 16px; }
  .wiz-net-box { background:#111; border:1px solid #262626; border-radius:10px; padding:11px 13px; }
  .wiz-net-box b { display:block; font-size:13.5px; color:#eee; margin-bottom:3px; }
  .wiz-net-box span { display:block; font-size:12px; color:#8d8d8d; line-height:1.55; }
  .wiz-net-box.here { border-color:#5a2226; }
  .wiz-net-hop { display:flex; gap:12px; padding:7px 0 7px 13px; }
  .wiz-net-wire { width:0; border-left:2px solid #4a2024; }
  /* The internet leg is dashed and the local ones are solid: the point of the
     picture is which hop leaves the building. */
  .wiz-net-wire.wan { border-left-style:dashed; border-left-color:#6b2b30; }
  .wiz-net-hop p { margin:0; font-size:11.5px; color:#8d8d8d; line-height:1.6; }
  .wiz-net-hop p b { color:#ff8a8f; font-weight:600; }
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
  const product = __PRODUCT_NAME__
  const binary = __BINARY_NAME__

  switch (id) {
    case 'intro':
      return {
        title: t('intro.title', { product }),
        html: `
          <p class="wiz-lead">${t('intro.lead', { product })}</p>
          <div class="wiz-net">
            <div class="wiz-net-box">
              <b>${t('intro.net.machine')}</b>
              <span>${t('intro.net.machineDesc', { product })}</span>
            </div>
            <div class="wiz-net-hop">
              <div class="wiz-net-wire wan"></div>
              <p>${t('intro.net.tailscale')}</p>
            </div>
            <div class="wiz-net-box here">
              <b>${t('intro.net.phone')}</b>
              <span>${t('intro.net.phoneDesc')}</span>
            </div>
            <div class="wiz-net-hop">
              <div class="wiz-net-wire"></div>
              <p>${t('intro.net.bluetooth')}</p>
            </div>
            <div class="wiz-net-box here">
              <b>${t('intro.net.glasses')}</b>
              <span>${t('intro.net.glassesDesc')}</span>
            </div>
          </div>
          <div class="wiz-card">
            <h3>${t('intro.getTitle')}</h3>
            <ul class="wiz-points">
              <li>${t('intro.get1')}</li>
              <li>${t('intro.get2')}</li>
              <li>${t('intro.get3')}</li>
              <li>${t('intro.get4')}</li>
            </ul>
          </div>
          <p class="wiz-note">${t('intro.time')}</p>
        `,
      }

    case 'machine':
      return {
        title: t('machine.title'),
        html: `
          <p class="wiz-lead">${t('machine.lead')}</p>
          <div class="wiz-card">
            <h3>${t('machine.supported')}</h3>
            <div class="wiz-kv">
              <span>${t('machine.linux')}</span><span>${t('machine.linuxArch')}</span>
              <span>${t('machine.macos')}</span><span>${t('machine.macosArch')}</span>
            </div>
          </div>
          <div class="wiz-card">
            <h3>${t('machine.awakeTitle')}</h3>
            <p>${t('machine.awake1')}</p>
            <p>${t('machine.awake2')}</p>
          </div>
          <div class="wiz-card">
            <h3>${t('machine.vpsTitle')}</h3>
            <p>${t('machine.vps1')}</p>
            <p class="wiz-note">${t('machine.vps2')}</p>
          </div>
        `,
      }

    case 'agent':
      return {
        title: t('agent.title'),
        html: `
          <p class="wiz-lead">${t('agent.lead', { product })}</p>
          <div class="wiz-card">
            <h3>${t('agent.claudeTitle')}</h3>
            ${cmd('npm install -g @anthropic-ai/claude-code')}
            <p class="wiz-note">${t('agent.claudeNote')}</p>
          </div>
          <div class="wiz-card wiz-warn">
            <h3>${t('agent.signInTitle')}</h3>
            <p>${t('agent.signIn')}</p>
          </div>
          <p class="wiz-note">${t('agent.others')}</p>
        `,
      }

    case 'tailscale':
      return {
        title: t('tailscale.title'),
        html: `
          <p class="wiz-lead">${t('tailscale.lead')}</p>
          <div class="wiz-card">
            <h3>${t('tailscale.linux')}</h3>
            ${cmd('curl -fsSL https://tailscale.com/install.sh | sh')}
            <h3 style="margin-top:12px">${t('tailscale.macos')}</h3>
            ${cmd('brew install tailscale')}
            <p class="wiz-note">${t('tailscale.brewNote')}</p>
          </div>
          <div class="wiz-card">
            <h3>${t('tailscale.certTitle')}</h3>
            ${cmd('sudo tailscale set --operator=$USER')}
            <p class="wiz-note">${t('tailscale.certNote', { binary })}</p>
          </div>
          <p class="wiz-note">${t('tailscale.downloads', {
            link: link('https://tailscale.com/download', t('tailscale.downloadsLabel')),
          })}</p>
        `,
      }

    case 'install':
      return {
        title: t('install.title', { product }),
        html: `
          <p class="wiz-lead">${t('install.lead')}</p>
          ${cmd(INSTALL_CMD)}
          <div class="wiz-card">
            <h3>${t('install.whatTitle')}</h3>
            <p>${t('install.what', {
              binary,
              herdr: link('https://herdr.dev/', 'herdr'),
            })}</p>
            <p class="wiz-note">${t('install.sudoNote', { binary })}</p>
          </div>
          <div class="wiz-card">
            <h3>${t('install.passwordTitle')}</h3>
            <p class="wiz-note">${t('install.password')}</p>
            ${cmd(`${binary} setup -P yourpassword`)}
          </div>
        `,
      }

    case 'connect':
      return {
        title: t('connect.title', { product }),
        html: `
          <p class="wiz-lead">${t('connect.lead')}</p>
          <div class="wiz-card">
            <h3>${t('connect.tailscaleTitle')}</h3>
            ${linkButton('https://play.google.com/store/apps/details?id=com.tailscale.ipn', 'Google Play')}
            ${linkButton('https://apps.apple.com/app/tailscale/id1470499037', 'App Store')}
            <p class="wiz-note">${t('connect.tailscaleNote')}</p>
            ${cmd('https://tailscale.com/download')}
          </div>
          <div class="wiz-card">
            <h3>${t('connect.scanTitle')}</h3>
            <p class="wiz-note">${t('connect.scanNote')}</p>
            ${cmd(`${binary} qr`)}
            <button type="button" class="wiz-scan" id="wiz-scan">${t('connect.scanButton')}</button>
            <div id="wiz-scan-status" class="wiz-status" style="margin:0 0 6px"></div>
            <div class="wiz-or">${t('connect.orType')}</div>
            <input id="wiz-url" class="wiz-input" type="url" inputmode="url" autocapitalize="off"
                   autocorrect="off" spellcheck="false"
                   placeholder="https://your-machine.tailnet.ts.net:${__DEFAULT_PORT__}" />
          </div>
          <div id="wiz-connect-status" class="wiz-status"></div>
          <div class="wiz-card" style="margin-top:14px">
            <h3>${t('connect.troubleTitle')}</h3>
            <p class="wiz-note">${t('connect.trouble', { binary })}</p>
          </div>
        `,
      }

    case 'done':
      return {
        title: t('done.title'),
        html: `
          <div class="wiz-card" style="border-color:#1a3a1a; background:#0a1a0a">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px">
              <div class="wiz-dot"></div>
              <h3 class="wiz-ok" style="margin:0">${t('done.connected')}</h3>
            </div>
            <div id="wiz-server" class="wiz-kv"></div>
          </div>
          <div class="wiz-card">
            <h3>${t('done.launchTitle')}</h3>
            <p>${t('done.launch', { product })}</p>
          </div>
          ${settingsPanelHtml()}
          <div id="wiz-diag" class="wiz-cmd" style="color:#888; padding-right:11px"></div>
          <button type="button" class="wiz-ghost wiz-wide" id="wiz-disconnect">${t('done.disconnect')}</button>
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
  const where = step.where === 'pc' ? t('nav.onMachine') : t('nav.onPhone')

  const back =
    index > 0
      ? `<button type="button" class="wiz-ghost" id="wiz-back">${t('nav.back')}</button>`
      : ''

  const primary =
    id === CONNECT_STEP
      ? `<button type="button" class="wiz-primary" id="wiz-connect">${t('connect.connectButton')}</button>`
      : `<button type="button" class="wiz-primary" id="wiz-next">${
          index === 0 ? t('nav.start') : t('nav.next')
        }</button>`

  // Someone who already has a server running should not walk through eight
  // screens about installing one.
  const skip =
    index === 0 && !connected
      ? `<button type="button" class="wiz-ghost" id="wiz-skip">${t('nav.skip')}</button>`
      : ''

  // Offered on every screen rather than only the first: the app is launched by
  // the host, in whatever language the phone happens to report, and someone who
  // gets six screens in before deciding they would rather read the other one
  // should not have to start over to say so.
  const langs = (['en', 'ja'] as const)
    .map(
      (l) =>
        `<button type="button" class="wiz-lang${l === getLang() ? ' on' : ''}" data-lang="${l}">${
          l === 'en' ? 'EN' : '日本語'
        }</button>`,
    )
    .join('')

  return `
    <div class="wiz">
      <div class="wiz-top">
        <div class="wiz-brand">
          <div class="wiz-mark">H</div>
          <div class="wiz-name">${__PRODUCT_NAME__}<span style="color:#666; font-weight:400"> ${t('brand.for')}</span></div>
          <div class="wiz-langs">${langs}</div>
        </div>
        <div class="wiz-bar"><i style="width:${pct}%"></i></div>
        <div class="wiz-meta">
          <span>${t('nav.step', {
            n: index + 1,
            total: TOTAL_STEPS,
            label: t(`step.${id}`),
          })}</span>
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

    for (const button of app.querySelectorAll<HTMLButtonElement>('[data-lang]')) {
      button.addEventListener('click', () => {
        const lang = button.dataset.lang as Lang
        if (lang === getLang()) return
        setLang(lang)
        // Everything on screen is built from `t()`, so a re-render is the whole
        // of the change — including the status line, which is stored as markup
        // and would otherwise stay in the language it was written in.
        status = ''
        render()
      })
    }

    // One handler for every copy button on the screen.
    for (const button of app.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
      button.addEventListener('click', () => {
        const text = button.parentElement?.querySelector('[data-cmd]')?.textContent?.trim() || ''
        if (!text) return
        navigator.clipboard
          .writeText(text)
          .then(() => {
            button.textContent = t('cmd.copied')
            setTimeout(() => {
              button.textContent = t('cmd.copy')
            }, 1500)
          })
          .catch(() => {
            button.textContent = t('cmd.copyFailed')
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
      if (scanStatus) scanStatus.innerHTML = `<span style="color:#ff0">${t('connect.opening')}</span>`
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
        if (scanStatus) scanStatus.innerHTML = `<span class="wiz-ok">${t('connect.addressRead')}</span>`
        // Straight on to connecting: the scan already did the only thing this
        // screen asks for, and a second press to confirm an address the user
        // never typed is a step with nothing in it.
        button.click()
      }
    })

    button.addEventListener('click', async () => {
      const candidate = normalizeUrl(input.value)
      if (!candidate) {
        statusEl.innerHTML = `<span style="color:#f44">${t('connect.enterFirst')}</span>`
        return
      }
      input.value = candidate
      button.setAttribute('disabled', '')
      statusEl.innerHTML = `<span style="color:#ff0">${t('connect.connecting')}</span>`
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
      status = `<span class="wiz-ok">${t('connect.connected')}</span>`
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
      status = `<span style="color:#f44">${t('connect.failed', { error: (err as Error).message })}</span>`
      return false
    }
  }

  /** Fill the done screen's server card, once it exists in the DOM. */
  function paintServer(): void {
    const target = app.querySelector<HTMLDivElement>('#wiz-server')
    if (!target || !summary) return
    const { url: at, version, sessions, usage } = summary
    target.innerHTML = `
      <span>${t('done.server')}</span><span style="font-family:ui-monospace,Menlo,monospace; font-size:12px; word-break:break-all">${at}</span>
      <span>${t('done.version')}</span><span>v${version}</span>
      <span>${t('done.sessions')}</span><span>${sessions}</span>
      <span>${t('done.usage')}</span><span>${usage}</span>
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
