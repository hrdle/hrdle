// A transcription that never came back, told apart from one that came back
// empty.
//
// These read identically until now - "(nothing was recognized)" for both - and
// they are not the same news. A clear recording of silence is answered by
// saying something; a request cut off mid-upload is answered by saying it
// again at all. The 10-second HTTP idle timeout that prompted this was turning
// every long recording on a slow link into the first message.

import { describe, expect, test } from 'bun:test'
import { GlassesController, MIC_SAMPLE_RATE, type GlassesPlatform } from '../controller.ts'
import { screenText } from '../display.ts'

/** A second of ordinary speech, so the recording has a phrase in it to send. */
function speech(): Uint8Array {
  const out = new Uint8Array(MIC_SAMPLE_RATE * 2)
  for (let i = 0; i < MIC_SAMPLE_RATE; i++) {
    const v = i % 2 === 0 ? 4000 : -4000
    out[i * 2] = v & 0xff
    out[i * 2 + 1] = (v >> 8) & 0xff
  }
  return out
}

function platform(transcribe: () => Promise<string>): GlassesPlatform {
  const p = {
    onDevice: false,
    render() {},
    renderHeader() {},
    requestExit() {},
    async startMicCapture() {
      return true
    },
    async stopMicCapture() {},
    transcribeAudio: transcribe,
  }
  return p as unknown as GlassesPlatform
}

/** Drive one recording to its confirm screen and hand back the state. */
async function record(transcribe: () => Promise<string>) {
  const c = new GlassesController(platform(transcribe))
  const inner = c as unknown as {
    startVoice(target: { sessionId: string }): Promise<void>
    onAudioData(pcm: Uint8Array): void
    stopAndTranscribe(): Promise<void>
  }
  await inner.startVoice({ sessionId: 'w1' })
  inner.onAudioData(speech())
  await inner.stopAndTranscribe()
  // The phrase is transcribed after the recording has been stopped, so the
  // screen it produces is one turn behind the stop.
  await new Promise((r) => setTimeout(r, 0))
  return c.state
}

describe('a transcription that did not come back', () => {
  test('says so, rather than reporting silence', async () => {
    const state = await record(async () => {
      throw new Error('STT 500')
    })
    expect(state.voicePhase).toBe('confirm')
    expect(state.voiceFailed).toBe(true)
    const body = screenText(state).body
    expect(body).toContain('did not come back')
    expect(body).not.toContain('nothing was recognized')
  })

  test('an empty transcript still reports silence', async () => {
    const state = await record(async () => '')
    expect(state.voiceFailed).toBe(false)
    expect(screenText(state).body).toContain('nothing was recognized')
  })

  test('a recognized phrase is unaffected', async () => {
    const state = await record(async () => 'リリースして')
    expect(state.voiceFailed).toBe(false)
    expect(screenText(state).body).toContain('リリースして')
  })

  test('the flag does not survive into the next recording', async () => {
    // Otherwise one failure would explain away every silence after it.
    const c = new GlassesController(platform(async () => ''))
    const inner = c as unknown as {
      startVoice(target: { sessionId: string }): Promise<void>
      stopAndTranscribe(): Promise<void>
    }
    c.state.voiceFailed = true
    await inner.startVoice({ sessionId: 'w1' })
    expect(c.state.voiceFailed).toBe(false)
    ;(inner as unknown as { onAudioData(pcm: Uint8Array): void }).onAudioData(speech())
    await inner.stopAndTranscribe()
    await new Promise((r) => setTimeout(r, 0))
    expect(c.state.voiceFailed).toBe(false)
  })
})
