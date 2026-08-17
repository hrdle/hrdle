// Entry point: which environment this is, and the G2 wiring.
//
// Everything a wearer would notice lives in `controller.ts` and is shared with
// the browser simulator. This file provides the platform the controller cannot:
// the Even Hub bridge, the microphone, the host's own store, and the crash
// reporting a WebView with no reachable console makes necessary.

import { reportLog, setBaseUrl, transcribe } from './api.ts'
import { GlassesController, MIC_SAMPLE_RATE } from './controller.ts'
import type { GlassesPlatform } from './controller.ts'
import {
  buildSetupGuide,
  initDisplay,
  invalidatePanel,
  panelDrops,
  panelWrites,
  setPanelTrace,
  setupEvents,
  startMic,
  stopMic,
  updateDisplay,
  updateHeader,
} from './display.ts'
import type { AppState, Bridge } from './display.ts'
import { startDebugUI } from './debug-ui.ts'
import { startPhoneUI } from './phone-ui.ts'
import { createSetupGate } from './setup-gate.ts'
import { readStored, storageKey } from './storage.ts'

const URL_SUFFIX = 'url'
const HEARTBEAT_MS = 30_000

// ── Crash reporting ──
//
// A WebView with no reachable console means an uncaught exception kills the app
// leaving nothing behind. Everything is buffered until the server address is
// known - the handlers go on before that, since the earliest failures are the
// interesting ones - and then shipped to /api/logs.

const pendingLogs: Array<{ level: string; message: string; stack?: string }> = []
let logSinkReady = false

/** Which run wrote a line. The host starts an app twice within seconds often
 *  enough that a log is two interleaved stories. */
const RUN_ID = Math.floor(Math.random() * 0x10000)
  .toString(16)
  .padStart(4, '0')

function trace(message: string, level = 'info', stack?: string): void {
  const tagged = `[${RUN_ID}] ${message}`
  if (logSinkReady) void reportLog(level, tagged, stack)
  else pendingLogs.push({ level, message: tagged, stack })
}

function flushLogs(): void {
  logSinkReady = true
  for (const entry of pendingLogs.splice(0)) void reportLog(entry.level, entry.message, entry.stack)
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
    trace(`unhandled rejection: ${reason?.message ?? String(event.reason)}`, 'error', reason?.stack)
  })
}

// ── Glasses mode ──

async function startGlassesMode(bridge: NonNullable<Awaited<ReturnType<typeof initDisplay>>>) {
  /**
   * The address, from the host's own store.
   *
   * The same key the other app writes. Whether the host keeps one store across
   * packages or one per package is not something this side can see, and the
   * shared key answers both: if it is shared, an address already set up over
   * there is simply here and setup is over; if it is not, this app asks for one
   * once, on the phone screen below.
   */
  let savedUrl = await readStored((key) => bridge.getLocalStorage(key), URL_SUFFIX)
  if (!savedUrl && location.hostname === 'localhost') {
    savedUrl = location.origin
    await bridge.setLocalStorage(storageKey(URL_SUFFIX), savedUrl)
  }

  /**
   * One frame at a time.
   *
   * `updateDisplay` is async, and firing it without waiting put several SDK page
   * rebuilds in flight at once during a burst - which is where the other app
   * died mid-burst, taking the JS with it. Frames arriving while one is in
   * flight collapse into the latest state, which is the only one worth drawing.
   */
  let renders = 0
  let pending: { state: AppState; headerOnly: boolean } | null = null
  let draining = false
  let stopped = false

  async function drainRenders(): Promise<void> {
    while (pending && !stopped) {
      const { state, headerOnly } = pending
      pending = null
      try {
        await (headerOnly ? updateHeader(bridge, state) : updateDisplay(bridge, state))
      } catch (err) {
        trace(`updateDisplay failed (screen=${state.screen}): ${err}`, 'error', (err as Error)?.stack)
      }
    }
    draining = false
  }

  function enqueue(state: AppState, headerOnly: boolean): void {
    if (stopped) return
    // A full render supersedes a header tick waiting behind it: it draws the
    // bar too, and drawing it twice is the overlap this queue exists to stop.
    pending = { state, headerOnly: headerOnly && (pending?.headerOnly ?? true) }
    if (draining) return
    draining = true
    void drainRenders()
  }

  /**
   * Publish the frame the panel is about to show.
   *
   * This is how `hrdle steward screen` answers - the steward asking what its
   * owner can see. Skipped when the frame is identical to the last one: a
   * screen that has not changed is not news, and the link is BLE.
   */
  let lastPublished = ''
  function publishScreen(): void {
    try {
      const frame = controller.screenFrame()
      const key = JSON.stringify([frame.mode, frame.header, frame.notice, frame.body, frame.footer])
      if (key === lastPublished) return
      lastPublished = key
      controller.ws.publishScreen(frame)
    } catch (err) {
      // A mirror is a nicety; never let it take the panel down with it.
      trace(`publishScreen failed: ${err}`, 'error', (err as Error)?.stack)
    }
  }

  const platform: GlassesPlatform = {
    onDevice: true,
    render(state) {
      if (++renders <= 10) trace(`render #${renders} screen=${state.screen} sessions=${state.sessions.length}`)
      publishScreen()
      enqueue(state, false)
    },
    renderHeader(state) {
      publishScreen()
      enqueue(state, true)
    },
    startMicCapture: () => startMic(bridge),
    stopMicCapture: () => stopMic(bridge),
    transcribeAudio: (pcm, sessionId) => transcribe(pcm, MIC_SAMPLE_RATE, sessionId),
    requestExit() {
      // Mode 1 - the host's own confirmation, which the user can cancel. Only
      // if they confirm does `SYSTEM_EXIT_EVENT` arrive, and the cleanup goes
      // there rather than here.
      trace('exit dialogue requested (overview double-tap)')
      try {
        void Promise.resolve(bridge.shutDownPageContainer(1)).then((ok) => {
          if (ok === false) trace('shutDownPageContainer refused by host', 'error')
        })
      } catch (err) {
        trace(`shutDownPageContainer failed: ${err}`, 'error', (err as Error)?.stack)
      }
    },
    exitNow() {
      // Mode 0 - no dialogue. This is the run reporting it has nothing left to
      // do, and a cancelled exit would leave it as unreachable as it already is.
      trace('closing: server unreachable')
      releaseHostResources()
      try {
        void Promise.resolve(bridge.shutDownPageContainer(0)).then((ok) => {
          if (ok === false) trace('shutDownPageContainer(0) refused by host', 'error')
        })
      } catch (err) {
        trace(`shutDownPageContainer(0) failed: ${err}`, 'error', (err as Error)?.stack)
      }
    },
  }

  const controller = new GlassesController(platform)
  trace('controller constructed')

  if (!savedUrl) {
    await bridge.rebuildPageContainer(buildSetupGuide())
    // The ring, while we wait. Everything below is behind an await that only
    // resolves once an address exists, so without this a wearer who has not set
    // one up has no working input at all - not a tap, not a swipe, and no way
    // to close the app. An Even Hub reviewer met exactly that in the other app
    // and reported it as double-tap failing to bring up the exit dialogue.
    const gate = createSetupGate({
      startDemo: () => controller.startDemo(),
      stopDemo: () => controller.stopDemo(),
      tap: () => controller.tap(),
      doubleTap: () => controller.doubleTap(),
      swipeUp: () => controller.swipeUp(),
      swipeDown: () => controller.swipeDown(),
      invalidatePanel,
      trace: (m) => trace(m),
      requestExit: () => platform.requestExit(),
    })
    const setupGate = setupEvents(bridge, {
      onSwipeUp: () => gate.onSwipeUp(),
      onSwipeDown: () => gate.onSwipeDown(),
      onTap: () => gate.onTap(),
      onDoubleTap: () => gate.onDoubleTap(),
    })
    try {
      savedUrl = await new Promise<string>((resolve) => {
        const poll = setInterval(async () => {
          const url = await readStored((key) => bridge.getLocalStorage(key), URL_SUFFIX)
          if (url) {
            clearInterval(poll)
            resolve(url)
          }
        }, 2000)
      })
    } finally {
      setupGate?.()
      gate.close()
    }
  }

  setBaseUrl(savedUrl)
  flushLogs()
  trace(`steward mode: url=${savedUrl}`)

  controller.connect()
  platform.render(controller.state)

  let foreground = true
  let unsubEvents: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  /** Hand back everything this file took from the host. Runs from the exit
   *  events only - `requestExit` asks a question the wearer may cancel, and
   *  tearing down at the point of asking leaves a live app with no clocks. */
  function releaseHostResources(): void {
    if (stopped) return
    stopped = true
    pending = null
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
    try {
      unsubEvents?.()
    } catch {
      /* on the way out */
    }
    unsubEvents = null
  }

  unsubEvents = setupEvents(bridge, {
    onForegroundEnter() {
      foreground = true
      trace('foreground: entered')
      // The panel may not be ours any more; draw the next frame in full rather
      // than trusting a record of what it showed before the suspend.
      invalidatePanel()
      controller.onForegroundEnter()
    },
    onForegroundExit() {
      foreground = false
      trace('foreground: exited')
      controller.onForegroundExit()
    },
    onExit(kind, detail) {
      trace(`host exit: ${kind} fg=${foreground ? 1 : 0}${detail ?? ''}`, 'error')
      controller.onHostExit(kind)
      releaseHostResources()
    },
    onRawEvent(raw) {
      trace(`event: ${raw}`)
    },
    onSwipeDown: () => controller.swipeDown(),
    onSwipeUp: () => controller.swipeUp(),
    onTap: () => controller.tap(),
    onDoubleTap: () => controller.doubleTap(),
    onAudioData: (pcm) => controller.onAudioData(pcm),
  })

  trace('startup complete')

  const bootAt = Date.now()
  heartbeat = setInterval(() => {
    trace(
      `alive ${((Date.now() - bootAt) / 1000).toFixed(1)}s renders=${renders} ` +
        `writes=${panelWrites()} drops=${panelDrops()} fg=${foreground ? 1 : 0} ws=${controller.ws.getState()}`,
    )
  }, HEARTBEAT_MS)
}

// ── Entry point ──

async function main(): Promise<void> {
  installCrashReporting()
  setPanelTrace((message, level) => trace(`display: ${message}`, level ?? 'info'))

  // The SDK's window.EvenAppBridge stub exists in a plain desktop browser, so
  // the bridge resolving is not proof of the Even Hub WebView. The real Flutter
  // WebView injects `flutter_inappwebview`; gate on that, or the simulator
  // would never start.
  const isEvenHub =
    typeof (window as unknown as Record<string, unknown>).flutter_inappwebview !== 'undefined'
  trace(`main: v${__APP_VERSION__} (${__BUILD_COMMIT__}) isEvenHub=${isEvenHub}`)

  // The host pushes the launch source once when loading completes and the SDK
  // keeps no copy, so the subscription has to be in place before the startup
  // container's round trip - which is what `initDisplay`'s callback is for.
  let unsubLaunch: (() => void) | null = null
  function subscribeLaunchSource(b: Bridge): void {
    unsubLaunch = b.onLaunchSource((source) => {
      trace(`launchSource=${source}`)
      if (source === 'appMenu') {
        startPhoneUI(b)
          .then(() => trace('phone UI ready'))
          .catch((err) => trace(`phone UI failed: ${err}`, 'error', (err as Error)?.stack))
      }
      try {
        unsubLaunch?.()
      } catch {
        /* nothing left to release */
      }
      unsubLaunch = null
    })
  }

  const bridge = isEvenHub ? await initDisplay(subscribeLaunchSource) : null
  trace(`bridge=${bridge ? 'ready' : 'null'}`)

  if (bridge) {
    await startGlassesMode(bridge)
  } else if (new URLSearchParams(location.search).has('phone')) {
    // The phone screen without a device. On the G2 it is reachable only through
    // the Even Hub app menu, so without this every wording change there costs
    // an ehpk build and a launch on real hardware.
    trace('phone UI (browser)')
    startPhoneUI(null)
      .then(() => trace('phone UI ready'))
      .catch((err) => trace(`phone UI failed: ${err}`, 'error', (err as Error)?.stack))
  } else {
    startDebugUI()
  }
}

main().catch((err) => {
  console.error(err)
  trace(`main() rejected: ${err}`, 'error', (err as Error)?.stack)
})
