// The host's exit dialogue, once raised - cancelled or not - leaves the
// microphone refused until the app is restarted, and nothing the app calls
// brings it back. The screen has to say restart, because it is the only thing
// that works.

import { describe, expect, test } from 'bun:test'
import { GlassesController, type GlassesPlatform } from '../controller.ts'
import { screenText } from '../display.ts'

function refusingMic(): GlassesPlatform {
  const p = {
    onDevice: false,
    render() {},
    renderHeader() {},
    requestExit() {},
    async startMicCapture() {
      return false
    },
    async stopMicCapture() {},
    async transcribeAudio() {
      return ''
    },
  }
  return p as unknown as GlassesPlatform
}

async function refusedRecording(afterExitDialogue: boolean) {
  const c = new GlassesController(refusingMic())
  const inner = c as unknown as {
    askHostToExit(): void
    startVoice(target: { sessionId: string }): Promise<void>
  }
  if (afterExitDialogue) inner.askHostToExit()
  await inner.startVoice({ sessionId: 'w1' })
  return c.state
}

describe('a microphone the host refuses', () => {
  test('after the exit dialogue, the screen says to restart the app', async () => {
    const state = await refusedRecording(true)
    expect(state.voiceMicFailed).toBe(true)
    expect(screenText(state).body).toContain('Close this app and open it again')
  })

  test('without it, the screen does not send the wearer to restart', async () => {
    const state = await refusedRecording(false)
    expect(state.voiceMicFailed).toBe(true)
    expect(screenText(state).body).not.toContain('open it again')
    expect(screenText(state).body).toContain('Nothing was listening')
  })
})
