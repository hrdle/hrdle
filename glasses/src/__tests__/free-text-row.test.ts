// The row a wearer reaches for when none of the options fit.
//
// Every agent draws one and the ring cannot type into any of them, so they
// travel marked rather than dropped: picking one opens the microphone. That
// worked on a single-pick list and on nothing else, because the test for it sat
// *after* the multi-select branch had already returned.
//
// Recorded off the glasses on 2026-08-12 (`~/.hrdle/glasses-screen-recording`,
// 18:58:29 and 18:58:35), on a live Claude Code multi-select:
//
//   - `Type something` was tapped. The box ticked and nothing else happened.
//     Tapped again, it unticked. The microphone never opened.
//   - `Chat about this` was tapped twice. The panel did not change at all, so
//     it read as a dead row - but the digit had reached the pane, and the pane
//     had taken the question down and opened a prompt nobody could see.
//
// The second is the worse one: the question was gone and the wearer was still
// looking at a picker for it.
//
// Measured against Claude Code 2.1.228 the same evening, driving a live pane
// key by key, the two rows turn out not to be the same kind of thing at all:
//
//   5. [ ] Type something     <- a field. Typing here fills it and ticks it.
//                                Its digit only ticks the box, and submitting
//                                that way returns an answer with nothing in it.
//   ─────────────────────────
//   6. Chat about this        <- a choice. Its digit takes the question down.
//
// So one is walked to and typed into, the other is answered by number, and
// both open the microphone.
//
// Which of the two a row is, and what key reaches it, are both decided
// server-side and travel on the item (`choiceFieldRows`, `choiceKeys`). This
// file is the app's half: send the key you were handed, listen, and then either
// finish the question or stay on it. Deciding *here* is what costs an ehpk
// build the next time an agent redraws its picker.

import { describe, expect, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import type { GlassesPlatform } from '../controller.ts'

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
  enterChoice(
    options: string[],
    target: { sessionId: string; paneId?: string; itemId?: string },
    inline?: unknown,
    details?: string[],
    freeText?: number[],
    keys?: string[],
    fieldRows?: number[],
  ): void
  sendChoiceKey(data: string): void
  handle(action: 'tap' | 'doubleTap' | 'swipeUp' | 'swipeDown'): Promise<void>
  sendVoice(): Promise<void>
}

const inner = (c: GlassesController) => c as unknown as Internals

const DOWN = '\x1b[B'

/** The keys the server sends for the multi-select below: a walk to the field,
 *  and each other row's own number left to fall out of its position. */
const WALK_TO_FIELD: string[] = []
WALK_TO_FIELD[4] = DOWN.repeat(4)

/** The multi-select from the recording, and where the pane's cursor is on it. */
const MULTI = [
  '[ ] 認証機能',
  '[ ] 通知',
  '[ ] ダークモード',
  '[ ] 多言語対応',
  '[ ] Type something',
  'Chat about this',
]
const FREE_TEXT = [4, 5]

/** A single-pick list with a text row, which is the case that always worked. */
const SINGLE = ['vaultに自分で保存', 'チャットで直接教える', 'Chat about this']

function picker(
  options: string[],
  freeText: number[],
  fieldRows?: number[],
  choiceKeys?: string[],
): { c: GlassesController; keys: string[] } {
  const c = new GlassesController(platform())
  c.state.sessions = [{ id: 's1', name: 'ws', state: 'idle' }] as GlassesController['state']['sessions']
  const keys: string[] = []
  inner(c).sendChoiceKey = (data: string) => { keys.push(data) }
  inner(c).enterChoice(
    options,
    { sessionId: 's1', paneId: '%0', itemId: 'q1' },
    undefined,
    undefined,
    freeText,
    choiceKeys,
    fieldRows,
  )
  return { c, keys }
}

/** Move the wearer's cursor down to `index` and tap. */
async function tapRow(c: GlassesController, index: number): Promise<void> {
  for (let i = 0; i < index; i++) await inner(c).handle('swipeDown')
  await inner(c).handle('tap')
}

describe('the text field of a multi-select', () => {
  test('opens the microphone instead of ticking the box', async () => {
    const { c } = picker(MULTI, FREE_TEXT, [4], WALK_TO_FIELD)
    await tapRow(c, 4)
    expect(c.state.mode).toBe('voice')
    // The box is what the old path left behind, and it is not an answer: the
    // pane returns an empty one when a ticked `Type something` is submitted.
    expect(c.state.choiceOptions[4]).toBe('[ ] Type something')
  })

  test('sends the key it was given rather than the row\'s number', async () => {
    // The digit ticks the box and moves nothing, so a field reached that way is
    // never the row the typing lands in. What reaches it is worked out on the
    // server; this side only has to not substitute a number for it.
    const { c, keys } = picker(MULTI, FREE_TEXT, [4], WALK_TO_FIELD)
    await tapRow(c, 4)
    expect(keys).toEqual([DOWN.repeat(4)])
  })

  test('sends nothing when the key it was given is empty', async () => {
    // Which is how the server says the pane is already sitting on the row. An
    // empty key must not fall back to the digit - that is the exact key this
    // whole path exists to keep off a field.
    const already: string[] = []
    already[4] = ''
    const { c, keys } = picker(MULTI, FREE_TEXT, [4], already)
    await tapRow(c, 4)
    expect(keys).toEqual([])
    expect(c.state.mode).toBe('voice')
  })

  test('the whole walk goes in one send', async () => {
    // The same rule the side-by-side walk follows: separate sends are separate
    // requests and arrive in whatever order they finish in.
    const { c, keys } = picker(MULTI, FREE_TEXT, [4], WALK_TO_FIELD)
    await tapRow(c, 4)
    expect(keys).toHaveLength(1)
  })
})

describe('what the transcript does', () => {
  test('is typed into the field, with no Enter after it', async () => {
    // Enter on a picker row toggles it. A prompt is entered; a field is filled.
    const { c, keys } = picker(MULTI, FREE_TEXT, [4], WALK_TO_FIELD)
    await tapRow(c, 4)
    c.state.voiceText = 'あとで相談したい'
    await inner(c).sendVoice()
    expect(keys).toEqual([DOWN.repeat(4), 'あとで相談したい'])
  })

  test('leaves the picker up, with the row reading back what was said', async () => {
    // The question is not answered yet: the other boxes are still tickable and
    // the send row still has to be pressed. Dropped into the conversation here,
    // a wearer would have no way back to either.
    const { c } = picker(MULTI, FREE_TEXT, [4], WALK_TO_FIELD)
    await tapRow(c, 4)
    c.state.voiceText = 'あとで相談したい'
    await inner(c).sendVoice()
    expect(c.state.mode).toBe('choice')
    expect(c.state.choiceOptions[4]).toBe('[✔] あとで相談したい')
  })
})

describe('the row below the rule', () => {
  test('is answered by its own number, and then listens', async () => {
    // `Chat about this` carries no box, is not marked a field, and takes the
    // question down. Tapped, it used to do nothing visible at all - the panel
    // stayed on a picker whose question no longer existed.
    const { c, keys } = picker(MULTI, FREE_TEXT, [4], WALK_TO_FIELD)
    await tapRow(c, 5)
    expect(keys).toEqual(['6'])
    expect(c.state.mode).toBe('voice')
  })
})

describe('a single-pick list', () => {
  test('still answers its text row by number', async () => {
    // No field rows at all, which is every list but claude's multi-select.
    const { c, keys } = picker(SINGLE, [2])
    await tapRow(c, 2)
    expect(keys).toEqual(['3'])
    expect(c.state.mode).toBe('voice')
  })
})

describe('the rows that are not text', () => {
  test('a box is still ticked by its own number', async () => {
    const { c, keys } = picker(MULTI, FREE_TEXT, [4], WALK_TO_FIELD)
    await tapRow(c, 2)
    expect(keys).toEqual(['3'])
    expect(c.state.mode).toBe('choice')
    expect(c.state.choiceOptions[2]).toBe('[✔] ダークモード')
  })

  test('the send row is still the Tab that finishes the question', async () => {
    const { c, keys } = picker(MULTI, FREE_TEXT, [4], WALK_TO_FIELD)
    await tapRow(c, MULTI.length)
    expect(keys).toEqual(['\t'])
  })
})
