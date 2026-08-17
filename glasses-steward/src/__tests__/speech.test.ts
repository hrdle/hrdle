// Turning several transcriptions back into one instruction.
//
// Speech arrives a phrase at a time, because a phrase is what a single request
// bills for and what a single swipe takes back. What is sent is the join of
// them, and the join is not the same in every language.

import { describe, expect, test } from 'bun:test'
import { joinPhrases, pcmRms } from '../controller.ts'
import { micLevel, micLevelBar, SPEECH_RMS } from '../display.ts'

describe('joining what was said', () => {
  test('English keeps its spaces', () => {
    expect(joinPhrases(['send the review', 'to Fable'])).toBe('send the review to Fable')
  })

  // Inserting one would be a space in the middle of a Japanese sentence, which
  // is not how it is written - and it reaches an agent as text either way.
  test('Japanese runs together with no space inserted', () => {
    expect(joinPhrases(['レビューを', 'Fable に投げて'])).toBe('レビューをFable に投げて')
  })

  test('empty phrases leave no trace', () => {
    expect(joinPhrases(['', 'one', '  ', 'two'])).toBe('one two')
    expect(joinPhrases([])).toBe('')
  })
})

describe('the loudness meter', () => {
  test('silence fills nothing and speech crosses the divider', () => {
    expect(micLevel(0)).toBe(0)
    const quietCells = micLevelBar(0).indexOf('|')
    expect(micLevel(SPEECH_RMS)).toBeGreaterThan(quietCells)
  })

  // Drawn with a narrow character for the empty cells, the whole meter shifts
  // on every syllable.
  test('the bar is the same width however loud it is', () => {
    expect(micLevelBar(0).length).toBe(micLevelBar(12).length)
  })

  test('RMS is measured over the samples, not the bytes', () => {
    const samples = new Int16Array([1000, -1000, 1000, -1000])
    expect(Math.round(pcmRms(new Uint8Array(samples.buffer)))).toBe(1000)
    expect(pcmRms(new Uint8Array(0))).toBe(0)
  })
})
