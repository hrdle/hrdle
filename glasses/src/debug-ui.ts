// Browser simulator — runs when the Even Hub SDK is absent, so the glasses UI
// can be driven from a browser with no G2 on your face (vite dev on 8391, or
// served by the server itself at /glasses).
//
// It consumes the SAME GlassesController as the real G2 path AND draws through
// the same `updateDisplay()` the device draws through: this file supplies a
// bridge that records containers instead of sending them to a host, and the
// canvas paints what that bridge is holding. So the rebuild-vs-upgrade
// decision, the skip-if-unchanged record, which container id a string is
// addressed to, and every container's own geometry are decided once, in
// `display.ts`, for the device and for this window alike.
//
// That is the point. It used to lay the screen out here from `screenText()` —
// same strings, second implementation of where they go — and every divergence
// that has cost real debugging time was of that shape: a border 36px from
// where the device puts it, a page repeating its previous line on the device
// only. Copying the screen quotes the containers, so it says what the panel is
// holding rather than what it ought to be.
//
// Mic/STT are faked: the "STT result" textbox injects what the Groq
// transcription would have returned.

import { setBaseUrl, transcribe } from './api.ts'
import { settingsPanelHtml, wireSettingsPanel } from './settings-ui.ts'
import { GlassesController } from './controller.ts'
import type { GlassesPlatform } from './controller.ts'
import {
  NOTICE_BORDER,
  NOTICE_BORDER_COLOR,
  NOTICE_PAD,
  noticeHeight,
  screenText,
  updateDisplay,
  updateHeader,
  wrapForPanel,
} from './display.ts'
import {
  BAR_H,
  CARD_BORDER,
  CARD_BORDER_COLOR,
  CARD_RADIUS,
  LINE_H,
  PANEL_H,
  PANEL_W,
  advance,
  cardBox,
  splitLines,
  textWidth,
} from './metrics.ts'
import { clearStoredSync, readStoredSync, writeStoredSync } from './storage.ts'
import type { AppState } from './display.ts'

/** Screen names — the shared vocabulary used when reporting issues. */
const MODE_LABEL: Record<string, string> = {
  session_list: 'List',
  conversation: 'Conversation',
  overlay: 'Interrupt',
  choice: 'Choice',
  voice: 'Voice',
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
  /* Held upright, the phone gives a 576x288 panel its short edge to live on,
     and the fit lands on that edge: a third of the width the screen has. So
     the view turns a quarter instead - room, panel and all, because the room is
     what is being looked through and a level room under a tilted panel is not a
     picture of anything. Turning the phone to match brings it upright, which is
     the way this is meant to be held.

     Turned on the children, not on .lens itself: the fullscreen element sits
     in the top layer, where the UA stylesheet pins transform:none !important
     and an author !important does not outrank it. Measured before it was
     believed - the class landed, the rule matched, and the computed transform
     came back none. */
  .lens.fs.turned .scene {
    inset: auto; left: 50%; top: 50%;
    width: 100vh; height: 100vw;
    transform: translate(-50%, -50%) rotate(90deg); }
  .lens.fs.turned .hud-canvas, .lens.fs.turned .glass {
    transform: translate(-50%, -50%) rotate(90deg); }
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
  // `?hub=` points the simulator at another server; default is same-origin,
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
  const BG_SUFFIX = 'glasses-bg'
  const savedBg = readStoredSync(BG_SUFFIX)
  const bgUrl = params.get('bg') ?? savedBg ?? DEFAULT_BG

  document.title = `${__PRODUCT_NAME__} - simulator`
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)

  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <div class="sim-wrap">
      <div class="sim-title">
        <h1>${__PRODUCT_NAME__} simulator</h1>
        <span class="sub">Draws exactly what the device draws (576x288 / 7 rows, widths measured in px)</span>
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
            <span class="mode-pill" id="g2-mode-jp">List</span>
            <span class="mode-id" id="g2-mode-id">session_list</span>
            <button type="button" id="g2-copy">Copy screen</button>
            <button type="button" id="g2-png">Save PNG</button>
            <button type="button" id="g2-fs">Fullscreen</button>
            <button type="button" id="g2-pip">Picture-in-picture</button>
            <video id="g2-pip-video" muted playsinline hidden></video>
            <label class="mirror"><input type="checkbox" id="g2-mirror" />Mirror the device</label>
            <span class="hint" id="g2-mirror-status"></span>
            <span class="hint" id="g2-copied"></span>
          </div>
          <div class="diag" id="g2-diag"></div>
          <div class="diag" id="g2-relay"></div>
        </div>

        <div class="panel">
          <h2>Ring controls</h2>
          <div class="ring">
            <button type="button" id="btn-up">Swipe up</button>
            <button type="button" id="btn-down">Swipe down</button>
            <button type="button" id="btn-tap">Tap</button>
            <button type="button" id="btn-dbl">Double tap</button>
          </div>
          <h2>Host lifecycle</h2>
          <div class="ring">
            <button type="button" id="btn-fg-exit">Foreground exit</button>
            <button type="button" id="btn-fg-enter">Foreground enter</button>
            <button type="button" id="btn-host-exit">Host exit</button>
            <button type="button" id="btn-superseded">Superseded</button>
            <button type="button" id="btn-gave-up">Server unreachable</button>
          </div>
          <p class="hint" id="lifecycle-status">On the device these arrive from the host. A host exit releases the socket, the clocks and the microphone for good — the diagnostics line above says <code>stopped</code> once it has, and nothing draws after that.</p>
          <h2>Voice input</h2>
          <input type="text" id="dbg-stt" placeholder="Text to use instead of STT (optional)" />
          <p class="hint" id="voice-status">Tap on the conversation screen to start recording, tap again to send it to Groq. With text in the field it skips recording and uses that as the transcript.</p>
          ${settingsPanelHtml()}

          <h2>Background</h2>
          <div class="bg-row">
            <button type="button" id="bg-pick">Pick an image</button>
            <button type="button" id="bg-cam">Camera</button>
            <button type="button" id="bg-reset">Reset</button>
            <label class="mirror"><input type="checkbox" id="g2-glassy" checked />Reflection</label>
          </div>
          <input type="file" id="bg-file" accept="image/*" hidden />
          <input type="text" id="bg-url" placeholder="Paste an image URL (Enter)" />
          <p class="hint" id="bg-status">You can also drag and drop onto the screen to replace it.</p>
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
      // A phone held upright offers its short edge to a panel twice as wide as
      // it is tall, and `min` obediently fits to that edge. Turning the view a
      // quarter puts the panel along the long axis instead, which is most of
      // the difference between reading it and squinting at it.
      const turned = window.innerHeight > window.innerWidth
      lens.classList.toggle('turned', turned)
      // The axes the panel is fitted against are the turned ones, since that is
      // what it will be laid along.
      const across = turned ? window.innerHeight : window.innerWidth
      const down = turned ? window.innerWidth : window.innerHeight
      // The backdrop owns the viewport; only the projected panel is scaled,
      // and CSS does that from --fs-scale.
      const scale = Math.min(across / PANEL_W, down / PANEL_H)
      lens.style.setProperty('--fs-scale', String(scale * FS_PANEL_FRACTION))
      return
    }
    lens.classList.remove('turned')
    const scale = Math.min(1, box.clientWidth / PANEL_W)
    lens.style.transform = `scale(${scale})`
    box.style.height = `${PANEL_H * scale}px`
  }
  new ResizeObserver(fitPanel).observe(document.body)
  fitPanel()

  const DEFAULT_BG_HINT = 'You can also drag and drop onto the screen to replace it.'
  function setBgStatus(message: string): void {
    const node = document.getElementById('bg-status')
    if (node) node.textContent = message || DEFAULT_BG_HINT
  }

  const DEFAULT_VOICE_HINT =
    'Tap on the conversation screen to start recording, tap again to send it to Groq. With text in the field it skips recording and uses that as the transcript.'
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
        writeStoredSync(BG_SUFFIX, url)
      }
      setBgStatus('')
    })
    probe.addEventListener('error', () => setBgStatus('Could not load the image'))
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

  // `notice` belongs here as much as the other three: the copy button is how a
  // screen gets reported, and one that silently drops the recap reports a
  // panel nobody is looking at.
  let lastScreen: { header: string; body: string; footer: string; notice?: string; headerless?: boolean } = {
    header: '', body: '', footer: '',
  }
  let lastMode = 'session_list'

  /**
   * A container as the panel is holding it.
   *
   * Geometry included, and taken from what `updateDisplay` actually sent rather
   * than recomputed here. This window used to lay the screen out itself from
   * `screenText` — same strings, second implementation of where they go — and
   * every constant it kept (the notice strip's top, the card's border, the
   * body's first baseline) was a copy of one in `display.ts` that could drift
   * without either side noticing. The four divergences found on 2026-07-27/28
   * were all of that shape.
   */
  type PanelContainer = {
    id: number
    name: string
    x: number
    y: number
    w: number
    h: number
    pad: number
    border: number
    borderColor: number
    radius: number
    content: string
  }
  let panel: PanelContainer[] = []

  /**
   * The host, as far as `updateDisplay` can tell.
   *
   * The point is not that it records the containers — it is that the simulator
   * now goes through the same path the device does. Skip-if-unchanged, the
   * rebuild-vs-upgrade decision, and which container id a string is addressed
   * to are all decided in `display.ts` for both of us now. A stale upgrade or
   * an id that means the list on one screen and the header on another shows up
   * here, on a desk, rather than only on someone's face.
   */
  const panelBridge = {
    rebuildPageContainer(container: { textObject?: unknown[] }): boolean {
      const objects = (container.textObject ?? []) as Array<Record<string, unknown>>
      panel = objects.map((t) => ({
        id: (t.containerID as number) ?? 0,
        name: (t.containerName as string) ?? '',
        x: (t.xPosition as number) ?? 0,
        y: (t.yPosition as number) ?? 0,
        w: (t.width as number) ?? PANEL_W,
        h: (t.height as number) ?? LINE_H,
        pad: (t.paddingLength as number) ?? 0,
        border: (t.borderWidth as number) ?? 0,
        borderColor: (t.borderColor as number) ?? CARD_BORDER_COLOR,
        radius: (t.borderRadius as number) ?? 0,
        content: (t.content as string) ?? '',
      }))
      return true
    },
    textContainerUpgrade(up: { containerID?: number; content?: string }): boolean {
      const target = panel.find((c) => c.id === up.containerID)
      // A miss is not silently ignored: an upgrade addressed to a container
      // this page does not have is the id bug this simulator exists to catch.
      if (!target) {
        setVoiceStatus(`upgrade addressed container ${up.containerID}, which this page does not have`)
        return true
      }
      target.content = up.content ?? ''
      return true
    },
  }

  // ── Device mirror (demo) ──
  //
  // The device publishes the three strings it just drew; this panel paints
  // them with the same painter it uses for its own state. What the audience
  // sees is the wearer's screen, not a second interpretation of it.
  //
  // This one stays on the `screenText` path: it is handed three strings off the
  // wire with no state behind them, so there is no `updateDisplay` to run and
  // nothing to be faithful to beyond the text itself.
  let mirroring = false
  let localScreen: { header: string; body: string; footer: string; notice?: string; headerless?: boolean } = { header: '', body: '', footer: '' }
  let localMode = 'session_list'

  function paint(
    screen: { header: string; body: string; footer: string; notice?: string; headerless?: boolean },
    mode: string,
  ): void {
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
  // kerning included - is the only way this window earns the phrase "draws
  // exactly what the device draws" in its own subtitle.
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

  /**
   * Draw what the panel is holding, container by container.
   *
   * Everything positional comes off the container: where it starts, how wide it
   * is, how much padding it keeps, whether it draws a border. Nothing is
   * recomputed from the mode, so a screen whose geometry changes in
   * `display.ts` moves here without this file being touched.
   *
   * Two things LVGL does that have to be done here as well, or the window stops
   * earning its subtitle:
   *
   * - **Wrapping happens inside the container**, at its inner width, not at a
   *   panel-wide constant. A container narrower than the body wraps sooner, and
   *   pre-wrapping to `BODY_WIDTH` would have hidden that.
   * - **A container clips what it cannot fit.** Text past its height is not
   *   drawn — it does not spill onto the container below. A page that overflows
   *   silently loses its last line on the device, and it now does so here.
   */
  function drawContainers(ctx: CanvasRenderingContext2D): void {
    for (const c of panel) {
      if (c.border > 0) {
        ctx.strokeStyle = `rgba(${GREEN}, ${c.borderColor / 15})`
        ctx.lineWidth = c.border
        ctx.beginPath()
        ctx.roundRect(c.x + c.border / 2, c.y + c.border / 2, c.w - c.border, c.h - c.border, c.radius)
        ctx.stroke()
      }
      // The footer is the one thing drawn dimmer than the rest — it carries the
      // gestures and the clock, which are reference rather than content.
      ctx.fillStyle = c.name === 'footer' ? `rgba(${GREEN}, 0.78)` : `rgb(${GREEN})`
      const inset = c.border + c.pad
      const innerW = c.w - 2 * inset
      const lines = c.content
        .split('\n')
        .flatMap((line) => (textWidth(line) <= innerW ? [line] : splitLines(line, innerW)))
      const room = Math.floor((c.h - 2 * inset) / LINE_H)
      for (const [i, line] of lines.slice(0, Math.max(0, room)).entries()) {
        drawRow(ctx, line, c.x + inset, c.y + inset + BASELINE + i * LINE_H)
      }
    }
  }

  function beginFrame(): CanvasRenderingContext2D | null {
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.font = FONT
    ctx.textBaseline = 'alphabetic'
    // Optics bloom a little; keep it subtle or quantising turns it to mud.
    ctx.shadowColor = `rgba(${GREEN}, 0.55)`
    ctx.shadowBlur = 6
    ctx.fillStyle = `rgb(${GREEN})`
    return ctx
  }

  function endFrame(ctx: CanvasRenderingContext2D): void {
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

  /** This simulator's own screen: whatever `updateDisplay` left in the panel. */
  function paintPanel(): void {
    const ctx = beginFrame()
    if (!ctx) return
    drawContainers(ctx)
    endFrame(ctx)
  }

  /**
   * The mirrored device screen, laid out from three strings.
   *
   * Kept on its own path because that is all a mirror is given — text off the
   * wire, with no state behind it to run `updateDisplay` against. It is the one
   * place this file still positions anything itself, and it is not claiming to
   * show where the device put things, only what it said.
   */
  function drawPanel(screen: { header: string; body: string; footer: string; notice?: string; headerless?: boolean; card?: boolean }): void {
    const ctx = beginFrame()
    if (!ctx) return

    if (!screen.headerless) drawRow(ctx, screen.header, HEADER_PAD, HEADER_BASE)

    // The notice strip is its own container on the device, with a drawn border
    // where a row of dashes used to be. Its height decides where the
    // conversation starts, so this has to match the device's arithmetic or the
    // window stops being worth the phrase in its own subtitle.
    const noticeLines = screen.notice ? screen.notice.split('\n') : []
    const nHeight = noticeHeight(noticeLines.length)
    // Without a header container there is no bar for the strip to sit under, so
    // it starts at the top of the panel - the same place `buildSessionList` puts
    // it. A strip drawn 36px lower than the device draws it is the kind of
    // divergence this simulator exists to make visible, not to introduce.
    const noticeTop = screen.headerless ? 0 : BAR_H
    for (const [i, line] of noticeLines.entries()) {
      drawRow(ctx, line, 4 + NOTICE_PAD + NOTICE_BORDER, noticeTop + NOTICE_PAD + NOTICE_BORDER + BASELINE + i * LINE_H)
    }
    if (nHeight > 0) {
      // The list's strip is a notification and is drawn to be noticed; the
      // conversation's is a recap, and its rule only has to separate.
      const level = screen.headerless ? CARD_BORDER_COLOR : NOTICE_BORDER_COLOR
      ctx.strokeStyle = `rgba(${GREEN}, ${level / 15})`
      ctx.lineWidth = NOTICE_BORDER
      ctx.beginPath()
      ctx.roundRect(
        4 + NOTICE_BORDER / 2,
        noticeTop + NOTICE_BORDER / 2,
        PANEL_W - 8 - NOTICE_BORDER,
        nHeight - NOTICE_BORDER,
        screen.headerless ? CARD_RADIUS : 0,
      )
      ctx.stroke()
      ctx.fillStyle = `rgb(${GREEN})`
    }

    if (screen.card) {
      // A notification is a box laid over the panel, not another screen filling
      // it. Drawn here at the same geometry `buildOverlay` gives the device -
      // getting this wrong would put the simulator's border somewhere the G2's
      // is not, which is the exact class of divergence that keeps turning up.
      const lines = screen.body.split('\n')
      const box = cardBox(lines.length)
      ctx.strokeStyle = `rgba(${GREEN}, ${CARD_BORDER_COLOR / 15})`
      ctx.lineWidth = CARD_BORDER
      ctx.beginPath()
      ctx.roundRect(
        box.x + CARD_BORDER / 2,
        box.y + CARD_BORDER / 2,
        box.w - CARD_BORDER,
        box.h - CARD_BORDER,
        CARD_RADIUS,
      )
      ctx.stroke()
      ctx.fillStyle = `rgb(${GREEN})`
      const top = box.y + CARD_BORDER + BODY_PAD + BASELINE
      for (const [i, line] of lines.entries()) {
        drawRow(ctx, line, box.x + CARD_BORDER + BODY_PAD, top + i * LINE_H)
      }
    } else {
      // Without a header container the body owns that band too, and starts where
      // it does rather than a bar below it - but still below its own notice.
      const bodyTop = screen.headerless ? nHeight + BODY_PAD + BASELINE : BODY_TOP + nHeight
      for (const [i, line] of screen.body.split('\n').entries()) {
        drawRow(ctx, line, 4 + BODY_PAD, bodyTop + i * LINE_H)
      }
    }

    ctx.fillStyle = `rgba(${GREEN}, 0.78)`
    drawRow(ctx, screen.footer, HEADER_PAD, FOOTER_BASE)

    endFrame(ctx)
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
      setVoiceStatus('Recording... speak into the microphone')
      return true
    } catch (err) {
      setVoiceStatus(`Cannot use the microphone: ${err instanceof Error ? err.message : err}`)
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
    // A browser panel, not a face. Claiming otherwise would silence the
    // wearer's browser notifications for as long as this tab stayed open.
    onDevice: false,
    render(state) {
      // Kept for the mirror to fall back to and for `Copy screen` to quote
      // while the device owns the panel; the drawing below does not read it.
      const raw = screenText(state)
      localScreen = { ...raw, body: wrapForPanel(raw.body) }
      localMode = state.mode
      renderDiag(state)
      // While mirroring the device owns the panel; this connection's own
      // state keeps running underneath so switching back is instant.
      if (mirroring) return
      lastScreen = localScreen
      lastMode = state.mode
      modeJp.textContent = MODE_LABEL[state.mode] ?? state.mode
      modeId.textContent = state.mode
      // The same call the device makes. Every write goes to `panelBridge`,
      // which resolves synchronously, so the `then` runs on a microtask and the
      // panel is drawn before anything else can render over it.
      void updateDisplay(panelBridge as never, state).then(paintPanel)
    },
    // Drawing costs nothing here, so the header tick is just a render. It still
    // goes through `updateHeader` rather than a full render: which single
    // container the device settles for is exactly the sort of decision that
    // wants exercising on a desk.
    renderHeader(state) {
      const raw = screenText(state)
      localScreen = { ...raw, body: wrapForPanel(raw.body) }
      localMode = state.mode
      renderDiag(state)
      if (mirroring) return
      lastScreen = localScreen
      void updateHeader(panelBridge as never, state).then(paintPanel)
    },
    // There is no host here to show an exit dialogue and no app to be exited
    // from, so this reports rather than acts — the simulator's job is to make
    // the gesture's new meaning visible while it is being designed.
    requestExit() {
      setVoiceStatus('Requested the exit dialog (on the device the host asks for confirmation)')
    },
    // The browser never backgrounds this the way the host does, so this only
    // fires if the simulator is driven into that state deliberately. Reported
    // rather than silent: the recovery it stands for is the whole point.
    onForegroundRegained() {
      setVoiceStatus('Detected a return to the foreground (input arrived, so drawing resumes)')
    },
    // `instanceId` is deliberately absent: the simulator subscribes with
    // `onDevice: false`, so the server never retires it and never lets it retire
    // real glasses — testing in a browser while wearing them has to keep
    // working. The button below drives this path anyway, because a path only
    // reachable by owning two WebViews at once is a path nobody tests.
    onSuperseded() {
      setVoiceStatus('Retired in favour of a newer run (the panel is no longer ours)')
    },
    // Reported rather than acted on, like `requestExit` above: closing the tab
    // would take the screen the closing message is being checked on with it,
    // and the message is the part worth looking at here.
    exitNow() {
      setVoiceStatus('Closed itself (on the device the WebView goes away here)')
    },
    // No host store in a browser; localStorage plays the same part, and it
    // lets the simulator exercise the resume path without the device.
    saveState(json) {
      writeStoredSync('glasses-resume', json)
    },
    async loadState() {
      return readStoredSync('glasses-resume')
    },
    startMicCapture: () => startMic(),
    stopMicCapture: () => stopMic(),
    // Typed text short-circuits the transcription, which is handy for driving
    // the confirm/send flow without speaking. Left empty, the recording is
    // sent to Groq exactly as the glasses would send it.
    transcribeAudio: async (pcm) => {
      const scripted = sttInput.value.trim()
      if (scripted) {
        setVoiceStatus(`Using the text from the STT field: ${scripted}`)
        return scripted
      }
      setVoiceStatus(`Transcribing... (sent ${(pcm.length / 2 / MIC_RATE).toFixed(1)}s of audio)`)
      try {
        const text = await transcribe(pcm, MIC_RATE)
        setVoiceStatus(text ? `Transcript: ${text}` : 'Nothing was recognized')
        return text
      } catch (err) {
        setVoiceStatus(`Transcription failed: ${err instanceof Error ? err.message : err}`)
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
    diag.textContent =
      `WS: ${ws.getState()} | Sub: ${ws.getSubscribed() || 'none'} | Buf: ${bufText.length}ch | Choices: [${choices.join(', ')}]` +
      (controller.isStopped() ? ' | stopped' : '')
    const top = state.relayWaiting[0]
    relay.textContent =
      `Relay: waiting=${state.relayWaiting.length} info=${state.relayInfo.length}` +
      (top ? ` | top: [${top.kind}] ${top.sessionId}${top.paneId ?? ''} "${top.text.slice(0, 40)}"${top.choices?.length ? ` choices=${top.choices.length}` : ''}` : '') +
      (state.overlayItemId ? ` | overlay=${state.overlayItemId}` : '')
  }

  /** The screen as pasteable text: three framed sections, same strings the G2
   *  drew. This is the point of the simulator — quoting a screen in a report
   *  should not require retyping it. */
  /**
   * The screen as text, quoted from the containers rather than rebuilt.
   *
   * `screenText(state)` would say what the screen *should* show; these are the
   * strings the panel is actually holding, which is the same thing right up
   * until the moment it is not — a skipped upgrade, or one addressed to the
   * wrong id, differs in exactly this. Each block is named for its container so
   * a copied screen says where a wrong line came from.
   *
   * Mirroring has no containers to quote: three strings arrive off the wire
   * with no state behind them, so that path prints what it was handed.
   */
  function screenAsText(): string {
    const rule = '─'.repeat(52)
    const head = `[${MODE_LABEL[lastMode] ?? lastMode} / ${lastMode}]${mirroring ? ' mirroring the device' : ''}`
    if (mirroring) {
      return [
        head,
        rule,
        lastScreen.header,
        rule,
        // The panel draws this rule as a container border rather than a row of
        // text; here it is a row like the others, so the copy reads the way the
        // screen looks.
        ...(lastScreen.notice ? [lastScreen.notice, rule] : []),
        lastScreen.body,
        rule,
        lastScreen.footer,
        rule,
      ].join('\n')
    }
    return [head, rule, ...panel.flatMap((c) => [`${c.name}:`, c.content, rule])].join('\n')
  }

  // The voice-input settings live on the server; the simulator talks to the
  // same endpoints the phone UI does, so a key or a language set here is what
  // the G2 will use too.
  void wireSettingsPanel()

  el('g2-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(screenAsText())
      copied.textContent = 'Copied'
      copied.className = 'hint copied'
    } catch {
      copied.textContent = 'Could not copy'
      copied.className = 'hint'
    }
    setTimeout(() => { copied.textContent = '' }, 2000)
  })

  /**
   * The panel alone, as a transparent PNG.
   *
   * What EVEN Hub's store listing wants: it supplies the room behind the lens
   * (Home / Office / Store / Cafe) and composites the app's own drawing over
   * it, so a submitted image must carry the drawing and nothing else. The
   * canvas is already in that shape — 576×288, background at alpha 0, lit
   * pixels green with alpha carrying the sixteen levels — so this is a
   * download, not a conversion.
   *
   * Screenshotting the lens element instead bakes in whichever backdrop the
   * simulator happens to be showing, which is the right image for judging
   * legibility and the wrong one to submit. Two different jobs, hence a button
   * beside "Copy screen" rather than in place of it.
   */
  el('g2-png').addEventListener('click', () => {
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const a = document.createElement('a')
      a.download = `${__PRODUCT_NAME__.toLowerCase()}-glasses-${lastMode}-${stamp}.png`
      a.href = canvas.toDataURL('image/png')
      a.click()
      copied.textContent = 'Saved the PNG (transparent, 576x288)'
      copied.className = 'hint copied'
    } catch {
      copied.textContent = 'Could not save the PNG'
      copied.className = 'hint'
    }
    setTimeout(() => { copied.textContent = '' }, 2500)
  })

  // ── Backdrop controls ──

  const bgFile = document.getElementById('bg-file') as HTMLInputElement
  const bgUrlInput = document.getElementById('bg-url') as HTMLInputElement

  /** Show a local file without persisting it: a blob URL is dead on reload. */
  function useLocalFile(file: File): void {
    if (!file.type.startsWith('image/')) {
      setBgStatus('That is not an image file')
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
    clearStoredSync(BG_SUFFIX)
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
    camBtn.textContent = 'Camera'
  }

  async function startCam(): Promise<void> {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        // The rear camera is the one pointing at what the wearer would see.
        video: { facingMode: 'environment', width: { ideal: 1280 } },
      })
      camEl.srcObject = camStream
      lensEl.classList.add('cam-on')
      camBtn.textContent = 'Stop the camera'
      setBgStatus('')
      startCameraPump()
    } catch {
      setBgStatus('Could not open the camera (check permissions and HTTPS)')
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
    else void lensEl.requestFullscreen().catch(() => setBgStatus('Could not go fullscreen'))
  })

  document.addEventListener('fullscreenchange', () => {
    const on = document.fullscreenElement === lensEl
    lensEl.classList.toggle('fs', on)
    if (!on) lensEl.style.removeProperty('--fs-scale')
    el('g2-fs').textContent = on ? 'Exit fullscreen' : 'Fullscreen'
    fitPanel()
  })
  window.addEventListener('resize', fitPanel)
  // Turning the phone is the gesture this is built around, and some browsers
  // report the old dimensions to the `resize` that announces it - so ask again
  // on the next frame, when they have settled.
  window.addEventListener('orientationchange', () => {
    fitPanel()
    requestAnimationFrame(fitPanel)
  })

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
      setBgStatus('Could not open picture-in-picture (the browser may not support it)')
    }
  }

  el('g2-pip').addEventListener('click', () => {
    if (pipActive()) void document.exitPictureInPicture()
    else void enterPip()
  })

  pipVideo.addEventListener('enterpictureinpicture', () => {
    el('g2-pip').textContent = 'Close picture-in-picture'
  })
  pipVideo.addEventListener('leavepictureinpicture', () => {
    el('g2-pip').textContent = 'Picture-in-picture'
    stopPipPump()
  })

  // ── Lens reflection ──
  //
  // Presentation only, and separable on purpose: reading the panel for
  // fidelity wants the bare canvas, showing it to people wants the glass.

  const GLASS_SUFFIX = 'glasses-glassy'
  const glassyToggle = document.getElementById('g2-glassy') as HTMLInputElement
  if (readStoredSync(GLASS_SUFFIX) === 'off') glassyToggle.checked = false

  function applyGlassy(): void {
    lensEl.classList.toggle('glassy', glassyToggle.checked)
  }
  glassyToggle.addEventListener('change', () => {
    applyGlassy()
    writeStoredSync(GLASS_SUFFIX, glassyToggle.checked ? 'on' : 'off')
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

  // The host's own lifecycle, on demand. These paths used to be reachable only
  // by wearing the glasses and waiting for the host to close the app — which is
  // exactly how a release went out with nothing releasing anything.
  const lifecycleStatus = el('lifecycle-status')
  el('btn-fg-exit').addEventListener('click', () => {
    controller.onForegroundExit()
    lifecycleStatus.textContent = 'Foreground exit: drawing stopped, resume point saved, microphone closed.'
    renderDiag(controller.state)
  })
  el('btn-fg-enter').addEventListener('click', () => {
    controller.onForegroundEnter()
    lifecycleStatus.textContent = 'Foreground enter: reconnected and redrawn from scratch.'
    renderDiag(controller.state)
  })
  el('btn-host-exit').addEventListener('click', () => {
    controller.onHostExit('system')
    lifecycleStatus.textContent =
      'Host exit: socket closed, clocks cleared, microphone closed. Nothing draws from here — reload to start again.'
    renderDiag(controller.state)
  })
  el('btn-gave-up').addEventListener('click', () => {
    // The real route takes five minutes of failed reconnects, which is not a
    // thing anyone will sit through to look at the screen it ends on — and that
    // screen is the part worth looking at, since it is the app's one chance to
    // tell a wearer it closed on purpose.
    ;(controller as unknown as { onWsGaveUp(): void }).onWsGaveUp()
    lifecycleStatus.textContent =
      'Server unreachable: the closing message is up, and on the device the WebView goes away a few seconds later.'
    renderDiag(controller.state)
  })
  el('btn-superseded').addEventListener('click', () => {
    // What the server sends when a newer run of the app connects. Same release
    // as a host exit, minus the resume point — the newcomer owns that.
    ;(controller as unknown as { onSuperseded(by: string): void }).onSuperseded('newer')
    lifecycleStatus.textContent =
      'Superseded: released everything and saved no resume point (the newer run owns the reader’s place).'
    renderDiag(controller.state)
  })

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
      setMirrorUi(false, 'No device is connected')
      return
    }
    // Rebuilt field by field, so a new one added to GlassesScreen is dropped
    // here unless it is named — which is exactly how the notice strip went
    // missing from the mirror while the local panel drew it.
    paint({
      header: screen.header,
      notice: screen.notice ? wrapForPanel(screen.notice) : undefined,
      body: wrapForPanel(screen.body),
      footer: screen.footer,
    }, screen.mode)
    setMirrorUi(true, 'In sync with the device')
  })

  mirrorToggle.addEventListener('change', () => {
    mirroring = mirrorToggle.checked
    if (mirroring) {
      controller.ws.subscribeGlassesScreen()
      setMirrorUi(false, 'Waiting for the device...')
    } else {
      controller.ws.unsubscribeGlassesScreen()
      setMirrorUi(false, '')
      // Back to this simulator's own panel, which has been kept up to date
      // underneath the mirror — repaint it rather than re-running a render,
      // which would find every container unchanged and draw nothing.
      lastScreen = localScreen
      lastMode = localMode
      modeJp.textContent = MODE_LABEL[localMode] ?? localMode
      modeId.textContent = localMode
      paintPanel()
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
