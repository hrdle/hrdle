// Reading the server's address off a QR code instead of typing it.
//
// The address is a Tailscale FQDN with a random-looking tailnet in the middle
// of it - `https://your-machine.tail4459c9.ts.net:5924` - and typing that on a
// phone keyboard, from a terminal window across the room, is the worst moment
// of the whole setup. `hrdle qr` on the computer draws it as a code; this reads
// it back.
//
// A single still, not a live preview. The host SDK offers `captureImageFromCamera`,
// which hands back one photo through the phone's own camera UI - no getUserMedia,
// no permission prompt of our own, and nothing to tear down afterwards. It is
// worse than a continuous scanner at finding a code, and it is the one that
// works inside a WebView we do not control.

import jsQR from 'jsqr'
import type { Bridge } from './display.ts'

/**
 * Longest edge the decode runs at.
 *
 * A phone camera still is upwards of 12 megapixels, and jsQR walks every pixel.
 * A QR filling a decent part of the frame survives this reduction easily, and
 * the alternative is several seconds of a frozen WebView.
 */
const MAX_EDGE = 1400

export interface ScanOutcome {
  /** The address read from the code. */
  url?: string
  /** Something to show the user. Never a raw exception. */
  error?: string
  /** They backed out of the camera. Not a failure; say nothing. */
  cancelled?: boolean
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * One still image as a data URL, or null if the user backed out.
 *
 * The browser branch exists so the connect screen can be exercised at
 * `?phone` without a device: a file input with `capture` opens the camera on a
 * phone and a file picker on a desktop, which is enough to test the decode with
 * a screenshot of a code.
 */
async function captureStill(bridge: Bridge | null): Promise<string | null> {
  if (bridge) {
    const asset = await bridge.captureImageFromCamera()
    if (!asset?.base64) return null
    return `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`
  }
  return pickFile()
}

function pickFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    // Opens the camera directly on a phone; ignored on a desktop, where it
    // falls back to the ordinary picker.
    input.setAttribute('capture', 'environment')
    // Moved off screen rather than hidden: browsers decline to open a chooser
    // for an input that `display:none` has taken out of the layout entirely.
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    input.style.opacity = '0'
    document.body.append(input)

    const done = (value: string | null) => {
      input.remove()
      resolve(value)
    }

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) {
        done(null)
        return
      }
      const reader = new FileReader()
      reader.onload = () => done(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => done(null)
      reader.readAsDataURL(file)
    })
    // Dismissing the picker fires no `change`, so without this the promise
    // would never settle and the button would stay disabled for good.
    input.addEventListener('cancel', () => done(null))

    input.click()
  })
}

/** The payload of the first QR code in the image, if there is one. */
async function decode(dataUrl: string): Promise<string | null> {
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('that image could not be read'))
    img.src = dataUrl
  })

  const longest = Math.max(img.naturalWidth, img.naturalHeight)
  if (!longest) throw new Error('that image was empty')
  const scale = Math.min(1, MAX_EDGE / longest)
  const width = Math.max(1, Math.round(img.naturalWidth * scale))
  const height = Math.max(1, Math.round(img.naturalHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('this device cannot process the photo')
  ctx.drawImage(img, 0, 0, width, height)

  const { data } = ctx.getImageData(0, 0, width, height)
  // A terminal draws the code in whichever way the shell's colours land, and
  // half the time that is light-on-dark. Trying both costs one more pass over
  // an already-downscaled image.
  const found = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })
  return found?.data?.trim() || null
}

/**
 * Take a photo and read an address out of it.
 *
 * Never throws: every outcome the user can cause - backing out, a blurry frame,
 * a code that turns out to be a Wi-Fi password - comes back as a field on the
 * result, because this runs behind a button on a setup screen and an unhandled
 * rejection there leaves a spinner turning forever.
 */
export async function scanQr(bridge: Bridge | null): Promise<ScanOutcome> {
  let still: string | null
  try {
    still = await captureStill(bridge)
  } catch (err) {
    return { error: `The camera could not be opened: ${message(err)}` }
  }
  if (!still) return { cancelled: true }

  let payload: string | null
  try {
    payload = await decode(still)
  } catch (err) {
    return { error: `Could not read that photo: ${message(err)}` }
  }

  if (!payload) {
    return { error: 'No QR code in that photo. Fill more of the frame with it and try again.' }
  }
  if (!/^https?:\/\//i.test(payload)) {
    return { error: 'That code is not a web address. Scan the one printed by `hrdle qr`.' }
  }
  return { url: payload }
}
