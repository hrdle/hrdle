// Who is allowed to move the conversation: the clock, or the reader.
//
// The auto-advance clock is for the glance - look up, see the whole answer
// without touching anything. Read at a person's own pace it is a fight: a page
// of a long reply takes longer than the ten seconds of ring silence the clock
// waits for, so the view moves mid-sentence, the reader pages back, and ten
// seconds later it happens again.
//
// A manual scroll - either direction - says a reader is here, and the screen
// is theirs until one of the explicit signals hands it back: the double-tap
// home, or answering. Arriving at the newest message by swiping is not such a
// signal (the page a reader spends longest on is often the newest one), and
// neither is the conversation refreshing underneath them.

import { describe, expect, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import type { GlassesPlatform } from '../controller.ts'
import { screenText } from '../display.ts'
import type { ConversationMessage } from '../../../shared/types'
import type { GlassesRelayItem } from '../types.ts'

function platform(): GlassesPlatform {
  return {
    onDevice: false,
    render() {},
    renderHeader() {},
    requestExit() {},
    async startMicCapture() { return true },
    async stopMicCapture() {},
    async transcribeAudio() { throw new Error('not used here') },
  } as unknown as GlassesPlatform
}

type Internals = {
  tickAutoAdvance(): void
  lastGestureAt: number
  lastConvRefresh: number
  autoResting: boolean
  loadConversation(): Promise<void>
  maybeRefreshConversation(): void
  followFocus(focus: { sessionId: string }): boolean
  onRelayUpsert(item: GlassesRelayItem): void
  queue: { topWaiting(): GlassesRelayItem | undefined }
}

const inner = (c: GlassesController) => c as unknown as Internals

/** A reply several screens long, which is the only kind this is about. */
const LONG = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the answer`).join('\n')

/** Reading the newest message of an open conversation. */
function reading(): GlassesController {
  const c = new GlassesController(platform())
  c.state.sessions = [{ id: 's1', name: 'one', state: 'idle' }] as GlassesController['state']['sessions']
  c.state.sessionIndex = 0
  c.state.mode = 'conversation'
  c.state.conversation = [{ role: 'assistant', content: LONG }] as ConversationMessage[]
  c.state.conversationOffset = 0
  c.state.conversationPage = 0
  return c
}

/**
 * Ring silence, then enough ticks for the clock to reach a page turn.
 *
 * A page costs several ticks (`AUTO_PAGE_STEP_MS` over `AUTO_SCROLL_STEP_MS`),
 * and the ten seconds are moved into the past rather than waited out - the
 * clock this reads is the only one in play.
 */
function idleThenTick(c: GlassesController, ticks = 10): void {
  inner(c).lastGestureAt = Date.now() - 60_000
  for (let i = 0; i < ticks; i++) inner(c).tickAutoAdvance()
}

describe('the footer says which of the two the screen is in', () => {
  // A screen that stops moving without saying so is still, and unaccountably
  // so: the reader cannot tell their gesture from a hung app.
  test('the word is there while the clock has the view, and goes when it does not', () => {
    const c = reading()
    expect(screenText(c.state).footer).toContain('auto')

    // From the first page of the newest message there is nothing to page back
    // to, so the clock has to have moved first - which is the case the hold is
    // for anyway.
    idleThenTick(c)
    c.swipeUp()
    expect(screenText(c.state).footer).not.toContain('auto')
  })

  test('it comes back with the double-tap home, not with a down-swipe', async () => {
    const c = reading()
    c.state.conversation = [
      { role: 'assistant', content: 'the newest thing said' },
      { role: 'user', content: 'the one before it' },
    ] as ConversationMessage[]
    c.swipeUp()
    expect(screenText(c.state).footer).not.toContain('auto')

    // Swiping down is still a hand on the ring.
    c.swipeDown()
    expect(screenText(c.state).footer).not.toContain('auto')

    // The double-tap home is the explicit signal.
    c.swipeUp()
    await c.doubleTap()
    expect(c.state.conversationOffset).toBe(0)
    expect(screenText(c.state).footer).toContain('auto')
  })
})

describe('the auto-advance clock yields to a reader', () => {
  test('untouched, it walks the pages by itself', () => {
    const c = reading()
    idleThenTick(c)
    expect(c.state.conversationPage).toBeGreaterThan(0)
  })

  test('a page back holds the view still', () => {
    const c = reading()
    idleThenTick(c)
    const advanced = c.state.conversationPage
    expect(advanced).toBeGreaterThan(0)

    c.swipeUp()
    const readingAt = c.state.conversationPage
    expect(readingAt).toBe(advanced - 1)

    // Ten seconds later it used to happen again.
    idleThenTick(c)
    expect(c.state.conversationPage).toBe(readingAt)
  })

  test('paging back onto the newest page holds it there too', () => {
    // The page a reader spends longest on is the first one, and swiping up to
    // it lands where "at the newest message" is otherwise measured. Releasing
    // on arrival would leave the complaint exactly where it was.
    const c = reading()
    idleThenTick(c)
    while (c.state.conversationPage > 0) c.swipeUp()

    idleThenTick(c)
    expect(c.state.conversationPage).toBe(0)
  })

  test('swiping down to the newest message keeps the screen with the reader', () => {
    const c = reading()
    c.state.conversation = [
      { role: 'assistant', content: 'the newest thing said' },
      { role: 'user', content: 'the one before it' },
    ] as ConversationMessage[]
    c.swipeUp()
    expect(c.state.conversationOffset).toBe(1)

    c.swipeDown()
    expect(c.state.conversationOffset).toBe(0)

    c.state.conversation = [{ role: 'assistant', content: LONG }] as ConversationMessage[]
    idleThenTick(c)
    expect(c.state.conversationPage).toBe(0)
  })

  test('a reload leaves a held pin alone', async () => {
    const c = reading()
    idleThenTick(c)
    c.swipeUp()

    await inner(c).loadConversation()
    c.state.conversation = [{ role: 'assistant', content: LONG }] as ConversationMessage[]
    idleThenTick(c)
    expect(c.state.conversationPage).toBe(0)
    expect(screenText(c.state).footer).not.toContain('auto')
  })

  test('the periodic refresh never runs against a pinned reader', () => {
    // Pinned at a true 0/0 - the position gate would not catch this, so the
    // refresh has to consult the pin itself.
    const c = reading()
    c.state.conversation = [
      { role: 'assistant', content: 'the newest thing said' },
      { role: 'user', content: 'the one before it' },
    ] as ConversationMessage[]
    c.swipeUp()
    c.swipeDown()
    expect(c.state.conversationOffset).toBe(0)
    expect(c.state.conversationPage).toBe(0)

    inner(c).lastConvRefresh = 0
    inner(c).maybeRefreshConversation()
    // A refresh would have replaced the transcript (with nothing, in here).
    expect(c.state.conversation.length).toBe(2)
  })

  test('a swipe that moves nothing pins nothing, and the transcript stays live', () => {
    // The newest reply fits one page, the wearer swipes down expecting a next
    // message, and there is none. Pinning that would silently freeze the
    // transcript on the gesture that used to mean "catch me up".
    const c = reading()
    c.state.conversation = [{ role: 'assistant', content: 'fits one page' }] as ConversationMessage[]
    c.swipeDown()
    expect(screenText(c.state).footer).toContain('auto')

    inner(c).lastConvRefresh = 0
    inner(c).maybeRefreshConversation()
    // The refresh ran: with no server here, the reload empties the transcript.
    expect(c.state.conversation.length).toBe(0)
  })

  test('a swipe racing the initial load pins nothing either', () => {
    const c = reading()
    c.state.conversation = [] as ConversationMessage[]
    c.swipeUp()
    c.swipeDown()
    expect(screenText(c.state).footer).toContain('auto')
  })

  test('pinned at the newest message, one double-tap releases and the next one leaves', async () => {
    const c = reading()
    c.state.conversation = [
      { role: 'assistant', content: 'the newest thing said' },
      { role: 'user', content: 'the one before it' },
    ] as ConversationMessage[]
    // Up then down: both moved, so the pin is held at a true 0/0.
    c.swipeUp()
    c.swipeDown()
    expect(c.state.conversationOffset).toBe(0)
    expect(c.state.conversationPage).toBe(0)
    expect(screenText(c.state).footer).not.toContain('auto')

    await c.doubleTap()
    expect(c.state.mode).toBe('conversation')
    expect(screenText(c.state).footer).toContain('auto')

    await c.doubleTap()
    expect(c.state.mode).toBe('session_list')
  })

  test('the release stays in reach while a banner-grade item is queued', async () => {
    // The banner dismiss used to swallow the double-tap ahead of the pin, so
    // a pinned reader had no way back to a live transcript for as long as
    // anything was queued. The pin is the innermost level: it comes off first
    // and the item stays queued for the next tap.
    const c = reading()
    c.state.conversation = [
      { role: 'assistant', content: 'the newest thing said' },
      { role: 'user', content: 'the one before it' },
    ] as ConversationMessage[]
    c.swipeUp()
    c.swipeDown()
    expect(screenText(c.state).footer).not.toContain('auto')
    inner(c).onRelayUpsert({
      id: 'b1',
      kind: 'waiting',
      source: 'auto',
      sessionId: 's1',
      paneId: '%0',
      text: 'Which migration?',
      present: 'banner',
      createdAt: 1,
    } as GlassesRelayItem)

    await c.doubleTap()
    expect(c.state.mode).toBe('conversation')
    expect(screenText(c.state).footer).toContain('auto')
    expect(inner(c).queue.topWaiting()?.id).toBe('b1')
  })

  test('the release clears the notice window with the rest of the position', async () => {
    const c = reading()
    c.state.conversation = [
      { role: 'assistant', content: 'the newest thing said' },
      { role: 'user', content: 'the one before it' },
    ] as ConversationMessage[]
    c.swipeUp()
    c.swipeDown()
    c.state.noticeWindow = 3

    await c.doubleTap()
    expect(c.state.noticeWindow).toBe(0)
  })

  test('a release without a gesture un-rests the clock', () => {
    // Gestures already clear the rest on their way in (handle() does it), so
    // only a release nobody's hand triggered can prove resumeAutoAdvance()
    // clears it: following the phone's focus is one.
    const c = reading()
    c.state.sessions = [
      { id: 's1', name: 'one', state: 'idle' },
      { id: 's2', name: 'two', state: 'idle' },
    ] as GlassesController['state']['sessions']
    idleThenTick(c, 200)
    expect(inner(c).autoResting).toBe(true)

    c.ws.subscribe = () => {}
    inner(c).followFocus({ sessionId: 's2' })
    c.state.conversation = [{ role: 'assistant', content: LONG }] as ConversationMessage[]
    idleThenTick(c)
    expect(c.state.conversationPage).toBeGreaterThan(0)
  })
})
