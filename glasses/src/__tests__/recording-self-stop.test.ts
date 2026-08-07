// A recording stops itself after MAX_RECORDING_MS.
//
// Spoken instructions to an agent are a sentence or two, so an open microphone
// is far more likely to be one somebody forgot to stop than one still being
// spoken into - and left open it spends battery, upload and Groq quota to
// produce a transcript with a minute of room noise on the end.
//
// The timer is caught rather than waited for: half a minute of real time per
// assertion is not a test anyone runs.

import { afterEach, describe, expect, test } from 'bun:test'
import { GlassesController, type GlassesPlatform } from '../controller.ts'
import { MAX_RECORDING_MS, screenText } from '../display.ts'

const realSetTimeout = globalThis.setTimeout

afterEach(() => {
  globalThis.setTimeout = realSetTimeout
})

/** Hold the self-stop callback instead of scheduling it. */
function catchRecordTimer(): { fire(): void; armed(): boolean; cleared(): boolean } {
  let pending: (() => void) | null = null
  let handle = 0
  let clearedHandle = false
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if (ms === MAX_RECORDING_MS) {
      pending = fn
      handle = 12345
      return handle
    }
    return realSetTimeout(fn, ms)
  }) as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((h?: unknown) => {
    if (h === handle && handle !== 0) clearedHandle = true
    else realClear(h as Parameters<typeof globalThis.clearTimeout>[0])
  }) as typeof globalThis.clearTimeout
  return {
    fire: () => pending?.(),
    armed: () => pending !== null,
    cleared: () => clearedHandle,
  }
}

function platform(counters: { transcribes: number; micStops: number }): GlassesPlatform {
  const p = {
    onDevice: false,
    render() {},
    renderHeader() {},
    requestExit() {},
    async startMicCapture() {
      return true
    },
    async stopMicCapture() {
      counters.micStops++
    },
    async transcribeAudio() {
      counters.transcribes++
      return 'リリースして'
    },
  }
  return p as unknown as GlassesPlatform
}

function driver(c: GlassesController) {
  return c as unknown as {
    startVoice(target: { sessionId: string }): Promise<void>
    stopAndTranscribe(): Promise<void>
    cancelVoice(): Promise<void>
    shutdown(): void
  }
}

describe('a recording nobody stopped', () => {
  test('stops itself and transcribes what it has', async () => {
    const counters = { transcribes: 0, micStops: 0 }
    const timer = catchRecordTimer()
    const c = new GlassesController(platform(counters))
    await driver(c).startVoice({ sessionId: 'w1' })
    expect(timer.armed()).toBe(true)
    expect(counters.transcribes).toBe(0)

    timer.fire()
    await Promise.resolve()
    await new Promise((r) => realSetTimeout(r, 0))

    expect(counters.micStops).toBe(1)
    expect(counters.transcribes).toBe(1)
    expect(c.state.voicePhase).toBe('confirm')
    expect(c.state.voiceText).toBe('リリースして')
  })

  test('the screen says it will, rather than counting down to it', () => {
    // A countdown means redrawing the panel over BLE every second for the whole
    // recording, which is what the slow spinner exists to avoid.
    const body = screenText({
      mode: 'voice',
      voicePhase: 'recording',
      sessions: [],
      sessionIndex: 0,
    } as unknown as Parameters<typeof screenText>[0]).body
    expect(body).toContain('30 seconds')
  })
})

describe('the self-stop is disarmed by everything that ends a recording', () => {
  test('a manual stop', async () => {
    const counters = { transcribes: 0, micStops: 0 }
    const timer = catchRecordTimer()
    const c = new GlassesController(platform(counters))
    await driver(c).startVoice({ sessionId: 'w1' })
    await driver(c).stopAndTranscribe()
    expect(timer.cleared()).toBe(true)
    // Firing a stale timer must not transcribe a second time.
    timer.fire()
    await new Promise((r) => realSetTimeout(r, 0))
    expect(counters.transcribes).toBe(1)
  })

  test('a cancel', async () => {
    const counters = { transcribes: 0, micStops: 0 }
    const timer = catchRecordTimer()
    const c = new GlassesController(platform(counters))
    await driver(c).startVoice({ sessionId: 'w1' })
    await driver(c).cancelVoice()
    expect(timer.cleared()).toBe(true)
    timer.fire()
    await new Promise((r) => realSetTimeout(r, 0))
    expect(counters.transcribes).toBe(0)
  })

  test('the host tearing the run down', async () => {
    const counters = { transcribes: 0, micStops: 0 }
    const timer = catchRecordTimer()
    const c = new GlassesController(platform(counters))
    await driver(c).startVoice({ sessionId: 'w1' })
    driver(c).shutdown()
    expect(timer.cleared()).toBe(true)
  })
})

describe('a microphone that would not open', () => {
  test('arms nothing', async () => {
    const counters = { transcribes: 0, micStops: 0 }
    const timer = catchRecordTimer()
    const p = platform(counters) as GlassesPlatform & { startMicCapture(): Promise<boolean> }
    p.startMicCapture = async () => false
    const c = new GlassesController(p)
    await driver(c).startVoice({ sessionId: 'w1' })
    expect(timer.armed()).toBe(false)
    expect(c.state.voicePhase).toBe('confirm')
  })
})
