// Reading what an option means, not just what it is called.
//
// A picker row is one line and the panel cuts what overruns it, and an option
// used to arrive with its description glued to its label. So every row ended in
// an ellipsis a few characters into the description - the part that decides
// between the options - and the wearer of the G2 on 2026-08-12 put it plainly:
// the choices appear, but the information needed to choose cannot be read.
//
// The first answer drew the description of the row under the cursor once,
// beneath the whole list. Reported the same evening, with five options on
// screen: four of the panel's eight lines had gone to labels and the
// description arrived as a line and a half. So the two are interleaved now -
// label, description, label, description - and the list scrolls with the ring.

import { describe, expect, test } from 'bun:test'
import { choiceWindow, screenText } from '../display.ts'
import { MAX_LINES } from '../metrics.ts'
import type { AppState } from '../display.ts'

function st(over: Partial<AppState> = {}): AppState {
  return {
    mode: 'choice',
    sessions: [],
    sessionIndex: 0,
    conversation: [],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 0,
    conversationHasMore: false,
    conversationLoading: false,
    choiceOptions: ['種モデルに移行', '現状維持'],
    choiceDetails: [
      '起動時に共通設定を取り込み、以降はワークスペースが持つ',
      '共有グロサリーとワークスペース単位の辞退で足りるとする',
    ],
    choiceIndex: 0,
    choiceSessionName: 'dashboard',
    relayWaiting: [],
    relayInfo: [],
    ...over,
  } as unknown as AppState
}

/** The body as the panel would draw it, line by line. */
const bodyLines = (state: AppState): string[] => screenText(state).body.split('\n')

describe('an option and what it says about itself', () => {
  test('the description follows the label it belongs to', () => {
    const lines = bodyLines(st())
    expect(lines[0]).toContain('種モデルに移行')
    expect(lines[1]).toContain('起動時に共通設定を取り込み、以降はワークスペースが持つ')
  })

  test('every option carries its own, not only the one under the cursor', () => {
    // Drawn once below the list, a description reads as a caption to the list
    // rather than as part of an option - and the wearer has to move the ring to
    // find out what each one means before deciding which to move it to.
    const body = bodyLines(st()).join('\n')
    expect(body).toContain('起動時に共通設定を取り込み')
    expect(body).toContain('共有グロサリーとワークスペース単位の辞退で足りるとする')
  })

  test('no label is cut, because a label is the line and the description is not on it', () => {
    for (const line of bodyLines(st())) {
      expect(line).not.toContain('…')
    }
  })

  test('the panel is not overrun', () => {
    expect(bodyLines(st()).length).toBeLessThanOrEqual(MAX_LINES)
  })
})

describe('when there is nothing to add', () => {
  test('an older server sends no details and the labels are the whole picker', () => {
    expect(bodyLines(st({ choiceDetails: undefined }))).toHaveLength(2)
  })

  test('an option with nothing to say takes one line', () => {
    const lines = bodyLines(st({ choiceDetails: ['', 'あとの方だけ説明がある'] }))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('種モデルに移行')
    expect(lines[1]).toContain('現状維持')
    expect(lines[2]).toContain('あとの方だけ説明がある')
  })
})

describe('a list longer than the panel', () => {
  const blocks = Array.from({ length: 6 }, (_, i) => [`label${i}`, `detail${i}a`, `detail${i}b`])

  test('the window holds the option the ring is on', () => {
    const shown = choiceWindow(blocks, 3, 8).join('\n')
    expect(shown).toContain('label3')
    expect(shown).toContain('detail3a')
    expect(shown).toContain('detail3b')
  })

  test('it scrolls with the ring rather than paging', () => {
    // Two rings apart is two blocks further down, not a screen further down:
    // what was at the bottom is still on screen, which is what tells the wearer
    // the list moved rather than changed.
    const near = choiceWindow(blocks, 2, 8)
    const far = choiceWindow(blocks, 3, 8)
    expect(near).not.toEqual(far)
    expect(far.filter((l) => near.includes(l)).length).toBeGreaterThan(0)
  })

  test('a label is never scrolled off above its own description', () => {
    // A description with nothing over it saying which option it belongs to is
    // worse than one that is cut.
    const tall = [['label0'], Array.from({ length: 12 }, (_, i) => `line${i}`)]
    expect(choiceWindow(tall, 1, 8)[0]).toBe('line0')
  })

  test('the top of the list needs no scrolling', () => {
    expect(choiceWindow(blocks, 0, 8)[0]).toBe('label0')
  })

  test('a list that fits is shown whole', () => {
    expect(choiceWindow(blocks.slice(0, 2), 1, 8)).toHaveLength(6)
  })
})
