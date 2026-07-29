// Entry point: environment detection + G2 wiring.
//
// All app logic (relay queue, state machine, ring handlers) lives in
// controller.ts and is shared with the browser debug simulator (debug-ui.ts);
// this file only provides the G2 platform (Even Hub bridge rendering, mic,
// Groq STT) and the LocalStorage URL setup flow.

import { setBaseUrl, transcribe, reportLog } from './api.ts'
import { initDisplay, updateDisplay, updateHeader, setupEvents, buildSetupGuide, screenText, panelWrites, invalidatePanel, startMic, stopMic } from './display.ts'
import type { AppState } from './display.ts'
import { GlassesController } from './controller.ts'
import type { GlassesPlatform } from './controller.ts'
import { startPhoneUI } from './phone-ui.ts'
import { startDebugUI } from './debug-ui.ts'

const LS_KEY = 'cchub-url'
const MIC_SAMPLE_RATE = 16000
// Slow now that the crash is understood: enough to date a silent death, not
// so often that the log is mostly heartbeat.
const HEARTBEAT_MS = 30_000
const RESUME_KEY = 'cchub-glasses-resume'

// ── Crash reporting ──
//
// A WebView with no reachable console means an uncaught exception kills the
// app leaving nothing behind — "起動して一瞬で落ちる" and no way to see why.
// Everything is buffered until the hub URL is known (the handlers are
// installed before that, since the earliest failures are the interesting
// ones), then shipped to /api/logs. `trace` also marks each startup milestone
// so a silent death localises to the last line that made it out.

const pendingLogs: Array<{ level: string; message: string; stack?: string }> = []
let logSinkReady = false

function trace(message: string, level = 'info', stack?: string): void {
  if (logSinkReady) void reportLog(level, message, stack)
  else pendingLogs.push({ level, message, stack })
}

function flushLogs(): void {
  logSinkReady = true
  for (const entry of pendingLogs.splice(0)) {
    void reportLog(entry.level, entry.message, entry.stack)
  }
}

function installCrashReporting(): void {
  window.addEventListener('error', (event) => {
    trace(
      `uncaught: ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`,
      'error',
      (event.error as Error | undefined)?.stack,
    )
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: string; stack?: string } | undefined
    trace(
      `unhandled rejection: ${reason?.message ?? String(event.reason)}`,
      'error',
      reason?.stack,
    )
  })
}

// ── Glasses mode: G2 display + ring controls ──

async function startGlassesMode(bridge: NonNullable<Awaited<ReturnType<typeof initDisplay>>>) {
  // Load CC Hub URL from LocalStorage
  let savedUrl = await bridge.getLocalStorage(LS_KEY)
  // Dev mode: use proxy (relative URL) when running via Vite dev server
  if (!savedUrl && location.hostname === 'localhost') {
    savedUrl = location.origin
    await bridge.setLocalStorage(LS_KEY, savedUrl)
  }
  if (!savedUrl) {
    // Show setup guide and poll for URL
    await bridge.rebuildPageContainer(buildSetupGuide())
    await new Promise<void>((resolve) => {
      const poll = setInterval(async () => {
        const url = await bridge.getLocalStorage(LS_KEY)
        if (url) {
          clearInterval(poll)
          savedUrl = url
          resolve()
        }
      }, 2000)
    })
  }

  setBaseUrl(savedUrl)
  flushLogs() // hub URL known — everything buffered so far can now be shipped
  trace(`glasses mode: url=${savedUrl}`)

  // Draw one frame at a time.
  //
  // updateDisplay is async and was being fired without waiting, so bursts of
  // sessions-updated on startup put several SDK page rebuilds in flight at
  // once — and the app died mid-burst, taking the JS with it (no heartbeat,
  // no error, nothing). Serialising removes the overlap. Frames that arrive
  // while one is in flight collapse into the latest state, which is the only
  // one worth drawing anyway.
  let renders = 0
  let pending: { state: AppState; headerOnly: boolean } | null = null
  let draining = false

  async function drainRenders(): Promise<void> {
    while (pending) {
      const { state, headerOnly } = pending
      pending = null
      try {
        await (headerOnly ? updateHeader(bridge, state) : updateDisplay(bridge, state))
      } catch (err) {
        trace(`updateDisplay failed (mode=${state.mode}): ${err}`, 'error', (err as Error)?.stack)
      }
    }
    draining = false
  }

  function enqueue(state: AppState, headerOnly: boolean): void {
    // A full render supersedes a spinner tick waiting behind it — it draws the
    // header too, and drawing it twice would be the overlap this queue exists
    // to prevent.
    pending = { state, headerOnly: headerOnly && (pending?.headerOnly ?? true) }
    if (draining) return
    draining = true
    void drainRenders()
  }

  // Demo mirror: publish the same three strings the panel is about to show, so
  // a browser can render the screen the wearer is looking at. Skipped when the
  // frame is identical to the last one — renders fire every five seconds
  // whether or not anything changed, and a demo audience does not need the
  // traffic.
  let lastPublished = ''
  function publishScreen(state: AppState): void {
    try {
      const { header, body, footer, notice } = screenText(state)
      const key = `${state.mode}\u0000${header}\u0000${notice ?? ''}\u0000${body}\u0000${footer}`
      if (key === lastPublished) return
      lastPublished = key
      controller.ws.publishScreen({ header, body, footer, notice, mode: state.mode, at: Date.now() })
    } catch (err) {
      // A mirror is a nicety; never let it take the panel down with it.
      trace(`publishScreen failed: ${err}`, 'error', (err as Error)?.stack)
    }
  }

  const platform: GlassesPlatform = {
    // startGlassesMode only runs with a real Even Hub bridge.
    onDevice: true,
    render(state) {
      // Just the startup burst — that is where frames used to pile up.
      if (++renders <= 10) trace(`render #${renders} mode=${state.mode} sessions=${state.sessions.length}`)
      publishScreen(state)
      enqueue(state, false)
    },
    renderHeader(state) {
      publishScreen(state)
      enqueue(state, true)
    },
    // The host app's own store, which outlives the WebView the phone suspends.
    saveState(json) {
      void bridge?.setLocalStorage(RESUME_KEY, json).catch(() => {})
    },
    async loadState() {
      try {
        return (await bridge?.getLocalStorage(RESUME_KEY)) || null
      } catch {
        return null
      }
    },
    startMicCapture: () => startMic(bridge),
    stopMicCapture: () => stopMic(bridge),
    transcribeAudio: (pcm) => transcribe(pcm, MIC_SAMPLE_RATE),
    requestExit() {
      // Mode 1 — the host's own confirmation, which the user can cancel. Only
      // if they confirm does `SYSTEM_EXIT_EVENT` arrive, and the cleanup goes
      // there rather than here.
      trace('exit dialogue requested (root double-tap)')
      try {
        void bridge.shutDownPageContainer(1)
      } catch (err) {
        trace(`shutDownPageContainer failed: ${err}`, 'error', (err as Error)?.stack)
      }
    },
  }
  const controller = new GlassesController(platform)
  trace('controller constructed')
  controller.connect()
  trace('ws connect issued')
  platform.render(controller.state)

  /**
   * Front or back, as far as the host has told us.
   *
   * The transitions were already traced, but only as events — so a death with
   * no transition before it was unreadable: it could have been the foreground
   * dying, or the background dying long after the last logged transition, and
   * pairing them up after the fact turned out to depend entirely on how the
   * pairing was written. Carried on the heartbeat and on the exit line
   * instead, every death states which one it was.
   *
   * Starts true: the host launches the app into the foreground.
   */
  let foreground = true

  setupEvents(bridge, {
    onForegroundEnter() {
      foreground = true
      trace('foreground: entered — reconnecting after suspend')
      // The panel may not be ours any more; draw the next frame in full rather
      // than trusting a record of what it showed before the suspend.
      invalidatePanel()
      controller.onForegroundEnter()
    },
    onForegroundExit() {
      foreground = false
      trace('foreground: exited — saving resume point')
      controller.onForegroundExit()
    },
    onExit(kind) {
      // The host says why it is stopping us, and the two kinds mean opposite
      // things: `abnormal` is an unexpected disconnect, `system` is the user
      // confirming the host's exit dialogue. Only ever having seen `system` is
      // the finding — this app was being left, not crashing.
      //
      // So the gesture goes out with it. A double-tap moments before says the
      // wearer walked out through the dialogue; silence says something else
      // closed us, and that is a different problem entirely.
      const g = controller.lastGesture()
      trace(
        `host exit: ${kind} fg=${foreground ? 1 : 0} gesture=${g.kind}@${g.agoMs < 0 ? 'never' : `${Math.round(g.agoMs / 100) / 10}s`}`,
        'error',
      )
      controller.onHostExit(kind)
    },
    onSwipeDown: () => controller.swipeDown(),
    onSwipeUp: () => controller.swipeUp(),
    onTap: () => controller.tap(),
    onDoubleTap: () => controller.doubleTap(),
    onAudioData: (pcm) => controller.onAudioData(pcm),
  })

  trace('events wired')
  trace('startup complete')

  /**
   * JS heap, when the engine will say.
   *
   * Deliberately narrow evidence: this is the JS heap alone, not the WebView's
   * DOM, GPU textures or native allocations. If Android is killing the process
   * on total footprint, this stays flat right up to the end — which is itself
   * worth knowing, because it rules the JS heap out rather than leaving it a
   * suspect. Non-standard and Chromium-only, hence the cast and the guard.
   */
  function heapNote(): string {
    const mem = (performance as unknown as {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
    }).memory
    if (!mem) return ''
    const mb = (n: number) => Math.round(n / 1048576)
    return ` heap=${mb(mem.usedJSHeapSize)}/${mb(mem.totalJSHeapSize)}MB(limit ${mb(mem.jsHeapSizeLimit)})`
  }

  // Heartbeat. Startup already completes cleanly in every failing report, so
  // the question is no longer whether it starts but how long it survives —
  // the last beat that arrives is the moment it died. Its spacing is evidence
  // too: the interval stretched from 30s to 65s before eight of twenty deaths,
  // which is the engine being throttled rather than the app failing.
  const bootAt = Date.now()
  setInterval(() => {
    trace(
      `alive ${((Date.now() - bootAt) / 1000).toFixed(1)}s renders=${renders} writes=${panelWrites()} fg=${foreground ? 1 : 0} ws=${controller.ws.getState()}${heapNote()}`,
    )
  }, HEARTBEAT_MS)
}

// ── Entry point: detect environment ──

async function main(): Promise<void> {
  installCrashReporting()
  // The SDK's window.EvenAppBridge stub can exist in a plain desktop browser,
  // so waitForEvenAppBridge() resolving is not proof of the Even Hub WebView.
  // The real Flutter WebView injects `flutter_inappwebview` (its absence is
  // exactly what the SDK's "Flutter handler not available" warning reports) —
  // gate on it, or the browser debug simulator would never start.
  const isEvenHub =
    typeof (window as unknown as Record<string, unknown>).flutter_inappwebview !== 'undefined'
  trace(`main: v${__APP_VERSION__} (${__BUILD_COMMIT__}) isEvenHub=${isEvenHub}`)
  const bridge = isEvenHub ? await initDisplay() : null
  trace(`bridge=${bridge ? 'ready' : 'null'}`)

  if (bridge) {
    // Even Hub environment — check launch source
    bridge.onLaunchSource((source) => {
      // Which path was taken matters: launching from the phone runs the
      // companion UI AND the glasses mode at once, and only that case has
      // been reported as dying seconds after startup.
      trace(`launchSource=${source}`)
      if (source === 'appMenu') {
        startPhoneUI(bridge)
          .then(() => trace('phone UI ready'))
          .catch((err) => trace(`phone UI failed: ${err}`, 'error', (err as Error)?.stack))
      }
      // glassesMenu: already started below
    })
    // Always start glasses mode (bridge exists = Even Hub)
    await startGlassesMode(bridge)
  } else {
    // Browser debug mode
    startDebugUI()
  }
}

main().catch((err) => {
  console.error(err)
  trace(`main() rejected: ${err}`, 'error', (err as Error)?.stack)
})
