// Which of the app's subscriptions is a person choosing.
//
// The glasses follow the focus election, so the subscriptions they make are
// mostly its own output coming back - and the server, seeing only a subscribe,
// cannot tell those from the one the wearer made with the ring. It excluded
// the glasses from the election entirely rather than guess, and a tablet left
// visible on a desk then outbid a wearer who had just picked a session.
//
// Only this side knows which act it is performing, so only this side can say.
// `claimFocus` is that sentence, and these tests are about where it may appear:
// on a gesture, and nowhere else.

import { describe, expect, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import type { GlassesPlatform } from '../controller.ts'
import type { ClientFocus } from '../types.ts'

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
  onSessionListAction(action: 'tap' | 'swipeUp' | 'swipeDown'): Promise<void>
  onSessionsUpdated(sessions: unknown[], focus?: ClientFocus): void
  loadConversation(): Promise<void>
  lastGestureAt: number
}

const inner = (c: GlassesController) => c as unknown as Internals

/** Records what went out, with the conversation fetch stubbed - none of this
 *  is about the network. */
function listeningAt(index: number) {
  const c = new GlassesController(platform())
  const claimed: string[] = []
  const subscribed: string[] = []
  c.state.sessions = [
    { id: 'w54', name: 'one', state: 'idle' },
    { id: 'w66', name: 'two', state: 'idle' },
  ] as GlassesController['state']['sessions']
  c.state.sessionIndex = index
  c.state.mode = 'session_list'
  c.ws.claimFocus = (id: string) => { claimed.push(id) }
  c.ws.subscribe = (id: string) => { subscribed.push(id) }
  inner(c).loadConversation = async () => {}
  return { c, claimed, subscribed }
}

describe('the ring claims, the election does not', () => {
  test('a tap on a row claims that session', async () => {
    const { c, claimed, subscribed } = listeningAt(1)
    await inner(c).onSessionListAction('tap')
    expect(claimed).toEqual(['w66'])
    expect(subscribed).toEqual(['w66'])
  })

  test('walking the list claims nothing until it is tapped', async () => {
    const { c, claimed } = listeningAt(0)
    await inner(c).onSessionListAction('swipeDown')
    await inner(c).onSessionListAction('swipeUp')
    expect(claimed).toEqual([])
  })

  /**
   * The feedback loop. Following subscribes exactly as a tap does, so a server
   * reading claims off subscriptions would take every follow for a wearer's
   * choice and the glasses would then hold the focus against every other
   * screen for as long as they stayed connected.
   */
  test('following a phone subscribes without claiming', () => {
    const { c, claimed, subscribed } = listeningAt(0)
    c.state.mode = 'conversation'
    // The election only moves the glasses when the ring has been quiet.
    inner(c).lastGestureAt = 0
    inner(c).onSessionsUpdated(
      [
        { id: 'w54', name: 'one', state: 'idle' },
        { id: 'w66', name: 'two', state: 'idle' },
      ],
      { sessionId: 'w66', deviceType: 'mobile', at: Date.now() },
    )
    expect(subscribed).toEqual(['w66'])
    expect(claimed).toEqual([])
  })
})
