// Entry point: environment detection + G2 wiring.
//
// All app logic (relay queue, state machine, ring handlers) lives in
// controller.ts and is shared with the browser debug simulator (debug-ui.ts);
// this file only provides the G2 platform (Even Hub bridge rendering, mic,
// Groq STT) and the LocalStorage URL setup flow.

import { setBaseUrl, transcribe, reportLog } from './api.ts'
import { initDisplay, updateDisplay, setupEvents, buildSetupGuide, startMic, stopMic } from './display.ts'
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
  let pending: AppState | null = null
  let draining = false

  async function drainRenders(): Promise<void> {
    while (pending) {
      const state = pending
      pending = null
      try {
        await updateDisplay(bridge, state)
      } catch (err) {
        trace(`updateDisplay failed (mode=${state.mode}): ${err}`, 'error', (err as Error)?.stack)
      }
    }
    draining = false
  }

  const platform: GlassesPlatform = {
    render(state) {
      // Just the startup burst — that is where frames used to pile up.
      if (++renders <= 10) trace(`render #${renders} mode=${state.mode} sessions=${state.sessions.length}`)
      pending = state
      if (draining) return
      draining = true
      void drainRenders()
    },
    startMicCapture: () => startMic(bridge),
    stopMicCapture: () => stopMic(bridge),
    transcribeAudio: (pcm) => transcribe(pcm, MIC_SAMPLE_RATE),
  }
  const controller = new GlassesController(platform)
  trace('controller constructed')
  controller.connect()
  trace('ws connect issued')
  platform.render(controller.state)

  setupEvents(bridge, {
    onSwipeDown: () => controller.swipeDown(),
    onSwipeUp: () => controller.swipeUp(),
    onTap: () => controller.tap(),
    onDoubleTap: () => controller.doubleTap(),
    onAudioData: (pcm) => controller.onAudioData(pcm),
  })

  trace('events wired')
  trace('startup complete')

  // Heartbeat. Startup already completes cleanly in every failing report, so
  // the question is no longer whether it starts but how long it survives —
  // the last beat that arrives is the moment it died.
  const bootAt = Date.now()
  setInterval(() => {
    trace(`alive ${((Date.now() - bootAt) / 1000).toFixed(1)}s renders=${renders} ws=${controller.ws.getState()}`)
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
  trace(`main: isEvenHub=${isEvenHub}`)
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
