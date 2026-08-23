// Speaking is a hold, and the gap between phrases is silence.
//
// The microphone opens on a long press rather than a tap, which frees the tap
// the host's own menu is reached through (`tap` then long press, and an app
// that spends the tap never gets there). The phrase ends when the finger comes
// off, and nothing is taken in until it goes back on - so the pause where the
// wearer is thinking is not dictated by whatever else is in the room. A
// television clears the speech threshold perfectly well, and no threshold can
// tell one voice from another.

import { describe, expect, test } from 'bun:test'
import { GlassesController, MIC_SAMPLE_RATE } from '../controller.ts'
import type { GlassesPlatform } from '../controller.ts'
import { screenText } from '../display.ts'

// `onForegroundEnter` reconnects the socket, which reads `location.origin`.
// Nothing here exercises the socket; this only keeps it from throwing.
;(globalThis as { location?: unknown }).location ??= { origin: 'http://localhost' }
import { stripUnrenderable } from '../metrics.ts'

const CHUNK = 3200
const SPEECH = 9000
/** A phrase long enough to be worth a request. */
const LONG = Math.ceil((MIC_SAMPLE_RATE * 11) / (CHUNK / 2))

function pcm(bytes: number, amplitude: number): Uint8Array {
  const buf = new Uint8Array(bytes)
  const view = new DataView(buf.buffer)
  for (let i = 0; i < bytes / 2; i++) {
    view.setInt16(i * 2, i % 2 === 0 ? amplitude : -amplitude, true)
  }
  return buf
}

function platform(): GlassesPlatform {
  return {
    onDevice: false,
    render() {},
    renderHeader() {},
    requestExit() {},
    async startMicCapture() { return true },
    async stopMicCapture() {},
    async transcribeAudio() { return 'said' },
  } as unknown as GlassesPlatform
}

type Inner = {
  startVoice(t: { sessionId: string }): Promise<void>
  onAudioData(pcm: Uint8Array): void
  longPress(): void
  longPressEnd(): void
  listening: boolean
  phraseSamples: number
}
const inner = (c: GlassesController) => c as unknown as Inner

function feed(d: Inner, chunks: number, amp: number): void {
  for (let i = 0; i < chunks; i++) d.onAudioData(pcm(CHUNK, amp))
}

/** The voice screen, open and waiting. A tap opens it; the hold below is the
 *  wearer starting to speak, which is what most of these tests need. */
async function recording(): Promise<{ c: GlassesController; d: Inner }> {
  const c = new GlassesController(platform())
  c.state.sessions = [{ id: 's1', name: 'one', state: 'idle' }] as GlassesController['state']['sessions']
  c.state.sessionIndex = 0
  const d = inner(c)
  await d.startVoice({ sessionId: 's1' })
  d.longPress()
  return { c, d }
}

/** The screen as the tap leaves it: open, not listening. */
async function opened(): Promise<{ c: GlassesController; d: Inner }> {
  const c = new GlassesController(platform())
  c.state.sessions = [{ id: 's1', name: 'one', state: 'idle' }] as GlassesController['state']['sessions']
  c.state.sessionIndex = 0
  const d = inner(c)
  await d.startVoice({ sessionId: 's1' })
  return { c, d }
}

describe('arming a phrase', () => {
  test('opening the screen does not open the microphone to the room', async () => {
    // The tap asks for the screen, the hold asks for the microphone. Arming
    // on entry would have the room dictating while the wearer decides what to
    // say - which is the thing this whole arrangement is for.
    const { c, d } = await opened()
    expect(d.listening).toBe(false)
    expect(c.state.voicePhase).toBe('recording')
  })

  test('the first hold arms the first phrase', async () => {
    const { d } = await opened()
    d.longPress()
    expect(d.listening).toBe(true)
  })

  test('a closed phrase stops the intake', async () => {
    const { c, d } = await recording()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    expect(d.listening).toBe(false)
    expect(c.state.voiceListening).toBe(false)
  })

  test('audio arriving between phrases is not collected', async () => {
    // The whole point: the room talks on while the wearer thinks, and none of
    // it belongs in what they are dictating.
    const { d } = await recording()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    feed(d, 20, SPEECH)
    expect(d.phraseSamples).toBe(0)
  })

  test('a hold arms the next phrase', async () => {
    const { c, d } = await recording()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    d.longPress()
    expect(d.listening).toBe(true)
    expect(c.state.voiceListening).toBe(true)
    feed(d, 5, SPEECH)
    expect(d.phraseSamples).toBeGreaterThan(0)
  })

  test('a hold mid-phrase changes nothing', async () => {
    // The finger arriving again while the wearer is already speaking means
    // nothing new; restarting the phrase there would drop the words so far.
    const { d } = await recording()
    feed(d, 5, SPEECH)
    const before = d.phraseSamples
    d.longPress()
    expect(d.listening).toBe(true)
    expect(d.phraseSamples).toBe(before)
  })
})

describe('a hold that arrives unasked', () => {
  /**
   * The glasses OS opens its own menu on `tap` then long press and hands both
   * to the app on the way past, so a hold can always be the wearer reaching
   * for the menu rather than speaking. There is no way to tell: the gap
   * between the two is the same gap a person leaves when they tap into this
   * screen and start talking.
   *
   * So the hold is taken either way, and what makes that safe is that an
   * unmeant one leaves nothing behind.
   */
  test('the hold that follows the tap that opened the screen is speech', async () => {
    // Through `tap()` rather than `startVoice` directly: the tap that opens
    // this screen is the one a wearer makes, and it is the one a rule counting
    // from the last tap would have counted from - dropping the first hold of
    // every dictation while the panel said "Hold to speak".
    const c = new GlassesController(platform())
    c.state.sessions = [{ id: 's1', name: 'one', state: 'idle' }] as GlassesController['state']['sessions']
    c.state.sessionIndex = 0
    c.state.mode = 'conversation'
    const d = inner(c)
    c.tap()
    await new Promise((r) => setTimeout(r, 0))
    expect(c.state.mode as string).toBe('voice')
    c.longPress()
    expect(d.listening).toBe(true)
    feed(d, 5, SPEECH)
    expect(d.phraseSamples).toBeGreaterThan(0)
  })

  test('one nobody spoke into leaves no phrase and no request', async () => {
    // The wearer reached for the OS menu from this screen. A phrase opened
    // behind it and closed when they lifted their finger to choose, and the
    // draft is as they left it.
    let asked = 0
    const c = new GlassesController({
      ...platform(),
      async transcribeAudio() { asked++; return 'said' },
    } as unknown as GlassesPlatform)
    c.state.sessions = [{ id: 's1', name: 'one', state: 'idle' }] as GlassesController['state']['sessions']
    c.state.sessionIndex = 0
    const d = inner(c)
    await d.startVoice({ sessionId: 's1' })
    d.longPress()
    feed(d, 10, 0)
    d.longPressEnd()
    await new Promise((r) => setTimeout(r, 0))
    expect(asked).toBe(0)
    expect(c.state.voicePhrases ?? []).toHaveLength(0)
    expect(c.state.voiceText ?? '').toBe('')
  })
})

describe('a line break the wearer asked for', () => {
  /**
   * The one character dictation cannot produce. A transcript arrives with
   * punctuation and never with structure, so an instruction in two parts came
   * out as a single run of words.
   */
  const draft = (c: GlassesController) => c.state.voiceText ?? ''

  async function spoken(): Promise<{ c: GlassesController; d: Inner }> {
    const { c, d } = await recording()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    await new Promise((r) => setTimeout(r, 0))
    return { c, d }
  }

  test('reaches the draft as a real break', async () => {
    const { c } = await spoken()
    c.swipeDown()
    expect(draft(c)).toContain('\n')
  })

  test('an undo takes it back like anything else', async () => {
    const { c } = await spoken()
    c.swipeDown()
    c.swipeUp()
    expect(draft(c)).not.toContain('\n')
  })

  test('two in a row are two breaks', async () => {
    // A blank line is what separates the parts of an instruction, and the mark
    // drawn for each says which it is, so two of them are legible on the
    // screen the wearer is reading.
    const { c } = await spoken()
    c.swipeDown()
    c.swipeDown()
    expect(draft(c).split('\n')).toHaveLength(3)
  })

  test('the blank line survives as far as the screen that confirms it', async () => {
    // The draft carrying it is not enough: the wearer decides to send from
    // what is drawn, and a screen that closes the gap up says the second break
    // did nothing.
    const { c, d } = await spoken()
    c.swipeDown()
    c.swipeDown()
    d.longPress()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    await new Promise((r) => setTimeout(r, 0))
    c.tap()
    await new Promise((r) => setTimeout(r, 0))
    expect(c.state.voicePhase).toBe('confirm')
    expect(screenText(c.state).body).toContain('\n\n')
  })

  test('one before the first phrase is allowed too', async () => {
    // Refusing it would be a rule of its own to carry, for a case that costs
    // nothing: an empty line at the top of an instruction is harmless, and
    // what goes there later - a saved command - is not.
    const { c } = await opened()
    c.swipeDown()
    expect(draft(c)).toBe('\n')
  })

  test('refused while the finger is down', async () => {
    // The gesture cannot arrive then anyway; the guard is there so the rule
    // does not depend on that staying true.
    const { c, d } = await spoken()
    d.longPress()
    c.swipeDown()
    expect(draft(c)).not.toContain('\n')
  })

  test('its mark is one the panel can actually draw', async () => {
    // `⏎` and `↵` are both dropped by the firmware's own advances, so the mark
    // would have been invisible on the one device it is for - measured on
    // 0.0.89, where nothing appeared.
    const { c } = await spoken()
    c.swipeDown()
    const body = screenText(c.state).body
    expect(stripUnrenderable(body)).toBe(body)
  })
})

describe('a sleep the wearer asked for', () => {
  test('survives the app being foregrounded', async () => {
    // Choosing Sleep from the host's menu backgrounds this app and foregrounds
    // it again as the menu closes. Relighting on the way back undid the thing
    // that had just been asked for.
    const { c } = await recording()
    ;(c as unknown as { listening: boolean }).listening = false
    c.sleepNow()
    expect(c.state.screenOff).toBe(true)
    c.onForegroundExit()
    c.onForegroundEnter()
    expect(c.state.screenOff).toBe(true)
  })

  test('the idle timeout kind still relights on the way back', async () => {
    // A panel that went dark on its own is not a decision to preserve - a
    // resume onto a dark screen reads as the app having died.
    const { c } = await recording()
    c.state.screenOff = true
    c.onForegroundEnter()
    expect(c.state.screenOff).toBe(false)
  })
})

describe('there is always a way out', () => {
  /**
   * The property rather than the path: repeated double taps reach the
   * conversation from wherever the voice screen starts.
   *
   * Two screens that each answer this gesture by showing the other are a
   * closed door, and the wearer's only way through it is to kill the app.
   * Pinned here so an arrangement of these gestures cannot make one.
   */
  async function leaves(c: GlassesController): Promise<string> {
    for (let i = 0; i < 6; i++) {
      c.doubleTap()
      await new Promise((r) => setTimeout(r, 0))
      if (c.state.mode !== 'voice') break
    }
    return c.state.mode
  }

  test('from a recording with nothing said', async () => {
    const { c } = await recording()
    expect(await leaves(c)).toBe('conversation')
  })

  test('from a paused draft', async () => {
    const { c, d } = await recording()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    await new Promise((r) => setTimeout(r, 0))
    expect(await leaves(c)).toBe('conversation')
  })

  test('from the sending screen', async () => {
    // Two taps from here: this one goes back to the microphone, the next
    // leaves. Leaving outright would be quicker and is not offered - the
    // draft is worth the step of seeing it again.
    const { c, d } = await recording()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    await new Promise((r) => setTimeout(r, 0))
    await (c as unknown as { stopAndTranscribe(): Promise<void> }).stopAndTranscribe()
    expect(c.state.voicePhase).toBe('confirm')
    expect(await leaves(c)).toBe('conversation')
  })

  test('cancelling the sending screen returns the draft rather than dropping it', async () => {
    // Cancel on a screen asking "send this?" is an answer to the question,
    // not an instruction to throw the answer away. It steps back to the draft
    // the wearer was looking at, where the microphone is waiting and another
    // phrase is one hold away. Leaving for good is the next double tap.
    const { c, d } = await recording()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    await new Promise((r) => setTimeout(r, 0))
    await (c as unknown as { stopAndTranscribe(): Promise<void> }).stopAndTranscribe()
    const before = (c.state.voicePhrases ?? []).length
    expect(c.state.voicePhase).toBe('confirm')

    c.doubleTap()
    await new Promise((r) => setTimeout(r, 0))
    expect(c.state.voicePhase).toBe('recording')
    expect(c.state.voicePhrases ?? []).toHaveLength(before)
    // Not listening: the finger is not down. The draft waits for a hold, the
    // same way it does when the screen is first opened.
    expect(d.listening).toBe(false)

    // And the hold still works from there, phrase and release both.
    d.longPress()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    await new Promise((r) => setTimeout(r, 0))
    expect(c.state.voicePhrases ?? []).toHaveLength(before + 1)
  })
})

describe('a slept panel takes the double tap and nothing else', () => {
  /**
   * A gesture on a dark panel is the wearer asking for the panel, not for
   * whatever screen is waiting underneath it. Reaching that screen is worse
   * than doing nothing: it acts on a state they cannot see, and this screen's
   * own answer to a double tap is to end the recording.
   */
  async function slept(): Promise<GlassesController> {
    const { c, d } = await recording()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    await new Promise((r) => setTimeout(r, 0))
    c.sleepNow()
    expect(c.state.screenOff).toBe(true)
    return c
  }

  test('a double tap only relights it', async () => {
    const c = await slept()
    c.doubleTap()
    await new Promise((r) => setTimeout(r, 0))
    expect(c.state.screenOff).toBe(false)
    expect(c.state.voicePhase).toBe('recording')
  })

  test('a tap does nothing at all', async () => {
    const c = await slept()
    c.tap()
    await new Promise((r) => setTimeout(r, 0))
    expect(c.state.screenOff).toBe(true)
    expect(c.state.voicePhase).toBe('recording')
  })

  test('the idle tick does not undo it while the timeout is off', async () => {
    // This is what took the sleep away on the device. The timeout is off by
    // default, and the branch for that relights a dark panel so that turning
    // the setting off from the phone is visibly answered. It ran every 2.5
    // seconds against a panel the wearer had just darkened - and the double
    // tap meant to relight it then reached the recording underneath, which
    // read it as "done".
    const c = await slept()
    const inner = c as unknown as { screenOffIdleMs: number; tickScreenOff(): void }
    inner.screenOffIdleMs = 0
    inner.tickScreenOff()
    expect(c.state.screenOff).toBe(true)
  })

  test('but it still answers the setting being switched off', () => {
    // The behaviour that branch exists for: a panel dark on the timeout's own
    // account comes back when the timeout is turned off.
    const c = new GlassesController(platform())
    c.state.screenOff = true
    const inner = c as unknown as { screenOffIdleMs: number; tickScreenOff(): void }
    inner.screenOffIdleMs = 0
    inner.tickScreenOff()
    expect(c.state.screenOff).toBe(false)
  })
})

describe('a release with no phrase open', () => {
  /**
   * The host reports a press and a release as two events, and there is no
   * guarantee they arrive in pairs the app agrees with: a hold suppressed as
   * the host's menu prefix still ends, and one that began before this screen
   * did ends on it. A release that closes nothing must therefore do nothing.
   */
  test('does not close a phrase that never began', async () => {
    const { c, d } = await opened()
    d.longPressEnd()
    await new Promise((r) => setTimeout(r, 0))
    expect(c.state.voicePhrases ?? []).toHaveLength(0)
    expect(c.state.voicePhase).toBe('recording')
  })

  test('and does not redraw the panel over it', async () => {
    // Every draw is BLE traffic to a device that dies under load, and a
    // release lands on this screen every time the wearer lets go of a hold
    // the menu prefix suppressed. Closing nothing still redrew the draft.
    let draws = 0
    const c = new GlassesController({
      onDevice: false,
      render() { draws++ },
      renderHeader() {},
      requestExit() {},
      async startMicCapture() { return true },
      async stopMicCapture() {},
      async transcribeAudio() { return 'said' },
    } as unknown as GlassesPlatform)
    c.state.sessions = [{ id: 's1', name: 'one', state: 'idle' }] as GlassesController['state']['sessions']
    c.state.sessionIndex = 0
    const d = inner(c)
    await d.startVoice({ sessionId: 's1' })
    await new Promise((r) => setTimeout(r, 0))
    draws = 0
    d.longPressEnd()
    await new Promise((r) => setTimeout(r, 0))
    expect(draws).toBe(0)
  })

  test('a second release after one phrase adds nothing', async () => {
    // Closing again would push an empty phrase into the draft, which is a
    // line the wearer cannot account for and an undo that removes nothing.
    const { c, d } = await recording()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    await new Promise((r) => setTimeout(r, 0))
    const before = (c.state.voicePhrases ?? []).length
    d.longPressEnd()
    await new Promise((r) => setTimeout(r, 0))
    expect(c.state.voicePhrases ?? []).toHaveLength(before)
  })
})

describe('the host taking the screen away', () => {
  /**
   * Backgrounding is not the wearer leaving. The host does it for its own
   * reasons - its menu is one of them - and it takes the microphone with it,
   * because PCM streaming from a screen nobody can see is battery spent on
   * nothing.
   */
  const tick = () => new Promise((r) => setTimeout(r, 0))

  test('the phrases already closed are still there on the way back', async () => {
    // A draft is built over several holds. Losing all of it because the host
    // wanted the screen for a moment is losing work the wearer did, and the
    // interruption is not theirs.
    const { c, d } = await recording()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    await tick()
    d.longPress()
    feed(d, LONG, SPEECH)
    d.longPressEnd()
    await tick()
    d.longPress()
    feed(d, 5, SPEECH)
    c.onForegroundExit()
    await tick()
    expect(c.state.voicePhrases ?? []).toHaveLength(2)
    expect(c.state.mode).toBe('voice')
    expect(c.state.voicePhase).toBe('recording')
  })

  test('the phrase that was being spoken does not survive it', async () => {
    // Half a sentence, with the rest said to a screen that was not listening.
    const { c, d } = await recording()
    feed(d, 5, SPEECH)
    c.onForegroundExit()
    await tick()
    expect(d.listening).toBe(false)
    expect(c.state.voiceListening).toBe(false)
    expect(d.phraseSamples).toBe(0)
  })

  test('a microphone stopped mid-open is opened again by the next hold', async () => {
    // The stop and the open race: the open was already on its way when the
    // host took the screen, and its answer lands after the stop. Left to
    // report itself as an open microphone, it makes the next hold skip the
    // one thing that would have opened a real one - and the screen then says
    // it is listening with nothing arriving to end the phrase.
    let answer: (opened: boolean) => void = () => {}
    let starts = 0
    const c = new GlassesController({
      ...platform(),
      startMicCapture() {
        starts++
        return new Promise<boolean>((resolve) => { answer = resolve })
      },
    } as unknown as GlassesPlatform)
    c.state.sessions = [{ id: 's1', name: 'one', state: 'idle' }] as GlassesController['state']['sessions']
    c.state.sessionIndex = 0
    const d = inner(c)
    const opening = d.startVoice({ sessionId: 's1' })
    // The open reaches the host a microtask later, through the queue that
    // keeps microphone calls in order. Backgrounding before that has nothing
    // in flight to race with, which is not the case being pinned here.
    await tick()
    c.onForegroundExit()
    c.onForegroundEnter()
    answer(true)
    await opening
    await tick()
    d.longPress()
    await tick()
    expect(starts).toBe(2)
  })
})
