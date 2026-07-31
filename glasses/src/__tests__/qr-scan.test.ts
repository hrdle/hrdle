// The two decisions the live scanner makes on every frame.
//
// The scanner itself needs a camera, a video element and a canvas, none of
// which exist here - but the parts that decide what happens with a frame are
// plain functions, and they are the parts that can be wrong quietly. A payload
// wrongly accepted ends the scan on a Wi-Fi code and sends the setup off to
// connect to it; a frame size wrongly computed either costs a decode per frame
// or squashes the code out of readability.

import { describe, expect, test } from 'bun:test'
import { frameSize, isAddress } from '../qr-scan.ts'

describe('what counts as an address', () => {
  test('accepts what `hrdle qr` prints', () => {
    expect(isAddress('https://your-machine.tail4459c9.ts.net:5924')).toBe(true)
  })

  test('accepts plain http, for a server without Tailscale in front of it', () => {
    expect(isAddress('http://192.168.1.10:5924')).toBe(true)
  })

  test('ignores the scheme case, which a code is free to carry either way', () => {
    expect(isAddress('HTTPS://example.ts.net:5924')).toBe(true)
  })

  test('rejects the other codes a camera finds while looking', () => {
    // Keep looking rather than finish: these are what a phone sees on a desk,
    // on a poster behind the desk, and on the back of a router.
    expect(isAddress('WIFI:S:home;T:WPA;P:hunter2;;')).toBe(false)
    expect(isAddress('your-machine.tail4459c9.ts.net:5924')).toBe(false)
    expect(isAddress('mailto:someone@example.com')).toBe(false)
    expect(isAddress('')).toBe(false)
  })
})

describe('the size a frame is decoded at', () => {
  test('leaves a frame already inside the cap alone', () => {
    expect(frameSize(640, 480, 720)).toEqual({ width: 640, height: 480 })
  })

  test('caps the longest edge and keeps the shape', () => {
    expect(frameSize(1280, 720, 720)).toEqual({ width: 720, height: 405 })
  })

  test('caps by height when the frame is portrait, as a held phone is', () => {
    expect(frameSize(720, 1280, 720)).toEqual({ width: 405, height: 720 })
  })

  test('never rounds an edge down to nothing', () => {
    // A 1px edge is useless to the decoder, but a 0px canvas throws on
    // getImageData - and that would end the scan instead of skipping a frame.
    expect(frameSize(4000, 1, 720).height).toBe(1)
  })

  test('reports nothing for a frame that has not arrived yet', () => {
    // `videoWidth` is 0 until metadata loads, which is several frames after the
    // element gets its stream.
    expect(frameSize(0, 0, 720)).toEqual({ width: 0, height: 0 })
  })
})
