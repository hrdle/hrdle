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

import { setBaseUrl, transcribe } from './api.ts'
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
  body { margin: 0; color: #d8ded6;
         font-family: "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif;
         background: radial-gradient(ellipse 90% 60% at 50% 0%, #161c19 0%, #0a0d0b 60%); }
  .sim-wrap { max-width: 1040px; margin: 0 auto; padding: 28px 20px 48px;
              display: flex; flex-direction: column; gap: 20px; }
  .sim-title { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .sim-title h1 { font-size: 18px; font-weight: 800; letter-spacing: .02em; margin: 0; }
  .sim-title .sub { font-size: 12px; color: #7d867a; }
  .sim-main { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
  .lens-col { display: flex; flex-direction: column; gap: 10px; max-width: 100%; min-width: 0; }
  /* The panel is a fixed 576x288 — it is the hardware. On a narrow screen it
     is scaled down to fit rather than clipped or scrolled: seeing the whole
     display at once is the entire point. */
  .lens-fit { width: 100%; overflow: hidden; padding: 10px 0 4px; }
  .lens { transform-origin: top left; }

  /* 576x288 at 1:1 — the real panel size, drawn as what the wearer actually
     sees: the room straight ahead, someone standing in it, and the text
     floating over both. The display is additive light on clear glass, never a
     black rectangle, so the scene stays visible right through the type. */
  .lens { position: relative; overflow: hidden;
          width: 576px; height: 288px; flex: none; border-radius: 10px;
          font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }

  /* A lit room with people in it. The --bg custom property swaps in a real
     photo (?bg=URL) when demoing; the drawn fallback keeps the page
     self-contained. */
  .scene { position: absolute; inset: 0;
           background-image: var(--bg, none);
           background-size: cover; background-position: center;
           filter: saturate(.9); }
  /* The room is dimmed under the type. Real glasses lose contrast in bright
     rooms, but a demo nobody can read proves nothing. */
  .scene::after { content: ''; position: absolute; inset: 0;
                  background: linear-gradient(180deg, rgba(4,8,6,.42), rgba(4,8,6,.52)); }
  .room { position: absolute; inset: 0; filter: blur(1.5px);
          background:
            linear-gradient(115deg, rgba(255,250,238,.6) 0 30%, transparent 30.5%),
            linear-gradient(180deg, #cdd4db 0%, #bcc4cc 54%, #939ba4 54.5%, #6f767e 100%); }
  .room::before { content: ''; position: absolute; left: 56%; top: 4%;
                  width: 38%; height: 46%; border-radius: 3px;
                  background: rgba(255,252,244,.72);
                  box-shadow: inset 0 0 0 3px rgba(120,128,136,.55); }

  /* Three people at different depths. Dark against the window light, which is
     what makes the green legible in the first place. */
  .figure { position: absolute; bottom: -8%; filter: blur(2px); }
  .figure::before { content: ''; position: absolute; left: 50%; top: 4%;
                    transform: translateX(-50%); width: 33%; height: 31%;
                    border-radius: 48% 48% 44% 44%; background: var(--tone, #2a3138); }
  .figure::after { content: ''; position: absolute; left: 50%; bottom: 0;
                   transform: translateX(-50%); width: 100%; height: 68%;
                   border-radius: 46% 46% 0 0; background: var(--tone, #2a3138); }
  .figure.a { left: 4%; width: 210px; height: 250px; --tone: #1d232a; }
  .figure.b { left: 46%; width: 170px; height: 205px; --tone: #262d35; }
  .figure.c { left: 74%; width: 195px; height: 232px; --tone: #212830; }

  /* The projected layer, drawn on a real 576x288 canvas and quantised to the
     panel's 16 green levels. The browser's own text rendering is far finer
     than the hardware, which would flatter the design into something the
     wearer never sees — the type is coarse up there, and it matters. */
  .hud-canvas { position: absolute; inset: 0; width: 576px; height: 288px;
                image-rendering: pixelated; }

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
  .bg-row { display: flex; gap: 8px; }
  .bg-row button { flex: 1; }
  body.dropping { outline: 2px dashed #7cc98f; outline-offset: -8px; }
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

  // A real room behind the display reads far better in a demo than a drawing
  // of one, so a meeting photo ships as the default backdrop. It can be
  // swapped from the panel (file, drag-drop, or URL) or with `?bg=<url>`; a
  // pasted URL is remembered, an opened file is not, since its blob URL dies
  // with the page. The device build omits the photo and the drawn scene
  // stays as the fallback, so neither case ends up with a blank backdrop.
  const DEFAULT_BG = `${import.meta.env.BASE_URL}scene-meeting.jpg`
  const BG_KEY = 'cchub-glasses-bg'
  const savedBg = (() => {
    try { return localStorage.getItem(BG_KEY) } catch { return null }
  })()
  const bgUrl = params.get('bg') ?? savedBg ?? DEFAULT_BG

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
          <div class="lens-fit" id="lens-fit">
            <div class="lens" id="lens">
              <div class="scene" aria-hidden="true">
                <span class="room"></span>
                <span class="figure a"></span>
                <span class="figure c"></span>
                <span class="figure b"></span>
              </div>
              <canvas class="hud-canvas" id="g2-canvas" width="576" height="288"></canvas>
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
          <h2>音声入力</h2>
          <input type="text" id="dbg-stt" placeholder="STTを飛ばす場合の文字列（任意）" />
          <p class="hint" id="voice-status">会話画面でタップすると録音を開始し、もう一度タップで Groq に送る。文字列を入れておくと録音せずそれを認識結果として扱う。</p>

          <h2>背景</h2>
          <div class="bg-row">
            <button type="button" id="bg-pick">画像を選ぶ</button>
            <button type="button" id="bg-reset">既定に戻す</button>
          </div>
          <input type="file" id="bg-file" accept="image/*" hidden />
          <input type="text" id="bg-url" placeholder="画像URLを貼り付け（Enter）" />
          <p class="hint" id="bg-status">画面にドラッグ＆ドロップでも差し替えられる。</p>
        </div>
      </div>
    </div>
  `

  const el = (id: string) => document.getElementById(id) as HTMLElement
  const canvas = document.getElementById('g2-canvas') as HTMLCanvasElement

  // Scale the 576x288 panel down to whatever width there is. The canvas keeps
  // its real pixel count, so the type stays as coarse as the hardware's — it
  // is the whole thing that shrinks, exactly like stepping back from it.
  const PANEL_W = 576
  const PANEL_H = 288
  function fitPanel(): void {
    const box = document.getElementById('lens-fit')
    const lens = document.getElementById('lens')
    if (!box || !lens) return
    const scale = Math.min(1, box.clientWidth / PANEL_W)
    lens.style.transform = `scale(${scale})`
    box.style.height = `${PANEL_H * scale}px`
  }
  new ResizeObserver(fitPanel).observe(document.body)
  fitPanel()

  const DEFAULT_BG_HINT = '画面にドラッグ＆ドロップでも差し替えられる。'
  function setBgStatus(message: string): void {
    const node = document.getElementById('bg-status')
    if (node) node.textContent = message || DEFAULT_BG_HINT
  }

  const DEFAULT_VOICE_HINT =
    '会話画面でタップすると録音を開始し、もう一度タップで Groq に送る。文字列を入れておくと録音せずそれを認識結果として扱う。'
  function setVoiceStatus(message: string): void {
    const node = document.getElementById('voice-status')
    if (node) node.textContent = message || DEFAULT_VOICE_HINT
  }

  /** Swap the backdrop, but only once the image has actually decoded — a
   *  missing file would otherwise leave nothing at all behind the text. */
  function applyBackdrop(url: string, remember: boolean): void {
    const probe = new Image()
    probe.addEventListener('load', () => {
      const scene = document.querySelector('.scene') as HTMLElement | null
      // Quotes and backslashes stripped: the URL can come from the query
      // string or a text field and lands inside a CSS url().
      scene?.style.setProperty('--bg', `url("${url.replace(/["\\]/g, '')}")`)
      for (const drawn of document.querySelectorAll('.room, .figure')) {
        ;(drawn as HTMLElement).style.display = 'none'
      }
      if (remember) {
        try { localStorage.setItem(BG_KEY, url) } catch { /* private mode */ }
      }
      setBgStatus('')
    })
    probe.addEventListener('error', () => setBgStatus('画像を読み込めませんでした'))
    probe.src = url
  }

  applyBackdrop(bgUrl, false)
  const modeJp = el('g2-mode-jp')
  const modeId = el('g2-mode-id')
  const copied = el('g2-copied')
  const diag = el('g2-diag')
  const relay = el('g2-relay')
  const sttInput = document.getElementById('dbg-stt') as HTMLInputElement

  let lastScreen = { header: '', body: '', footer: '' }

  // Panel geometry, straight from display.ts's container layout.
  const HEADER_H = 36
  const FOOTER_Y = PANEL_H - 36
  const FONT = '19px ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  // The panel's phosphor green, bright enough to hold against a lit room.
  const GREEN = '106, 255, 122'

  /** Draw one screen at the hardware's real pixel count, then crush it to the
   *  panel's 16 levels of green. Anti-aliasing finer than 4 bits is exactly
   *  what the wearer does not get. */
  function drawPanel(screen: { header: string; body: string; footer: string }): void {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.font = FONT
    ctx.textBaseline = 'alphabetic'
    // Optics bloom a little; keep it subtle or quantising turns it to mud.
    ctx.shadowColor = `rgba(${GREEN}, 0.55)`
    ctx.shadowBlur = 6

    ctx.fillStyle = `rgb(${GREEN})`
    ctx.fillText(screen.header, 4, 25)

    for (const [i, line] of screen.body.split('\n').entries()) {
      ctx.fillText(line, 10, HEADER_H + 28 + i * 28)
    }

    ctx.fillStyle = `rgba(${GREEN}, 0.78)`
    ctx.fillText(screen.footer, 4, FOOTER_Y + 25)

    ctx.shadowBlur = 0
    ctx.fillStyle = `rgba(${GREEN}, 0.3)`
    ctx.fillRect(0, HEADER_H - 1, PANEL_W, 1)
    ctx.fillRect(0, FOOTER_Y, PANEL_W, 1)

    // 4-bit: 16 alpha levels, nothing in between.
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const px = frame.data
    for (let i = 3; i < px.length; i += 4) {
      px[i] = Math.round((px[i] / 255) * 15) * 17
    }
    ctx.putImageData(frame, 0, 0)
  }

  // ── Microphone ──
  //
  // The browser records for real and the audio goes to the same Groq endpoint
  // the G2 uses, so the whole voice path can be exercised without the
  // hardware. The G2's SDK hands over raw 16-bit PCM at 16kHz; asking the
  // AudioContext for that rate lets the same bytes reach the same server code.
  const MIC_RATE = 16000
  let micStream: MediaStream | null = null
  let micCtx: AudioContext | null = null
  let micNode: ScriptProcessorNode | null = null

  async function startMic(): Promise<boolean> {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
      micCtx = new AudioContext({ sampleRate: MIC_RATE })
      const source = micCtx.createMediaStreamSource(micStream)
      // ScriptProcessor is deprecated in favour of AudioWorklet, which needs a
      // separate module file and a build step to match. For a debug panel that
      // records a few seconds of speech, the deprecated node is the smaller
      // thing to carry.
      micNode = micCtx.createScriptProcessor(4096, 1, 1)
      micNode.addEventListener('audioprocess', (e) => {
        const samples = (e as AudioProcessingEvent).inputBuffer.getChannelData(0)
        const pcm = new Int16Array(samples.length)
        for (let i = 0; i < samples.length; i++) {
          const clamped = Math.max(-1, Math.min(1, samples[i]))
          pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
        }
        controller.onAudioData(new Uint8Array(pcm.buffer))
      })
      // Routed through a silent gain: the processor only runs while connected
      // to the destination, and nobody wants to hear themselves back.
      const mute = micCtx.createGain()
      mute.gain.value = 0
      source.connect(micNode)
      micNode.connect(mute)
      mute.connect(micCtx.destination)
      setVoiceStatus('録音中… マイクに向かって話してください')
      return true
    } catch (err) {
      setVoiceStatus(`マイクを使えません: ${err instanceof Error ? err.message : err}`)
      return false
    }
  }

  async function stopMic(): Promise<void> {
    micNode?.disconnect()
    micNode = null
    for (const track of micStream?.getTracks() ?? []) track.stop()
    micStream = null
    await micCtx?.close().catch(() => {})
    micCtx = null
  }

  const platform: GlassesPlatform = {
    render(state) {
      const raw = screenText(state)
      // The device's container wraps for it; this panel has to do it itself.
      const screen = { ...raw, body: wrapForPanel(raw.body) }
      lastScreen = screen
      drawPanel(screen)
      modeJp.textContent = MODE_LABEL[state.mode] ?? state.mode
      modeId.textContent = state.mode
      renderDiag(state)
    },
    startMicCapture: () => startMic(),
    stopMicCapture: () => stopMic(),
    // Typed text short-circuits the transcription, which is handy for driving
    // the confirm/send flow without speaking. Left empty, the recording is
    // sent to Groq exactly as the glasses would send it.
    transcribeAudio: async (pcm) => {
      const scripted = sttInput.value.trim()
      if (scripted) {
        setVoiceStatus(`STT欄の文字列を使用: ${scripted}`)
        return scripted
      }
      setVoiceStatus(`認識中… (${(pcm.length / 2 / MIC_RATE).toFixed(1)}秒の音声を送信)`)
      try {
        const text = await transcribe(pcm, MIC_RATE)
        setVoiceStatus(text ? `認識結果: ${text}` : '認識できませんでした')
        return text
      } catch (err) {
        setVoiceStatus(`認識に失敗: ${err instanceof Error ? err.message : err}`)
        return ''
      }
    },
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

  // ── Backdrop controls ──

  const bgFile = document.getElementById('bg-file') as HTMLInputElement
  const bgUrlInput = document.getElementById('bg-url') as HTMLInputElement

  /** Show a local file without persisting it: a blob URL is dead on reload. */
  function useLocalFile(file: File): void {
    if (!file.type.startsWith('image/')) {
      setBgStatus('画像ファイルではありません')
      return
    }
    applyBackdrop(URL.createObjectURL(file), false)
  }

  el('bg-pick').addEventListener('click', () => bgFile.click())
  bgFile.addEventListener('change', () => {
    const file = bgFile.files?.[0]
    if (file) useLocalFile(file)
    bgFile.value = ''
  })

  bgUrlInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const url = bgUrlInput.value.trim()
    if (url) applyBackdrop(url, true)
  })

  el('bg-reset').addEventListener('click', () => {
    try { localStorage.removeItem(BG_KEY) } catch { /* private mode */ }
    bgUrlInput.value = ''
    applyBackdrop(DEFAULT_BG, false)
  })

  // Drop anywhere on the page — hunting for a small target is the sort of
  // friction that made the query parameter annoying in the first place.
  for (const type of ['dragenter', 'dragover']) {
    window.addEventListener(type, (e) => {
      e.preventDefault()
      document.body.classList.add('dropping')
    })
  }
  for (const type of ['dragleave', 'drop']) {
    window.addEventListener(type, () => document.body.classList.remove('dropping'))
  }
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    const dropped = e as DragEvent
    const file = dropped.dataTransfer?.files?.[0]
    if (file) {
      useLocalFile(file)
      return
    }
    const url = dropped.dataTransfer?.getData('text/uri-list') || dropped.dataTransfer?.getData('text/plain')
    if (url?.trim()) applyBackdrop(url.trim(), true)
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
