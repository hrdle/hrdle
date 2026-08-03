// The canvas painter for a G2 panel, shared by the simulator (debug-ui.ts)
// and the replay player (player-ui.ts). One implementation on purpose: the
// simulator's whole worth is that it draws what the device draws, and a second
// painter would drift from the first the way the simulator itself keeps
// threatening to drift from the hardware.

import { NOTICE_BORDER, NOTICE_BORDER_COLOR, NOTICE_PAD, noticeHeight } from './display.ts'
import {
  BAR_H,
  CARD_BORDER,
  CARD_BORDER_COLOR,
  CARD_RADIUS,
  HEADER_PAD,
  BODY_PAD,
  LINE_H,
  LIST_PAD,
  PANEL_H,
  PANEL_W,
  advance,
  cardBox,
} from './metrics.ts'

// Panel geometry, straight from the container definitions in display.ts.
// Text starts below the container's own padding, and LVGL stacks lines at a
// fixed 27px — drawing them 28px apart put the last of seven a full line's
// eighth out of place.
// Both come from metrics.ts. They were declared here as literals, which meant
// the panel's geometry lived in two files and only one of them was authoritative
// - the same shape of fault as a field the mirror forgets to send.
export { HEADER_PAD, BODY_PAD }
/** Baseline within a 27px line box, for the font this canvas draws with. */
export const BASELINE = 21
export const HEADER_BASE = HEADER_PAD + BASELINE
export const BODY_TOP = BAR_H + BODY_PAD + BASELINE
export const FOOTER_BASE = PANEL_H - BAR_H + HEADER_PAD + BASELINE
// Proportional, not monospace: the G2 font is proportional (a space is 5px,
// `i` is 4, `W` is 16) and drawing into those cells with a monospace face
// meant squeezing almost every ASCII glyph. A plain sans lands within about
// 1px of the firmware's advances instead of 4.
export const FONT = '19px system-ui, "Noto Sans", "DejaVu Sans", sans-serif'
// The panel's phosphor green. Pulled toward pure green — the G2 is a
// monochrome green display and the paler mint read as a generic HUD.
export const GREEN = '76, 255, 100'

/** The three container strings a screen is drawn from, mirror-shaped. */
export interface PanelScreen {
  header: string
  body: string
  footer: string
  notice?: string
  headerless?: boolean
  card?: boolean
}

export interface PanelPainter {
  drawRow(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void
  beginFrame(): CanvasRenderingContext2D | null
  endFrame(ctx: CanvasRenderingContext2D): void
  drawScreen(screen: PanelScreen): void
}

/**
 * A painter bound to one 576x288 canvas. `onFrame` runs after every finished
 * frame (the simulator keeps its picture-in-picture copy in step with it).
 */
export function createPanelPainter(canvas: HTMLCanvasElement, onFrame?: () => void): PanelPainter {
  // Every glyph lands where the firmware puts it.
  //
  // Letting the browser lay out a whole string drifts badly: the G2 font is
  // proportional (a space is 5px, `i` is 4, `W` is 16) and no browser
  // monospace comes close, so a right-aligned clock ended up near the middle
  // of the panel. Advancing by the firmware's own per-character widths —
  // kerning included - is the only way this window earns the phrase "draws
  // exactly what the device draws" in its own subtitle.
  function drawRow(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
    let dx = 0
    let prev = ''
    for (const ch of text) {
      const cell = advance(prev, ch)
      const natural = ctx.measureText(ch).width
      if (natural > cell + 0.5) {
        // The browser's glyph is wider than the cell the firmware gives it —
        // an emoji, a box-drawing rune. Squeeze it in rather than let it run
        // over its neighbour, which is also what the reader needs to know.
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
    // 4-bit: 16 alpha levels, nothing in between.
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const px = frame.data
    for (let i = 3; i < px.length; i += 4) {
      px[i] = Math.round((px[i] / 255) * 15) * 17
    }
    ctx.putImageData(frame, 0, 0)
    onFrame?.()
  }

  /**
   * A device screen laid out from three strings.
   *
   * This is all a mirror or a recording is given — text off the wire, with no
   * state behind it to run `updateDisplay` against. It positions things
   * itself, and it is not claiming to show where the device put things, only
   * what it said.
   */
  function drawScreen(screen: PanelScreen): void {
    const ctx = beginFrame()
    if (!ctx) return

    if (!screen.headerless) drawRow(ctx, screen.header, HEADER_PAD, HEADER_BASE)

    // The notice strip is its own container on the device, with a drawn border
    // where a row of dashes used to be. Its height decides where the
    // conversation starts, so this has to match the device's arithmetic or the
    // window stops being worth the phrase in its own subtitle.
    const noticeLines = screen.notice ? screen.notice.split('\n') : []
    const nHeight = noticeHeight(noticeLines.length)
    // Without a header container there is no bar for the strip to sit under, so
    // it starts at the top of the panel - the same place `buildSessionList` puts
    // it. A strip drawn 36px lower than the device draws it is the kind of
    // divergence the simulator exists to make visible, not to introduce.
    const noticeTop = screen.headerless ? 0 : BAR_H
    for (const [i, line] of noticeLines.entries()) {
      drawRow(ctx, line, 4 + NOTICE_PAD + NOTICE_BORDER, noticeTop + NOTICE_PAD + NOTICE_BORDER + BASELINE + i * LINE_H)
    }
    if (nHeight > 0) {
      // The list's strip is a notification and is drawn to be noticed; the
      // conversation's is a recap, and its rule only has to separate.
      const level = screen.headerless ? CARD_BORDER_COLOR : NOTICE_BORDER_COLOR
      ctx.strokeStyle = `rgba(${GREEN}, ${level / 15})`
      ctx.lineWidth = NOTICE_BORDER
      ctx.beginPath()
      ctx.roundRect(
        4 + NOTICE_BORDER / 2,
        noticeTop + NOTICE_BORDER / 2,
        PANEL_W - 8 - NOTICE_BORDER,
        nHeight - NOTICE_BORDER,
        screen.headerless ? CARD_RADIUS : 0,
      )
      ctx.stroke()
      ctx.fillStyle = `rgb(${GREEN})`
    }

    if (screen.card) {
      // A notification is a box laid over the panel, not another screen filling
      // it. Drawn here at the same geometry `buildOverlay` gives the device -
      // getting this wrong would put the simulator's border somewhere the G2's
      // is not, which is the exact class of divergence that keeps turning up.
      const lines = screen.body.split('\n')
      const box = cardBox(lines.length)
      ctx.strokeStyle = `rgba(${GREEN}, ${CARD_BORDER_COLOR / 15})`
      ctx.lineWidth = CARD_BORDER
      ctx.beginPath()
      ctx.roundRect(
        box.x + CARD_BORDER / 2,
        box.y + CARD_BORDER / 2,
        box.w - CARD_BORDER,
        box.h - CARD_BORDER,
        CARD_RADIUS,
      )
      ctx.stroke()
      ctx.fillStyle = `rgb(${GREEN})`
      const top = box.y + CARD_BORDER + BODY_PAD + BASELINE
      for (const [i, line] of lines.entries()) {
        drawRow(ctx, line, box.x + CARD_BORDER + BODY_PAD, top + i * LINE_H)
      }
    } else {
      // Without a header container the body owns that band too, and starts where
      // it does rather than a bar below it - but still below its own notice.
      // Headerless means the list container, which pads tighter than the body
      // does - `LIST_PAD` is what buys its ninth row, and padding it like a
      // body here would draw eight rows 4px lower than the device draws nine.
      const pad = screen.headerless ? LIST_PAD : BODY_PAD
      const bodyTop = screen.headerless ? nHeight + pad + BASELINE : BODY_TOP + nHeight
      for (const [i, line] of screen.body.split('\n').entries()) {
        drawRow(ctx, line, 4 + pad, bodyTop + i * LINE_H)
      }
    }

    ctx.fillStyle = `rgba(${GREEN}, 0.78)`
    drawRow(ctx, screen.footer, HEADER_PAD, FOOTER_BASE)

    endFrame(ctx)
  }

  return { drawRow, beginFrame, endFrame, drawScreen }
}
