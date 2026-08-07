import { describe, expect, test } from 'bun:test'
;(globalThis as unknown as { __STORAGE_PREFIX__: string }).__STORAGE_PREFIX__ = 'hrdle-'
;(globalThis as unknown as { __LEGACY_STORAGE_PREFIXES__: string[] }).__LEGACY_STORAGE_PREFIXES__ = []

import { screenText } from '../display.ts'
import type { AppState } from '../display.ts'

/**
 * Only a summary earns the strip above the transcript.
 *
 * Claude writes an away_summary: text that exists nowhere else. A thread agent
 * has no such thing, so what it sends is a copy of its own latest message -
 * one useful line on a workspace card, and on this screen the same words as
 * the message directly beneath it, in two of the eight lines there are.
 *
 * It could not retire itself either. The staleness test compares the recap
 * against the newest message, and when the recap *is* the newest message it is
 * never behind: on 2026-08-08 the kimi session drew it on 79% of its
 * conversation frames while claude's drew 0%.
 */

function state(over: Partial<Record<string, unknown>>): AppState {
  return {
    mode: 'conversation',
    sessions: [{ id: 'w1', name: 'work', state: 'active', ...over }],
    sessionIndex: 0,
    selectedPaneId: null,
    conversation: [{ role: 'assistant', content: 'the newest message' }],
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
  } as unknown as AppState
}

describe('the recap strip', () => {
  test("a thread agent's copy of its latest message is not shown", () => {
    const { notice } = screenText(state({
      ccRecap: 'the newest message',
      ccRecapAt: '2026-08-08T06:00:00.000Z',
      ccRecapKind: 'last-message',
    }))
    expect(notice).toBe('')
  })

  test("claude's summary still is", () => {
    const { notice } = screenText(state({
      ccRecap: 'renamed the service and moved its unit file',
      ccRecapAt: '2026-08-08T06:00:00.000Z',
      ccRecapKind: 'summary',
    }))
    expect(notice).toContain('renamed the service')
  })

  test('a server that sends no kind is treated as a summary', () => {
    // An ehpk can outlive the server it talks to; the old shape has to keep
    // meaning what it meant.
    const { notice } = screenText(state({
      ccRecap: 'renamed the service and moved its unit file',
      ccRecapAt: '2026-08-08T06:00:00.000Z',
    }))
    expect(notice).toContain('renamed the service')
  })
})

describe('an ehpk talking to a server from before the kind', () => {
  test("a thread agent's recap is hidden on the agent alone", () => {
    // v0.3.76 and earlier send no kind at all. The app still knows which agent
    // it is, and every agent but claude reaches its recap the same way.
    const { notice } = screenText(state({
      agent: 'kimi',
      ccRecap: 'the newest message',
      ccRecapAt: '2026-08-08T06:00:00.000Z',
    }))
    expect(notice).toBe('')
  })

  test("claude's is still drawn", () => {
    const { notice } = screenText(state({
      agent: 'claude',
      ccRecap: 'renamed the service and moved its unit file',
      ccRecapAt: '2026-08-08T06:00:00.000Z',
    }))
    expect(notice).toContain('renamed the service')
  })

  test('the server wins where it does speak', () => {
    // A kind of `summary` on a non-claude agent is the server telling us
    // something this side cannot know. It is not overruled by the guess.
    const { notice } = screenText(state({
      agent: 'kimi',
      ccRecap: 'a real summary, somehow',
      ccRecapAt: '2026-08-08T06:00:00.000Z',
      ccRecapKind: 'summary',
    }))
    expect(notice).toContain('a real summary')
  })
})
