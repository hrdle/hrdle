// Entry point: environment detection + G2 wiring.
//
// All app logic (relay queue, state machine, ring handlers) lives in
// controller.ts and is shared with the browser debug simulator (debug-ui.ts);
// this file only provides the G2 platform (Even Hub bridge rendering, mic,
// Groq STT) and the LocalStorage URL setup flow.

import { setBaseUrl, transcribe, reportLog } from './api.ts'
import { initDisplay, updateDisplay, updateHeader, setupEvents, buildSetupGuide, screenText, panelWrites, panelDrops, setPanelTrace, invalidatePanel, startMic, stopMic } from './display.ts'
import type { AppState, Bridge } from './display.ts'
import { GlassesController } from './controller.ts'
import { createSetupGate } from './setup-gate.ts'
import type { GlassesPlatform } from './controller.ts'
import { startPhoneUI } from './phone-ui.ts'
import { startDebugUI } from './debug-ui.ts'
import { startPlayerUI } from './player-ui.ts'
import { readStored, storageKey } from './storage.ts'
import { DriftMonitor } from './drift.ts'

const URL_SUFFIX = 'url'
const MIC_SAMPLE_RATE = 16000
// Fine enough to see lateness building before the beat that would have shown it.
const DRIFT_TICK_MS = 1000
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
  /** Set once the host has taken the app down; see `releaseHostResources`. */
  let stopped = false

  async function drainRenders(): Promise<void> {
    while (pending && !stopped) {
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
    if (stopped) return
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
      const { header, body, footer, notice, card, headerless } = screenText(state)
      // The session under the cursor, as data: the recording (#127) groups by
      // it, and the header string is for eyes, not for parsing back apart.
      const cursor = state.sessions[state.sessionIndex]
      const session =
        cursor && !state.listOnNotifications
          ? {
              id: cursor.id,
              name: cursor.customTitle ?? cursor.name,
              ...(state.selectedPaneId ? { paneId: state.selectedPaneId } : {}),
            }
          : undefined
      const key = `${state.mode}\u0000${session?.id ?? ''}\u0000${session?.paneId ?? ''}\u0000${header}\u0000${notice ?? ''}\u0000${body}\u0000${footer}\u0000${card ? '1' : ''}\u0000${headerless ? '1' : ''}`
      if (key === lastPublished) return
      lastPublished = key
      controller.ws.publishScreen({ header, body, footer, notice, card, headerless, mode: state.mode, session, at: Date.now() })
    } catch (err) {
      // A mirror is a nicety; never let it take the panel down with it.
      trace(`publishScreen failed: ${err}`, 'error', (err as Error)?.stack)
    }
  }

  const platform: GlassesPlatform = {
    // startGlassesMode only runs with a real Even Hub bridge.
    onDevice: true,
    // The same id every log line carries, so "superseded by 0e3f" names a run
    // whose story is already in the log.
    instanceId: RUN_ID,
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
    transcribeAudio: (pcm, sessionId) => transcribe(pcm, MIC_SAMPLE_RATE, sessionId),
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
    exitNow() {
      // Mode 0 — no dialogue. `requestExit` uses mode 1 because a double-tap is
      // the wearer asking and they are allowed to change their mind; this is
      // the run reporting that it has nothing left to do, and a cancelled exit
      // would leave it exactly as unreachable as it already was.
      //
      // Released here rather than waiting for `SYSTEM_EXIT_EVENT`: the event
      // may not arrive at all for an exit we asked for, and everything this
      // holds is already useless.
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
    onSuperseded() {
      // Same release as a host exit, and for the same reason: nothing this run
      // does from here reaches anybody. The panel belongs to the newer instance.
      releaseHostResources()
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
  if (!savedUrl) {
    // Show setup guide and poll for URL
    await bridge.rebuildPageContainer(buildSetupGuide())
    // The ring, while we wait.
    //
    // Everything below this point - the controller, the gestures, the way out -
    // is behind an await that only resolves once a server address exists. So a
    // wearer who has not set one up yet sat on this screen with no working
    // input of any kind: not a tap, not a swipe, and no way to close the app.
    // An Even Hub reviewer, who has no server at all, met exactly that and
    // reported it as double-tap failing to bring up the exit dialog (#148).
    //
    // A double-tap is the way out of every screen in this app; it has to be the
    // way out of the first one. Torn down as soon as the address arrives, so
    // the real wiring below is the only handler from then on.
    const gate = createSetupGate({
      startDemo: () => controller.startDemo(),
      stopDemo: () => controller.stopDemo(),
      tap: () => controller.tap(),
      doubleTap: () => controller.doubleTap(),
      swipeUp: () => controller.swipeUp(),
      swipeDown: () => controller.swipeDown(),
      invalidatePanel,
      trace: (m) => trace(m),
      requestExit: () => {
        try {
          void Promise.resolve(bridge.shutDownPageContainer(1)).then((ok) => {
            if (ok === false) trace('shutDownPageContainer refused by host', 'error')
          })
        } catch (err) {
          trace(`shutDownPageContainer failed: ${err}`, 'error', (err as Error)?.stack)
        }
      },
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
      // Not optional, and not only tidiness: `demo` is a flag on the state the
      // real app is about to draw from, so a run that passed through the demo
      // kept the DEMO tail over live workspaces for the rest of its life.
      gate.close()
    }
  }

  setBaseUrl(savedUrl)
  flushLogs() // hub URL known — everything buffered so far can now be shipped
  trace(`glasses mode: url=${savedUrl}`)

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
  let lastConnect: string | undefined
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
    // Whether it ever moves off `none`. The first event is traced already, and
    // it has been `none` in every run looked at - so the fields behind it are
    // `createDefault()`'s filler and the exit line has been silent about the
    // glasses this whole time. Only a transition would change that, and only a
    // line here would show one.
    if (s.connectType !== lastConnect) {
      trace(`device status: connectType ${lastConnect ?? '(first)'} -> ${s.connectType ?? '?'}`)
      lastConnect = s.connectType
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

  /**
   * The phone's power state, beside every heartbeat and on the exit line.
   *
   * Whatever closes this app runs on the phone, so whether the phone is on a
   * charger - and how full it is - are variables the record has been missing
   * while every other one was ruled out. The glasses' own reading is the
   * obvious thing to reach for and is not available: `onDeviceStatusChanged`
   * has only ever delivered `connectType: "none"` with `createDefault()`'s
   * filler behind it, which is why `dev=` and `batt=` never appear.
   *
   * The Battery Status API is deprecated on the open web and still implemented
   * in Chromium on Android, which is what this WebView is. Where it is missing
   * the note is simply absent, as it was before.
   */
  let powerNote = ''
  type BatteryLike = {
    charging: boolean
    level: number
    addEventListener(type: string, listener: () => void): void
  }
  void (async () => {
    try {
      const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }
      if (!nav.getBattery) {
        trace('battery: getBattery unavailable')
        return
      }
      const battery = await nav.getBattery()
      const apply = (): void => {
        powerNote = ` pwr=${battery.charging ? 'chg' : 'bat'},${Math.round(battery.level * 100)}%`
      }
      apply()
      trace(`battery: ${battery.charging ? 'charging' : 'on battery'} ${Math.round(battery.level * 100)}%`)
      // Both, and both worth a line: a charger going in mid-run is exactly the
      // kind of change the kill rate is being compared against.
      battery.addEventListener('chargingchange', () => {
        apply()
        trace(`battery: ${battery.charging ? 'charger in' : 'charger out'} ${Math.round(battery.level * 100)}%`)
      })
      battery.addEventListener('levelchange', apply)
    } catch (err) {
      trace(`battery: ${err}`, 'error')
    }
  })()

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
  // Held, not discarded: the SDK returns an unsubscribe function from every
  // subscription and this one was throwing it away, so the handler outlived the
  // app it was reporting to.
  let unsubDeviceStatus: (() => void) | null = null
  try {
    unsubDeviceStatus = bridge.onDeviceStatusChanged((status) => applyDeviceStatus(status))
  } catch (err) {
    // Without this the exit line simply carries no device state, which is the
    // situation before it existed — worth saying so rather than looking flat.
    trace(`onDeviceStatusChanged failed: ${err}`, 'error')
  }

  let unsubEvents: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let driftTick: ReturnType<typeof setInterval> | null = null

  /**
   * Hand back everything this file took from the host.
   *
   * Runs only from the exit events, never from `requestExit` — that one asks the
   * host for its confirmation dialogue, which the wearer is free to cancel, and
   * tearing down at the point of asking would leave a live app with no clocks
   * and no subscriptions.
   *
   * The controller's own release (sockets, its two clocks, the microphone) is
   * `controller.onHostExit`; this is the part main.ts owns. Both together are
   * what the metric asks for: not one line in the log carrying this run's id
   * after its `host exit`.
   */
  function releaseHostResources(): void {
    if (stopped) return
    stopped = true
    pending = null
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
    if (driftTick) {
      clearInterval(driftTick)
      driftTick = null
    }
    for (const unsub of [unsubEvents, unsubDeviceStatus]) {
      try {
        unsub?.()
      } catch { /* on the way out; a failed unsubscribe is not worth reporting */ }
    }
    unsubEvents = null
    unsubDeviceStatus = null
  }

  unsubEvents = setupEvents(bridge, {
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
        `host exit: ${kind} fg=${foreground ? 1 : 0} gesture=${g.kind}@${g.agoMs < 0 ? 'never' : `${Math.round(g.agoMs / 100) / 10}s`}${powerNote}${deviceNote}${detail ?? ''}`,
        'error',
      )
      // Traced first, released second: this is the last line the run gets to
      // write, and the release stops the clock that would otherwise date it.
      controller.onHostExit(kind)
      releaseHostResources()
    },
    // `display.ts` has always built this string and `main.ts` has never taken
    // it, so every event's shape was being stringified and dropped. Audio and
    // IMU are excluded upstream; what is left is rare enough to log outright,
    // and an exit is usually preceded by something.
    onRawEvent(raw) {
      trace(`event: ${raw}`)
    },
    // Each gesture is also published for the recording (#129) before it acts,
    // so a replayed gesture marker lands just ahead of the frame it caused.
    // publishInput never throws (send() swallows a dead socket), and the
    // simulator has no path here - its ring buttons are not the wearer.
    onSwipeDown: () => {
      controller.ws.publishInput('swipeDown')
      controller.swipeDown()
    },
    onSwipeUp: () => {
      controller.ws.publishInput('swipeUp')
      controller.swipeUp()
    },
    onTap: () => {
      controller.ws.publishInput('tap')
      controller.tap()
    },
    onDoubleTap: () => {
      controller.ws.publishInput('doubleTap')
      controller.doubleTap()
    },
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

  // How late the timers are.
  //
  // Every exit with a measurable last heartbeat interval had a stretched one —
  // one run beat at exactly 30.0s twenty times over and then produced a single
  // interval of 53.7s before the host closed it, with the panel drawing
  // successfully throughout. A 30-second beat cannot resolve that any further:
  // it only notices lateness that pushes a beat past the next boundary, and a run
  // starved and killed inside one interval leaves nothing behind.
  //
  // This tick's own lateness is the measurement. `DriftMonitor` decides what is
  // worth a line — an episode's start goes out immediately, so a run that dies
  // two seconds later still leaves the onset in the log.
  const drift = new DriftMonitor(bootAt, DRIFT_TICK_MS)
  driftTick = setInterval(() => {
    for (const line of drift.tick(Date.now())) trace(line, 'error')
  }, DRIFT_TICK_MS)

  heartbeat = setInterval(() => {
    trace(
      `alive ${((Date.now() - bootAt) / 1000).toFixed(1)}s renders=${renders} writes=${panelWrites()} drops=${panelDrops()} fg=${foreground ? 1 : 0} ws=${controller.ws.getState()}${heapNote()}${powerNote}${deviceNote}${drift.note()}`,
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
  // Even Hub environment — check launch source.
  //
  // Handed to `initDisplay` rather than registered after it, because the host
  // pushes the launch source once when loading completes and the SDK stores no
  // copy: `onLaunchSource` is an event subscription with no cached getter
  // beside it, so whatever is not listening at that moment never finds out.
  // Registering after `initDisplay` meant waiting out the startup container's
  // round trip to the host first, and three runs on 2026-07-31 reached
  // `startup complete` with no launch source at all.
  //
  // One launch, one answer: the subscription is released as soon as it arrives
  // rather than left open for the life of the app, which is what the SDK asks
  // for and what nothing here was doing.
  let unsubLaunch: (() => void) | null = null
  function subscribeLaunchSource(b: Bridge): void {
    unsubLaunch = b.onLaunchSource((source) => {
      // Which path was taken matters: launching from the phone runs the
      // companion UI AND the glasses mode at once, and only that case has
      // been reported as dying seconds after startup.
      trace(`launchSource=${source}`)
      if (source === 'appMenu') {
        startPhoneUI(b)
          .then(() => trace('phone UI ready'))
          .catch((err) => trace(`phone UI failed: ${err}`, 'error', (err as Error)?.stack))
      }
      // glassesMenu: glasses mode starts either way, below
      try {
        unsubLaunch?.()
      } catch { /* nothing left to release */ }
      unsubLaunch = null
    })
  }

  const bridge = isEvenHub ? await initDisplay(subscribeLaunchSource) : null
  trace(`bridge=${bridge ? 'ready' : 'null'}`)

  if (bridge) {
    // Always start glasses mode (bridge exists = Even Hub)
    await startGlassesMode(bridge)
  } else if (new URLSearchParams(location.search).has('phone')) {
    // The phone companion UI without a device.
    //
    // On the G2 this screen is reachable only through the Even Hub app menu, so
    // every wording change in a nine-screen setup wizard would otherwise cost an
    // ehpk build and a launch on real hardware. Same reasoning as the glasses
    // simulator below, and the same rule applies: this is where it is checked
    // first, never where it is checked last.
    trace('phone UI (browser)')
    startPhoneUI(null)
      .then(() => trace('phone UI ready'))
      .catch((err) => trace(`phone UI failed: ${err}`, 'error', (err as Error)?.stack))
  } else if (new URLSearchParams(location.search).has('player')) {
    // The recording replay player - its own page, so the transport controls
    // sit under the screen instead of a side panel away (#127).
    trace('player UI (browser)')
    startPlayerUI()
  } else {
    // Browser debug mode
    startDebugUI()
  }
}

main().catch((err) => {
  console.error(err)
  trace(`main() rejected: ${err}`, 'error', (err as Error)?.stack)
})
