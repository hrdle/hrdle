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
import { BAR_H, LINE_H, PANEL_H, PANEL_W, advance } from './metrics.ts'
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

  /* A live room behind the type sells a see-through display in a way a still
     photo cannot. Sits inside .scene so the same dimming pass covers it. */
  .cam { position: absolute; inset: -3%; width: 106%; height: 106%;
         object-fit: cover; display: none;
         /* Out of focus, because the eye is focused on the near display and
            not on the room. The drawn fallback has always been blurred for
            this reason; the live feed should match. Overscanned so the blur
            has pixels to sample at the edge instead of fading to nothing. */
         filter: blur(2.5px) saturate(.92); }
  .lens.cam-on .cam { display: block; }
  .lens.cam-on .room, .lens.cam-on .figure { display: none; }

  /* The glass the panel is projected onto. Everything here is presentation and
     lives strictly above the canvas — the canvas is the faithful 4-bit render,
     and mixing effects into it would undo the point of drawing it that way.
     Toggleable for exactly that reason. */
  .glass { position: absolute; inset: 0; pointer-events: none; display: none; }
  .lens.glassy .glass { display: block; }
  /* Additive, like the real optics: the display adds light to the room, it
     never paints black onto it. */
  .lens.glassy .hud-canvas { mix-blend-mode: screen; }
  /* Light catching the lens on the diagonal. */
  .glass::before { content: ''; position: absolute; inset: -20%;
                   transform: rotate(-8deg);
                   background: linear-gradient(103deg,
                     transparent 0 26%,
                     rgba(214,255,229,.07) 35%,
                     rgba(220,255,234,.17) 44%,
                     rgba(214,255,229,.06) 53%,
                     transparent 62%); }
  /* Brightness falls off toward the edge of a waveguide, and the lens rim
     shades the corners. */
  .glass::after { content: ''; position: absolute; inset: 0;
                  background:
                    /* Light leaking in along the top of the combiner. */
                    linear-gradient(180deg, rgba(196,255,214,.10), transparent 22%),
                    radial-gradient(118% 96% at 50% 44%,
                      transparent 44%, rgba(2,7,5,.40) 100%);
                  box-shadow: inset 0 0 34px rgba(2,10,6,.6); }

  /* Fullscreen, for recording a demo.
     The real display occupies the middle of the field of view, not all of it,
     so the backdrop takes the whole viewport and the projected panel sits
     centred and small inside it. --fs-scale is the fit-to-viewport factor,
     already reduced, computed in JS because CSS cannot min() two ratios. */
  .lens.fs { width: 100vw; height: 100vh; border-radius: 0;
             transform: none !important; }
  .lens.fs .hud-canvas, .lens.fs .glass {
    inset: auto; left: 50%; top: 50%;
    width: calc(576px * var(--fs-scale, 1));
    height: calc(288px * var(--fs-scale, 1));
    transform: translate(-50%, -50%); }
  /* The room needs less holding back here: the type covers a fraction of the
     frame, so the contrast fight it was dimmed for barely happens. */
  .lens.fs .scene::after {
    background: linear-gradient(180deg, rgba(4,8,6,.24), rgba(4,8,6,.32)); }

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
  .mirror { display: inline-flex; align-items: center; gap: 5px; font-size: 13px;
            color: #cbd5e1; cursor: pointer; user-select: none; }
  .mirror input { accent-color: #6affa0; }
  .mirror-live { color: #6affa0; }
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
        <span class="sub">実機と同じ描画（576×288 / 7行・幅は実測px）</span>
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
                <video class="cam" id="g2-cam" autoplay muted playsinline disablePictureInPicture></video>
              </div>
              <canvas class="hud-canvas" id="g2-canvas" width="576" height="288"></canvas>
              <div class="glass"></div>
            </div>
          </div>
          <div class="lens-meta">
            <span class="mode-pill" id="g2-mode-jp">一覧</span>
            <span class="mode-id" id="g2-mode-id">session_list</span>
            <button type="button" id="g2-copy">画面をコピー</button>
            <button type="button" id="g2-fs">全画面</button>
            <button type="button" id="g2-pip">小窓</button>
            <video id="g2-pip-video" muted playsinline hidden></video>
            <label class="mirror"><input type="checkbox" id="g2-mirror" />実機ミラー</label>
            <span class="hint" id="g2-mirror-status"></span>
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
            <button type="button" id="bg-cam">カメラ</button>
            <button type="button" id="bg-reset">既定に戻す</button>
            <label class="mirror"><input type="checkbox" id="g2-glassy" checked />映り込み</label>
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
  // Panel size comes from metrics.ts — one place holds the hardware numbers.
  /** How much of the fitted size the panel actually takes in fullscreen.
   *  Looking through the G2, the display sits in the middle of the field of
   *  view rather than filling it; edge to edge would be the wrong picture. */
  const FS_PANEL_FRACTION = 0.8

  function fitPanel(): void {
    const box = document.getElementById('lens-fit')
    const lens = document.getElementById('lens')
    if (!box || !lens) return
    if (document.fullscreenElement === lens) {
      // The backdrop owns the viewport; only the projected panel is scaled,
      // and CSS does that from --fs-scale.
      const scale = Math.min(window.innerWidth / PANEL_W, window.innerHeight / PANEL_H)
      lens.style.setProperty('--fs-scale', String(scale * FS_PANEL_FRACTION))
      return
    }
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

  /** The decoded backdrop, kept for the PiP compositor, which draws its own
   *  layers and cannot read a CSS background. Null until the first load, and
   *  tainted images simply do not composite (captureStream would throw). */
  let backdropImage: HTMLImageElement | null = null

  /** Swap the backdrop, but only once the image has actually decoded — a
   *  missing file would otherwise leave nothing at all behind the text. */
  function applyBackdrop(url: string, remember: boolean): void {
    const probe = new Image()
    probe.crossOrigin = 'anonymous'
    probe.addEventListener('load', () => {
      backdropImage = probe
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

  const mirrorToggle = document.getElementById('g2-mirror') as HTMLInputElement
  const mirrorStatus = el('g2-mirror-status')

  let lastScreen = { header: '', body: '', footer: '' }
  let lastMode = 'session_list'

  // ── Device mirror (demo) ──
  //
  // The device publishes the three strings it just drew; this panel paints
  // them with the same painter it uses for its own state. What the audience
  // sees is the wearer's screen, not a second interpretation of it.
  let mirroring = false
  let localScreen = { header: '', body: '', footer: '' }
  let localMode = 'session_list'

  function paint(screen: { header: string; body: string; footer: string }, mode: string): void {
    lastScreen = screen
    lastMode = mode
    drawPanel(screen)
    modeJp.textContent = MODE_LABEL[mode] ?? mode
    modeId.textContent = mode
  }

  // Panel geometry, straight from the container definitions in display.ts.
  // Text starts below the container's own padding, and LVGL stacks lines at a
  // fixed 27px — drawing them 28px apart put the last of seven a full line's
  // eighth out of place.
  const HEADER_PAD = 4
  const BODY_PAD = 6
  /** Baseline within a 27px line box, for the font this canvas draws with. */
  const BASELINE = 21
  const HEADER_BASE = HEADER_PAD + BASELINE
  const BODY_TOP = BAR_H + BODY_PAD + BASELINE
  const FOOTER_BASE = PANEL_H - BAR_H + HEADER_PAD + BASELINE
  // Proportional, not monospace: the G2 font is proportional (a space is 5px,
  // `i` is 4, `W` is 16) and drawing into those cells with a monospace face
  // meant squeezing almost every ASCII glyph. A plain sans lands within about
  // 1px of the firmware's advances instead of 4.
  const FONT = '19px system-ui, "Noto Sans", "DejaVu Sans", sans-serif'
  // The panel's phosphor green, bright enough to hold against a lit room.
  // The panel's phosphor green. Pulled toward pure green — the G2 is a
  // monochrome green display and the paler mint read as a generic HUD.
  const GREEN = '76, 255, 100'

  /** Draw one screen at the hardware's real pixel count, then crush it to the
   *  panel's 16 levels of green. Anti-aliasing finer than 4 bits is exactly
   *  what the wearer does not get. */
  // Every glyph lands where the firmware puts it.
  //
  // Letting the browser lay out a whole string drifts badly: the G2 font is
  // proportional (a space is 5px, `i` is 4, `W` is 16) and no browser
  // monospace comes close, so a right-aligned clock ended up near the middle
  // of the panel. Advancing by the firmware's own per-character widths —
  // kerning included — is the only way this window earns the phrase "実機と
  // 同じ描画" in its own subtitle.
  function drawRow(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
    let dx = 0
    let prev = ''
    for (const ch of text) {
      const cell = advance(prev, ch)
      const natural = ctx.measureText(ch).width
      if (natural > cell + 0.5) {
        // The browser's glyph is wider than the cell the firmware gives it —
        // an emoji, a box-drawing rune. Squeeze it in rather than let it run
        // over its neighbour, which is also what the reader needs to know.
        ctx.save()
        ctx.translate(x + dx, y)
        ctx.scale(cell / natural, 1)
        ctx.fillText(ch, 0, 0)
        ctx.restore()
      } else {
        ctx.fillText(ch, x + dx, y)
      }
      dx += cell
      prev = ch
    }
  }

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
    drawRow(ctx, screen.header, HEADER_PAD, HEADER_BASE)

    for (const [i, line] of screen.body.split('\n').entries()) {
      drawRow(ctx, line, 4 + BODY_PAD, BODY_TOP + i * LINE_H)
    }

    ctx.fillStyle = `rgba(${GREEN}, 0.78)`
    drawRow(ctx, screen.footer, HEADER_PAD, FOOTER_BASE)

    // No rules between the zones: the containers carry borderWidth 0, so the
    // panel has nothing there and neither should this.
    ctx.shadowBlur = 0

    // 4-bit: 16 alpha levels, nothing in between.
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const px = frame.data
    for (let i = 3; i < px.length; i += 4) {
      px[i] = Math.round((px[i] / 255) * 15) * 17
    }
    ctx.putImageData(frame, 0, 0)

    // The little window is a copy of this one; keep it in step.
    pumpPip()
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
      localScreen = screen
      localMode = state.mode
      renderDiag(state)
      // While mirroring the device owns the panel; this connection's own
      // state keeps running underneath so switching back is instant.
      if (!mirroring) paint(screen, state.mode)
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
      `[${MODE_LABEL[lastMode] ?? lastMode} / ${lastMode}]${mirroring ? ' 実機ミラー' : ''}`,
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
    stopCam()
    applyBackdrop(DEFAULT_BG, false)
  })

  // ── Camera backdrop ──

  const lensEl = el('lens')
  const camEl = document.getElementById('g2-cam') as HTMLVideoElement
  const camBtn = el('bg-cam')
  let camStream: MediaStream | null = null

  function stopCam(): void {
    // Release the device, not just the element: a camera left running keeps
    // the indicator light on and the hardware busy for everything else.
    for (const track of camStream?.getTracks() ?? []) track.stop()
    camStream = null
    camEl.srcObject = null
    lensEl.classList.remove('cam-on')
    camBtn.textContent = 'カメラ'
  }

  async function startCam(): Promise<void> {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        // The rear camera is the one pointing at what the wearer would see.
        video: { facingMode: 'environment', width: { ideal: 1280 } },
      })
      camEl.srcObject = camStream
      lensEl.classList.add('cam-on')
      camBtn.textContent = 'カメラを止める'
      setBgStatus('')
      startCameraPump()
    } catch {
      setBgStatus('カメラを開けませんでした（権限とHTTPSを確認）')
    }
  }

  camBtn.addEventListener('click', () => {
    if (camStream) stopCam()
    else void startCam()
  })

  // ── Fullscreen ──
  //
  // For recording: no page chrome, the room across the whole frame, and the
  // panel where the wearer actually sees it.

  el('g2-fs').addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void lensEl.requestFullscreen().catch(() => setBgStatus('全画面にできませんでした'))
  })

  document.addEventListener('fullscreenchange', () => {
    const on = document.fullscreenElement === lensEl
    lensEl.classList.toggle('fs', on)
    if (!on) lensEl.style.removeProperty('--fs-scale')
    el('g2-fs').textContent = on ? '全画面を終了' : '全画面'
    fitPanel()
  })
  window.addEventListener('resize', fitPanel)

  // ── Picture-in-picture ──
  //
  // A PiP window carries exactly one video and nothing else: the earlier
  // attempt put the bare camera feed in the little window, with none of the
  // display in it, because the canvas and the CSS layers above the <video>
  // never travel. So everything is composited into one canvas here — the same
  // layers, drawn instead of stacked — and that canvas becomes the video.
  //
  // Worth the work because it is the demo: the terminal on the phone and what
  // the glasses make of it, side by side.

  const PIP_SCALE = 2 // panel pixels are coarse; upscale before PiP resamples
  /** Clearance for the window's own rounded corners, which were cutting the
   *  ends off lines that run to the edge of the panel. */
  const PIP_PANEL_FRACTION = 0.92
  const pipCanvas = document.createElement('canvas')
  pipCanvas.width = PANEL_W * PIP_SCALE
  pipCanvas.height = PANEL_H * PIP_SCALE
  const pipVideo = document.getElementById('g2-pip-video') as HTMLVideoElement
  let pipStream: MediaStream | null = null
  let pipTimer: ReturnType<typeof setInterval> | null = null
  let pipRvfc: number | null = null

  const pipActive = (): boolean => document.pictureInPictureElement === pipVideo

  /** Cover-fit a source into the composite, the way object-fit: cover would. */
  function drawCover(
    ctx: CanvasRenderingContext2D,
    src: CanvasImageSource,
    sw: number,
    sh: number,
  ): void {
    if (!sw || !sh) return
    const scale = Math.max(pipCanvas.width / sw, pipCanvas.height / sh)
    const w = sw * scale
    const h = sh * scale
    ctx.drawImage(src, (pipCanvas.width - w) / 2, (pipCanvas.height - h) / 2, w, h)
  }

  function compositePip(): void {
    const ctx = pipCanvas.getContext('2d')
    if (!ctx) return
    const { width: W, height: H } = pipCanvas

    // 1. The room, out of focus, as on the page.
    ctx.save()
    ctx.filter = `blur(${2.5 * PIP_SCALE}px) saturate(.92)`
    if (camStream && camEl.videoWidth) {
      drawCover(ctx, camEl, camEl.videoWidth, camEl.videoHeight)
    } else if (backdropImage?.complete && backdropImage.naturalWidth) {
      drawCover(ctx, backdropImage, backdropImage.naturalWidth, backdropImage.naturalHeight)
    } else {
      ctx.fillStyle = '#1a2028'
      ctx.fillRect(0, 0, W, H)
    }
    ctx.restore()

    // 2. Held back so the green reads against a lit room.
    ctx.fillStyle = 'rgba(4, 8, 6, 0.44)'
    ctx.fillRect(0, 0, W, H)

    // 3. The panel itself, kept blocky — resampling it smooth would flatter
    //    the hardware into something the wearer never sees. Held in from the
    //    frame because the little window has rounded corners of its own and
    //    was clipping the ends of lines that run to the edge.
    const pw = W * PIP_PANEL_FRACTION
    const ph = H * PIP_PANEL_FRACTION
    ctx.save()
    if (glassyToggle.checked) ctx.globalCompositeOperation = 'screen'
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(canvas, (W - pw) / 2, (H - ph) / 2, pw, ph)
    ctx.restore()

    if (!glassyToggle.checked) return

    // 4. The glass: a diagonal catch of light, a leak along the top of the
    //    combiner, and the falloff toward its edge.
    const sheen = ctx.createLinearGradient(0, H, W * 0.95, 0)
    sheen.addColorStop(0.26, 'rgba(214,255,229,0)')
    sheen.addColorStop(0.35, 'rgba(214,255,229,.07)')
    sheen.addColorStop(0.44, 'rgba(220,255,234,.17)')
    sheen.addColorStop(0.53, 'rgba(214,255,229,.06)')
    sheen.addColorStop(0.62, 'rgba(214,255,229,0)')
    ctx.fillStyle = sheen
    ctx.fillRect(0, 0, W, H)

    const leak = ctx.createLinearGradient(0, 0, 0, H * 0.22)
    leak.addColorStop(0, 'rgba(196,255,214,.10)')
    leak.addColorStop(1, 'rgba(196,255,214,0)')
    ctx.fillStyle = leak
    ctx.fillRect(0, 0, W, H * 0.22)

    const vignette = ctx.createRadialGradient(
      W / 2, H * 0.44, Math.min(W, H) * 0.2,
      W / 2, H * 0.44, Math.max(W, H) * 0.62,
    )
    vignette.addColorStop(0, 'rgba(2,7,5,0)')
    vignette.addColorStop(1, 'rgba(2,7,5,.40)')
    ctx.fillStyle = vignette
    ctx.fillRect(0, 0, W, H)
  }

  /** Redraw the little window. Called after every panel render, and on a timer
   *  while the camera is live — requestAnimationFrame stops firing once the
   *  page is hidden, which is precisely when PiP is being watched. */
  function pumpPip(): void {
    if (pipActive()) compositePip()
  }

  function startPipPump(): void {
    if (!pipTimer) pipTimer = setInterval(pumpPip, 200)
    startCameraPump()
  }

  /** Timers are clamped to a second once the page is hidden, which is exactly
   *  when the little window is being watched — fine for a panel that changes
   *  every five seconds, not for a live room. A video frame callback rides the
   *  media pipeline instead and is not clamped. */
  function startCameraPump(): void {
    if (pipRvfc !== null || !camStream || !pipActive()) return
    if (!('requestVideoFrameCallback' in camEl)) return
    pipRvfc = camEl.requestVideoFrameCallback(() => {
      pipRvfc = null
      if (!pipActive()) return
      compositePip()
      startCameraPump()
    })
  }

  function stopPipPump(): void {
    if (pipTimer) {
      clearInterval(pipTimer)
      pipTimer = null
    }
    if (pipRvfc !== null) {
      camEl.cancelVideoFrameCallback?.(pipRvfc)
      pipRvfc = null
    }
  }

  async function enterPip(): Promise<void> {
    try {
      compositePip()
      if (!pipStream) {
        pipStream = pipCanvas.captureStream(15)
        pipVideo.srcObject = pipStream
      }
      await pipVideo.play()
      await pipVideo.requestPictureInPicture()
      startPipPump()
    } catch {
      setBgStatus('小窓にできませんでした（対応していないブラウザかもしれません）')
    }
  }

  el('g2-pip').addEventListener('click', () => {
    if (pipActive()) void document.exitPictureInPicture()
    else void enterPip()
  })

  pipVideo.addEventListener('enterpictureinpicture', () => {
    el('g2-pip').textContent = '小窓を閉じる'
  })
  pipVideo.addEventListener('leavepictureinpicture', () => {
    el('g2-pip').textContent = '小窓'
    stopPipPump()
  })

  // ── Lens reflection ──
  //
  // Presentation only, and separable on purpose: reading the panel for
  // fidelity wants the bare canvas, showing it to people wants the glass.

  const GLASS_KEY = 'cchub-glasses-glassy'
  const glassyToggle = document.getElementById('g2-glassy') as HTMLInputElement
  try {
    if (localStorage.getItem(GLASS_KEY) === 'off') glassyToggle.checked = false
  } catch { /* private mode */ }

  function applyGlassy(): void {
    lensEl.classList.toggle('glassy', glassyToggle.checked)
  }
  glassyToggle.addEventListener('change', () => {
    applyGlassy()
    try { localStorage.setItem(GLASS_KEY, glassyToggle.checked ? 'on' : 'off') } catch { /* private mode */ }
  })
  applyGlassy()

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
  // ── Mirror wiring ──

  const RING_BUTTONS = ['btn-up', 'btn-down', 'btn-tap', 'btn-dbl']

  function setMirrorUi(live: boolean, message: string): void {
    mirrorStatus.textContent = message
    mirrorStatus.className = live ? 'hint mirror-live' : 'hint'
    // A viewer clicking the ring while the device drives the panel would fight
    // the wearer for the screen. Mirroring is for watching.
    for (const id of RING_BUTTONS) (el(id) as HTMLButtonElement).disabled = mirroring
  }

  controller.ws.setGlassesScreenHandler((screen) => {
    if (!mirroring) return
    if (!screen) {
      // The publisher's socket closed. Say so — a mirror still showing the
      // last frame is indistinguishable from a live one that has gone quiet.
      setMirrorUi(false, '実機が接続されていません')
      return
    }
    paint({ header: screen.header, body: wrapForPanel(screen.body), footer: screen.footer }, screen.mode)
    setMirrorUi(true, '実機と同期中')
  })

  mirrorToggle.addEventListener('change', () => {
    mirroring = mirrorToggle.checked
    if (mirroring) {
      controller.ws.subscribeGlassesScreen()
      setMirrorUi(false, '実機を待っています…')
    } else {
      controller.ws.unsubscribeGlassesScreen()
      setMirrorUi(false, '')
      paint(localScreen, localMode)
    }
  })

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
