// The tutorial, in both languages, against the panel it has to fit on.
//
// The demo is the one screen a wearer meets before anything is set up, so it
// follows the phone's language rather than a setting - there is nowhere to go
// and change one first. That makes the Japanese a first-class copy of the
// lesson rather than a translation of it: full-width characters take twice the
// room, so the same sentence written the same way runs off the panel or eats
// the page the next line needed.
//
// These are budget tests. They do not read the prose; they check it fits.

import { beforeAll, describe, expect, test } from 'bun:test'

// The storage key is built from constants Vite injects, and `setLang` writes
// through it. Unit tests import the module directly, with nothing injected.
;(globalThis as unknown as { __STORAGE_PREFIX__: string }).__STORAGE_PREFIX__ = 'hrdle-'

import { BODY_WIDTH, splitLines, textWidth } from '../metrics.ts'
import { conversationLines, screenText } from '../display.ts'
import type { AppState } from '../display.ts'
import { getLang, keysOf, setLang } from '../i18n.ts'
import type { Lang } from '../i18n.ts'
import { demoChoices, demoConversation, demoSessions, demoTranscript } from '../demo.ts'

const LANGS: Lang[] = ['en', 'ja']

/** Lines the panel would need for a message. */
function lines(text: string): number {
  return text.split('\n').reduce((n, l) => n + Math.max(1, splitLines(l, BODY_WIDTH).length), 0)
}

/** The conversation screen as the demo opens it: the waiting workspace, its
 *  recap, and the transcript at its newest message. */
function conversationState(): AppState {
  const sessions = demoSessions()
  return {
    mode: 'conversation',
    sessions,
    sessionIndex: 0,
    selectedPaneId: null,
    conversation: demoConversation(),
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 20,
    conversationHasMore: false,
    conversationLoading: false,
    choiceOptions: [],
    choiceIndex: 0,
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
    spinnerTick: 0,
    demo: true,
  } as unknown as AppState
}

beforeAll(() => {
  // Leave the run in the language it started in.
  const started = getLang()
  process.on('exit', () => setLang(started))
})

describe('both languages carry the tutorial', () => {
  test('every demo key exists in both tables', () => {
    const demoKeys = (l: Lang) => keysOf(l).filter((k) => k.startsWith('demo.'))
    expect(demoKeys('ja')).toEqual(demoKeys('en'))
    expect(demoKeys('en').length).toBeGreaterThan(15)
  })

  test('the workspaces are named differently in each', () => {
    // A missing Japanese key falls back to English silently, which reads as a
    // finished screen with one row in the wrong language.
    setLang('en')
    const en = demoSessions().map((s) => s.name)
    setLang('ja')
    const ja = demoSessions().map((s) => s.name)
    for (let i = 0; i < en.length; i++) expect(ja[i]).not.toBe(en[i])
  })
})

describe('it fits the panel in both', () => {
  for (const lang of LANGS) {
    test(`${lang}: a workspace name is one row`, () => {
      setLang(lang)
      for (const s of demoSessions()) {
        // The row carries a cursor, brackets and a context bar besides the
        // name, so the name alone has to leave room for them.
        expect(textWidth(`>  [${s.name}] ctx:_`)).toBeLessThanOrEqual(BODY_WIDTH)
        for (const p of s.panes ?? []) expect(textWidth(`>      ${p.label} ctx:_`)).toBeLessThanOrEqual(BODY_WIDTH)
      }
    })

    test(`${lang}: an option is one row`, () => {
      setLang(lang)
      for (const o of demoChoices()) expect(textWidth(`>>> ${o}`)).toBeLessThanOrEqual(BODY_WIDTH)
    })

    test(`${lang}: the transcript is one row`, () => {
      setLang(lang)
      expect(lines(demoTranscript())).toBe(1)
    })

    test(`${lang}: the whole lesson is on the first page`, () => {
      // Asserted against what the screen draws, not against a line count of
      // its own: a conversation opens at its newest message, so a line that
      // does not fit is behind the swipe the lesson is there to explain. An
      // arithmetic model of the page was wrong by one and let exactly that
      // through - the paging line, the one explaining the swipe.
      setLang(lang)
      const { body, notice } = screenText(conversationState())
      const noticeLines = notice ? splitLines(notice, BODY_WIDTH).length : 0
      // What the container holds once the recap strip has taken its share.
      // screenText hands back everything it assembled; the panel is what
      // clips, so the count has to be checked here rather than inferred from
      // what came back.
      expect(lines(body)).toBeLessThanOrEqual(conversationLines(noticeLines))
      const shown = body
      for (const m of demoConversation()) {
        // The opening question is the wearer's own line and can page off the
        // top; everything the app is teaching has to be visible.
        if (m.role === 'user') continue
        expect(shown).toContain(m.content.split('\n')[0].slice(0, 12))
      }
    })
  }
})
