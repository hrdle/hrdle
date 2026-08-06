// The green a store submission has to be drawn in.
//
// EVEN Hub rejected v0.0.48 with "the color tone of the provided screenshots
// does not match the original display captured from the simulator". The
// original is `@evenrealities/evenhub-simulator`, whose screenshot endpoint
// writes RGBA with the colour fixed at pure green and only the alpha varying.
// Measured on 2026-08-04: every pixel of every capture was exactly (0,255,0),
// seven distinct RGBA values across a screen. Ours was a mint with a bloom
// behind it - 251 distinct values on the same screen - and that is what a
// reviewer saw as processed.
//
// The panel keeps its own green, because it is nicer to look at and this
// window is mostly for looking at. Only the export changes. These tests hold
// that split: they are cheap, and the thing they guard is a rejection that
// costs a day.
//
// What they deliberately do NOT check is layout. That was measured against the
// official simulator the same day, on the same two screens, and came back with
// identical line counts, at most 1px of vertical drift and at most 3px of
// width over lines up to 568px - so the browser font is not the risk here and
// a pixel assertion would only be brittle about it.

import { describe, expect, test } from 'bun:test'
import { EXPORT_GREEN, GREEN, inkColor, withExportInk } from '../panel-paint.ts'

describe('the export green', () => {
  test('is the pure green EVEN writes, and the panel green is not', () => {
    expect(EXPORT_GREEN).toBe('0, 255, 0')
    expect(GREEN).not.toBe(EXPORT_GREEN)
  })

  test('is what the painter reads inside an export', () => {
    expect(inkColor()).toBe(GREEN)
    let seen = ''
    withExportInk(() => { seen = inkColor() })
    expect(seen).toBe(EXPORT_GREEN)
  })

  test('is put back afterwards', () => {
    withExportInk(() => {})
    expect(inkColor()).toBe(GREEN)
  })

  test('is put back even when the repaint throws', () => {
    // The panel is left on screen after this. Leaking the export green would
    // mean the simulator quietly showing the wrong colour from then on, which
    // is the sort of thing nobody notices until a screenshot is wrong again.
    expect(() => withExportInk(() => { throw new Error('paint failed') })).toThrow('paint failed')
    expect(inkColor()).toBe(GREEN)
  })
})
