// One photo through the phone's own camera app.
//
// `capture` on a file input asks the platform for its camera rather than a
// picker. It travels the WebView's file-chooser path (`onShowFileChooser`)
// rather than its permission path (`onPermissionRequest`), which is the whole
// reason it is worth trying after getUserMedia has been refused: the picture is
// taken by the camera app, under the camera app's own permission, and arrives
// here as a file.
//
// Its own file because both the scanner and the diagnostics screen need it, and
// the scanner already imports the diagnostics screen.

/**
 * How long to wait for a photo before assuming nothing will arrive.
 *
 * A WebView with no file-chooser implementation is silent - `click()` returns,
 * no chooser opens, and neither `change` nor `cancel` ever fires. Without this
 * the promise would never settle and the button that started it would spin for
 * good.
 */
const PHOTO_TIMEOUT_MS = 100_000

export interface PhotoAttempt {
  /** The picture, or null if none arrived. */
  file: File | null
  /**
   * Whether the page ever went to the background.
   *
   * This separates "the camera app opened and they backed out" from "nothing
   * opened at all". The first is a decision and deserves silence; the second is
   * a WebView that will not open a chooser, and is the thing worth reporting.
   */
  wentAway: boolean
  /** Milliseconds from click to settle. A near-instant nothing is a shut door. */
  elapsedMs: number
}

export function takePhoto(): Promise<PhotoAttempt> {
  return new Promise((resolve) => {
    // performance.now rather than Date.now: this measures a duration, and the
    // wall clock is free to move underneath it.
    const startedAt = performance.now()
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.setAttribute('capture', 'environment')
    // Moved off screen rather than hidden: browsers decline to open a chooser
    // for an input that `display:none` has taken out of the layout entirely.
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    input.style.opacity = '0'
    document.body.append(input)

    let wentAway = false
    const onVisibility = () => {
      if (document.hidden) wentAway = true
    }
    document.addEventListener('visibilitychange', onVisibility)

    let timer = 0
    let settled = false
    const done = (file: File | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      input.remove()
      resolve({ file, wentAway, elapsedMs: Math.round(performance.now() - startedAt) })
    }

    input.addEventListener('change', () => done(input.files?.[0] ?? null))
    // Dismissing the chooser fires no `change`, so without this the promise
    // would only settle on the timeout.
    input.addEventListener('cancel', () => done(null))
    timer = setTimeout(() => done(null), PHOTO_TIMEOUT_MS) as unknown as number

    input.click()
  })
}
