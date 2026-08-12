// Reading what an option means, not just what it is called.
//
// A picker row is one line and the panel cuts what overruns it, and an option
// used to arrive with its description glued to its label. So every row ended in
// an ellipsis a few characters into the description - the part that decides
// between the options - and the wearer of the G2 on 2026-08-12 put it plainly:
// the choices appear, but the information needed to choose cannot be read.
//
// Three options take three of the panel's eight lines. The picker had been
// drawing three cut rows into a screen more than half empty.

import { describe, expect, test } from 'bun:test'
import { screenText } from '../display.ts'
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

describe('the description of the option under the cursor', () => {
  test('is drawn in full under the rows', () => {
    const lines = bodyLines(st())
    expect(lines.join('\n')).toContain('起動時に共通設定を取り込み、以降はワークスペースが持つ')
  })

  test('no row is cut, because a row is now the label alone', () => {
    for (const line of bodyLines(st())) {
      expect(line).not.toContain('…')
    }
  })

  test('moving the ring reads the next one', () => {
    const lines = bodyLines(st({ choiceIndex: 1 }))
    expect(lines.join('\n')).toContain('共有グロサリーとワークスペース単位の辞退で足りるとする')
    expect(lines.join('\n')).not.toContain('起動時に共通設定を取り込み')
  })

  test('every option is still on the screen', () => {
    const body = bodyLines(st()).join('\n')
    expect(body).toContain('種モデルに移行')
    expect(body).toContain('現状維持')
  })

  test('the panel is not overrun', () => {
    expect(bodyLines(st()).length).toBeLessThanOrEqual(MAX_LINES)
  })
})

describe('when there is nothing to add', () => {
  test('an older server sends no details and the rows are the whole picker', () => {
    const lines = bodyLines(st({ choiceDetails: undefined }))
    expect(lines).toHaveLength(2)
  })

  test('an option with no description of its own gets no rule under it', () => {
    const lines = bodyLines(st({ choiceDetails: ['', 'あとの方だけ説明がある'] }))
    expect(lines).toHaveLength(2)
  })

  test('a long list keeps its options rather than its descriptions', () => {
    // The rows are what the cursor indexes, so they can never be given up for
    // the block below them. Eight options fill the panel and the description
    // simply has nowhere to go.
    const many = Array.from({ length: 8 }, (_, i) => `選択肢${i + 1}`)
    const lines = bodyLines(st({ choiceOptions: many, choiceDetails: many.map(() => '説明') }))
    expect(lines).toHaveLength(8)
    expect(lines.join('\n')).not.toContain('説明')
  })
})
