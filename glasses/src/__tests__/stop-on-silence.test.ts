// A recording ends when the sentence does.
//
// The 30-second limit closes a microphone nobody closed; this closes one that
// has finished being spoken into, which is the ordinary case. Both end the same
// way - transcribe what was collected - so there is only one path to be right.
//
// Silence is counted in samples rather than milliseconds, so these tests feed
// chunks and never touch a clock.

import { describe, expect, test } from 'bun:test'
import { GlassesController, MIC_SAMPLE_RATE, type GlassesPlatform, pcmRms } from '../controller.ts'

/** `samples` of 16-bit PCM at a given amplitude. */
function pcm(samples: number, amplitude: number): Uint8Array {
  const out = new Uint8Array(samples * 2)
  for (let i = 0; i < samples; i++) {
    // Alternating, so the RMS is the amplitude rather than a DC offset.
    const v = i % 2 === 0 ? amplitude : -amplitude
    out[i * 2] = v & 0xff
    out[i * 2 + 1] = (v >> 8) & 0xff
  }
  return out
}

const QUIET = 40 // a still room
const SPEECH = 4000 // an ordinary voice

function platform(counters: { transcribes: number; sent: number[] }): GlassesPlatform {
  const p = {
    onDevice: false,
    render() {},
    renderHeader() {},
    requestExit() {},
    async startMicCapture() {
      return true
    },
    async stopMicCapture() {},
    async transcribeAudio(audio: Uint8Array) {
      counters.transcribes++
      counters.sent.push(audio.length)
      return 'リリースして'
    },
  }
  return p as unknown as GlassesPlatform
}

function driver(c: GlassesController) {
  return c as unknown as {
    startVoice(target: { sessionId: string }): Promise<void>
    onAudioData(pcm: Uint8Array): void
    cancelVoice(): Promise<void>
  }
}

/** Quarter-second chunks, the shape a host actually delivers. */
const CHUNK = MIC_SAMPLE_RATE / 4

describe('pcmRms', () => {
  test('reads the bytes as signed, so loud audio is loud', () => {
    // Read as unsigned, every negative sample becomes enormous and nothing is
    // ever quiet - the detector would then never fire.
    expect(pcmRms(pcm(1000, 4000))).toBeCloseTo(4000, 0)
    expect(pcmRms(pcm(1000, 40))).toBeCloseTo(40, 0)
    expect(pcmRms(new Uint8Array(0))).toBe(0)
  })
})

describe('a recording that has finished being spoken into', () => {
  test('stops after the speech is followed by quiet', async () => {
    const counters = { transcribes: 0, sent: [] as number[] }
    const c = new GlassesController(platform(counters))
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    d.onAudioData(pcm(CHUNK, SPEECH))
    d.onAudioData(pcm(CHUNK, SPEECH))
    expect(counters.transcribes).toBe(0)

    // 1.5s of quiet, a quarter-second at a time.
    for (let i = 0; i < 6; i++) d.onAudioData(pcm(CHUNK, QUIET))
    await new Promise((r) => setTimeout(r, 0))

    expect(counters.transcribes).toBe(1)
    expect(c.state.voicePhase).toBe('confirm')
    expect(c.state.voiceText).toBe('リリースして')
  })

  test('the audio sent includes the speech, not only the tail', async () => {
    const counters = { transcribes: 0, sent: [] as number[] }
    const c = new GlassesController(platform(counters))
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    d.onAudioData(pcm(CHUNK, SPEECH))
    for (let i = 0; i < 6; i++) d.onAudioData(pcm(CHUNK, QUIET))
    await new Promise((r) => setTimeout(r, 0))
    expect(counters.sent[0]).toBe(CHUNK * 2 * 7)
  })

  test('a pause mid-sentence does not end it', async () => {
    const counters = { transcribes: 0, sent: [] as number[] }
    const c = new GlassesController(platform(counters))
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    d.onAudioData(pcm(CHUNK, SPEECH))
    // A second of quiet - drawing breath - then more speech.
    for (let i = 0; i < 4; i++) d.onAudioData(pcm(CHUNK, QUIET))
    d.onAudioData(pcm(CHUNK, SPEECH))
    for (let i = 0; i < 4; i++) d.onAudioData(pcm(CHUNK, QUIET))
    await new Promise((r) => setTimeout(r, 0))
    expect(counters.transcribes).toBe(0)
  })
})

describe('quiet before anyone has spoken', () => {
  test('does not end the recording', async () => {
    // Tap, then take a moment to think. Cutting that off would be worse than
    // the open microphone this feature exists to close.
    const counters = { transcribes: 0, sent: [] as number[] }
    const c = new GlassesController(platform(counters))
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    for (let i = 0; i < 40; i++) d.onAudioData(pcm(CHUNK, QUIET)) // 10 seconds
    await new Promise((r) => setTimeout(r, 0))
    expect(counters.transcribes).toBe(0)
    expect(c.state.voicePhase).toBe('recording')
  })
})

describe('the detector does not leak between recordings', () => {
  test('a fresh recording starts having heard nothing', async () => {
    const counters = { transcribes: 0, sent: [] as number[] }
    const c = new GlassesController(platform(counters))
    const d = driver(c)

    await d.startVoice({ sessionId: 'w1' })
    d.onAudioData(pcm(CHUNK, SPEECH))
    await d.cancelVoice()

    // Second recording: opening quiet must not be read as the end of the
    // first recording's sentence.
    await d.startVoice({ sessionId: 'w1' })
    for (let i = 0; i < 8; i++) d.onAudioData(pcm(CHUNK, QUIET))
    await new Promise((r) => setTimeout(r, 0))
    expect(counters.transcribes).toBe(0)
    expect(c.state.voicePhase).toBe('recording')
  })
})
