// The browser simulator.
//
// Not a preview. It runs the same `GlassesController` the device runs, and it
// draws by handing `updateDisplay()` a bridge that records containers instead
// of sending them - so the rebuild-vs-upgrade decision, the skip-if-unchanged
// record, which container id a string is addressed to and every container's
// geometry are decided once, in `display.ts`, for both.
//
// A second implementation of where the strings go is what produced the
// divergences that cost real debugging time in the other app: character widths
// off by one, paging repeating a line on the device only, a strip drawn 36px
// from where the device drew it. That is why this file positions nothing.
//
// What it still cannot do is glyphs: this window draws with a browser font at
// the firmware's advances, so a character the panel has no glyph for can
// appear here. The order stays: check here, release, check on the device.

import { setBaseUrl, transcribe } from './api.ts'
import { GlassesController, MIC_SAMPLE_RATE, SEEN_SUFFIX } from './controller.ts'
import type { GlassesPlatform } from './controller.ts'
import { screenText, updateDisplay, updateHeader, wrapForPanel } from './display.ts'
import type { AppState } from './display.ts'
import { LINE_H, PANEL_H, PANEL_W, splitLines, textWidth } from './metrics.ts'
import { readStoredSync, writeStoredSync } from './storage.ts'
import { BASELINE, createPanelPainter, inkColor } from './panel-paint.ts'

const SCREEN_LABEL: Record<string, string> = {
  overview: 'Overview',
  session: 'Session',
  ask: 'Question',
  report: 'Report',
  voice: 'Voice',
  direct: 'Direct',
}

const STYLE = `
  :root { color-scheme: dark; }
  body { margin:0; background:#0d0f0e; color:#dfe6e1;
         font-family:system-ui,-apple-system,'Helvetica Neue',sans-serif; }
  .wrap { max-width:64rem; margin:0 auto; padding:24px 20px 60px; display:flex; flex-direction:column; gap:18px; }
  h1 { font-size:19px; margin:0; font-weight:650; }
  .sub { font-size:12px; color:#7d8a83; }
  .main { display:grid; grid-template-columns:minmax(0,1.35fr) minmax(15rem,1fr); gap:22px; align-items:start; }
  @media (max-width:52rem) { .main { grid-template-columns:1fr; } }
  .lens-fit { width:100%; }
  .lens { width:576px; height:288px; transform-origin:top left; position:relative;
          background:#05100b; border:1px solid #1b2c22; border-radius:4px; overflow:hidden; }
  canvas { display:block; }
  .meta { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:12px; color:#7d8a83; }
  .pill { border:1px solid #2c3a33; border-radius:3px; padding:2px 8px; color:#8fe3b0; }
  .panel { display:flex; flex-direction:column; gap:10px; }
  h2 { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:#7d8a83; margin:14px 0 0; }
  .ring { display:flex; flex-wrap:wrap; gap:8px; }
  button { background:#1a221e; color:#dfe6e1; border:1px solid #2c3a33; border-radius:7px;
           padding:9px 13px; font-size:13px; }
  button:hover { background:#232e28; }
  input[type=text] { width:100%; box-sizing:border-box; background:#141a17; color:#dfe6e1;
                     border:1px solid #2c3a33; border-radius:7px; padding:9px 11px; font-size:13px; }
  .hint { font-size:12px; line-height:1.6; color:#6f7d76; margin:0; }
  .diag { font-family:ui-monospace,Menlo,monospace; font-size:11px; color:#7d8a83;
          white-space:pre-wrap; word-break:break-all; line-height:1.6; }
`

export function startDebugUI(): void {
  // `?hub=` points the simulator at another server; the default is same-origin,
  // which is what /glasses-steward and the vite proxy both want.
  const params = new URLSearchParams(location.search)
  const hub = params.get('hub')
  if (hub) setBaseUrl(hub)

  document.title = `${__PRODUCT_NAME__} Steward - simulator`
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)

  const app = document.querySelector<HTMLDivElement>('#app')
  if (!app) return
  app.innerHTML = `
    <div class="wrap">
      <div>
        <h1>${__PRODUCT_NAME__} Steward simulator</h1>
        <span class="sub">Draws what the device draws (576x288, widths measured in px)</span>
      </div>
      <div class="main">
        <div>
          <div class="lens-fit" id="lens-fit">
            <div class="lens" id="lens"><canvas id="g2-canvas" width="576" height="288"></canvas></div>
          </div>
          <div class="meta">
            <span class="pill" id="screen-label">Overview</span>
            <span id="screen-id">overview</span>
            <button type="button" id="copy">Copy screen</button>
            <span id="copied"></span>
          </div>
          <div class="diag" id="diag"></div>
        </div>

        <div class="panel">
          <h2>Ring</h2>
          <div class="ring">
            <button type="button" id="btn-up">Swipe up</button>
            <button type="button" id="btn-down">Swipe down</button>
            <button type="button" id="btn-tap">Tap</button>
            <button type="button" id="btn-dbl">Double tap</button>
          </div>
          <p class="hint">Arrow keys, Enter and Backspace do the same.</p>

          <h2>Host lifecycle</h2>
          <div class="ring">
            <button type="button" id="btn-fg-exit">Foreground exit</button>
            <button type="button" id="btn-fg-enter">Foreground enter</button>
            <button type="button" id="btn-host-exit">Host exit</button>
            <button type="button" id="btn-gave-up">Server unreachable</button>
          </div>
          <p class="hint">On the device these arrive from the host. After a host exit nothing draws again.</p>

          <h2>First run</h2>
          <div class="ring"><button type="button" id="btn-demo">Demo data</button></div>
          <p class="hint">What a reviewer with no server sees: canned sessions, a canned report.</p>

          <h2>Voice</h2>
          <input type="text" id="stt" placeholder="Text to use instead of the microphone" />
          <p class="hint" id="voice-status">The microphone is real: it records and posts to the server's
          transcription endpoint exactly as the glasses do. With text in the field it skips recording
          and uses that instead.</p>
        </div>
      </div>
    </div>
  `

  const el = (id: string) => document.getElementById(id) as HTMLElement
  const canvas = document.getElementById('g2-canvas') as HTMLCanvasElement
  const sttInput = document.getElementById('stt') as HTMLInputElement

  /** Scale the panel to whatever width there is. The canvas keeps its real
   *  pixel count, so the type stays as coarse as the hardware's. */
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

  /**
   * A container as the panel is holding it.
   *
   * Geometry included, taken from what `updateDisplay` actually sent rather
   * than recomputed here.
   */
  interface PanelContainer {
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
   * The point is not that it records containers - it is that this window goes
   * through the same path the device does. A stale upgrade, or an id that means
   * the body on one screen and the header on another, shows up here on a desk
   * rather than only on someone's face.
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
        borderColor: (t.borderColor as number) ?? 6,
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

  const painter = createPanelPainter(canvas)
  const { drawRow, beginFrame, endFrame } = painter

  /**
   * Draw what the panel is holding, container by container.
   *
   * Everything positional comes off the container. Two things LVGL does that
   * have to be done here as well: wrapping happens inside the container at its
   * inner width, and a container clips what it cannot fit rather than spilling
   * onto the one below.
   */
  function paintPanel(): void {
    const ctx = beginFrame()
    if (!ctx) return
    for (const c of panel) {
      if (c.border > 0) {
        ctx.strokeStyle = `rgba(${inkColor()}, ${c.borderColor / 15})`
        ctx.lineWidth = c.border
        ctx.beginPath()
        ctx.roundRect(c.x + c.border / 2, c.y + c.border / 2, c.w - c.border, c.h - c.border, c.radius)
        ctx.stroke()
      }
      // The footer is drawn dimmer: it carries gestures and a clock, which are
      // reference rather than content.
      ctx.fillStyle = c.name === 'footer' ? `rgba(${inkColor()}, 0.78)` : `rgb(${inkColor()})`
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
    endFrame(ctx)
  }

  const DEFAULT_VOICE_HINT = el('voice-status').textContent ?? ''
  function setVoiceStatus(message: string): void {
    el('voice-status').textContent = message || DEFAULT_VOICE_HINT
  }

  // ── Microphone ──
  //
  // The browser records for real and the audio goes to the same endpoint the
  // G2 uses, so the whole voice path can be exercised without hardware. The
  // G2's SDK hands over raw 16-bit PCM at 16kHz; asking the AudioContext for
  // that rate lets the same bytes reach the same server code.
  let micStream: MediaStream | null = null
  let micCtx: AudioContext | null = null
  let micNode: ScriptProcessorNode | null = null

  async function startMic(): Promise<boolean> {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
      micCtx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE })
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
          const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
          pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
        }
        controller.onAudioData(new Uint8Array(pcm.buffer))
      })
      // Through a silent gain: the processor only runs while connected to the
      // destination, and nobody wants to hear themselves back.
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
    // A browser panel, not a face. Claiming otherwise would have the steward
    // reasoning about a screen nobody is looking at.
    onDevice: false,
    persist: (suffix, value) => writeStoredSync(suffix, value),
    render(state) {
      renderMeta(state)
      // The same call the device makes. `panelBridge` resolves synchronously,
      // so the `then` runs on a microtask and the panel is drawn before
      // anything else can render over it.
      void updateDisplay(panelBridge as never, state).then(paintPanel)
    },
    renderHeader(state) {
      renderMeta(state)
      // Still through `updateHeader`: which single container the device settles
      // for is exactly the sort of decision worth exercising on a desk.
      void updateHeader(panelBridge as never, state).then(paintPanel)
    },
    startMicCapture: () => startMic(),
    stopMicCapture: () => stopMic(),
    // Typed text short-circuits the transcription, for driving the confirm and
    // send flow without speaking. One phrase's worth: a recording is several
    // requests, and text left in the field would answer all of them the same.
    transcribeAudio: async (pcm, sessionId) => {
      const scripted = sttInput.value.trim()
      if (scripted) {
        sttInput.value = ''
        setVoiceStatus(`Using the text from the field: ${scripted}`)
        return scripted
      }
      setVoiceStatus(`Transcribing... (${(pcm.length / 2 / MIC_SAMPLE_RATE).toFixed(1)}s of audio)`)
      try {
        const text = await transcribe(pcm, MIC_SAMPLE_RATE, sessionId)
        setVoiceStatus(text ? `Transcript: ${text}` : 'Nothing was recognized')
        return text
      } catch (err) {
        setVoiceStatus(`Transcription failed: ${err instanceof Error ? err.message : err}`)
        // Rethrown rather than answered with an empty transcript: the device
        // passes `transcribe` straight through, and swallowing it here would
        // make the simulator the one place a failed request looks like a
        // recording of silence - which is a different screen.
        throw err
      }
    },
    requestExit() {
      setVoiceStatus('Requested the exit dialogue (on the device the host asks for confirmation)')
    },
    exitNow() {
      setVoiceStatus('Closed itself (on the device the WebView goes away here)')
    },
  }

  const controller = new GlassesController(platform)
  controller.loadSeen(readStoredSync(SEEN_SUFFIX))
  controller.connect()

  function renderMeta(state: AppState): void {
    el('screen-label').textContent = SCREEN_LABEL[state.screen] ?? state.screen
    el('screen-id').textContent = state.screen
    const ws = controller.ws
    el('diag').textContent = [
      `ws=${ws.getState()}`,
      `sessions=${state.sessions.length}`,
      `lines=${state.lines.length}`,
      `thread=${state.thread.length}`,
      state.openSessionId ? `open=${state.openSessionId}` : '',
      state.ask ? `ask=${state.ask.id.slice(0, 8)}` : '',
      state.deferredAskId ? 'deferred=1' : '',
      state.voice ? `voice=${state.voice.phase}` : '',
      controller.isStopped() ? 'stopped' : '',
    ]
      .filter(Boolean)
      .join('  ')
  }

  el('btn-up').addEventListener('click', () => controller.swipeUp())
  el('btn-down').addEventListener('click', () => controller.swipeDown())
  el('btn-tap').addEventListener('click', () => controller.tap())
  el('btn-dbl').addEventListener('click', () => controller.doubleTap())
  el('btn-fg-exit').addEventListener('click', () => controller.onForegroundExit())
  el('btn-fg-enter').addEventListener('click', () => controller.onForegroundEnter())
  el('btn-host-exit').addEventListener('click', () => {
    controller.onHostExit('system')
    renderMeta(controller.state)
  })
  el('btn-gave-up').addEventListener('click', () => {
    controller.state.fatal = 'offline'
    platform.render(controller.state)
  })

  let inDemo = false
  el('btn-demo').addEventListener('click', () => {
    inDemo = !inDemo
    if (inDemo) controller.startDemo()
    else controller.stopDemo()
  })

  el('copy').addEventListener('click', async () => {
    const { header, body, footer, notice, headerless } = screenText(controller.state)
    // Framed, so wrapping and the line count are visible in a paste. The body
    // is re-wrapped the way the panel wraps it - what is copied has to be what
    // is drawn, or a report of a screen is a report of something else.
    const lines = [
      ...(headerless ? [] : [header]),
      ...(notice ? notice.split('\n') : []),
      ...wrapForPanel(body).split('\n'),
      footer,
    ]
    const width = Math.max(...lines.map((l) => [...l].length), 20)
    const rule = `+${'-'.repeat(width + 2)}+`
    const framed = [rule, ...lines.map((l) => `| ${l}${' '.repeat(width - [...l].length)} |`), rule].join('\n')
    try {
      await navigator.clipboard.writeText(framed)
      el('copied').textContent = 'copied'
      setTimeout(() => {
        el('copied').textContent = ''
      }, 1500)
    } catch {
      console.log(framed)
      el('copied').textContent = 'logged to console'
    }
  })

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return
    const keys: Record<string, () => void> = {
      ArrowUp: () => controller.swipeUp(),
      ArrowDown: () => controller.swipeDown(),
      Enter: () => controller.tap(),
      Backspace: () => controller.doubleTap(),
    }
    const action = keys[e.key]
    if (!action) return
    e.preventDefault()
    action()
  })

  setInterval(() => renderMeta(controller.state), 1000)

  // Driving handles for tests and for a browser console.
  ;(window as unknown as Record<string, unknown>)._steward = {
    controller,
    swipeUp: () => controller.swipeUp(),
    swipeDown: () => controller.swipeDown(),
    tap: () => controller.tap(),
    doubleTap: () => controller.doubleTap(),
    screen: () => screenText(controller.state),
  }
}
