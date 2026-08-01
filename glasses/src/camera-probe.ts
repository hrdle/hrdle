// What the host offered, gathered for the case where it offers nothing.
//
// The QR scanner asks for a camera and is refused on the device while every
// browser we can reach hands one over without comment. That gap cannot be closed
// by reasoning about it: the WebView belongs to the Even Realities app, its
// version is not ours to pick, and the same call fails three different ways
// depending on which of the platform's several no's we are hearing.
//
// So this screen exists to end the guessing. It reports the origin the page was
// served from, whether that origin counts as secure, whether `mediaDevices`
// exists at all, what `permissions.query` says, how many video inputs the
// platform admits to, and the exception verbatim. Together those separate the
// four candidates - a WebView that never grants camera to web content, an
// insecure origin, a permission the user really did refuse, and a device with no
// camera - which the single sentence the user saw could not.
//
// Deliberately not logged to a server: this runs during setup, which is the one
// moment when there is no server to log to yet.

import { t } from './i18n.ts'
import { takePhoto } from './photo-capture.ts'
import { decodeImage, hasBarcodeDetector } from './qr-decode.ts'

/** Never let a probe throw - it runs on the failure path already. */
async function attempt<T>(fn: () => Promise<T>): Promise<T | string> {
  try {
    return await fn()
  } catch (err) {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  }
}

function describe(err: unknown): string {
  if (!err) return '(none)'
  const e = err as { name?: string; message?: string }
  if (e.name || e.message) return `${e.name ?? 'Error'}: ${e.message ?? ''}`.trim()
  return String(err)
}

/**
 * A short report on why there is no camera stream.
 *
 * Plain lines rather than JSON: it is read off a phone screen, and half the time
 * it is retyped rather than copied.
 */
export async function probeCamera(
  cause?: unknown,
  extra?: Record<string, string>,
): Promise<string> {
  const lines: string[] = []
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices

  lines.push(`origin      ${globalThis.location?.origin || '(none)'}`)
  lines.push(`protocol    ${globalThis.location?.protocol || '(none)'}`)
  lines.push(`secure      ${String(globalThis.isSecureContext)}`)
  lines.push(`mediaDevices ${media ? 'yes' : 'no'}`)
  lines.push(`getUserMedia ${typeof media?.getUserMedia === 'function' ? 'yes' : 'no'}`)

  if (media?.enumerateDevices) {
    const devices = await attempt(() => media.enumerateDevices())
    if (typeof devices === 'string') {
      lines.push(`devices     ${devices}`)
    } else {
      const video = devices.filter((d) => d.kind === 'videoinput')
      // Labels stay empty until a stream has been granted, so their presence is
      // the interesting part: a WebView that lists cameras it will not open is a
      // different problem from one that lists none.
      lines.push(`videoinput  ${video.length} of ${devices.length}`)
    }
  }

  const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions
  if (permissions?.query) {
    const state = await attempt(async () => {
      // 'camera' is not in every engine's PermissionName union, and querying an
      // unknown name throws rather than returning a state.
      const status = await permissions.query({ name: 'camera' as PermissionName })
      return status.state as string
    })
    lines.push(`permission  ${state}`)
  } else {
    lines.push('permission  (no permissions API)')
  }

  // The second door and its decoder. When the diagnostics screen is on the
  // display at all, the photo path has already been tried and did not open, so
  // what these say is whether it was ever going to.
  // Only whether a file input is a file input. Whether `capture` is honoured
  // cannot be detected - Chrome accepts the attribute without exposing an IDL
  // property for it, so `'capture' in input` reports absent on a browser that
  // supports it perfectly well. The retry button below is the real test.
  let fileInput = 'no document'
  if (typeof document !== 'undefined') {
    const probe = document.createElement('input')
    probe.type = 'file'
    fileInput = probe.type === 'file' ? 'yes' : 'unsupported'
  }
  lines.push(`fileInput   ${fileInput}`)
  lines.push(`barcodeAPI  ${hasBarcodeDetector() ? 'yes' : 'no'}`)
  lines.push(
    `clipboard   ${typeof navigator?.clipboard?.readText === 'function' ? 'readText present' : 'no readText'}`,
  )
  for (const [key, value] of Object.entries(extra ?? {})) {
    lines.push(`${key.padEnd(11)} ${value}`)
  }

  lines.push(`error       ${describe(cause)}`)
  // Which host globals are present, rather than a yes/no for "is this the Even
  // app": the names are the SDK's business and change between versions, so the
  // useful thing is the list itself.
  const hostGlobals = Object.keys(globalThis)
    .filter((key) => /evenapp|evenhub|bridge|flutter/i.test(key))
    .slice(0, 6)
  lines.push(`globals     ${hostGlobals.join(' ') || '(none)'}`)
  lines.push(`ua          ${typeof navigator === 'undefined' ? '(none)' : navigator.userAgent}`)

  return lines.join('\n')
}

const CSS = `
  .cpr { position:fixed; inset:0; z-index:2147483100; background:#0a0a0a; overflow:auto;
         font-family:-apple-system,'Helvetica Neue',sans-serif; color:#ddd;
         padding:24px 20px calc(24px + env(safe-area-inset-bottom,0px)); }
  .cpr h1 { font-size:17px; margin:0 0 10px; color:#eee; }
  .cpr p { font-size:13px; line-height:1.7; margin:0 0 8px; color:#8d8d8d; }
  .cpr pre { font-family:ui-monospace,Menlo,monospace; font-size:11px; line-height:1.6;
             background:#161616; border:1px solid #262626; border-radius:8px;
             padding:12px; margin:14px 0; white-space:pre-wrap; word-break:break-all;
             color:#cfe6cf; user-select:text; -webkit-user-select:text; }
  .cpr-actions { display:flex; gap:10px; }
  .cpr-actions button { flex:1; padding:12px 14px; border-radius:9px; border:none;
                        font-size:14px; font-weight:600; cursor:pointer; }
  .cpr-copy { background:#1e1e1e; color:#ddd; }
  .cpr-close { background:#c9272e; color:#fff; }
  .cpr-tests { display:flex; gap:10px; margin:16px 0 0; }
  .cpr-tests button { flex:1; padding:11px 12px; border-radius:9px; border:1px solid #2c2c2c;
                      background:#141414; color:#cfcfcf; font-size:13px; font-weight:600;
                      cursor:pointer; }
  .cpr-log:empty { display:none; }
`

/**
 * Put the report on screen and wait for it to be dismissed.
 *
 * Rendered by the host page rather than handed back to the guide: the guide
 * shows a scan failure as one line of prose, and this is twelve lines of
 * monospace that has to survive being read aloud over a phone call.
 */
export function showCameraProbe(reason: string, report: string): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve()

  const overlay = document.createElement('div')
  overlay.className = 'cpr'
  overlay.innerHTML = `
    <h1>${t('probe.title')}</h1>
    <p>${reason}</p>
    <p>${t('probe.hint')}</p>
    <pre class="cpr-report"></pre>
    <div class="cpr-actions">
      <button type="button" class="cpr-copy">${t('probe.copy')}</button>
      <button type="button" class="cpr-close">${t('probe.close')}</button>
    </div>
    <div class="cpr-tests">
      <button type="button" class="cpr-photo">${t('probe.tryPhoto')}</button>
      <button type="button" class="cpr-clip">${t('probe.tryClipboard')}</button>
    </div>
    <pre class="cpr-log"></pre>
    <style>${CSS}</style>
  `
  // textContent, not innerHTML: the report carries a user agent string and an
  // exception message, neither of which is ours to trust as markup.
  const pre = overlay.querySelector('.cpr-report') as HTMLElement
  pre.textContent = report
  document.body.append(overlay)

  // The two doors, retriable by hand. The report above says what the platform
  // claims; these say what it actually does when asked, which is not always the
  // same answer - and the photo path in particular is worth a second try after
  // a permission dialog has been dealt with.
  const log = overlay.querySelector('.cpr-log') as HTMLElement
  const append = (line: string) => {
    log.textContent = log.textContent ? `${log.textContent}\n${line}` : line
  }

  overlay.querySelector('.cpr-photo')?.addEventListener('click', () => {
    append('photo: asking for the camera app...')
    void takePhoto().then(async (photo) => {
      const parts = [
        photo.file ? `file ${photo.file.size}B ${photo.file.type || 'no type'}` : 'no file',
        `background ${photo.wentAway ? 'yes' : 'no'}`,
        `${photo.elapsedMs}ms`,
      ]
      if (photo.file) {
        const result = await decodeImage(photo.file)
        parts.push(result.payload ? `read by ${result.how}` : `not read (${result.how})`)
        if (result.payload) parts.push(result.payload.slice(0, 60))
      }
      append(`photo: ${parts.join(', ')}`)
    })
  })

  overlay.querySelector('.cpr-clip')?.addEventListener('click', () => {
    const read = navigator.clipboard?.readText
    if (!read) {
      append('clipboard: no readText on this platform')
      return
    }
    void navigator.clipboard.readText().then(
      (text) => append(`clipboard: ${text ? `${text.length} chars, ${text.slice(0, 60)}` : 'empty'}`),
      (err) => append(`clipboard: ${describe(err)}`),
    )
  })

  return new Promise<void>((resolve) => {
    const copy = overlay.querySelector('.cpr-copy') as HTMLButtonElement
    copy.addEventListener('click', () => {
      // A WebView may have no clipboard API and no permission for it either, so
      // selecting the text is the fallback that always works - the user finishes
      // the copy with the platform's own control.
      const done = () => {
        copy.textContent = t('probe.copied')
      }
      // Whatever the retry buttons have logged goes with it: that is the half
      // of the report that says what actually happened, not what was claimed.
      const full = log.textContent ? `${report}\n\n${log.textContent}` : report
      navigator.clipboard?.writeText(full).then(done, () => {
        const range = document.createRange()
        range.selectNodeContents(pre)
        const selection = getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      })
    })
    overlay.querySelector('.cpr-close')?.addEventListener('click', () => {
      overlay.remove()
      resolve()
    })
  })
}
