// A recording is a draft being built out of phrases, not one shot at a sentence.
//
// A pause closes a phrase and sends it while the microphone stays open, so the
// words appear as they are spoken and the wearer can take the last one back.
// Everything here is decided from the audio itself, so these tests feed chunks
// and never touch a clock.

import { describe, expect, test } from 'bun:test'
import { GlassesController, MIC_SAMPLE_RATE, type GlassesPlatform, trimSilence } from '../controller.ts'
import { invalidatePanel, screenText, updateDisplay, updateHeader } from '../display.ts'
import { BODY_WIDTH, MAX_LINES, splitLines, textWidth } from '../metrics.ts'

/** `samples` of 16-bit PCM at a given amplitude. */
function pcm(samples: number, amplitude: number): Uint8Array {
  const out = new Uint8Array(samples * 2)
  for (let i = 0; i < samples; i++) {
    const v = i % 2 === 0 ? amplitude : -amplitude
    out[i * 2] = v & 0xff
    out[i * 2 + 1] = (v >> 8) & 0xff
  }
  return out
}

const QUIET = 40 // a still room
const SPEECH = 4000 // an ordinary voice

/** Quarter-second chunks, the shape a host actually delivers. */
const CHUNK = MIC_SAMPLE_RATE / 4
/** Enough chunks to clear the ten-second floor a phrase has to reach. */
const TEN_SECONDS = 40
/** The quiet that closes a phrase (1.5s). */
const TAIL = 6

interface Recorder {
  /** One entry per transcription request, in the order they were made. */
  calls: Uint8Array[]
  micStops: number
  /** Answer request `n`. Left unanswered, the phrase stays pending. */
  answer(n: number, text: string): Promise<void>
  fail(n: number): Promise<void>
}

function platform(): { platform: GlassesPlatform; rec: Recorder } {
  const calls: Uint8Array[] = []
  const settle: Array<{ resolve(t: string): void; reject(e: Error): void }> = []
  const rec: Recorder = {
    calls,
    micStops: 0,
    async answer(n, text) {
      settle[n].resolve(text)
      await flush()
    },
    async fail(n) {
      settle[n].reject(new Error('no'))
      await flush()
    },
  }
  const p = {
    onDevice: false,
    render() {},
    renderHeader() {},
    requestExit() {},
    async startMicCapture() {
      return true
    },
    async stopMicCapture() {
      rec.micStops++
    },
    transcribeAudio(audio: Uint8Array) {
      calls.push(audio)
      return new Promise<string>((resolve, reject) => settle.push({ resolve, reject }))
    },
  }
  return { platform: p as unknown as GlassesPlatform, rec }
}

/** Let the pending transcription callbacks run. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

function driver(c: GlassesController) {
  return c as unknown as {
    startVoice(target: { sessionId: string }): Promise<void>
    onAudioData(pcm: Uint8Array): void
    stopAndTranscribe(): Promise<void>
    cancelVoice(): Promise<void>
  }
}

function speak(d: ReturnType<typeof driver>, chunks: number): void {
  for (let i = 0; i < chunks; i++) d.onAudioData(pcm(CHUNK, SPEECH))
}

function pause(d: ReturnType<typeof driver>, chunks = TAIL): void {
  for (let i = 0; i < chunks; i++) d.onAudioData(pcm(CHUNK, QUIET))
}

describe('a pause in the middle of a recording', () => {
  test('closes a phrase and sends it, and the microphone stays open', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    pause(d)
    await flush()

    expect(rec.calls.length).toBe(1)
    expect(rec.micStops).toBe(0)
    expect(c.state.voicePhase).toBe('recording')
  })

  test('does not close one that is still short of the billing floor', async () => {
    // Groq bills ten seconds whatever the length, so a phrase closed at three
    // spends the same request as one closed at ten.
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, 20) // five seconds
    pause(d)
    speak(d, 4)
    pause(d)
    await flush()

    expect(rec.calls.length).toBe(0)
  })

  test('carries the whole phrase, pauses inside it included', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, 20)
    pause(d, 4) // drawing breath, under the tail
    speak(d, 20)
    pause(d)
    await flush()

    expect(rec.calls.length).toBe(1)
    // Trimmed at the ends only: everything from the first word to the last.
    expect(rec.calls[0].length).toBeGreaterThan(CHUNK * 2 * 44)
  })
})

describe('the draft', () => {
  test('holds a place for a phrase that has not come back', async () => {
    const { platform: p } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    pause(d)
    await flush()

    // The payload is still empty - a placeholder is a thing to look at, not a
    // thing to send.
    expect(c.state.voiceText).toBe('')
    expect(screenText(c.state).body).toContain('...')
  })

  test('reads in the order the phrases were spoken, not the order they came back', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    pause(d)
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    expect(rec.calls.length).toBe(2)

    await rec.answer(1, 'あとの句')
    // The one still out keeps its place above, rather than the words that did
    // arrive sliding up into it.
    expect(c.state.voicePhrases).toEqual([{ kind: 'pending' }, { kind: 'text', text: 'あとの句' }])
    await rec.answer(0, 'さきの句')
    expect(c.state.voiceText).toBe('さきの句あとの句')
  })

  test('spaces two English phrases even when the first ends in a full stop', async () => {
    // Transcripts are punctuated far more often than not, and this builds the
    // instruction rather than only the screen: `the tests.and push` is what the
    // agent would have been given.
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    pause(d)
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await rec.answer(0, 'Run the tests.')
    await rec.answer(1, 'Then push.')

    expect(c.state.voiceText).toBe('Run the tests. Then push.')
  })

  test('runs two Japanese phrases together across the full stop between them', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    pause(d)
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await rec.answer(0, 'テストを流して。')
    await rec.answer(1, 'それから push して。')

    expect(c.state.voiceText).toBe('テストを流して。それから push して。')
  })

  test('spaces Latin phrases and runs Japanese ones together', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    pause(d)
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await rec.answer(0, 'run the tests')
    await rec.answer(1, 'and push')

    expect(c.state.voiceText).toBe('run the tests and push')
  })

  test('keeps the phrases that did come back when one of them fails', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    pause(d)
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await rec.answer(0, 'こんにちは')
    await rec.fail(1)

    expect(c.state.voiceText).toBe('こんにちは')
    // The draft still has words in it, so this is a gap rather than a failure.
    expect(c.state.voiceFailed).toBeFalsy()
    // But a gap it has to be shown as. Filtered out silently, the wearer reads
    // a complete-looking instruction and sends one with a hole in it.
    expect(screenText(c.state).body).toContain('(lost)')
  })

  test('says on the sending screen that a phrase is missing from it', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    pause(d)
    speak(d, TEN_SECONDS)
    await d.stopAndTranscribe()
    await rec.answer(0, 'こんにちは')
    await rec.fail(1)

    expect(c.state.voicePhase).toBe('confirm')
    // That screen has no marks on it by design, so the count is the only way
    // the hole can be named there.
    expect(screenText(c.state).body).toContain('1 lost')
  })
})

describe('silence', () => {
  test('is never sent to be transcribed', async () => {
    // Whisper answers a run of silence with a stock sign-off it invents, and
    // the request costs a ten-second minimum to be told it.
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    pause(d, 60) // fifteen seconds of room noise
    await d.stopAndTranscribe()

    expect(rec.calls.length).toBe(0)
    expect(c.state.voicePhase).toBe('confirm')
    expect(c.state.voiceText).toBe('')
  })

  test('under the bar spends no request at all, and the screen says which it was', async () => {
    // A room with a television in it clears "audible" all evening. One bar, and
    // it is the meter's divider: nothing under it is ever uploaded, whichever
    // gesture ended the phrase.
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    for (let i = 0; i < 20; i++) d.onAudioData(pcm(CHUNK, 1200))
    c.swipeDown()
    await flush()
    await d.stopAndTranscribe()

    expect(rec.calls.length).toBe(0)
    // Not "nothing was recognized": nothing was asked, and a wearer told the
    // recognition failed goes looking for the wrong problem.
    expect(screenText(c.state).body).toContain('loud enough')
  })

  test('is trimmed from both ends of a phrase', () => {
    const audio = new Uint8Array([
      ...pcm(MIC_SAMPLE_RATE, QUIET),
      ...pcm(MIC_SAMPLE_RATE, SPEECH),
      ...pcm(MIC_SAMPLE_RATE * 2, QUIET),
    ])
    const trimmed = trimSilence(audio)
    // The speech, plus the quarter-second margin kept either side of it.
    expect(trimmed.length).toBeGreaterThanOrEqual(MIC_SAMPLE_RATE * 2)
    expect(trimmed.length).toBeLessThan(MIC_SAMPLE_RATE * 2 * 2)
  })

  test('leaves a phrase alone when there is nothing loud in it', () => {
    const audio = pcm(MIC_SAMPLE_RATE, QUIET)
    expect(trimSilence(audio).length).toBe(audio.length)
  })
})

describe('tapping done', () => {
  test('sends the tail however short it is', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    speak(d, 4) // one second, well under the floor
    await d.stopAndTranscribe()

    expect(rec.calls.length).toBe(2)
    expect(rec.micStops).toBe(1)
  })

  test('waits for the phrases still in flight before confirming', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    await d.stopAndTranscribe()
    expect(c.state.voicePhase).toBe('transcribing')

    await rec.answer(0, 'できました')
    expect(c.state.voicePhase).toBe('confirm')
    expect(c.state.voiceText).toBe('できました')
  })

  test('confirms straight away when nothing is outstanding', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await rec.answer(0, 'できました')
    await d.stopAndTranscribe()

    expect(c.state.voicePhase).toBe('confirm')
    expect(c.state.voiceText).toBe('できました')
  })
})

describe('the footer', () => {
  test('offers undo only once there is a phrase to take back', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    expect(screenText(c.state).footer).not.toContain('up:undo')

    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await rec.answer(0, 'ひとつめ')

    expect(screenText(c.state).footer).toContain('up:undo')
  })

  test('offers a way back to the microphone from a draft that came out empty', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    await d.stopAndTranscribe()
    await rec.answer(0, '')

    expect(c.state.voicePhase).toBe('confirm')
    expect(screenText(c.state).footer).toContain('dbl:try again')
  })
})

describe('the screen', () => {
  test('marks where one phrase ends and the next begins', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    pause(d)
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await rec.answer(0, 'まずテストを流して')
    await rec.answer(1, 'それから push して')

    const body = screenText(c.state).body
    expect(body.split('\n').slice(0, 2)).toEqual(['· まずテストを流して', '· それから push して'])
    // The marks are the wearer's, not the agent's.
    expect(c.state.voiceText).toBe('まずテストを流してそれから push して')
  })

  test('shows the instruction as it will be sent once there is nothing left to undo', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    pause(d)
    speak(d, TEN_SECONDS)
    await d.stopAndTranscribe()
    await rec.answer(0, 'まずテストを流して')
    await rec.answer(1, 'それから push して')

    const body = screenText(c.state).body
    // The marks divide what an undo takes back, and this screen has no undo on
    // it - a wearer approving pieces is approving something else than what
    // will arrive.
    expect(body).not.toContain('·')
    expect(body).toContain(c.state.voiceText as string)
  })

  test('says the draft was taken back rather than never recognized', async () => {
    // It was recognised. Undoing every phrase and being told nothing was
    // recognised sends the wearer to check the microphone they were heard on.
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await rec.answer(0, 'やっぱりやめる')
    c.swipeUp()
    await flush()
    await d.stopAndTranscribe()

    expect(screenText(c.state).body).toContain('taken back')
  })

  test('does not tell a wearer who took every phrase back to speak up', async () => {
    // They were heard perfectly well. Speaking louder is the one thing that
    // would not help, and it is what the too-quiet screen asks for.
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await rec.answer(0, 'やっぱりやめる')
    c.swipeUp()
    await flush()
    await d.stopAndTranscribe()

    const body = screenText(c.state).body
    expect(body).not.toContain('loud enough')
  })

  test('asks before sending, so the draft is not the transcribing screen again', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    await d.stopAndTranscribe()
    const waiting = screenText(c.state).body

    await rec.answer(0, 'これで送ります')
    const asking = screenText(c.state).body

    expect(waiting).not.toContain('Send this?')
    expect(asking).toContain('Send this?')
    expect(asking).toContain('これで送ります')
  })

  test('keeps the meter the same width and in the same place as a voice moves it', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    const meterOf = (body: string) => {
      const lines = body.split('\n')
      return { line: lines.length, text: lines[lines.length - 1] }
    }
    const quiet = meterOf(screenText(c.state).body)
    speak(d, 1)
    const loud = meterOf(screenText(c.state).body)
    // A phrase arriving must not move it either.
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await rec.answer(0, 'ひとつめの句')
    const withDraft = meterOf(screenText(c.state).body)

    expect(loud.text).not.toBe(quiet.text)
    // In pixels, not characters: a narrow character for the empty cells
    // measures the same in a string and moves the whole bar on the panel.
    expect(textWidth(loud.text)).toBe(textWidth(quiet.text))
    expect(loud.line).toBe(quiet.line)
    expect(withDraft.line).toBe(quiet.line)
  })

  test('leaves the meter on the last row when the screen above it wraps', async () => {
    // The opening instruction is one sentence with no break in it and covers
    // two rows once the panel has wrapped it. Counted as one, the meter is
    // pushed a row past the bottom of the panel and is not drawn at all.
    const { platform: p } = platform()
    const c = new GlassesController(p)
    await driver(c).startVoice({ sessionId: 'w1' })

    // Wrapped the way the panel wraps it, which is the count that decides
    // whether the last row is on the screen at all.
    const lines = splitLines(screenText(c.state).body, BODY_WIDTH)

    expect(lines.length).toBeLessThanOrEqual(MAX_LINES)
    expect(lines[lines.length - 1]).toContain('|')
  })

  test('marks the line the phrase detector draws', async () => {
    // "Is it hearing me" is not the whole question - "is that loud enough to
    // count" is the rest of it, and a bar with no line on it cannot say.
    const { platform: p } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    const meter = () => screenText(c.state).body.split('\n').pop() ?? ''

    d.onAudioData(pcm(CHUNK, 300)) // a quiet room, under the threshold
    const under = meter()
    await new Promise((r) => setTimeout(r, 300))
    d.onAudioData(pcm(CHUNK, SPEECH))
    const over = meter()

    // Nothing lit past the divider until the audio is loud enough to be a
    // phrase; something lit past it once it is.
    expect(under.split('|')[1]).not.toContain('▅')
    expect(over.split('|')[1]).toContain('▅')
  })

  test('shows how loud the microphone is hearing', async () => {
    const { platform: p } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    const quiet = screenText(c.state).body
    speak(d, 1)
    const loud = screenText(c.state).body

    // A still room and a microphone that never opened drew the same thing
    // before, which is the one question a recording screen has to answer.
    expect(quiet).not.toBe(loud)
    expect(loud).toContain('▅')
  })

  test('does not redraw the meter on every chunk of audio', async () => {
    // Four times a second over BLE is what the deliberately slow spinner
    // exists to avoid.
    let draws = 0
    const { platform: p } = platform()
    ;(p as unknown as { render(): void }).render = () => {
      draws++
    }
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    draws = 0

    for (let i = 0; i < 12; i++) {
      d.onAudioData(pcm(CHUNK, SPEECH))
      d.onAudioData(pcm(CHUNK, QUIET))
    }

    expect(draws).toBeLessThanOrEqual(2)
  })

  test('reaches the container the meter is actually in', async () => {
    // Wired the way the device wires it, because this is where the mistake
    // hides: a level meter in the body, drawn by the path that redraws the
    // header, goes out to a container it is not in and moves on the panel only
    // when something else happens to redraw.
    const drawn: Array<{ id: number; content: string }> = []
    const bridge = {
      textContainerUpgrade: (u: { containerID: number; content: string }) => {
        drawn.push({ id: u.containerID, content: u.content })
        return Promise.resolve()
      },
      rebuildPageContainer: () => Promise.resolve(),
    } as never
    const { platform: p } = platform()
    const c = new GlassesController(p)
    ;(p as unknown as { render(s: unknown): void }).render = (s) => {
      void updateDisplay(bridge, s as never)
    }
    ;(p as unknown as { renderHeader(s: unknown): void }).renderHeader = (s) => {
      void updateHeader(bridge, s as never)
    }
    const d = driver(c)
    invalidatePanel()
    await d.startVoice({ sessionId: 'w1' })
    await flush()
    drawn.length = 0

    d.onAudioData(pcm(CHUNK, SPEECH))
    await flush()

    expect(drawn.some((u) => u.content.includes('▅'))).toBe(true)
  })

  test('draws nothing at all while the level is holding still', async () => {
    // The throttle alone would still redraw four times a second in a quiet
    // room, for a bar that is not moving.
    let draws = 0
    const { platform: p } = platform()
    ;(p as unknown as { render(): void }).render = () => {
      draws++
    }
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, 1)
    const afterFirst = draws
    await new Promise((r) => setTimeout(r, 300))
    speak(d, 1)

    expect(draws).toBe(afterFirst)
  })
})

describe('a draft longer than the panel', () => {
  test('is scrolled by hand, and stops at either end', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    await d.stopAndTranscribe()
    await rec.answer(0, `${'長い句。'.repeat(120)}`)

    const shown = () => screenText(c.state).body.split('\n')[0]
    expect(shown()).toContain('1/')
    const pages = Number(shown().split('/')[1])
    expect(pages).toBeGreaterThan(1)

    // Up is the way back on every other screen, so on a draft it is the way
    // to its beginning - and there is nothing above the first page.
    c.swipeUp()
    await flush()
    expect(shown()).toContain(`1/${pages}`)

    for (let i = 0; i < pages + 3; i++) {
      c.swipeDown()
      await flush()
    }
    expect(shown()).toContain(`${pages}/${pages}`)

    c.swipeUp()
    await flush()
    expect(shown()).toContain(`${pages - 1}/${pages}`)
  })

  test('goes back to its beginning when a phrase is taken off the end', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    pause(d)
    speak(d, TEN_SECONDS)
    await d.stopAndTranscribe()
    await rec.answer(0, `${'長い句。'.repeat(120)}`)
    await rec.answer(1, '最後の句')
    c.swipeDown()
    await flush()
    expect(c.state.voicePage).toBe(1)

    // Back to the microphone, one more phrase, and the draft being read is a
    // different one - a page number kept across that points into a draft that
    // no longer exists.
    c.doubleTap()
    await flush()
    speak(d, TEN_SECONDS)
    await d.stopAndTranscribe()
    await rec.answer(2, 'さらに足した句')

    expect(c.state.voicePage).toBe(0)
  })

  test('shows the end of it, where the words just said are', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await rec.answer(0, `${'古い言葉。'.repeat(60)}最後に言ったこと`)

    const body = screenText(c.state).body
    // The wrapper breaks lines wherever they run out of panel, so the words
    // are looked for without them.
    expect(body.replace(/\n/g, '')).toContain('最後に言ったこと')
    expect(body.split('\n').length).toBeLessThanOrEqual(8)
  })
})

describe('swiping up to take the last phrase back', () => {
  test('removes it and leaves the rest of the draft, still recording', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    pause(d)
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await rec.answer(0, 'これは残る')
    await rec.answer(1, 'これは消す')
    expect(c.state.voiceText).toBe('これは残るこれは消す')

    c.swipeUp()
    await flush()

    expect(c.state.voiceText).toBe('これは残る')
    expect(c.state.voicePhase).toBe('recording')
  })

  test('drops the words of one that was still being transcribed', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    c.swipeUp()
    await flush()
    await rec.answer(0, '言い間違えた')

    expect(c.state.voiceText).toBe('')
  })

  test('lets the wait end when the phrase it removed was the one holding it up', async () => {
    const { platform: p } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    await d.stopAndTranscribe()
    expect(c.state.voicePhase).toBe('transcribing')

    c.swipeUp()
    await flush()

    expect(c.state.voicePhase).toBe('confirm')
  })

  test('does nothing when there is nothing to take back', async () => {
    const { platform: p } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    c.swipeUp()
    await flush()

    expect(c.state.voicePhase).toBe('recording')
    expect(c.state.voiceText).toBe('')
  })

  test('takes a demo phrase back too, since the demo promises the same gesture', async () => {
    const { platform: p } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    c.startDemo()
    await d.startVoice({ sessionId: 'w1' })
    await d.stopAndTranscribe()
    expect(c.state.voiceText).toBeTruthy()

    c.doubleTap()
    await flush()
    c.swipeUp()
    await flush()

    expect(c.state.voiceText).toBe('')
  })
})

describe('swiping down while recording', () => {
  test('ends the phrase there, short of the floor', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, 8) // two seconds
    c.swipeDown()
    await flush()

    expect(rec.calls.length).toBe(1)
    expect(c.state.voicePhase).toBe('recording')
  })

  test('does nothing before the first word', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    pause(d, 4)
    c.swipeDown()
    await flush()

    expect(rec.calls.length).toBe(0)
  })
})

describe('double-tapping the draft', () => {
  test('opens the microphone again and keeps what is there', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    await d.stopAndTranscribe()
    await rec.answer(0, 'まずはテスト')
    expect(c.state.voicePhase).toBe('confirm')

    c.doubleTap()
    await flush()
    expect(c.state.voicePhase).toBe('recording')

    speak(d, TEN_SECONDS)
    await d.stopAndTranscribe()
    await rec.answer(1, 'それから push')

    expect(c.state.voiceText).toBe('まずはテストそれから push')
  })

  test('goes back to the draft when the microphone will not open', async () => {
    const { platform: p, rec } = platform()
    const mic = p as GlassesPlatform & { startMicCapture(): Promise<boolean> }
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    await d.stopAndTranscribe()
    await rec.answer(0, '一度目は録れた')

    mic.startMicCapture = async () => false
    c.doubleTap()
    await flush()

    expect(c.state.voicePhase).toBe('confirm')
    expect(c.state.voiceText).toBe('一度目は録れた')
  })
})

describe('a gesture that lands while the host is still opening or closing the microphone', () => {
  /** A platform where one of the two microphone calls hangs until released. */
  function slowMic(slow: 'start' | 'stop') {
    const held: Array<() => void> = []
    const rec = { started: 0, stopped: 0, transcribes: 0 }
    const p = {
      onDevice: false,
      render() {},
      renderHeader() {},
      requestExit() {},
      startMicCapture() {
        rec.started++
        if (slow !== 'start') return Promise.resolve(true)
        return new Promise<boolean>((resolve) => held.push(() => resolve(true)))
      },
      stopMicCapture() {
        rec.stopped++
        if (slow !== 'stop') return Promise.resolve()
        return new Promise<void>((resolve) => held.push(resolve))
      },
      async transcribeAudio() {
        rec.transcribes++
        return 'text'
      },
    }
    return { platform: p as unknown as GlassesPlatform, rec, release: () => held.shift()?.() }
  }

  test('a stop that finishes late does not take the recording that replaced it', async () => {
    const { platform: p, rec, release } = slowMic('stop')
    const c = new GlassesController(p)
    const d = driver(c)

    await d.startVoice({ sessionId: 'w1' })
    speak(d, 4)

    // Tap done, and while the host is still closing the microphone: leave,
    // then start again somewhere else.
    void d.stopAndTranscribe()
    await flush()
    await d.cancelVoice()
    void d.startVoice({ sessionId: 'w2' })
    await flush()
    release()
    await flush()
    await flush()

    // The old stop must not push the new recording into transcribing, nor
    // close a phrase out of the audio the new one is collecting.
    expect(c.state.voicePhase).toBe('recording')
    expect(c.state.voiceText).toBe('')
    // And there is one microphone: the stop already on its way to the host
    // would otherwise close the one this recording just opened, leaving a
    // screen that says it is listening while no audio arrives.
    expect(rec.started).toBe(2)
    expect(rec.stopped).toBe(1)
  })

  test('a microphone that opens after the wearer has left is closed again', async () => {
    const { platform: p, rec, release } = slowMic('start')
    const c = new GlassesController(p)
    const d = driver(c)

    void d.startVoice({ sessionId: 'w1' })
    await flush()
    void d.cancelVoice()
    await flush()
    const stoppedBefore = rec.stopped

    release()
    await flush()
    await flush()

    // Left open, it spends the wearer's battery for as long as the app lasts,
    // on a screen they are no longer looking at.
    expect(rec.stopped).toBeGreaterThan(stoppedBefore)
  })

  test('the screen stops promising an action that no longer does anything', async () => {
    const { platform: p, release } = slowMic('stop')
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, 4)

    void d.stopAndTranscribe()
    await flush()

    // The host has not finished closing the microphone, but the wearer has
    // already said they are done - and a second tap here does nothing.
    expect(screenText(c.state).footer).not.toContain('tap:done')
    release()
    await flush()
  })

  test('does not take the previous capture\'s audio into the recording that follows it', async () => {
    // The old microphone is open until its stop reaches the host, and it keeps
    // delivering. Counted as the new recording's, those chunks are uploaded
    // under a session nobody spoke them to.
    const { platform: p, rec } = slowMic('stop')
    const c = new GlassesController(p)
    const d = driver(c)

    await d.startVoice({ sessionId: 'w1' })
    speak(d, 4)
    void d.stopAndTranscribe()
    await flush()
    await d.cancelVoice()
    void d.startVoice({ sessionId: 'w2' })
    await flush()

    // Still queued behind the stop: nothing is listening for this recording yet.
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()

    expect(rec.transcribes).toBe(0)
  })

  test('a host that rejects instead of answering does not strand the screen', async () => {
    const p = {
      onDevice: false,
      render() {},
      renderHeader() {},
      requestExit() {},
      startMicCapture: () => Promise.reject(new Error('no permission')),
      stopMicCapture: () => Promise.resolve(),
      async transcribeAudio() {
        return 'text'
      },
    } as unknown as GlassesPlatform
    const c = new GlassesController(p)

    await driver(c).startVoice({ sessionId: 'w1' })
    await flush()

    // A screen promising a recording that never started is the worst of the
    // three: there is nothing to tap and nothing says why.
    expect(c.state.voicePhase).toBe('confirm')
    expect(screenText(c.state).body).toContain('microphone did not open')
  })

  test('takes a tap that lands while the microphone is still opening', async () => {
    // The wearer is in a recording from the moment they asked for one. A tap
    // read against the device instead was dropped, and the recording they had
    // just finished carried on behind the screen.
    const { platform: p, rec, release } = slowMic('start')
    const c = new GlassesController(p)
    const d = driver(c)

    void d.startVoice({ sessionId: 'w1' })
    await flush()
    void d.stopAndTranscribe()
    await flush()
    release()
    await flush()
    await flush()

    expect(c.state.voicePhase).not.toBe('recording')
    expect(rec.stopped).toBeGreaterThan(0)
  })

  test('gives up a recording the glasses walked away from mid-open', async () => {
    const { platform: p, rec, release } = slowMic('start')
    const c = new GlassesController(p)
    const d = driver(c)

    void d.startVoice({ sessionId: 'w1' })
    await flush()
    c.onForegroundExit()
    await flush()
    release()
    await flush()
    await flush()

    // Otherwise it streams 16kHz PCM from a screen nobody can see until the
    // idle timer eventually notices.
    expect(rec.stopped).toBeGreaterThan(0)
    expect(c.state.mode).toBe('conversation')
  })

  test('an old failure is not reported on the recording that replaced it', async () => {
    const held: Array<(ok: boolean) => void> = []
    const p = {
      onDevice: false,
      render() {},
      renderHeader() {},
      requestExit() {},
      startMicCapture: () => new Promise<boolean>((resolve) => held.push(resolve)),
      stopMicCapture: () => Promise.resolve(),
      async transcribeAudio() {
        return 'text'
      },
    } as unknown as GlassesPlatform
    const c = new GlassesController(p)
    const d = driver(c)

    void d.startVoice({ sessionId: 'w1' })
    await flush()
    void d.cancelVoice()
    void d.startVoice({ sessionId: 'w2' })
    await flush()

    // The first run's microphone reports that it could not open - long after
    // the wearer left it and started somewhere else.
    held[0]?.(false)
    await flush()
    await flush()
    held[1]?.(true)
    await flush()

    expect(c.state.voicePhase).toBe('recording')
    expect(c.state.voiceMicFailed).toBeFalsy()
  })
})

describe('a microphone that would not open', () => {
  test('says so, rather than telling the wearer to speak up', async () => {
    const { platform: p } = platform()
    ;(p as unknown as { startMicCapture(): Promise<boolean> }).startMicCapture = async () => false
    const c = new GlassesController(p)
    await driver(c).startVoice({ sessionId: 'w1' })

    const body = screenText(c.state).body
    expect(body).toContain('microphone did not open')
    // Nothing was listening, so the loudness bar was never consulted - and
    // speaking louder is the one thing that cannot help.
    expect(body).not.toContain('loud enough')
  })

  test('lets the wearer out, because a double tap cannot answer a permission', async () => {
    // This screen is reached without passing through a recording, so the step
    // the usual escape is made of does not exist here: a double tap that means
    // "back to the microphone" only retries the open that just failed, and the
    // host refuses this capability silently and for good.
    const { platform: p } = platform()
    ;(p as unknown as { startMicCapture(): Promise<boolean> }).startMicCapture = async () => false
    const c = new GlassesController(p)
    await driver(c).startVoice({ sessionId: 'w1' })
    expect(screenText(c.state).footer).toContain('dbl:back')

    c.doubleTap()
    await flush()

    expect(c.state.mode).toBe('conversation')
  })
})

describe('a phrase whose words arrive after it is gone', () => {
  test('is not put back by a cancel', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })

    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await d.cancelVoice()
    await rec.answer(0, 'もう要らない')

    expect(c.state.voiceText).toBe('')
    expect(c.state.mode).toBe('conversation')
  })

  test('does not redraw a panel that has moved on', async () => {
    // Every draw is a BLE round trip, and the screen it would draw is one the
    // wearer left when they cancelled.
    let draws = 0
    const { platform: p, rec } = platform()
    ;(p as unknown as { render(): void }).render = () => {
      draws++
    }
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await d.cancelVoice()

    const before = draws
    await rec.answer(0, 'もう見ていない')
    expect(draws).toBe(before)
  })

  test('is not carried into the next recording', async () => {
    const { platform: p, rec } = platform()
    const c = new GlassesController(p)
    const d = driver(c)
    await d.startVoice({ sessionId: 'w1' })
    speak(d, TEN_SECONDS)
    pause(d)
    await flush()
    await d.cancelVoice()

    await d.startVoice({ sessionId: 'w1' })
    await rec.answer(0, '前の録音のもの')

    expect(c.state.voiceText).toBe('')
  })
})
