// The screen-off rules that came out of review rather than design, each the
// fix for a way the first version misbehaved against the world as it is:
//
// - a server older than the feature answers without `screenOffSeconds`, and
//   `undefined * 1000` is NaN - which slips every guard in `tickScreenOff`
//   and blanks the panel with no idle time at all
// - the notices the same-session rule suppresses arrive on every agent turn,
//   so a dark panel they could relight would never reach its timeout
// - disabling the timeout while the panel is dark must also relight it
// - the relay snapshot is re-sent on every reconnect, and presenting the same
//   pending item again relights a dark panel with nothing new to show

import { describe, expect, mock, test } from 'bun:test'
import type { GlassesRelayItem } from '../types.ts'

// Pass-through mock (see launch-source-timing.test.ts for why): only
// `getGlassesSettings` is replaced, and its default behavior - rejecting, as
// against an unreachable server - matches what every other test already gets
// from a real fetch in this environment.
const actualApi = await import('../api.ts')
let settingsView: Record<string, unknown> | null = null

mock.module('../api.ts', () => ({
  ...actualApi,
  getGlassesSettings: async () => {
    if (settingsView === null) throw new Error('unreachable in tests')
    return settingsView
  },
}))

const { GlassesController } = await import('../controller.ts')
type Controller = InstanceType<typeof GlassesController>

function platform() {
  return {
    onDevice: false,
    render() {},
    renderHeader() {},
    requestExit() {},
    async startMicCapture() { return true },
    async stopMicCapture() {},
    async transcribeAudio() { throw new Error('not used here') },
  } as unknown as ConstructorParameters<typeof GlassesController>[0]
}

type Internals = {
  lastGestureAt: number
  lastActivityAt: number
  screenOffIdleMs: number
  tickScreenOff(): void
  refreshScreenOffSetting(): void
  onRelayUpsert(item: GlassesRelayItem): void
  onRelaySnapshot(items: GlassesRelayItem[]): void
}

const inner = (c: Controller) => c as unknown as Internals

const TEST_IDLE_MS = 60_000

function controller(mode: 'session_list' | 'conversation') {
  const c = new GlassesController(platform())
  inner(c).screenOffIdleMs = TEST_IDLE_MS
  c.state.sessions = [
    { id: 's1', name: 'one', state: 'idle' },
    { id: 's2', name: 'two', state: 'idle' },
  ] as Controller['state']['sessions']
  c.state.sessionIndex = 0
  c.state.mode = mode
  return c
}

function ageOut(c: Controller): void {
  inner(c).lastGestureAt = Date.now() - TEST_IDLE_MS - 1
  inner(c).lastActivityAt = Date.now() - TEST_IDLE_MS - 1
}

function goDark(c: Controller): void {
  ageOut(c)
  inner(c).tickScreenOff()
  expect(c.state.screenOff).toBe(true)
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('the setting against an older server', () => {
  test('an answer without the field leaves the timeout untouched', async () => {
    const c = controller('session_list')
    inner(c).screenOffIdleMs = 0
    settingsView = {}
    inner(c).refreshScreenOffSetting()
    await flush()
    // NaN here would slip both guards and blank the panel on the first tick.
    expect(inner(c).screenOffIdleMs).toBe(0)
    ageOut(c)
    inner(c).tickScreenOff()
    expect(c.state.screenOff).toBeUndefined()
    settingsView = null
  })

  test('a real value still lands', async () => {
    const c = controller('session_list')
    settingsView = { screenOffSeconds: 30 }
    inner(c).refreshScreenOffSetting()
    await flush()
    expect(inner(c).screenOffIdleMs).toBe(30_000)
    settingsView = null
  })
})

describe('what a dark panel is woken by', () => {
  const info = (id: string, sessionId: string): GlassesRelayItem =>
    ({
      id,
      kind: 'info',
      source: 'auto',
      sessionId,
      text: 'response complete',
      createdAt: 1,
    }) as GlassesRelayItem

  test('the same conversation\'s own turn-by-turn notices leave it dark', () => {
    // These arrive on every agent response; a panel they could relight would
    // never reach its timeout while an agent is working.
    const c = controller('conversation')
    goDark(c)
    inner(c).onRelayUpsert(info('i1', 's1'))
    expect(c.state.screenOff).toBe(true)
    expect(c.state.mode).toBe('conversation')
  })

  test('another session\'s notice still wakes it', () => {
    const c = controller('conversation')
    goDark(c)
    inner(c).onRelayUpsert(info('i2', 's2'))
    expect(c.state.screenOff).toBe(false)
    expect(c.state.mode).toBe('overlay')
  })
})

describe('disabling the timeout while dark', () => {
  test('the next tick relights the panel', () => {
    const c = controller('session_list')
    goDark(c)
    // The wearer who just saved 0 on the phone reads a still-black panel as a
    // save that did not work.
    inner(c).screenOffIdleMs = 0
    inner(c).tickScreenOff()
    expect(c.state.screenOff).toBe(false)
  })
})

describe('the relay snapshot on reconnect', () => {
  const waiting = (id: string): GlassesRelayItem =>
    ({
      id,
      kind: 'waiting',
      source: 'auto',
      sessionId: 's1',
      paneId: '%0',
      text: 'Which migration?',
      present: 'takeover',
      createdAt: 1,
    }) as GlassesRelayItem

  test('the same pending item presents once, not on every reconnect', () => {
    const c = controller('conversation')
    inner(c).onRelaySnapshot([waiting('q1')])
    expect(c.state.mode).toBe('overlay')
    goDark(c)
    // The link flaps; the server re-sends the same snapshot on reconnect.
    inner(c).onRelaySnapshot([waiting('q1')])
    expect(c.state.screenOff).toBe(true)
  })

  test('a genuinely new pending item still presents', () => {
    const c = controller('conversation')
    inner(c).onRelaySnapshot([waiting('q1')])
    goDark(c)
    inner(c).onRelaySnapshot([waiting('q2')])
    expect(c.state.screenOff).toBe(false)
    expect(c.state.mode).toBe('overlay')
  })
})
