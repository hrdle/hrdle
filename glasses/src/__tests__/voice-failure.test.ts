// A transcription that never came back, told apart from one that came back
// empty (#209).
//
// These read identically until now - "(nothing was recognized)" for both - and
// they are not the same news. A clear recording of silence is answered by
// saying something; a request cut off mid-upload is answered by saying it
// again at all. The 10-second HTTP idle timeout that prompted this was turning
// every long recording on a slow link into the first message.

import { describe, expect, test } from 'bun:test'
import { GlassesController, type GlassesPlatform } from '../controller.ts'
import { screenText } from '../display.ts'

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
    stopAndTranscribe(): Promise<void>
  }
  await inner.startVoice({ sessionId: 'w1' })
  await inner.stopAndTranscribe()
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
    await inner.stopAndTranscribe()
    expect(c.state.voiceFailed).toBe(false)
  })
})
