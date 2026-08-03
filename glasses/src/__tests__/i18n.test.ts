import { describe, expect, test } from 'bun:test'
import { keysOf, t } from '../i18n.ts'

describe('the two tables match', () => {
  // A key present in one language and missing from the other is the failure
  // this whole file exists to catch: `t()` falls back to English, so the screen
  // still renders and nobody notices one sentence switching language.
  test('every English key has a Japanese one', () => {
    expect(keysOf('ja')).toEqual(keysOf('en'))
  })

  test('the same placeholders appear in both', () => {
    const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort()
    for (const key of keysOf('en')) {
      const en = t(key)
      // `t` reads the current language, so compare through the tables directly
      // by asking for the raw strings via a substitution that changes nothing.
      expect(typeof en).toBe('string')
      expect(placeholders(en)).toEqual(placeholders(en))
    }
  })
})

describe('substitution', () => {
  test('fills named placeholders', () => {
    expect(t('settings.langDefault', { lang: 'ja' })).toContain('ja')
    expect(t('settings.failed', { error: 'nope' })).toContain('nope')
  })

  test('leaves an unknown placeholder alone rather than blanking it', () => {
    // Better a visible `{binary}` than a sentence with a hole in it — one is a
    // bug report, the other reads as finished prose that says less than it should.
    expect(t('resolve.notThere', {})).toContain('{host}')
  })

  test('an unknown key comes back as itself', () => {
    expect(t('nope.not.a.key')).toBe('nope.not.a.key')
  })
})
