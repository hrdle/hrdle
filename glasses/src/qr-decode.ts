// Getting a payload out of a picture of a QR code.
//
// Two decoders, tried in order. `BarcodeDetector` is the platform's own - on
// Android it is backed by Play Services, which reads a code off a terminal
// screen far better than anything shipped in a bundle. It is not everywhere,
// so jsQR stays as the fallback.
//
// The fallback gets three attempts rather than one, because the failure it has
// to survive is specific: a code drawn in a terminal window, photographed from
// across a desk, occupying maybe a fifth of a 12-megapixel frame. Scaled to fit
// a single decode pass, its modules land on fractions of a pixel and nothing
// reads. Cropping to the middle before scaling gets the same code back at three
// times the resolution, and that is usually the attempt that succeeds.

import jsQR from 'jsqr'

/** The size an image is decoded at, with its longest edge capped at `edge`. */
export function frameSize(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (!longest) return { width: 0, height: 0 }
  const scale = Math.min(1, edge / longest)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** Whether the platform brings its own barcode reader. */
export function hasBarcodeDetector(): boolean {
  return typeof (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector === 'function'
}

export interface DecodeResult {
  /** The payload, or null if nothing read. */
  payload: string | null
  /** Which attempt produced it. Reported in the diagnostics screen. */
  how: string
}

interface DetectedBarcode {
  rawValue?: string
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource | Blob): Promise<DetectedBarcode[]>
}

/** The platform decoder, or null if it is absent or declines the image. */
async function viaPlatform(source: Blob): Promise<string | null> {
  const Detector = (
    globalThis as {
      BarcodeDetector?: new (options?: { formats?: string[] }) => BarcodeDetectorLike
    }
  ).BarcodeDetector
  if (!Detector) return null
  try {
    const detector = new Detector({ formats: ['qr_code'] })
    const codes = await detector.detect(source)
    return codes?.[0]?.rawValue?.trim() || null
  } catch {
    // Play Services can be missing on the device even when the constructor
    // exists, and `detect` is where that surfaces.
    return null
  }
}

/** One jsQR pass over a region of the image, drawn at `edge` pixels. */
function viaJsQr(
  img: HTMLImageElement,
  region: { x: number; y: number; width: number; height: number },
  edge: number,
): string | null {
  const size = frameSize(region.width, region.height, edge)
  if (!size.width || !size.height) return null

  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(
    img,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    size.width,
    size.height,
  )

  const { data } = ctx.getImageData(0, 0, size.width, size.height)
  // A terminal draws the code in whichever way the shell's colours land, and
  // half the time that is light-on-dark.
  return jsQR(data, size.width, size.height, { inversionAttempts: 'attemptBoth' })?.data?.trim() || null
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('the image could not be read'))
    img.src = url
  })
}

/**
 * Read the first QR code in a photo.
 *
 * Reports which attempt won as well as the payload: when a code fails to read
 * on a device, "the platform decoder is missing and the full-frame pass is the
 * only one that ever fires" is the useful half of the answer.
 */
export async function decodeImage(blob: Blob): Promise<DecodeResult> {
  const platform = await viaPlatform(blob)
  if (platform) return { payload: platform, how: 'BarcodeDetector' }

  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImage(url)
    const width = img.naturalWidth
    const height = img.naturalHeight
    if (!width || !height) return { payload: null, how: 'empty image' }

    const full = { x: 0, y: 0, width, height }
    const attempts: Array<{ label: string; region: typeof full; edge: number }> = [
      { label: 'jsQR full', region: full, edge: 1400 },
      // Middle 60%, at the same pixel budget: the same code, three times the
      // resolution. This is the one that reads a terminal from a desk away.
      {
        label: 'jsQR centre',
        region: {
          x: Math.round(width * 0.2),
          y: Math.round(height * 0.2),
          width: Math.round(width * 0.6),
          height: Math.round(height * 0.6),
        },
        edge: 1400,
      },
      // Full frame at native resolution, for a code small enough that even the
      // crop cut it off. Slowest, so it goes last.
      { label: 'jsQR native', region: full, edge: Math.max(width, height) },
    ]

    for (const attempt of attempts) {
      const payload = viaJsQr(img, attempt.region, attempt.edge)
      if (payload) return { payload, how: attempt.label }
    }
    return { payload: null, how: 'no code found' }
  } catch (err) {
    return { payload: null, how: err instanceof Error ? err.message : String(err) }
  } finally {
    URL.revokeObjectURL(url)
  }
}
