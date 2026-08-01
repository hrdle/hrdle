// What the address field accepts.
//
// The field takes four different things - a short address, a full address, a
// hostname and a complete URL - and picking the wrong branch is silent: a
// hostname prefixed with `100.` produces a lookup that times out rather than an
// error anyone can act on. The network half needs a server, but this half is
// where the mistakes are.

import { describe, expect, test } from 'bun:test'
import { expandShortAddress, isFullUrl } from '../resolve-host.ts'

describe('the short form of a Tailscale address', () => {
  test('gets its 100. back', () => {
    expect(expandShortAddress('91.210.90')).toBe('100.91.210.90')
    expect(expandShortAddress('65.207.53')).toBe('100.65.207.53')
  })

  test('is left alone when it is already whole', () => {
    expect(expandShortAddress('100.91.210.90')).toBe('100.91.210.90')
  })

  test('does not touch a hostname', () => {
    // `100.beelink-arch` resolves to nothing, and the failure would read as
    // "the machine is not there" rather than "that was never an address".
    expect(expandShortAddress('beelink-arch')).toBe('beelink-arch')
    expect(expandShortAddress('beelink-arch.tail4459c9.ts.net')).toBe('beelink-arch.tail4459c9.ts.net')
  })

  test('does not touch a LAN address', () => {
    // Four octets: already complete, and prefixing would produce five.
    expect(expandShortAddress('192.168.1.5')).toBe('192.168.1.5')
  })

  test('trims what a phone keyboard adds', () => {
    expect(expandShortAddress('  91.210.90  ')).toBe('100.91.210.90')
  })
})

describe('telling a complete URL from something to look up', () => {
  test('recognises what a paste produces', () => {
    expect(isFullUrl('https://beelink-arch.tail4459c9.ts.net:5924')).toBe(true)
    expect(isFullUrl('http://100.91.210.90:5924')).toBe(true)
    expect(isFullUrl('  https://example.ts.net:5924  ')).toBe(true)
  })

  test('does not mistake an address for a URL', () => {
    expect(isFullUrl('91.210.90')).toBe(false)
    expect(isFullUrl('beelink-arch')).toBe(false)
    expect(isFullUrl('beelink-arch.tail4459c9.ts.net:5924')).toBe(false)
  })
})
