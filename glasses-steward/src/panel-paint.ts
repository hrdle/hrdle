// The canvas painter for a G2 panel.
//
// Carried over from the other glasses app. Its worth is that it draws what the
// device draws: the glyph advances are the firmware's own, the frame is crushed
// to the panel's 16 levels of green, and the geometry comes from `metrics.ts`
// rather than from constants copied alongside it.
//
// The notification card is gone - this app has no card - and so is the export
// green, which belongs to a store submission rather than to a simulator.

import { NOTICE_BORDER, NOTICE_BORDER_COLOR, NOTICE_PAD, noticeHeight } from './display.ts'
import {
  BAR_H,
  BODY_PAD,
  HEADER_PAD,
  LINE_H,
  LIST_PAD,
  PANEL_H,
  PANEL_W,
  advance,
} from './metrics.ts'

export { HEADER_PAD, BODY_PAD }
/** Baseline within a 27px line box, for the font this canvas draws with. */
export const BASELINE = 21
export const HEADER_BASE = HEADER_PAD + BASELINE
export const BODY_TOP = BAR_H + BODY_PAD + BASELINE
export const FOOTER_BASE = PANEL_H - BAR_H + HEADER_PAD + BASELINE
// Proportional, not monospace: the G2 font is proportional (a space is 5px, `i`
// is 4, `W` is 16) and drawing into those cells with a monospace face squeezes
// almost every ASCII glyph. A plain sans lands within about 1px of the
// firmware's advances instead of 4.
export const FONT = '19px system-ui, "Noto Sans", "DejaVu Sans", sans-serif'
/** The panel's phosphor green. */
export const GREEN = '76, 255, 100'

export function inkColor(): string {
  return GREEN
}

/** The strings a screen is drawn from, mirror-shaped. */
export interface PanelScreen {
  header: string
  body: string
  footer: string
  notice?: string
  headerless?: boolean
}

export interface PanelPainter {
  drawRow(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void
  beginFrame(): CanvasRenderingContext2D | null
  endFrame(ctx: CanvasRenderingContext2D): void
  drawScreen(screen: PanelScreen): void
}

export function createPanelPainter(canvas: HTMLCanvasElement, onFrame?: () => void): PanelPainter {
  /**
   * Every glyph where the firmware puts it.
   *
   * Letting the browser lay out a whole string drifts badly - a right-aligned
   * clock ended up near the middle of the panel. Advancing by the firmware's
   * own per-character widths, kerning included, is what earns this window the
   * phrase "draws what the device draws".
   */
  function drawRow(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
    let dx = 0
    let prev = ''
    for (const ch of text) {
      const cell = advance(prev, ch)
      const natural = ctx.measureText(ch).width
      if (natural > cell + 0.5) {
        // The browser's glyph is wider than the cell the firmware gives it.
        // Squeeze it in rather than let it run over its neighbour - which is
        // also what the reader needs to know.
        ctx.save()
        ctx.translate(x + dx, y)
        ctx.scale(cell / natural, 1)
        ctx.fillText(ch, 0, 0)
        ctx.restore()
      } else {
        ctx.fillText(ch, x + dx, y)
      }
      dx += cell
      prev = ch
    }
  }

  function beginFrame(): CanvasRenderingContext2D | null {
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.font = FONT
    ctx.textBaseline = 'alphabetic'
    // Optics bloom a little; keep it subtle or quantising turns it to mud.
    ctx.shadowColor = `rgba(${GREEN}, 0.55)`
    ctx.shadowBlur = 6
    ctx.fillStyle = `rgb(${GREEN})`
    return ctx
  }

  /** Crush the finished frame to the panel's 16 levels of green.
   *  Anti-aliasing finer than 4 bits is exactly what the wearer does not get. */
  function endFrame(ctx: CanvasRenderingContext2D): void {
    ctx.shadowBlur = 0
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const px = frame.data
    for (let i = 3; i < px.length; i += 4) {
      px[i] = Math.round((px[i] / 255) * 15) * 17
    }
    ctx.putImageData(frame, 0, 0)
    onFrame?.()
  }

  /**
   * A screen laid out from its strings alone.
   *
   * All a mirror or a recording is given - text off the wire with no state
   * behind it to run `updateDisplay` against. The simulator's own panel does
   * not come through here: it draws the containers `updateDisplay` produced,
   * which is what keeps it honest.
   */
  function drawScreen(screen: PanelScreen): void {
    const ctx = beginFrame()
    if (!ctx) return

    if (!screen.headerless) drawRow(ctx, screen.header, HEADER_PAD, HEADER_BASE)

    const noticeLines = screen.notice ? screen.notice.split('\n') : []
    const nHeight = noticeHeight(noticeLines.length)
    // Without a header container there is no bar for the strip to sit under, so
    // it starts at the top of the panel - where `buildScreen` puts it.
    const noticeTop = screen.headerless ? 0 : BAR_H
    for (const [i, line] of noticeLines.entries()) {
      drawRow(
        ctx,
        line,
        4 + NOTICE_PAD + NOTICE_BORDER,
        noticeTop + NOTICE_PAD + NOTICE_BORDER + BASELINE + i * LINE_H,
      )
    }
    if (nHeight > 0) {
      ctx.strokeStyle = `rgba(${GREEN}, ${NOTICE_BORDER_COLOR / 15})`
      ctx.lineWidth = NOTICE_BORDER
      ctx.beginPath()
      ctx.roundRect(
        4 + NOTICE_BORDER / 2,
        noticeTop + NOTICE_BORDER / 2,
        PANEL_W - 8 - NOTICE_BORDER,
        nHeight - NOTICE_BORDER,
        0,
      )
      ctx.stroke()
      ctx.fillStyle = `rgb(${GREEN})`
    }

    // Headerless means the list container, which pads tighter than a body does
    // - `LIST_PAD` is what buys its ninth row.
    const pad = screen.headerless ? LIST_PAD : BODY_PAD
    const bodyTop = screen.headerless ? nHeight + pad + BASELINE : BODY_TOP + nHeight
    for (const [i, line] of screen.body.split('\n').entries()) {
      drawRow(ctx, line, 4 + pad, bodyTop + i * LINE_H)
    }

    ctx.fillStyle = `rgba(${GREEN}, 0.78)`
    drawRow(ctx, screen.footer, HEADER_PAD, FOOTER_BASE)

    endFrame(ctx)
  }

  return { drawRow, beginFrame, endFrame, drawScreen }
}
