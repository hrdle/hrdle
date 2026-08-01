// Reading the server's address off a QR code instead of typing it.
//
// The address is a Tailscale FQDN with a random-looking tailnet in the middle
// of it - `https://your-machine.tail4459c9.ts.net:5924` - and typing that on a
// phone keyboard, from a terminal window across the room, is the worst moment
// of the whole setup. `hrdle qr` on the computer draws it as a code; this reads
// it back.
//
// A live preview, decoding frames as they arrive.
//
// This began as a single still through the host SDK's `captureImageFromCamera`,
// on the reasoning that it needs no getUserMedia, raises no permission prompt of
// ours and works inside a WebView we do not control. In practice it did not read
// codes: the one the terminal draws is small, low-contrast and often
// light-on-dark, the photo comes back through the phone's own camera UI already
// compressed, and the person gets no feedback until after the shutter - by which
// point the only thing to do is take another one exactly as blind as the first.
// A continuous scanner decodes dozens of frames a second and lets them see the
// code being found. The still is gone rather than kept as a fallback: a fallback
// that has never once succeeded is a longer path to the same failure.

import jsQR from 'jsqr'
import { probeCamera, showCameraProbe } from './camera-probe.ts'
import { t } from './i18n.ts'

/**
 * Longest edge a frame is decoded at.
 *
 * jsQR walks every pixel, and this runs many times a second. A code that fills
 * the guide square is a few hundred pixels across at this size, which is several
 * times what the decoder needs, while a full 1280x720 frame would cost triple
 * for nothing.
 */
const FRAME_EDGE = 720

/**
 * Shortest gap between decode attempts.
 *
 * A hand holding a phone does not move meaningfully in one animation frame, so
 * decoding on every one of them buys no hit rate and costs heat and battery.
 */
const DECODE_INTERVAL_MS = 90

/**
 * How long the scanner runs before giving up.
 *
 * The guide waits 120s for an answer (`SCAN_TIMEOUT_MS` in its host-bridge), so
 * this has to come back inside that or the result is discarded and its button
 * stays spinning. Ninety seconds of pointing a camera at a terminal is already
 * well past the point where something else is wrong.
 */
const TIMEOUT_MS = 90_000

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
 * Whether a decoded payload is the thing we came for.
 *
 * A QR code in the wild is as likely to be a Wi-Fi password or a shop's menu,
 * and a live scanner reads whatever wanders into frame - so this decides whether
 * to finish or to keep looking, not whether to show an error.
 */
export function isAddress(payload: string): boolean {
  return /^https?:\/\//i.test(payload)
}

/** The size a frame is decoded at, with its longest edge capped at `edge`. */
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

// ── The screen ──

const CSS = `
  .qrs { position:fixed; inset:0; z-index:2147483000; background:#000;
         display:flex; flex-direction:column; }
  .qrs-stage { position:relative; flex:1; overflow:hidden; }
  .qrs-video { position:absolute; inset:0; width:100%; height:100%; object-fit:cover;
               background:#000; }
  .qrs-guide { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
               width:min(72vw,72vh); aspect-ratio:1; border:2px solid rgba(255,255,255,.85);
               border-radius:14px; box-shadow:0 0 0 100vmax rgba(0,0,0,.45); }
  .qrs-panel { padding:18px 20px calc(20px + env(safe-area-inset-bottom,0px));
               background:#0a0a0a; display:flex; flex-direction:column; gap:12px;
               align-items:center; font-family:-apple-system,'Helvetica Neue',sans-serif; }
  .qrs-status { margin:0; font-size:13px; line-height:1.6; color:#bbb; text-align:center;
                max-width:24em; min-height:3.2em; }
  .qrs-cancel { width:100%; max-width:22em; padding:12px 14px; border-radius:9px; border:none;
                background:#c9272e; color:#fff; font-size:14px; font-weight:600; cursor:pointer; }
`

function screenHtml(): string {
  return `
    <div class="qrs-stage">
      <video class="qrs-video" playsinline muted autoplay></video>
      <div class="qrs-guide"></div>
    </div>
    <div class="qrs-panel">
      <p class="qrs-status">${t('scan.starting')}</p>
      <button type="button" class="qrs-cancel">${t('scan.cancel')}</button>
    </div>
    <style>${CSS}</style>
  `
}

// ── The camera ──

/**
 * A camera stream, or the reason there is none.
 *
 * Every refusal is worth its own sentence now that this is the only way in: with
 * a fallback behind it, "could not open the camera" was a detail nobody needed,
 * and without one it is the whole answer - and the two common causes want
 * opposite things from the user (change a setting, or type the address).
 */
async function openCamera(): Promise<{ stream?: MediaStream; error?: string; cause?: unknown }> {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { error: t('scan.noCamera') }
  }
  // getUserMedia is undefined outside a secure context in every current engine,
  // and the EVEN Hub container is free to serve this page from wherever it likes.
  if (window.isSecureContext === false) return { error: t('scan.noCamera') }
  const media = navigator.mediaDevices
  if (!media?.getUserMedia) return { error: t('scan.noCamera') }
  try {
    const stream = await media.getUserMedia({
      // `ideal` rather than `exact`: a desktop browser at `?phone` has only a
      // front camera, and refusing to open it would make this screen untestable
      // on the one machine that has a keyboard.
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    })
    return { stream }
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return { error: t('scan.denied'), cause: err }
    }
    return { error: t('scan.cameraFailed', { error: message(err) }), cause: err }
  }
}

/**
 * Point a camera at the code and read it as it goes.
 *
 * Never throws: every outcome the user can cause - backing out, a camera the
 * WebView will not hand over, a code that turns out to be a Wi-Fi password -
 * comes back as a field on the result, because this runs behind a button on a
 * setup screen and an unhandled rejection there leaves a spinner turning forever.
 */
export async function scanQr(): Promise<ScanOutcome> {
  if (typeof document === 'undefined') return { error: t('scan.noCamera') }
  const camera = await openCamera()
  if (!camera.stream) {
    // The one sentence the user sees cannot tell four different no's apart, and
    // this one is being investigated rather than lived with. Show the report
    // before answering the guide, which would otherwise close the screen.
    const reason = camera.error ?? t('scan.noCamera')
    await showCameraProbe(reason, await probeCamera(camera.cause))
    return { error: reason }
  }
  const stream = camera.stream

  const overlay = document.createElement('div')
  overlay.className = 'qrs'
  overlay.innerHTML = screenHtml()
  document.body.append(overlay)

  const video = overlay.querySelector('video') as HTMLVideoElement
  const status = overlay.querySelector('.qrs-status') as HTMLElement
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  return new Promise<ScanOutcome>((resolve) => {
    let frame = 0
    let timer = 0
    let lastAt = 0
    let settled = false

    const finish = (outcome: ScanOutcome) => {
      if (settled) return
      settled = true
      if (frame) cancelAnimationFrame(frame)
      if (timer) clearTimeout(timer)
      // The tracks hold the camera indicator on, and a stream left running
      // behind a removed overlay keeps the light lit with nothing on screen to
      // explain it.
      for (const track of stream.getTracks()) track.stop()
      video.srcObject = null
      overlay.remove()
      resolve(outcome)
    }

    overlay.querySelector('.qrs-cancel')?.addEventListener('click', () => finish({ cancelled: true }))

    video.addEventListener('loadedmetadata', () => {
      status.textContent = t('scan.hint', { binary: __BINARY_NAME__ })
    })

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      if (now - lastAt < DECODE_INTERVAL_MS) return
      lastAt = now
      if (!ctx || video.readyState < 2) return

      const size = frameSize(video.videoWidth, video.videoHeight, FRAME_EDGE)
      if (!size.width || !size.height) return
      canvas.width = size.width
      canvas.height = size.height
      ctx.drawImage(video, 0, 0, size.width, size.height)

      let payload: string | null
      try {
        const { data } = ctx.getImageData(0, 0, size.width, size.height)
        // A terminal draws the code in whichever way the shell's colours land,
        // and half the time that is light-on-dark. Trying both costs one more
        // pass over an already-downscaled frame.
        payload = jsQR(data, size.width, size.height, { inversionAttempts: 'attemptBoth' })?.data?.trim() || null
      } catch {
        // A frame that cannot be read back is a tainted or zero-sized canvas -
        // both transient here, and neither worth ending the scan over.
        return
      }
      if (!payload) return
      if (!isAddress(payload)) {
        // Keep looking rather than fail: something else wandered into frame,
        // and the code we want may be sitting right next to it.
        status.textContent = t('scan.notAnAddress', { binary: __BINARY_NAME__ })
        return
      }
      finish({ url: payload })
    }

    if (!ctx) {
      finish({ error: t('scan.cannotProcess') })
      return
    }

    video.srcObject = stream
    video
      .play()
      .then(() => {
        timer = setTimeout(
          () => finish({ error: t('scan.timedOut') }),
          TIMEOUT_MS,
        ) as unknown as number
        frame = requestAnimationFrame(tick)
      })
      .catch((err) => {
        // Autoplay refused despite muted+playsinline. Nothing will ever appear,
        // so say so rather than leave a black rectangle up for ninety seconds.
        finish({ error: t('scan.cameraFailed', { error: message(err) }) })
      })
  })
}
