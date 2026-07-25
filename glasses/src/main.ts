// Entry point: environment detection + G2 wiring.
//
// All app logic (relay queue, state machine, ring handlers) lives in
// controller.ts and is shared with the browser debug simulator (debug-ui.ts);
// this file only provides the G2 platform (Even Hub bridge rendering, mic,
// Groq STT) and the LocalStorage URL setup flow.

import { getDashboard, setBaseUrl, transcribe } from './api.ts'
import { initDisplay, updateDisplay, setupEvents, buildSetupGuide, startMic, stopMic } from './display.ts'
import { GlassesController } from './controller.ts'
import type { GlassesPlatform } from './controller.ts'
import { startPhoneUI } from './phone-ui.ts'
import { startDebugUI } from './debug-ui.ts'

const LS_KEY = 'cchub-url'
const POLL_INTERVAL = 5000
const MIC_SAMPLE_RATE = 16000

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

  const platform: GlassesPlatform = {
    render(state) {
      void updateDisplay(bridge, state)
    },
    startMicCapture: () => startMic(bridge),
    stopMicCapture: () => stopMic(bridge),
    transcribeAudio: (pcm) => transcribe(pcm, MIC_SAMPLE_RATE),
  }
  const controller = new GlassesController(platform)
  controller.connect()
  platform.render(controller.state)

  setupEvents(bridge, {
    onSwipeDown: () => controller.swipeDown(),
    onSwipeUp: () => controller.swipeUp(),
    onTap: () => controller.tap(),
    onDoubleTap: () => controller.doubleTap(),
    onAudioData: (pcm) => controller.onAudioData(pcm),
  })

  // Poll dashboard for API usage
  const pollUsage = async () => {
    try {
      const dashRes = await getDashboard()
      if (dashRes.usageLimits) controller.setApiUsage(`${dashRes.usageLimits.fiveHour.utilization}%`)
    } catch { /* ignore */ }
  }
  await pollUsage()
  setInterval(pollUsage, POLL_INTERVAL)
}

// ── Entry point: detect environment ──

async function main(): Promise<void> {
  // The SDK's window.EvenAppBridge stub can exist in a plain desktop browser,
  // so waitForEvenAppBridge() resolving is not proof of the Even Hub WebView.
  // The real Flutter WebView injects `flutter_inappwebview` (its absence is
  // exactly what the SDK's "Flutter handler not available" warning reports) —
  // gate on it, or the browser debug simulator would never start.
  const isEvenHub =
    typeof (window as unknown as Record<string, unknown>).flutter_inappwebview !== 'undefined'
  const bridge = isEvenHub ? await initDisplay() : null

  if (bridge) {
    // Even Hub environment — check launch source
    bridge.onLaunchSource((source) => {
      if (source === 'appMenu') {
        startPhoneUI(bridge)
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

main().catch(console.error)
