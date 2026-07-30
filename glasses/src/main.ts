// Entry point: environment detection + G2 wiring.
//
// All app logic (relay queue, state machine, ring handlers) lives in
// controller.ts and is shared with the browser debug simulator (debug-ui.ts);
// this file only provides the G2 platform (Even Hub bridge rendering, mic,
// Groq STT) and the LocalStorage URL setup flow.

import { setBaseUrl, transcribe, reportLog } from './api.ts'
import { initDisplay, updateDisplay, updateHeader, setupEvents, buildSetupGuide, screenText, panelWrites, panelDrops, setPanelTrace, invalidatePanel, startMic, stopMic } from './display.ts'
import type { AppState } from './display.ts'
import { GlassesController } from './controller.ts'
import type { GlassesPlatform } from './controller.ts'
import { startPhoneUI } from './phone-ui.ts'
import { startDebugUI } from './debug-ui.ts'
import { readStored, storageKey } from './storage.ts'

const URL_SUFFIX = 'url'
const MIC_SAMPLE_RATE = 16000
// Slow now that the crash is understood: enough to date a silent death, not
// so often that the log is mostly heartbeat.
const HEARTBEAT_MS = 30_000
const RESUME_SUFFIX = 'glasses-resume'

// ── Crash reporting ──
//
// A WebView with no reachable console means an uncaught exception kills the
// app leaving nothing behind - it starts, dies in an instant, and there is no
// way to see why. Everything is buffered until the hub URL is known (the handlers are
// installed before that, since the earliest failures are the interesting
// ones), then shipped to /api/logs. `trace` also marks each startup milestone
// so a silent death localises to the last line that made it out.

const pendingLogs: Array<{ level: string; message: string; stack?: string }> = []
let logSinkReady = false

/**
 * Which run wrote a line.
 *
 * The host starts this app twice within seconds often enough that the log is
 * two interleaved stories, and until now nothing said which line belonged to
 * which. Worse, `page container created` has been seen printed *before* the
 * `main:` line of the same run — `reportLog` posts without awaiting, so arrival
 * order is not emission order and a reader cannot even rely on adjacency.
 *
 * Four hex characters is enough to separate two runs in one log and short
 * enough to sit on every line.
 */
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
  // Load the server URL from LocalStorage
  let savedUrl = await readStored((key) => bridge.getLocalStorage(key), URL_SUFFIX)
  // Dev mode: use proxy (relative URL) when running via Vite dev server
  if (!savedUrl && location.hostname === 'localhost') {
    savedUrl = location.origin
    await bridge.setLocalStorage(storageKey(URL_SUFFIX), savedUrl)
  }
  if (!savedUrl) {
    // Show setup guide and poll for URL
    await bridge.rebuildPageContainer(buildSetupGuide())
    savedUrl = await new Promise<string>((resolve) => {
      const poll = setInterval(async () => {
        const url = await readStored((key) => bridge.getLocalStorage(key), URL_SUFFIX)
        if (url) {
          clearInterval(poll)
          resolve(url)
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
      void bridge?.setLocalStorage(storageKey(RESUME_SUFFIX), json).catch(() => {})
    },
    async loadState() {
      try {
        return await readStored((key) => bridge.getLocalStorage(key), RESUME_SUFFIX)
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
        void Promise.resolve(bridge.shutDownPageContainer(1)).then((ok) => {
          if (ok === false) trace('shutDownPageContainer refused by host', 'error')
        })
      } catch (err) {
        trace(`shutDownPageContainer failed: ${err}`, 'error', (err as Error)?.stack)
      }
    },
    onForegroundRegained() {
      foreground = true
      trace('foreground: regained — a gesture arrived while we thought we were hidden')
      // Same reasoning as a real ENTER: the panel may have been taken down and
      // put back while we believed we were hidden, so trust nothing about it.
      invalidatePanel()
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

  /**
   * What the glasses themselves are doing, as the host reports it.
   *
   * The heap says the JS is innocent, which is useful and also the end of what
   * the JS can see. Eight deaths were recorded with a flat heap, no uncaught
   * exception, and `host exit: system` — and `system` is the same code the host
   * sends when the wearer confirms its exit dialogue, so the record could not
   * separate "something killed us" from "the glasses were simply taken off".
   *
   * These fields separate them. Off the head, in the case, or a dropped BLE
   * link are all ordinary reasons for the host to stop an app, and none of them
   * are bugs. What remains after they are excluded is the actual problem.
   *
   * Cached rather than fetched at the moment of interest: `onExit` has to
   * finish synchronously, and an exit is exactly when the answer matters most.
   * A beat old is close enough for a state that changes when someone moves.
   */
  /**
   * The device's own state, as the host pushes it.
   *
   * Read from `onDeviceStatusChanged` rather than `getDeviceInfo()`, which
   * returns the bridge's cached record: the SDK says the bridge updates that
   * record and *then* fires `deviceStatusChanged`, so polling it returns
   * whatever initialised it. That is real — `connectType` sits at `none` in the
   * first event and only reaches `connected` on a later one, which polling never
   * saw.
   *
   * It was not, however, the explanation for `isWearing`. Switching to the event
   * was done believing a stale cache was why that field read `false` while the
   * glasses were worn; it still reads `false` on the event, because the cause is
   * in `fromJson` rather than in the delivery — see the note where the flags are
   * assembled.
   *
   * The first status is logged verbatim, though it is worth knowing what that
   * first one is: `createDefault()`'s output, synthesised by the SDK rather than
   * reported by the device (`connectType: 'none'`, `sn: ''`, every number zero).
   * Its arrival proves the subscription works and says nothing about the glasses.
   */
  let deviceNote = ''
  let statusProbed = false
  function applyDeviceStatus(s: {
    connectType?: string
    isWearing?: boolean
    batteryLevel?: number
    isCharging?: boolean
    isInCase?: boolean
    toJson?: () => unknown
  } | undefined): void {
    if (!s) {
      deviceNote = ''
      return
    }
    if (!statusProbed) {
      statusProbed = true
      try {
        trace(`device status first event: ${JSON.stringify(s.toJson?.() ?? s)}`)
      } catch {
        trace('device status first event: (not serialisable)')
      }
    }
    // `none` is the SDK's uninitialised marker, and everything alongside it is
    // `createDefault()`'s filler rather than a reading: zero battery, false
    // flags, empty serial. Reporting that produced `dev=none,off-head batt=0%`
    // on an exit — which reads as a flat battery on glasses that were at 63%.
    // Say nothing until the device has actually spoken.
    if (!s.connectType || s.connectType === 'none') {
      deviceNote = ''
      return
    }
    // `isWearing` is deliberately not reported: `false` here does not mean
    // "not being worn".
    //
    // `DeviceStatus.fromJson` substitutes `false` for a field that arrives
    // absent or null, and the protobuf underneath omits zero values on the wire
    // — so `false` covers both "genuinely not worn" and "the host never filled
    // this in", with nothing to tell them apart. It read `false` across every
    // sample of two runs while the glasses were on the wearer's face, confirmed
    // with them directly.
    //
    // `connectType` moving `none` -> `connected` is not a counter-argument: it
    // is a non-zero string, so it actually travels. `batteryLevel` arriving as
    // 77% rather than the `0` a missing field would produce says that field is
    // populated too. `isWearing` being the one that never moves is exactly what
    // an unpopulated boolean looks like.
    //
    // A field that is always false is worse than an absent one, because it reads
    // as an answer. `off-head` was printed here for one afternoon and in that
    // time produced a confident, wrong conclusion — that nine exits taken while
    // the glasses were being worn were just someone taking them off. Restore it
    // if the raw host push is ever seen to carry the key; until then the exit
    // line should stay silent about wear rather than imply it.
    //
    // `isInCase` and `isCharging` are booleans from the same event and so carry
    // the same ambiguity. Kept because nothing has shown them wrong — not
    // because anything has shown them right.
    const flags = [
      s.isInCase ? 'in-case' : '',
      s.isCharging ? 'charging' : '',
    ].filter(Boolean)
    deviceNote =
      ` dev=${s.connectType ?? '?'}${flags.length ? `,${flags.join(',')}` : ''}` +
      (s.batteryLevel === undefined ? '' : ` batt=${s.batteryLevel}%`)
  }

  // Static identity once, live state by subscription. `model` and `sn` never
  // change; everything that does arrives on the event.
  void (async () => {
    try {
      const info = await bridge.getDeviceInfo()
      trace(`device: model=${info?.model ?? '?'} sn=${info?.sn ?? '?'}`)
    } catch (err) {
      trace(`getDeviceInfo failed: ${err}`, 'error')
    }
  })()
  try {
    bridge.onDeviceStatusChanged((status) => applyDeviceStatus(status))
  } catch (err) {
    // Without this the exit line simply carries no device state, which is the
    // situation before it existed — worth saying so rather than looking flat.
    trace(`onDeviceStatusChanged failed: ${err}`, 'error')
  }

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
    onExit(kind, detail) {
      // `system` is sent both when the wearer confirms the host's exit dialogue
      // and when the host decides on its own — the same code for opposite
      // meanings. Fifteen exits were recorded, every one of them `system`, and
      // this app never asked for a single one, so the interesting question is
      // always which of the two it was.
      //
      // The gesture narrows it: a double-tap moments before says the wearer
      // walked out through the dialogue, silence says something else closed us.
      // `detail` answers it outright — `systemExitReasonCode` and `eventSource`
      // are the host's own account, and both were being thrown away here.
      const g = controller.lastGesture()
      trace(
        `host exit: ${kind} fg=${foreground ? 1 : 0} gesture=${g.kind}@${g.agoMs < 0 ? 'never' : `${Math.round(g.agoMs / 100) / 10}s`}${deviceNote}${detail ?? ''}`,
        'error',
      )
      controller.onHostExit(kind)
    },
    // `display.ts` has always built this string and `main.ts` has never taken
    // it, so every event's shape was being stringified and dropped. Audio and
    // IMU are excluded upstream; what is left is rare enough to log outright,
    // and an exit is usually preceded by something.
    onRawEvent(raw) {
      trace(`event: ${raw}`)
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
      `alive ${((Date.now() - bootAt) / 1000).toFixed(1)}s renders=${renders} writes=${panelWrites()} drops=${panelDrops()} fg=${foreground ? 1 : 0} ws=${controller.ws.getState()}${heapNote()}${deviceNote}`,
    )
  }, HEARTBEAT_MS)
}

// ── Entry point: detect environment ──

async function main(): Promise<void> {
  installCrashReporting()
  // Before initDisplay, so the host's answer to the very first page-container
  // create reaches the log — that call is the one most likely to report a
  // host that has run out of room.
  setPanelTrace((message, level) => trace(`display: ${message}`, level ?? 'info'))
  // The SDK's window.EvenAppBridge stub can exist in a plain desktop browser,
  // so waitForEvenAppBridge() resolving is not proof of the Even Hub WebView.
  // The real Flutter WebView injects `flutter_inappwebview` (its absence is
  // exactly what the SDK's "Flutter handler not available" warning reports) —
  // gate on it, or the browser debug simulator would never start.
  const isEvenHub =
    typeof (window as unknown as Record<string, unknown>).flutter_inappwebview !== 'undefined'
  // `wasDiscarded` is how a reload tells itself apart from a launch. The host
  // starts this app twice within seconds regularly, and the two cases are
  // indistinguishable in the log so far: a genuine second launch, or the same
  // page being discarded under memory pressure and reloaded at the same URL.
  // Page Lifecycle is implemented across Blink, Android WebView included, so
  // the answer is available and was simply not being asked for.
  const lifecycle = (() => {
    const doc = document as Document & { wasDiscarded?: boolean }
    return `discarded=${doc.wasDiscarded ?? '?'} vis=${document.visibilityState}`
  })()
  trace(`main: v${__APP_VERSION__} (${__BUILD_COMMIT__}) isEvenHub=${isEvenHub} ${lifecycle}`)
  // Freeze is the host putting the page aside without tearing it down. If an
  // exit is preceded by one, the sequence is a suspend that never resumed —
  // which is a different failure from being stopped outright.
  document.addEventListener('freeze', () => trace('page: freeze'))
  document.addEventListener('resume', () => trace('page: resume'))
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
