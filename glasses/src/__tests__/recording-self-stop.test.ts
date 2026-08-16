// A microphone nobody is speaking into closes itself after IDLE_STOP_MS.
//
// The recording itself is not capped: a long instruction, or a pause to think
// in the middle of one, must not be the thing that ends it. What is capped is
// silence, because an open microphone left running spends the wearer's battery
// and the upload to collect room noise.
//
// The timer is caught rather than waited for: half a minute of real time per
// assertion is not a test anyone runs.

import { afterEach, describe, expect, test } from 'bun:test'
import { GlassesController, MIC_SAMPLE_RATE, type GlassesPlatform } from '../controller.ts'
import { IDLE_STOP_MS, screenText } from '../display.ts'

const realSetTimeout = globalThis.setTimeout

afterEach(() => {
  globalThis.setTimeout = realSetTimeout
})

/** Hold the idle-stop callback instead of scheduling it. */
function catchRecordTimer(): {
  fire(): void
  armed(): boolean
  cleared(): boolean
  arms(): number
} {
  let pending: (() => void) | null = null
  let handle = 0
  let clearedHandle = false
  let armCount = 0
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if (ms === IDLE_STOP_MS) {
      pending = fn
      handle = 12345
      armCount++
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
    arms: () => armCount,
  }
}

/** A second of ordinary speech. */
function speech(): Uint8Array {
  const out = new Uint8Array(MIC_SAMPLE_RATE * 2)
  for (let i = 0; i < MIC_SAMPLE_RATE; i++) {
    const v = i % 2 === 0 ? 4000 : -4000
    out[i * 2] = v & 0xff
    out[i * 2 + 1] = (v >> 8) & 0xff
  }
  return out
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
    onAudioData(pcm: Uint8Array): void
    stopAndTranscribe(): Promise<void>
    cancelVoice(): Promise<void>
    shutdown(): void
  }
}

describe('a microphone nobody is speaking into', () => {
  test('closes itself and transcribes what was said', async () => {
    const counters = { transcribes: 0, micStops: 0 }
    const timer = catchRecordTimer()
    const c = new GlassesController(platform(counters))
    await driver(c).startVoice({ sessionId: 'w1' })
    driver(c).onAudioData(speech())
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

  test('starts its wait again on every word', async () => {
    // Otherwise the wait would be a cap on the recording after all, and a
    // dictated instruction longer than it would be cut off mid-sentence.
    const counters = { transcribes: 0, micStops: 0 }
    const timer = catchRecordTimer()
    const c = new GlassesController(platform(counters))
    await driver(c).startVoice({ sessionId: 'w1' })
    expect(timer.arms()).toBe(1)

    driver(c).onAudioData(speech())
    driver(c).onAudioData(speech())

    expect(timer.arms()).toBe(3)
    expect(timer.armed()).toBe(true)
  })

  test('the screen says the number rather than counting down to it', () => {
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

describe('the idle stop is disarmed by everything that ends a recording', () => {
  test('a manual stop', async () => {
    const counters = { transcribes: 0, micStops: 0 }
    const timer = catchRecordTimer()
    const c = new GlassesController(platform(counters))
    await driver(c).startVoice({ sessionId: 'w1' })
    driver(c).onAudioData(speech())
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
