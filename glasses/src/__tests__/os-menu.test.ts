// The menu the glasses OS draws for this app.
//
// It exists because the host moved its own menu behind `tap` then long press,
// and this app spends `tap` on choosing and speaking - so the first tap moves
// the screen and the sequence never arrives. Long press is the only input left
// on any screen.
//
// Two things are pinned here. The entry must ride EVERY container, because a
// rebuild that omits it clears the menu and this app rebuilds on every change
// of screen; and sleeping must refuse the screens that are themselves the
// input.

import { describe, expect, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import type { GlassesPlatform } from '../controller.ts'
import { updateDisplay, invalidatePanel, setupEvents, MENU_SLEEP_ID } from '../display.ts'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { t, setLang } from '../i18n.ts'
import type { AppState } from '../display.ts'

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

function reading(): GlassesController {
  const c = new GlassesController(platform())
  c.state.sessions = [
    { id: 's1', name: 'one', state: 'idle' },
  ] as GlassesController['state']['sessions']
  c.state.sessionIndex = 0
  c.state.mode = 'conversation'
  return c
}

describe('sleeping on request', () => {
  test('darkens a screen that is only being read', () => {
    const c = reading()
    c.sleepNow()
    expect(c.state.screenOff).toBe(true)
  })

  test('the session list too', () => {
    const c = reading()
    c.state.mode = 'session_list'
    c.sleepNow()
    expect(c.state.screenOff).toBe(true)
  })

  test('refuses mid-utterance', () => {
    // The panel IS the input here: darkening it would leave the wearer
    // speaking into a screen that stopped telling them it was listening.
    const c = reading()
    c.state.mode = 'voice'
    ;(c as unknown as { listening: boolean }).listening = true
    c.sleepNow()
    expect(c.state.screenOff).toBeFalsy()
  })

  test('allows it between phrases, where the finger is off', () => {
    // Nothing is being taken in and the draft is only waiting, so this is a
    // resting screen like any other - and it is where the wearer reaches for
    // the menu, so refusing here is refusing the only time they ask.
    const c = reading()
    c.state.mode = 'voice'
    ;(c as unknown as { listening: boolean }).listening = false
    c.sleepNow()
    expect(c.state.screenOff).toBe(true)
  })

  test('refuses mid-pick', () => {
    const c = reading()
    c.state.mode = 'choice'
    c.sleepNow()
    expect(c.state.screenOff).toBeFalsy()
  })

  test('a dark panel stays dark rather than toggling back', () => {
    // The menu entry says "screen off", not "screen toggle" - and the wearer
    // cannot see which state they are in while it is dark.
    const c = reading()
    c.sleepNow()
    c.sleepNow()
    expect(c.state.screenOff).toBe(true)
  })
})

describe('the menu rides every container', () => {
  /**
   * A rebuild that omits `menuObject` clears the menu, and this app rebuilds
   * whenever the screen changes. So the entries are attached at the one exit
   * rather than in each `build*`, and this walks the screens to prove none of
   * them arrives without them - the failure otherwise is silent and only
   * visible on a device.
   */
  const MODES: Array<AppState['mode']> = [
    'session_list', 'conversation', 'choice', 'voice', 'overlay',
  ]

  function sent(): { containers: Array<{ menuObject?: unknown }>; bridge: never } {
    const containers: Array<{ menuObject?: unknown }> = []
    const bridge = {
      textContainerUpgrade: () => Promise.resolve(),
      rebuildPageContainer: (c: { menuObject?: unknown }) => {
        containers.push(c)
        return Promise.resolve(true)
      },
    } as never
    return { containers, bridge }
  }

  test.each(MODES)('%s carries the entry', async (mode) => {
    const { containers, bridge } = sent()
    const c = reading()
    c.state.mode = mode
    invalidatePanel()
    await updateDisplay(bridge, c.state)
    expect(containers.length).toBeGreaterThan(0)
    const items = (containers[0].menuObject as { menuItems: Array<{ itemID: number }> }).menuItems
    expect(items.map((i) => i.itemID)).toEqual([MENU_SLEEP_ID])
  })

  test('a dark panel carries it too', async () => {
    // The screen a wearer most needs a way out of is the one showing nothing.
    const { containers, bridge } = sent()
    const c = reading()
    c.sleepNow()
    invalidatePanel()
    await updateDisplay(bridge, c.state)
    expect(containers.length).toBeGreaterThan(0)
    expect((containers[0].menuObject as { menuItems: unknown[] }).menuItems).toHaveLength(1)
  })
})

describe('the entry is drawn by the glasses OS, so it is not held to English', () => {
  /**
   * Everything the panel draws stays English: Japanese is full-width and the
   * line widths and seven-line clamp are reckoned in the firmware's advances.
   * A menu entry is drawn by the host instead, in its own furniture, so that
   * reasoning does not reach it - and the setting it pairs with ("auto
   * screen-off") is in the wearer's language already.
   */
  const LABEL_BYTE_LIMIT = 32

  test('both languages fit what the firmware stores', () => {
    for (const lang of ['en', 'ja'] as const) {
      setLang(lang)
      const label = t('menu.sleep')
      expect(label.length).toBeGreaterThan(0)
      expect(new TextEncoder().encode(label).length).toBeLessThanOrEqual(LABEL_BYTE_LIMIT)
    }
  })

  test('the two languages say different things', () => {
    // A key present in one table and missing from the other falls back to
    // English silently, which is a screen in the wrong language that nobody
    // notices.
    setLang('en')
    const en = t('menu.sleep')
    setLang('ja')
    expect(t('menu.sleep')).not.toBe(en)
  })
})

describe('what the host sends reaches the app', () => {
  /**
   * The decoder in `setupEvents` is the only thing between the SDK's event
   * channel and every gesture this app has. Tests that call controller methods
   * directly cannot see it, so deleting a branch of it leaves a suite that is
   * entirely green and an app that no longer answers a press.
   */
  function dispatcher(): {
    send: (event: unknown) => void
    seen: string[]
    menu: number[]
  } {
    const seen: string[] = []
    const menu: number[] = []
    let handler: (event: unknown) => void = () => {}
    const bridge = {
      onEvenHubEvent(fn: (event: unknown) => void) {
        handler = fn
        return () => {}
      },
    } as never
    setupEvents(bridge, {
      onSwipeDown: () => seen.push('swipeDown'),
      onSwipeUp: () => seen.push('swipeUp'),
      onTap: () => seen.push('tap'),
      onDoubleTap: () => seen.push('doubleTap'),
      onLongPress: () => seen.push('longPress'),
      onLongPressEnd: () => seen.push('longPressEnd'),
      onMenuItem: (id) => menu.push(id),
    })
    return { send: (event: unknown) => handler(event), seen, menu }
  }

  test('a press and its release arrive as two gestures', () => {
    const { send, seen } = dispatcher()
    send({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } })
    send({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT } })
    expect(seen).toEqual(['longPress', 'longPressEnd'])
  })

  test('a short hold keeps its release', () => {
    // The ring debounce drops anything within 300ms of the last gesture, and a
    // press with its release inside that window is one phrase - so a release
    // swallowed there leaves the app believing the finger is still down, with
    // no second release ever coming to correct it.
    const { send, seen } = dispatcher()
    send({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } })
    send({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT } })
    send({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } })
    expect(seen).toEqual(['longPress', 'longPressEnd', 'longPress'])
  })

  test('a menu choice arrives with the item that was chosen', () => {
    // Not as a gesture: the menu is the host's own furniture, drawn over our
    // containers, so nothing lands on one of them.
    const { send, seen, menu } = dispatcher()
    send({ menuItemClickEvent: { itemID: MENU_SLEEP_ID } })
    expect(menu).toEqual([MENU_SLEEP_ID])
    expect(seen).toEqual([])
  })

  test('the item id is what decides, on both sides of the app', () => {
    // The device is handed an id and the simulator's stand-in button supplies
    // the same one, so the mapping belongs to neither of them.
    const c = reading()
    c.menuItem(MENU_SLEEP_ID)
    expect(c.state.screenOff).toBe(true)
  })

  test('an entry this app does not know is left alone', () => {
    const c = reading()
    c.menuItem(MENU_SLEEP_ID + 99)
    expect(c.state.screenOff).toBeFalsy()
  })
})
