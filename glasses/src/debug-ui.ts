// Browser simulator — runs when the Even Hub SDK is absent, so the glasses UI
// can be driven from a browser with no G2 on your face (vite dev on 8391, or
// served by CC Hub itself at /glasses).
//
// It consumes the SAME GlassesController as the real G2 path AND renders
// through the same `screenText()` the device renders through, so what you see
// here is the device's own output: identical wrapping at 52 columns, identical
// 7-line clamp, identical pagination. Copying the screen therefore quotes what
// the glasses actually showed. Mic/STT are faked: the "STT result" textbox
// injects what the Groq transcription would have returned.

import { setBaseUrl } from './api.ts'
import { GlassesController } from './controller.ts'
import type { GlassesPlatform } from './controller.ts'
import { screenText, wrapForPanel } from './display.ts'
import type { AppState } from './display.ts'

/** Japanese screen names — the shared vocabulary used when reporting issues. */
const MODE_LABEL: Record<string, string> = {
  session_list: '一覧',
  conversation: '会話',
  overlay: '割り込み',
  choice: '選択',
  voice: '音声',
}

const STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #0d100e; color: #d8ded6;
         font-family: "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; }
  .sim-wrap { max-width: 1000px; margin: 0 auto; padding: 28px 20px 48px;
              display: flex; flex-direction: column; gap: 20px; }
  .sim-title { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .sim-title h1 { font-size: 18px; font-weight: 800; letter-spacing: .02em; margin: 0; }
  .sim-title .sub { font-size: 12px; color: #7d867a; }
  .sim-main { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
  .lens-col { display: flex; flex-direction: column; gap: 10px; max-width: 100%; }
  .lens-scroll { overflow-x: auto; max-width: 100%; }

  /* 576x288 at 1:1 — the real panel size. */
  .lens { width: 576px; height: 288px; flex: none; background: #05090a; color: #7ce88a;
          font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
          border-radius: 10px; display: flex; flex-direction: column;
          box-shadow: inset 0 0 60px rgba(124,232,138,.06); }
  /* Sized so a full Japanese line fits. The G2 treats CJK as 1.857 columns
     wide and wraps at 28 characters; a browser monospace draws it at exactly
     2.0, so the two ratios cannot both be exact. Fitting the wider case keeps
     wrapped lines inside the panel — an ASCII line then stops a little short
     of the right edge, which is the harmless direction to be wrong in. */
  .lens .hdr, .lens .ftr { height: 36px; padding: 0 4px; display: flex; align-items: center;
                           font-size: 19px; white-space: pre; overflow: hidden; }
  .lens .hdr { border-bottom: 1px solid #1c3a22; }
  .lens .ftr { border-top: 1px solid #1c3a22; color: #3d7a48; }
  .lens .body { height: 216px; margin: 0 4px; padding: 6px; font-size: 19px; line-height: 28px;
                white-space: pre; overflow: hidden; }

  .lens-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
  .mode-pill { background: #1b2a1f; color: #7cc98f; padding: 3px 10px; border-radius: 999px;
               font-weight: 700; font-size: 12px; }
  .mode-id { color: #6b736a; font-family: ui-monospace, Menlo, monospace; }

  .panel { background: #151a14; border: 1px solid #262e25; border-radius: 8px;
           padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; min-width: 240px; }
  .panel h2 { font-size: 12px; letter-spacing: .12em; text-transform: uppercase;
              color: #7d867a; margin: 0; font-weight: 700; }
  .ring { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  button { font: inherit; font-size: 13px; padding: 8px 10px; border-radius: 6px;
           border: 1px solid #33402f; background: #1d251c; color: #d8ded6; cursor: pointer; }
  button:hover { background: #263021; }
  button:focus-visible { outline: 2px solid #7cc98f; outline-offset: 2px; }
  button.wide { grid-column: 1 / -1; }
  input[type=text] { font: inherit; font-size: 13px; padding: 7px 9px; border-radius: 6px;
                     border: 1px solid #33402f; background: #0f140e; color: #d8ded6; width: 100%;
                     box-sizing: border-box; }
  .hint { font-size: 11px; color: #6b736a; line-height: 1.6; }
  .diag { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: #6b736a;
          line-height: 1.8; word-break: break-all; }
  .copied { color: #7cc98f; }
`

export function startDebugUI(): void {
  // `?hub=` points the simulator at another CC Hub; default is same-origin,
  // which is what /glasses and the vite proxy both want.
  const params = new URLSearchParams(location.search)
  const hubUrl = params.get('hub')
  if (hubUrl) setBaseUrl(hubUrl)

  document.title = 'CC Hub Glasses — シミュレータ'
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)

  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <div class="sim-wrap">
      <div class="sim-title">
        <h1>CC Hub Glasses シミュレータ</h1>
        <span class="sub">実機と同じ描画（576×288 / 52字×7行）</span>
      </div>
      <div class="sim-main">
        <div class="lens-col">
          <div class="lens-scroll">
            <div class="lens">
              <div class="hdr" id="g2-hdr"></div>
              <div class="body" id="g2-body"></div>
              <div class="ftr" id="g2-ftr"></div>
            </div>
          </div>
          <div class="lens-meta">
            <span class="mode-pill" id="g2-mode-jp">一覧</span>
            <span class="mode-id" id="g2-mode-id">session_list</span>
            <button type="button" id="g2-copy">画面をコピー</button>
            <span class="hint" id="g2-copied"></span>
          </div>
          <div class="diag" id="g2-diag"></div>
          <div class="diag" id="g2-relay"></div>
        </div>

        <div class="panel">
          <h2>リング操作</h2>
          <div class="ring">
            <button type="button" id="btn-up">スワイプ↑</button>
            <button type="button" id="btn-down">スワイプ↓</button>
            <button type="button" id="btn-tap">タップ</button>
            <button type="button" id="btn-dbl">ダブルタップ</button>
          </div>
          <h2>音声（STT 差し込み）</h2>
          <input type="text" id="dbg-stt" placeholder="認識結果として使う文字列" />
          <p class="hint">音声画面でタップすると、この文字列が Groq の認識結果の代わりになる。</p>
        </div>
      </div>
    </div>
  `

  const el = (id: string) => document.getElementById(id) as HTMLElement
  const hdr = el('g2-hdr')
  const body = el('g2-body')
  const ftr = el('g2-ftr')
  const modeJp = el('g2-mode-jp')
  const modeId = el('g2-mode-id')
  const copied = el('g2-copied')
  const diag = el('g2-diag')
  const relay = el('g2-relay')
  const sttInput = document.getElementById('dbg-stt') as HTMLInputElement

  let lastScreen = { header: '', body: '', footer: '' }

  const platform: GlassesPlatform = {
    render(state) {
      const raw = screenText(state)
      // The device's container wraps for it; this panel has to do it itself.
      const screen = { ...raw, body: wrapForPanel(raw.body) }
      lastScreen = screen
      hdr.textContent = screen.header
      body.textContent = screen.body
      ftr.textContent = screen.footer
      modeJp.textContent = MODE_LABEL[state.mode] ?? state.mode
      modeId.textContent = state.mode
      renderDiag(state)
    },
    startMicCapture: () => Promise.resolve(true),
    stopMicCapture: () => Promise.resolve(),
    // The textbox injects what Groq STT would have returned.
    transcribeAudio: () => Promise.resolve(sttInput.value.trim()),
  }

  const controller = new GlassesController(platform)
  controller.connect()

  function renderDiag(state: AppState): void {
    const ws = controller.ws
    const session = state.sessions[state.sessionIndex]
    const bufText = session ? ws.getTerminalText(session.id) : ''
    const choices = session ? ws.getChoices(session.id) : []
    diag.textContent = `WS: ${ws.getState()} | Sub: ${ws.getSubscribed() || 'none'} | Buf: ${bufText.length}ch | Choices: [${choices.join(', ')}]`
    const top = state.relayWaiting[0]
    relay.textContent =
      `Relay: waiting=${state.relayWaiting.length} info=${state.relayInfo.length}` +
      (top ? ` | top: [${top.kind}] ${top.sessionId}${top.paneId ?? ''} "${top.text.slice(0, 40)}"${top.choices?.length ? ` choices=${top.choices.length}` : ''}` : '') +
      (state.overlayItemId ? ` | overlay=${state.overlayItemId}` : '')
  }

  /** The screen as pasteable text: three framed sections, same strings the G2
   *  drew. This is the point of the simulator — quoting a screen in a report
   *  should not require retyping it. */
  function screenAsText(): string {
    const rule = '─'.repeat(52)
    return [
      `[${MODE_LABEL[controller.state.mode] ?? controller.state.mode} / ${controller.state.mode}]`,
      rule,
      lastScreen.header,
      rule,
      lastScreen.body,
      rule,
      lastScreen.footer,
      rule,
    ].join('\n')
  }

  el('g2-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(screenAsText())
      copied.textContent = 'コピーしました'
      copied.className = 'hint copied'
    } catch {
      copied.textContent = 'コピーできませんでした'
      copied.className = 'hint'
    }
    setTimeout(() => { copied.textContent = '' }, 2000)
  })

  el('btn-up').addEventListener('click', () => controller.swipeUp())
  el('btn-down').addEventListener('click', () => controller.swipeDown())
  el('btn-tap').addEventListener('click', () => controller.tap())
  el('btn-dbl').addEventListener('click', () => controller.doubleTap())

  // Keyboard: arrows scroll, Enter taps, Backspace double-taps. Faster than
  // clicking when walking someone through a flow.
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return
    const map: Record<string, () => void> = {
      ArrowUp: () => controller.swipeUp(),
      ArrowDown: () => controller.swipeDown(),
      Enter: () => controller.tap(),
      Backspace: () => controller.doubleTap(),
    }
    const fn = map[e.key]
    if (!fn) return
    e.preventDefault()
    fn()
  })

  // Diag also changes outside controller render events (terminal buffers, WS
  // state) — keep it fresh on an interval.
  setInterval(() => renderDiag(controller.state), 500)

  ;(window as unknown as Record<string, unknown>)._ws = controller.ws
  ;(window as unknown as Record<string, unknown>)._dbg = {
    swipeUp: () => controller.swipeUp(),
    swipeDown: () => controller.swipeDown(),
    tap: () => controller.tap(),
    doubleTap: () => controller.doubleTap(),
    screenText: () => screenAsText(),
  }
  ;(window as unknown as Record<string, unknown>)._controller = controller
}
