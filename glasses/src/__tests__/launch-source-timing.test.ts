// Subscribing to the launch source in time.
//
// The host pushes it once when loading completes and the SDK keeps no copy —
// `onLaunchSource` is a plain event subscription with no cached getter beside
// it, so a listener attached after the push never learns the answer. The SDK's
// own troubleshooting table says as much: "No launch source received → register
// `onLaunchSource` early. The host pushes it once after load."
//
// `initDisplay` used to create the startup page container first and hand the
// bridge back afterwards, which put a round trip to the host between the bridge
// existing and anything listening. Three runs on 2026-07-31 reached `startup
// complete` having never been told their launch source, and for `appMenu` that
// is the whole companion UI silently not starting.
//
// The order is the guarantee, so the order is what is asserted.

import { describe, expect, mock, test } from 'bun:test'

/** Every SDK value `display.ts` imports, in a shape that records call order. */
const calls: string[] = []

class Noop {
  constructor(_props?: unknown) {}
}

function fakeBridge() {
  return {
    onLaunchSource(cb: (s: string) => void) {
      calls.push('onLaunchSource')
      queueMicrotask(() => cb('appMenu'))
      return () => calls.push('unsubscribe')
    },
    async createStartUpPageContainer(_c: unknown) {
      calls.push('createStartUpPageContainer')
      return 0
    },
  }
}

mock.module('@evenrealities/even_hub_sdk', () => ({
  waitForEvenAppBridge: async () => {
    calls.push('waitForEvenAppBridge')
    return fakeBridge()
  },
  TextContainerProperty: Noop,
  CreateStartUpPageContainer: Noop,
  RebuildPageContainer: Noop,
  TextContainerUpgrade: Noop,
  OsEventTypeList: {
    FOREGROUND_ENTER: 4,
    FOREGROUND_EXIT: 5,
    ABNORMAL_EXIT: 6,
    SYSTEM_EXIT: 7,
  },
  AudioInputSource: { Glasses: 0, Phone: 1 },
}))

// Supplied by `define` in vite.config.ts, so under `bun test` it has to be put
// there by hand — the startup container's first frame prints the product name.
;(globalThis as unknown as { __PRODUCT_NAME__: string }).__PRODUCT_NAME__ = 'Hrdle'

const { initDisplay } = await import('../display.ts')

describe('the launch-source subscription beats the startup container', () => {
  test('onBridge runs before the container round trip', async () => {
    calls.length = 0
    await initDisplay((b) => {
      calls.push('onBridge')
      b.onLaunchSource(() => {})
    })
    expect(calls.indexOf('onBridge')).toBeGreaterThan(calls.indexOf('waitForEvenAppBridge'))
    expect(calls.indexOf('onLaunchSource')).toBeLessThan(
      calls.indexOf('createStartUpPageContainer'),
    )
  })

  test('the bridge still comes back and the container is still built', async () => {
    calls.length = 0
    const bridge = await initDisplay(() => {})
    expect(bridge).not.toBeNull()
    expect(calls).toContain('createStartUpPageContainer')
  })

  test('a callback that throws costs the caller nothing', async () => {
    // It runs inside `initDisplay`, so an exception there would take the panel
    // with it — the app would come up with no screen because a subscription
    // failed.
    calls.length = 0
    const bridge = await initDisplay(() => {
      throw new Error('subscription blew up')
    })
    expect(bridge).not.toBeNull()
    expect(calls).toContain('createStartUpPageContainer')
  })

  test('no callback at all is still a working init', async () => {
    calls.length = 0
    const bridge = await initDisplay()
    expect(bridge).not.toBeNull()
    expect(calls).toContain('createStartUpPageContainer')
  })
})
